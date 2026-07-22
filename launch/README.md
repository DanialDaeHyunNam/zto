# 모듈 1 — 앱 출시 준비

실제 양대 스토어 런칭(2026-07-18)에서 실행 검증된 부품의 이관본. 상세 명세는 루트 `SPEC.md` §0~5.

## 구조

- `answers/` — 앱별 답안 시트 (SSOT). 표기명·IAP·가격·설문 답·심사 노트. **자격증명 파일은 절대 커밋하지 않는다** (경로만 기록).
- `scripts/` — 순수 CLI (의존성 0, node 단독 실행, stdout에 JSON). Electron 버튼·Claude 세션 어느 쪽에서든 호출.

## 스크립트

| 스크립트 | 역할 | 상태 |
|---|---|---|
| `google/token.js` | Play 액세스 토큰 발급 (스모크 테스트 겸용) | ✅ 검증 코드 이관 |
| `google/otp-upsert.js` | One-time product 업서트 (신 API, 403 함정 회피) | 이관 — 실전 검증 대기 |
| `google/otp-activate.js` | 구매 옵션 활성화 | 이관 — 실전 검증 대기 |
| `apple/asc-token.js` | ASC 관리용 JWT + 읽기 프로브 | ⏸ App Manager 키 발급 대기 |

사용 예:

```sh
node launch/scripts/google/token.js --sa <service-account.json>
node launch/scripts/google/otp-upsert.js --sa <sa.json> --answers launch/answers/<app>.json
node launch/scripts/google/otp-activate.js --sa <sa.json> --answers launch/answers/<app>.json
```

## 규칙 (SPEC §3 승계)

- 비가역 액션(스토어 제출·활성화·결제)은 **사람 컨펌 후** 실행.
- L2(콘솔 폼 — 앱 최초 등록·설문류)는 Claude in Chrome 전담, 답은 answers 시트에서.
