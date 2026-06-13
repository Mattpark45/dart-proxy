// DART API 프록시 — Node.js (Railway 배포용)
const https = require('https');
const http  = require('http');
const url   = require('url');

const DART_BASE = 'opendart.fss.or.kr';
const ALLOWED   = ['company', 'fnlttSinglAcntAll', 'fnlttMultiAcnt'];
const PORT      = process.env.PORT || 3000;

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

  const qs      = new URLSearchParams(parsed.query).toString();
  const dartPath = `/api/${path}.json?${qs}`;

  const options = {
    hostname: DART_BASE,
    path:     dartPath,
    method:   'GET',
    headers:  {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
      'Referer':    'https://opendart.fss.or.kr/',
      'Accept':     'application/json',
    },
    // TLS 1.2 강제 (DART 서버 호환)
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
