'use strict';
// DART API 프록시 — Railway 진입점 (package.json "start": "node index.js")
// 설정·보안 정책은 README.md 참고. 비밀값은 Railway 환경변수에만 둔다.
const { loadConfig } = require('./src/config');
const { createApp } = require('./src/app');

const config = loadConfig();
if (config.problems.length) {
  for (const p of config.problems) console.error(`[config] ${p}`);
  process.exit(1);
}
if (config.legacyBrowserMode) {
  console.warn('[config] LEGACY_BROWSER_MODE=on — 이행 기간 전용입니다. Origin 헤더는 위조 가능하므로 인증이 아닙니다.');
}

const { server } = createApp(config);
server.listen(config.port, () => {
  console.log(JSON.stringify({ level: 'info', msg: 'dart-proxy started', port: config.port, legacy: config.legacyBrowserMode }));
});

function shutdown() {
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 5000).unref();
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
