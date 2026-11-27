# dart-proxy — Claude Code 지침

공통 기준: `docs/ENGINEERING.md` (원본). 이 파일은 Claude Code 전용 보충만 담습니다.

- 시작 시 `git status`, `README.md`, `docs/ENGINEERING.md`를 읽고 `npm test`로 기준선을 확인합니다.
- 변경 보고: 변경 파일, `npm test` 결과, 미검증 항목, 롤백 방법.
- Scout 백엔드(`/api/dart-financial`)가 이 프록시를 실제로 호출하는지는 미확인입니다. 호출 측 계약을 바꾸는 변경은 확인 후 진행합니다.
