// DART API 프록시 — Railway (Node.js 호환)
const DART_BASE = 'https://opendart.fss.or.kr/api';
const ALLOWED   = ['company', 'fnlttSinglAcntAll', 'fnlttMultiAcnt'];

Deno.serve({ port: parseInt(Deno.env.get('PORT') || '8000') }, async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, OPTIONS',
      'Access-Control-Allow-Headers': '*',
    }});
  }
  const url  = new URL(req.url);
  const path = url.pathname.replace(/^\//, '').replace(/\.json$/, '');
  if (path === '' || path === 'health') {
    return new Response(JSON.stringify({ ok: true, service: 'dart-proxy' }), {
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
    });
  }
  if (!ALLOWED.includes(path)) {
    return new Response(JSON.stringify({ error: 'not allowed' }), {
      status: 403, headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
    });
  }
  const dartUrl = `${DART_BASE}/${path}.json?${url.searchParams}`;
  try {
    const res  = await fetch(dartUrl, {
      headers: { 'User-Agent': 'Mozilla/5.0', 'Referer': 'https://opendart.fss.or.kr/' },
    });
    const text = await res.text();
    return new Response(text, {
      headers: { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*' },
    });
  } catch (e: any) {
    return new Response(JSON.stringify({ error: e.message }), {
      status: 500, headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
    });
  }
});
