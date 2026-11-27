'use strict';
// DART 프록시 HTTP 앱. index.js 는 이 함수를 불러 listen 만 한다.
//
// 요청 처리 순서
//   1) 메서드·경로 길이 → 2) 인증(서버 간 토큰 / 이행기 브라우저 모드)
//   3) 호출량 제한(토큰·IP) → 4) 엔드포인트·파라미터 검증
//   5) 캐시 → 6) 동일 요청 합치기 → 7) 일일 예산 → 8) 동시 요청 제한 → 9) DART 호출
//   10) DART 상태코드 → HTTP 상태 변환 → 11) 비밀값 없는 구조화 로그

const http = require('http');
const crypto = require('crypto');
const { validateRequest } = require('./validate');
const { fetchDart: realFetchDart, UpstreamError } = require('./dart');

const KST_OFFSET_MS = 9 * 3600 * 1000;

// 파라미터 순서와 무관한 캐시 키
function keyOf(endpoint, params) {
  const sorted = Object.keys(params).sort().map((k) => [k, params[k]]);
  return `${endpoint}?${new URLSearchParams(sorted).toString()}`;
}

function sha256(s) {
  return crypto.createHash('sha256').update(s).digest();
}

function safeEqualToken(given, tokenDigests) {
  if (!given) return false;
  const g = sha256(given);
  let ok = false;
  for (const d of tokenDigests) ok = crypto.timingSafeEqual(g, d) || ok; // 모든 토큰과 비교(시간차 축소)
  return ok;
}

// DART 응답 status → 프록시 HTTP 응답
// https://opendart.fss.or.kr/guide/main.do 의 메시지 코드 기준
function mapDartStatus(code) {
  switch (code) {
    case '000': return { http: 200, cache: true };
    case '013': return { http: 404, error: 'no_data', cache: true };
    case '020': return { http: 429, error: 'upstream_rate_limited', tripBudget: true };
    case '100':
    case '101': return { http: 400, error: 'invalid_request' };
    case '800': return { http: 503, error: 'upstream_maintenance' };
    case '010':
    case '011':
    case '012':
    case '901': return { http: 502, error: 'upstream_auth', alert: true };
    default: return { http: 502, error: 'upstream_error' };
  }
}

function createApp(config, deps = {}) {
  const fetchDart = deps.fetchDart || realFetchDart;
  const now = deps.now || Date.now;
  const log = deps.log || ((o) => process.stdout.write(JSON.stringify(o) + '\n'));

  const tokenDigests = config.proxyTokens.map(sha256);
  const originSet = new Set(config.allowedOrigins);
  const secrets = [config.dartApiKey, ...config.proxyTokens].filter(Boolean);

  // 로그·응답으로 나가는 문자열에서 비밀값 제거 (방어적 이중 장치)
  function redact(s) {
    let out = String(s);
    for (const sec of secrets) out = out.split(sec).join('[REDACTED]');
    return out;
  }

  // ── 호출량 제한 (1분 고정 창) ──────────────────────────────
  const windows = new Map(); // key -> {start, count}
  function hit(key, limit) {
    const t = now();
    const w = windows.get(key);
    if (!w || t - w.start >= 60000) {
      windows.set(key, { start: t, count: 1 });
      return true;
    }
    w.count += 1;
    return w.count <= limit;
  }
  function sweepWindows() {
    const t = now();
    for (const [k, w] of windows) if (t - w.start >= 60000) windows.delete(k);
  }

  // ── 일일 예산 (KST 자정 리셋, 업스트림 호출만 차감) ───────────
  const budget = { day: '', used: 0, tripped: false };
  function kstDay() {
    return new Date(now() + KST_OFFSET_MS).toISOString().slice(0, 10);
  }
  function rollBudget() {
    const d = kstDay();
    if (budget.day !== d) Object.assign(budget, { day: d, used: 0, tripped: false });
  }

  // ── 캐시 (LRU) + 동일 요청 합치기 ─────────────────────────
  const cache = new Map(); // key -> {expires, http, body}
  const inflight = new Map(); // key -> Promise<result>
  function cacheGet(key) {
    const e = cache.get(key);
    if (!e) return null;
    if (e.expires <= now()) { cache.delete(key); return null; }
    cache.delete(key); cache.set(key, e); // LRU 갱신
    return e;
  }
  function cacheSet(key, value) {
    if (config.cacheMax === 0 || config.cacheTtlSec === 0) return;
    cache.set(key, { ...value, expires: now() + config.cacheTtlSec * 1000 });
    while (cache.size > config.cacheMax) cache.delete(cache.keys().next().value);
  }

  // ── 동시 요청 제한 ─────────────────────────────────────
  let active = 0;
  const queue = [];
  function acquire() {
    if (active < config.maxConcurrency) { active += 1; return Promise.resolve(); }
    if (queue.length >= config.maxQueue) return Promise.reject(Object.assign(new Error('busy'), { busy: true }));
    return new Promise((resolve) => queue.push(resolve));
  }
  function release() {
    const next = queue.shift();
    if (next) next(); else active -= 1;
  }

  async function callUpstream(endpoint, params) {
    rollBudget();
    if (budget.tripped || budget.used >= config.dailyBudget) {
      return { http: 429, body: { error: 'daily_budget_exhausted' } };
    }
    await acquire();
    try {
      rollBudget();
      if (budget.tripped || budget.used >= config.dailyBudget) {
        return { http: 429, body: { error: 'daily_budget_exhausted' } };
      }
      budget.used += 1;
      let res;
      try {
        res = await fetchDart(endpoint, params, config.dartApiKey, config.upstreamTimeoutMs);
      } catch (e) {
        if (e instanceof UpstreamError && e.kind === 'timeout') return { http: 504, body: { error: 'upstream_timeout' } };
        return { http: 502, body: { error: 'upstream_unreachable' } };
      }
      if (res.httpStatus !== 200) return { http: 502, body: { error: 'upstream_http_error', upstream_status: res.httpStatus } };
      let json;
      try { json = JSON.parse(res.text); } catch { return { http: 502, body: { error: 'upstream_invalid_json' } }; }
      const code = json && typeof json.status === 'string' ? json.status : '';
      const m = mapDartStatus(code);
      if (m.tripBudget) budget.tripped = true; // DART 한도 초과 → 오늘은 더 호출하지 않음
      if (m.alert) log({ level: 'alert', msg: 'DART 인증/키 오류 — 키 상태 확인 필요', dart_status: code });
      const out = m.http === 200
        ? { http: 200, body: json, raw: res.text }
        : { http: m.http, body: { error: m.error, dart_status: code } };
      if (m.cache) cacheSet(keyOf(endpoint, params), out);
      return out;
    } finally {
      release();
    }
  }

  function clientIp(req) {
    if (config.trustProxy) {
      const xff = req.headers['x-forwarded-for'];
      if (typeof xff === 'string' && xff) return xff.split(',')[0].trim();
    }
    return req.socket.remoteAddress || 'unknown';
  }

  function baseHeaders(origin) {
    const h = {
      'Content-Type': 'application/json; charset=utf-8',
      'X-Content-Type-Options': 'nosniff',
      'Cache-Control': 'no-store',
      'Referrer-Policy': 'no-referrer',
    };
    if (origin && originSet.has(origin)) {
      h['Access-Control-Allow-Origin'] = origin;
      h['Vary'] = 'Origin';
    }
    return h;
  }

  function send(res, status, body, origin, raw) {
    res.writeHead(status, baseHeaders(origin));
    res.end(raw !== undefined ? raw : JSON.stringify(body));
  }

  const handler = async (req, res) => {
    const started = now();
    const origin = typeof req.headers.origin === 'string' ? req.headers.origin : '';
    const ip = clientIp(req);
    const ipTag = crypto.createHash('sha256').update(ip).digest('hex').slice(0, 10); // 원 IP는 로그에 남기지 않음
    let status = 500;
    let endpointTag = '-';
    let cacheTag = '-';
    let auth = 'none';

    const finish = (s, body, raw) => {
      status = s;
      send(res, s, body, origin, raw);
      log({
        ts: new Date(started).toISOString(),
        ip: ipTag,
        method: req.method,
        endpoint: endpointTag,
        auth,
        cache: cacheTag,
        status,
        ms: now() - started,
      });
    };

    try {
      if ((req.url || '').length > 2048) return finish(414, { error: 'uri_too_long' });
      const url = new URL(req.url || '/', 'http://localhost');

      if (req.method === 'OPTIONS') {
        if (!originSet.has(origin)) return finish(403, { error: 'origin_not_allowed' });
        res.writeHead(204, {
          ...baseHeaders(origin),
          'Access-Control-Allow-Methods': 'GET, OPTIONS',
          'Access-Control-Allow-Headers': 'X-Proxy-Token',
          'Access-Control-Max-Age': '600',
        });
        res.end();
        return;
      }
      if (req.method !== 'GET') return finish(405, { error: 'method_not_allowed' });

      if (url.pathname === '/health' || url.pathname === '/') {
        endpointTag = 'health';
        return finish(200, { ok: true, service: 'dart-proxy' });
      }

      // ── 인증 ──
      const token = req.headers['x-proxy-token'];
      if (typeof token === 'string' && token && safeEqualToken(token, tokenDigests)) {
        auth = 'token';
      } else if (typeof token === 'string' && token) {
        return finish(401, { error: 'invalid_token' });
      } else if (config.legacyBrowserMode && originSet.has(origin)) {
        auth = 'legacy-origin'; // 이행 기간 전용. Origin 은 위조 가능하므로 IP 제한을 반드시 함께 적용
      } else {
        return finish(401, { error: 'auth_required' });
      }

      if (url.pathname === '/status') {
        endpointTag = 'status';
        if (auth !== 'token') return finish(401, { error: 'auth_required' });
        rollBudget();
        return finish(200, { day: budget.day, used: budget.used, limit: config.dailyBudget, tripped: budget.tripped, cache_entries: cache.size, active, queued: queue.length });
      }

      // ── 호출량 제한 ──
      sweepWindows();
      const tokenKey = auth === 'token' ? `t:${sha256(token).toString('hex').slice(0, 16)}` : null;
      if (tokenKey && !hit(tokenKey, config.rateLimitPerMinToken)) return finish(429, { error: 'rate_limited' });
      if (auth !== 'token' && !hit(`ip:${ip}`, config.rateLimitPerMinIp)) return finish(429, { error: 'rate_limited' });

      // ── 검증 ──
      const v = validateRequest(url.pathname, url.searchParams);
      if (!v.ok) return finish(v.status, { error: v.error });
      endpointTag = v.endpoint;

      const key = keyOf(v.endpoint, v.params);
      const cached = cacheGet(key);
      if (cached) {
        cacheTag = 'hit';
        return finish(cached.http, cached.body, cached.raw);
      }

      let p = inflight.get(key);
      if (p) {
        cacheTag = 'shared';
      } else {
        cacheTag = 'miss';
        p = callUpstream(v.endpoint, v.params).finally(() => inflight.delete(key));
        inflight.set(key, p);
      }
      const out = await p;
      return finish(out.http, out.body, out.raw);
    } catch (e) {
      if (e && e.busy) return finish(503, { error: 'busy' });
      log({ level: 'error', msg: redact(e && e.message ? e.message : 'internal error') });
      return finish(500, { error: 'internal_error' });
    }
  };

  const server = http.createServer((req, res) => {
    handler(req, res).catch(() => {
      if (!res.headersSent) send(res, 500, { error: 'internal_error' }, '');
    });
  });
  server.requestTimeout = config.upstreamTimeoutMs + 5000;
  server.headersTimeout = 10000;
  return { server, _state: { budget, cache, windows } };
}

module.exports = { createApp, mapDartStatus };
