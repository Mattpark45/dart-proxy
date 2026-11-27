'use strict';
// DART(opendart.fss.or.kr) 업스트림 호출. 호스트는 고정이며 요청으로 바꿀 수 없다.
const https = require('https');

const DART_HOST = 'opendart.fss.or.kr';

class UpstreamError extends Error {
  constructor(kind, message) {
    super(message);
    this.kind = kind; // 'timeout' | 'network' | 'http' | 'too_large'
  }
}

const MAX_BODY = 5 * 1024 * 1024; // 5MB

/**
 * @returns {Promise<{httpStatus:number, text:string}>}
 */
function fetchDart(endpoint, params, apiKey, timeoutMs) {
  const qs = new URLSearchParams({ ...params, crtfc_key: apiKey });
  const path = `/api/${endpoint}.json?${qs.toString()}`;

  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        hostname: DART_HOST,
        path,
        method: 'GET',
        headers: {
          'User-Agent': 'dart-proxy/2.0',
          Accept: 'application/json',
        },
        // 기존 운영본과 동일한 TLS 설정 유지 (DART 서버 호환)
        minVersion: 'TLSv1.2',
        maxVersion: 'TLSv1.2',
        timeout: timeoutMs,
      },
      (res) => {
        let size = 0;
        const chunks = [];
        res.on('data', (c) => {
          size += c.length;
          if (size > MAX_BODY) {
            req.destroy(new UpstreamError('too_large', 'upstream body too large'));
            return;
          }
          chunks.push(c);
        });
        res.on('end', () => resolve({ httpStatus: res.statusCode || 0, text: Buffer.concat(chunks).toString('utf8') }));
        res.on('error', (e) => reject(e instanceof UpstreamError ? e : new UpstreamError('network', 'upstream response error')));
      }
    );
    req.on('timeout', () => req.destroy(new UpstreamError('timeout', 'upstream timeout')));
    // 원본 에러 메시지에는 요청 경로(=키 포함)가 섞일 수 있으므로 버리고 분류만 남긴다
    req.on('error', (e) => reject(e instanceof UpstreamError ? e : new UpstreamError('network', 'upstream network error')));
    req.end();
  });
}

module.exports = { fetchDart, UpstreamError, DART_HOST };
