'use strict';
// 환경변수 → 설정 객체. 비밀값은 여기서만 읽고, 로그·응답에 절대 싣지 않는다.

function int(name, def, min, max) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return def;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n < min || n > max) {
    throw new Error(`환경변수 ${name} 값이 허용 범위(${min}~${max})를 벗어났습니다.`);
  }
  return n;
}

function list(name) {
  return (process.env[name] || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

function loadConfig(env = process.env) {
  // 테스트에서 env를 바꿔 끼울 수 있도록 process.env를 잠시 대체
  const saved = process.env;
  process.env = env;
  try {
    const dartApiKey = env.DART_API_KEY || '';
    const proxyTokens = list('PROXY_TOKENS');
    const allowedOrigins = list('ALLOWED_ORIGINS');
    const legacyBrowserMode = (env.LEGACY_BROWSER_MODE || 'off').toLowerCase() === 'on';

    const problems = [];
    if (!dartApiKey) problems.push('DART_API_KEY 가 없습니다.');
    if (proxyTokens.some((t) => t.length < 32)) problems.push('PROXY_TOKENS 의 각 토큰은 32자 이상이어야 합니다.');
    if (!legacyBrowserMode && proxyTokens.length === 0) {
      problems.push('PROXY_TOKENS 가 없습니다. 서버 간 호출 토큰을 설정하거나, 이행 기간에 한해 LEGACY_BROWSER_MODE=on 과 ALLOWED_ORIGINS 를 설정하세요.');
    }
    if (legacyBrowserMode && allowedOrigins.length === 0) {
      problems.push('LEGACY_BROWSER_MODE=on 에는 ALLOWED_ORIGINS 가 필요합니다.');
    }
    if (allowedOrigins.some((o) => o === '*' || !/^https?:\/\/[^/]+$/.test(o))) {
      problems.push('ALLOWED_ORIGINS 는 "https://host" 형식의 정확한 출처만 허용합니다("*" 금지).');
    }

    return {
      problems,
      port: int('PORT', 3000, 1, 65535),
      dartApiKey,
      proxyTokens,
      allowedOrigins,
      legacyBrowserMode,
      trustProxy: env.TRUST_PROXY === '1',
      rateLimitPerMinToken: int('RATE_LIMIT_PER_MIN_TOKEN', 60, 1, 10000),
      rateLimitPerMinIp: int('RATE_LIMIT_PER_MIN_IP', 20, 1, 10000),
      dailyBudget: int('DAILY_BUDGET', 5000, 1, 20000),
      maxConcurrency: int('MAX_CONCURRENCY', 4, 1, 64),
      maxQueue: int('MAX_QUEUE', 20, 0, 1000),
      upstreamTimeoutMs: int('UPSTREAM_TIMEOUT_MS', 8000, 500, 60000),
      cacheTtlSec: int('CACHE_TTL_SEC', 21600, 0, 7 * 86400),
      cacheMax: int('CACHE_MAX', 500, 0, 100000),
    };
  } finally {
    process.env = saved;
  }
}

module.exports = { loadConfig };
