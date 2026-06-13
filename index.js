// DART API 프록시 — Node.js (Railway 배포용)
// 브라우저에서 API 키가 노출되지 않도록 서버에서 키를 주입
const https = require('https');
const http  = require('http');
const url   = require('url');

const DART_BASE = 'opendart.fss.or.kr';
const ALLOWED   = ['company', 'fnlttSinglAcntAll', 'fnlttMultiAcnt'];
const PORT      = process.env.PORT || 3000;

// ── API 키는 Railway 환경변수에서만 읽음 (브라우저에 절대 노출 안 됨) ──
const DART_API_KEY = process.env.DART_API_KEY;
if (!DART_API_KEY) {
  console.error('[ERROR] DART_API_KEY 환경변수가 설정되지 않았습니다.');
  process.exit(1);
}

const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': '*',
};

http.createServer((req, res) => {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, CORS);
    return res.end();
  }

  const parsed = url.parse(req.url, true);
  const path   = parsed.pathname.replace(/^\//, '').replace(/\.json$/, '');

  if (!path || path === 'health') {
    res.writeHead(200, { ...CORS, 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ ok: true, service: 'dart-proxy' }));
  }

  if (!ALLOWED.includes(path)) {
    res.writeHead(403, { ...CORS, 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ error: 'not allowed' }));
  }

  // ── 브라우저가 보낸 파라미터에서 corp_code 등만 추출 ──────────
  // crtfc_key는 브라우저에서 받지 않고 서버에서 주입
  const clientParams = new URLSearchParams(parsed.query);
  clientParams.delete('crtfc_key'); // 혹시 브라우저가 보내도 무시

  // 서버에서 키 주입
  clientParams.set('crtfc_key', DART_API_KEY);

  const dartPath = `/api/${path}.json?${clientParams.toString()}`;

  const options = {
    hostname: DART_BASE,
    path:     dartPath,
    method:   'GET',
    headers:  {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
      'Referer':    'https://opendart.fss.or.kr/',
      'Accept':     'application/json',
    },
    minVersion: 'TLSv1.2',
    maxVersion: 'TLSv1.2',
  };

  const dartReq = https.request(options, (dartRes) => {
    let data = '';
    dartRes.on('data', chunk => data += chunk);
    dartRes.on('end', () => {
      res.writeHead(200, { ...CORS, 'Content-Type': 'application/json; charset=utf-8' });
      res.end(data);
    });
  });

  dartReq.on('error', (e) => {
    res.writeHead(500, { ...CORS, 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: e.message }));
  });

  dartReq.end();

}).listen(PORT, () => {
  console.log(`DART proxy running on port ${PORT}`);
});
