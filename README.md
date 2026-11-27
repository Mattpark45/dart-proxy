# dart-proxy v2

재무X레이 Scout 등 서버가 DART(opendart.fss.or.kr) 공시 재무 API를 호출할 때 쓰는 프록시입니다. DART 인증키는 이 서버의 환경변수에만 둡니다.

## 무엇이 바뀌었나 (v1 → v2)

| 항목 | v1 | v2 |
|---|---|---|
| 인증 | 없음. 누구나 호출 가능 | `X-Proxy-Token` 서버 간 토큰 필수. 이행 기간용 브라우저 모드는 선택 사항 |
| CORS | `*` | `ALLOWED_ORIGINS`에 적힌 정확한 출처만. CORS는 인증으로 쓰지 않음 |
| 호출량 | 제한 없음 | 토큰별·IP별 분당 제한, 일일 DART 호출 예산(KST 자정 리셋), DART 020 응답 시 당일 차단 |
| 검증 | 경로 이름만 확인 | 엔드포인트 3개와 파라미터 형식 검증. 알 수 없는 파라미터는 거절. 업스트림 호스트 고정 |
| 안정성 | timeout 없음 | 업스트림 timeout, 동시 요청 상한과 대기열, 응답 크기 상한 |
| 비용 | 매번 DART 호출 | 성공(000)과 자료없음(013) 응답을 캐시하고, 같은 시점의 동일 요청은 하나로 합침 |
| 오류 | 항상 200 | DART 상태코드와 HTTP 오류를 의미 있는 상태로 변환 |
| 로그 | 없음 | JSON 한 줄 로그. 키·토큰·원 IP·쿼리 값은 남기지 않음 |
| `main.ts` | Deno 판. 키를 주입하지 않고 브라우저 키를 그대로 전달 | **삭제**. Railway는 `npm start` → `node index.js`만 실행 |

## 환경변수

| 이름 | 필수 | 기본값 | 설명 |
|---|---|---|---|
| `DART_API_KEY` | ✅ | | DART 인증키 |
| `PROXY_TOKENS` | ✅* | | 호출 서버용 토큰. 쉼표로 여러 개, 각 32자 이상. 교체할 때는 새 토큰을 추가하고 호출 측을 바꾼 뒤 옛 토큰을 지움 |
| `ALLOWED_ORIGINS` | | | CORS를 허용할 정확한 출처. 예: `https://financial-xray-scout.pages.dev` |
| `LEGACY_BROWSER_MODE` | | `off` | `on`이면 허용 출처에서 오는 토큰 없는 요청을 IP 제한 아래에서 받음. **이행 기간에만 사용** |
| `TRUST_PROXY` | | `0` | Railway 앞단의 `X-Forwarded-For`를 믿을 때 `1` |
| `RATE_LIMIT_PER_MIN_TOKEN` | | `60` | 토큰별 분당 요청 수 |
| `RATE_LIMIT_PER_MIN_IP` | | `20` | 토큰 없는 요청(브라우저 모드)의 IP별 분당 요청 수 |
| `DAILY_BUDGET` | | `5000` | 하루 DART 호출 상한. DART 키의 일일 한도보다 낮게 설정 |
| `MAX_CONCURRENCY` / `MAX_QUEUE` | | `4` / `20` | 동시 업스트림 호출 수와 대기열 길이 |
| `UPSTREAM_TIMEOUT_MS` | | `8000` | DART 응답 대기 시간 |
| `CACHE_TTL_SEC` / `CACHE_MAX` | | `21600` / `500` | 캐시 유지 시간과 항목 수 |

\* `LEGACY_BROWSER_MODE=on`일 때만 생략할 수 있습니다. 설정이 잘못되면 서버가 기동을 거부합니다.

**브라우저에 토큰을 넣지 마세요.** 토큰은 Scout의 서버 쪽 코드(Cloudflare Pages Functions의 secret)에만 둡니다. 흐름은 `브라우저 → Scout /api/dart-financial → (토큰) → dart-proxy → DART`입니다.

## API

- `GET /health`: 생존 확인. 인증 없음
- `GET /status`: 당일 사용량과 캐시 상태. 토큰 필요
- `GET /company.json?corp_code=XXXXXXXX`
- `GET /fnlttSinglAcntAll.json?corp_code=&bsns_year=&reprt_code=&fs_div=`
- `GET /fnlttMultiAcnt.json?corp_code=A,B,...(최대 100)&bsns_year=&reprt_code=`

`crtfc_key`를 보내도 무시하고 서버 키를 넣습니다. v1 호출과의 경로 호환을 위해서입니다.

| DART status | 프록시 응답 |
|---|---|
| 000 | 200, DART 원문 (캐시) |
| 013 자료없음 | 404 `no_data` (캐시) |
| 020 한도초과 | 429. 그날 추가 호출 중단 |
| 100·101 | 400 |
| 800 점검 | 503 |
| 010·011·012·901 키 오류 | 502 `upstream_auth` + 경보 로그 |
| HTTP 오류·JSON 아님·네트워크 오류 | 502 / timeout은 504 |

## 테스트

```bash
npm test
```

외부 의존성 없이 Node 내장 `node:test`로 19개 시나리오를 검증합니다. 실제 DART는 호출하지 않습니다.

## 배포와 롤백 (운영 반영은 별도 승인 후)

1. **호출 측 확인**: Scout 서버 코드의 `/api/dart-financial`이 이 프록시를 쓰는지, DART를 직접 부르는지 먼저 확인합니다. 원본 소스 확보 전에는 단정하지 않습니다.
2. Railway Variables에 `PROXY_TOKENS`, `ALLOWED_ORIGINS`, `TRUST_PROXY=1`을 추가합니다. 브라우저에서 직접 부르는 호출이 남아 있다면 처음에는 `LEGACY_BROWSER_MODE=on`으로 둡니다.
3. 호출 서버에 같은 토큰을 secret으로 넣고 `X-Proxy-Token` 헤더를 보내게 합니다.
4. 이 브랜치를 배포하고 `/health`와 `/status`, 그리고 실제 기업 1건 조회로 확인합니다.
5. 브라우저 직접 호출이 사라지면 `LEGACY_BROWSER_MODE=off`로 바꿉니다.
6. **롤백**: Railway Deployments에서 직전 배포(v1)로 Redeploy합니다. v1은 추가 환경변수를 무시하므로 변수는 그대로 둬도 됩니다.

## DART 키 교체 (권장)

v1은 인증 없이 공개되어 있었고, 커밋 메시지로 보아 그 이전에는 키를 브라우저에서 다뤘던 것으로 보입니다. 노출을 배제할 수 없으므로:

1. OpenDART에서 새 키를 발급합니다(계정당 키 정책 확인).
2. Railway의 `DART_API_KEY`를 새 키로 바꾸고 재배포합니다.
3. 정상 조회를 확인한 뒤 옛 키를 폐기합니다.
