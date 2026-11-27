'use strict';
// 허용 엔드포인트와 파라미터 스키마. 여기에 없는 경로·파라미터는 모두 거절한다.
// 업스트림 호스트는 dart.js 에 고정되어 있으며, 요청으로 URL을 바꿀 수 없다.

const CORP_CODE = /^\d{8}$/;
const REPRT_CODES = new Set(['11011', '11012', '11013', '11014']); // 사업·반기·1분기·3분기
const FS_DIV = new Set(['CFS', 'OFS']); // 연결·별도

function year(v) {
  if (!/^\d{4}$/.test(v)) return false;
  const y = Number(v);
  return y >= 2015 && y <= new Date().getFullYear();
}

const ENDPOINTS = {
  company: {
    required: { corp_code: (v) => CORP_CODE.test(v) },
    optional: {},
  },
  fnlttSinglAcntAll: {
    required: {
      corp_code: (v) => CORP_CODE.test(v),
      bsns_year: year,
      reprt_code: (v) => REPRT_CODES.has(v),
      fs_div: (v) => FS_DIV.has(v),
    },
    optional: {},
  },
  fnlttMultiAcnt: {
    required: {
      corp_code: (v) => {
        const parts = v.split(',');
        return parts.length >= 1 && parts.length <= 100 && parts.every((p) => CORP_CODE.test(p));
      },
      bsns_year: year,
      reprt_code: (v) => REPRT_CODES.has(v),
    },
    optional: {},
  },
};

// 클라이언트가 보내더라도 무시하는 파라미터 (기존 호출 호환용)
const IGNORED = new Set(['crtfc_key']);

/**
 * @returns {{ok:true, endpoint:string, params:Record<string,string>} | {ok:false, status:number, error:string}}
 */
function validateRequest(pathname, searchParams) {
  const endpoint = pathname.replace(/^\/+/, '').replace(/\.json$/, '');
  const schema = Object.prototype.hasOwnProperty.call(ENDPOINTS, endpoint) ? ENDPOINTS[endpoint] : null;
  if (!schema) return { ok: false, status: 404, error: 'unknown_endpoint' };

  const params = {};
  const seen = new Set();
  for (const [k, v] of searchParams) {
    if (IGNORED.has(k)) continue;
    if (seen.has(k)) return { ok: false, status: 400, error: `duplicate_param:${k}` };
    seen.add(k);
    const check = schema.required[k] || schema.optional[k];
    if (!check) return { ok: false, status: 400, error: `unexpected_param:${k}` };
    if (typeof v !== 'string' || v.length > 1000 || !check(v)) {
      return { ok: false, status: 400, error: `invalid_param:${k}` };
    }
    params[k] = v;
  }
  for (const k of Object.keys(schema.required)) {
    if (!(k in params)) return { ok: false, status: 400, error: `missing_param:${k}` };
  }
  return { ok: true, endpoint, params };
}

module.exports = { validateRequest, ENDPOINTS };
