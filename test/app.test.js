'use strict';
// 실행: npm test  (Node 18+ 내장 node:test, 외부 의존성·실제 DART 호출 없음)
const test = require('node:test');
const assert = require('node:assert/strict');
const { createApp } = require('../src/app');
const { loadConfig } = require('../src/config');
const { UpstreamError } = require('../src/dart');

const KEY = 'FAKE_DART_KEY_0123456789abcdef0123456789';
const TOKEN = 'tok_' + 'a'.repeat(40);
const ORIGIN = 'https://financial-xray-scout.pages.dev';

function cfg(over = {}) {
  const c = loadConfig({
    DART_API_KEY: KEY,
    PROXY_TOKENS: TOKEN,
    ALLOWED_ORIGINS: ORIGIN,
    ...over,
  });
  assert.deepEqual(c.problems, []);
  return c;
}

const OK = JSON.stringify({ status: '000', message: '정상', list: [{ account_nm: '매출액' }] });

async function start(config, fetchImpl, extra = {}) {
  const logs = [];
  const calls = [];
  const fetchDart = async (endpoint, params, apiKey, timeout) => {
    calls.push({ endpoint, params, apiKey, timeout });
    return fetchImpl(endpoint, params, apiKey, timeout);
  };
  const { server, _state } = createApp(config, { fetchDart, log: (o) => logs.push(o), ...extra });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const get = (path, headers = {}) => fetch(base + path, { headers });
  return { server, base, get, logs, calls, state: _state, close: () => new Promise((r) => server.close(r)) };
}

const SINGLE = '/fnlttSinglAcntAll.json?corp_code=00126380&bsns_year=2024&reprt_code=11011&fs_div=CFS';
const auth = { 'X-Proxy-Token': TOKEN };

test('health 는 인증 없이 응답하고 내부 정보를 노출하지 않는다', async () => {
  const s = await start(cfg(), async () => ({ httpStatus: 200, text: OK }));
  const r = await s.get('/health');
  assert.equal(r.status, 200);
  assert.deepEqual(await r.json(), { ok: true, service: 'dart-proxy' });
  await s.close();
});

test('토큰 없음 → 401, 잘못된 토큰 → 401, DART 호출 없음', async () => {
  const s = await start(cfg(), async () => ({ httpStatus: 200, text: OK }));
  assert.equal((await s.get(SINGLE)).status, 401);
  assert.equal((await s.get(SINGLE, { 'X-Proxy-Token': 'wrong' })).status, 401);
  // CORS 허용 출처라도 레거시 모드가 꺼져 있으면 인증이 아님
  assert.equal((await s.get(SINGLE, { Origin: ORIGIN })).status, 401);
  assert.equal(s.calls.length, 0);
  await s.close();
});

test('정상 호출: 서버 키를 주입하고, 클라이언트가 보낸 crtfc_key 는 무시한다', async () => {
  const s = await start(cfg(), async () => ({ httpStatus: 200, text: OK }));
  const r = await s.get(SINGLE + '&crtfc_key=CLIENT_SUPPLIED', auth);
  assert.equal(r.status, 200);
  assert.equal((await r.json()).status, '000');
  assert.equal(s.calls.length, 1);
  assert.equal(s.calls[0].apiKey, KEY);
  assert.ok(!('crtfc_key' in s.calls[0].params));
  await s.close();
});

test('캐시: 같은 요청(파라미터 순서 무관)은 DART 를 한 번만 호출한다', async () => {
  const s = await start(cfg(), async () => ({ httpStatus: 200, text: OK }));
  await s.get(SINGLE, auth);
  const reordered = '/fnlttSinglAcntAll?fs_div=CFS&reprt_code=11011&bsns_year=2024&corp_code=00126380';
  const r = await s.get(reordered, auth);
  assert.equal(r.status, 200);
  assert.equal(s.calls.length, 1);
  await s.close();
});

test('동시 동일 요청은 하나로 합쳐진다', async () => {
  let release;
  const gate = new Promise((r) => (release = r));
  const s = await start(cfg(), async () => { await gate; return { httpStatus: 200, text: OK }; });
  const ps = [s.get(SINGLE, auth), s.get(SINGLE, auth), s.get(SINGLE, auth)];
  await new Promise((r) => setTimeout(r, 50));
  release();
  const rs = await Promise.all(ps);
  assert.deepEqual(rs.map((r) => r.status), [200, 200, 200]);
  assert.equal(s.calls.length, 1);
  await s.close();
});

test('허용되지 않은 엔드포인트·파라미터는 거절한다 (임의 URL 중계 불가)', async () => {
  const s = await start(cfg(), async () => ({ httpStatus: 200, text: OK }));
  const cases = [
    ['/list.json?corp_code=00126380', 404],
    ['/../../etc/passwd', 404],
    ['/https://evil.example/x', 404],
    ['/company.json', 400],
    ['/company.json?corp_code=123', 400],
    ['/company.json?corp_code=00126380&url=https://evil.example', 400],
    ['/company.json?corp_code=00126380&corp_code=00126381', 400],
    ['/fnlttSinglAcntAll.json?corp_code=00126380&bsns_year=1999&reprt_code=11011&fs_div=CFS', 400],
    ['/fnlttSinglAcntAll.json?corp_code=00126380&bsns_year=2024&reprt_code=99999&fs_div=CFS', 400],
    ['/fnlttSinglAcntAll.json?corp_code=00126380&bsns_year=2024&reprt_code=11011&fs_div=XXX', 400],
  ];
  for (const [path, want] of cases) {
    assert.equal((await s.get(path, auth)).status, want, path);
  }
  assert.equal(s.calls.length, 0);
  await s.close();
});

test('POST 등 다른 메서드는 405', async () => {
  const s = await start(cfg(), async () => ({ httpStatus: 200, text: OK }));
  const r = await fetch(s.base + SINGLE, { method: 'POST', headers: auth });
  assert.equal(r.status, 405);
  await s.close();
});

test('DART 상태코드 변환: 013→404(캐시), 100→400, 800→503, 010→502(경보, 키 미노출)', async () => {
  const map = { '00126380': '013', '00126381': '100', '00126382': '800', '00126383': '010' };
  const s = await start(cfg(), async (_e, p) => ({ httpStatus: 200, text: JSON.stringify({ status: map[p.corp_code], message: `key=${KEY}` }) }));
  const want = { '00126380': 404, '00126381': 400, '00126382': 503, '00126383': 502 };
  for (const [code, st] of Object.entries(want)) {
    const r = await s.get(`/company.json?corp_code=${code}`, auth);
    assert.equal(r.status, st, code);
    const text = await r.text();
    assert.ok(!text.includes(KEY), '응답에 키가 섞이면 안 됨');
  }
  await s.get('/company.json?corp_code=00126380', auth); // 013 은 캐시
  assert.equal(s.calls.length, 4);
  assert.ok(s.logs.some((l) => l.level === 'alert'));
  await s.close();
});

test('DART 020(한도 초과) 이후 그날은 더 이상 호출하지 않는다', async () => {
  const s = await start(cfg(), async () => ({ httpStatus: 200, text: JSON.stringify({ status: '020' }) }));
  assert.equal((await s.get('/company.json?corp_code=00126380', auth)).status, 429);
  const r = await s.get('/company.json?corp_code=00126381', auth);
  assert.equal(r.status, 429);
  assert.equal((await r.json()).error, 'daily_budget_exhausted');
  assert.equal(s.calls.length, 1);
  await s.close();
});

test('HTTP 오류·잘못된 JSON·네트워크 오류·타임아웃 처리', async () => {
  const behaviours = {
    '00126380': () => ({ httpStatus: 500, text: 'oops' }),
    '00126381': () => ({ httpStatus: 200, text: '<html>' }),
    '00126382': () => { throw new UpstreamError('network', 'x'); },
    '00126383': () => { throw new UpstreamError('timeout', 'x'); },
  };
  const s = await start(cfg(), async (_e, p) => behaviours[p.corp_code]());
  const want = { '00126380': 502, '00126381': 502, '00126382': 502, '00126383': 504 };
  for (const [code, st] of Object.entries(want)) {
    assert.equal((await s.get(`/company.json?corp_code=${code}`, auth)).status, st, code);
  }
  // 오류는 캐시하지 않음 → 재시도 시 다시 호출
  await s.get('/company.json?corp_code=00126380', auth);
  assert.equal(s.calls.length, 5);
  await s.close();
});

test('일일 예산을 넘으면 429 (캐시 적중은 차감하지 않음)', async () => {
  const s = await start(cfg({ DAILY_BUDGET: '2' }), async () => ({ httpStatus: 200, text: OK }));
  assert.equal((await s.get('/company.json?corp_code=00126380', auth)).status, 200);
  assert.equal((await s.get('/company.json?corp_code=00126380', auth)).status, 200); // 캐시
  assert.equal((await s.get('/company.json?corp_code=00126381', auth)).status, 200);
  assert.equal((await s.get('/company.json?corp_code=00126382', auth)).status, 429);
  assert.equal(s.calls.length, 2);
  await s.close();
});

test('일일 예산은 KST 자정에 리셋된다', async () => {
  let t = Date.parse('2026-11-27T14:59:00Z'); // KST 23:59
  const s = await start(cfg({ DAILY_BUDGET: '1' }), async () => ({ httpStatus: 200, text: OK }), { now: () => t });
  assert.equal((await s.get('/company.json?corp_code=00126380', auth)).status, 200);
  assert.equal((await s.get('/company.json?corp_code=00126381', auth)).status, 429);
  t = Date.parse('2026-11-27T15:00:01Z'); // KST 다음날 00:00
  assert.equal((await s.get('/company.json?corp_code=00126381', auth)).status, 200);
  await s.close();
});

test('토큰별 분당 호출량 제한', async () => {
  const s = await start(cfg({ RATE_LIMIT_PER_MIN_TOKEN: '3' }), async () => ({ httpStatus: 200, text: OK }));
  const st = [];
  for (let i = 0; i < 5; i++) st.push((await s.get(`/company.json?corp_code=0012638${i}`, auth)).status);
  assert.deepEqual(st, [200, 200, 200, 429, 429]);
  await s.close();
});

test('동시 요청 상한과 대기열 초과 시 503', async () => {
  let release;
  const gate = new Promise((r) => (release = r));
  const s = await start(cfg({ MAX_CONCURRENCY: '1', MAX_QUEUE: '1' }), async () => { await gate; return { httpStatus: 200, text: OK }; });
  const ps = [0, 1, 2].map((i) => s.get(`/company.json?corp_code=0012638${i}`, auth));
  await new Promise((r) => setTimeout(r, 80));
  release();
  const st = (await Promise.all(ps)).map((r) => r.status).sort();
  assert.deepEqual(st, [200, 200, 503]);
  await s.close();
});

test('이행기 브라우저 모드: 허용 출처만, IP 제한 적용, CORS 헤더는 허용 출처에만', async () => {
  const s = await start(cfg({ LEGACY_BROWSER_MODE: 'on', RATE_LIMIT_PER_MIN_IP: '2' }), async () => ({ httpStatus: 200, text: OK }));
  const ok = await s.get('/company.json?corp_code=00126380', { Origin: ORIGIN });
  assert.equal(ok.status, 200);
  assert.equal(ok.headers.get('access-control-allow-origin'), ORIGIN);
  const bad = await s.get('/company.json?corp_code=00126380', { Origin: 'https://evil.example' });
  assert.equal(bad.status, 401);
  assert.equal(bad.headers.get('access-control-allow-origin'), null);
  assert.equal((await s.get('/company.json?corp_code=00126381', { Origin: ORIGIN })).status, 200);
  assert.equal((await s.get('/company.json?corp_code=00126382', { Origin: ORIGIN })).status, 429);
  await s.close();
});

test('OPTIONS 사전요청은 허용 출처만 204', async () => {
  const s = await start(cfg(), async () => ({ httpStatus: 200, text: OK }));
  assert.equal((await fetch(s.base + SINGLE, { method: 'OPTIONS', headers: { Origin: ORIGIN } })).status, 204);
  assert.equal((await fetch(s.base + SINGLE, { method: 'OPTIONS', headers: { Origin: 'https://evil.example' } })).status, 403);
  await s.close();
});

test('/status 는 토큰 인증에서만 사용량을 보여준다', async () => {
  const s = await start(cfg({ LEGACY_BROWSER_MODE: 'on' }), async () => ({ httpStatus: 200, text: OK }));
  assert.equal((await s.get('/status', { Origin: ORIGIN })).status, 401);
  const r = await s.get('/status', auth);
  assert.equal(r.status, 200);
  assert.equal((await r.json()).limit, 5000);
  await s.close();
});

test('로그에 키·토큰·원 IP·쿼리 값이 남지 않는다', async () => {
  const s = await start(cfg(), async () => ({ httpStatus: 200, text: OK }));
  await s.get(SINGLE, auth);
  await s.get(SINGLE, { 'X-Proxy-Token': 'wrong' });
  const all = JSON.stringify(s.logs);
  for (const secret of [KEY, TOKEN, '127.0.0.1', '00126380']) assert.ok(!all.includes(secret), secret);
  await s.close();
});

test('설정 검증: 키 누락, 짧은 토큰, 와일드카드 출처, 토큰 없는 운영 모드는 기동 거부', () => {
  assert.ok(loadConfig({}).problems.length > 0);
  assert.ok(loadConfig({ DART_API_KEY: KEY, PROXY_TOKENS: 'short' }).problems.length > 0);
  assert.ok(loadConfig({ DART_API_KEY: KEY, PROXY_TOKENS: TOKEN, ALLOWED_ORIGINS: '*' }).problems.length > 0);
  assert.ok(loadConfig({ DART_API_KEY: KEY }).problems.length > 0);
  assert.ok(loadConfig({ DART_API_KEY: KEY, LEGACY_BROWSER_MODE: 'on' }).problems.length > 0);
  assert.deepEqual(loadConfig({ DART_API_KEY: KEY, LEGACY_BROWSER_MODE: 'on', ALLOWED_ORIGINS: ORIGIN }).problems, []);
});
