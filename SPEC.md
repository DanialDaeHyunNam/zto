# ZTO (Zero to One) — 스펙

> **읽는 순서: §6(ZTO 전체 비전·모듈 5개) 먼저 → §0~5(모듈 1 "앱 출시 준비" 상세).**
> §0~5는 실제 양대 스토어 런칭(2026-07-18)에서 **전부 실행으로 검증된** API 부품·함정 목록 — 모듈 1의 요구사항 명세이자 부품 목록이다. 특정 앱 고유 정보는 이 문서에 두지 않는다(2026-07-22, Dan — ZTO는 앱 무관 도구).

## 모듈 1 — 앱 출시 준비 (구 스펙 v0 본문)

> 여기 적힌 API 호출·함정은 전부 실제 런칭에서 **실행해 검증한 것**이다. 구현 시 이 문서가 요구사항 명세이자 부품 목록.

## 0. 동기 (실런칭에서 겪은 것)

앱 하나 내는 데 사람 손이 간 곳: Play 설문 폼 ~10종(스크린샷 핑퐁으로 안내), ASC 앱 생성·키 발급 3종, Apple 로그인 2FA 3회(그중 2회는 아카이브 버그 재시도), 라이선스 테스터 등록, 결제 테스트. **이 중 절반은 API가 있는데 몰라서/키가 없어서 콘솔로 했다.** 목표: 다음 앱(또는 IAP 추가)은 "결정만 사람, 실행은 전부 자동".

포트 9333에 세션 미러 서버를 띄우는 방안은 **기각** — Claude in Chrome(로그인된 실브라우저 조작)이 이미 그 역할이라 별도 인프라가 필요 없다.

## 1. 아키텍처 — 3층 자동화

| 층 | 수단 | 커버 범위 |
|---|---|---|
| **L1. API** | 스크립트 (키 기반, 완전 비대화) | 빌드·업로드·IAP·가격·등록정보·릴리스 |
| **L2. 브라우저** | Claude in Chrome (로그인 세션 조작, 반자동) | API 없는 콘솔 폼 — 앱 최초 등록, 설문류 |
| **L3. 사람** | 체크리스트로 최소화 | 2FA, 실기기 결제, 최종 제출 컨펌 |

## 2. L1 — 검증된 API 부품 목록

### 2.1 Google Play (인증: 서비스 계정 JSON → RS256 JWT → androidpublisher scope)
- 토큰 발급 코드: `launch/scripts/_lib/auth.js`의 `googleToken()` — 의존성 0 (이관 완료, 2026-07-22 스모크 테스트 통과).
- **IAP 생성 (2026-07-18 검증)**: ⚠️ 구 `inappproducts.insert`는 신규 앱에서 **403 "Please migrate to the new publishing API"**. 신 API를 쓸 것:
  - `POST /androidpublisher/v3/applications/{pkg}/oneTimeProducts:batchUpdate`
    - body: `{requests:[{oneTimeProduct:{packageName, productId, listings:[{languageCode:"ko-KR", title, description}], purchaseOptions:[{purchaseOptionId:"buy", buyOption:{}, regionalPricingAndAvailabilityConfigs:[{regionCode:"KR", price:{currencyCode:"KRW", units:"4400"}, availability:"AVAILABLE"}]}]}, updateMask:"listings,purchaseOptions", allowMissing:true, regionsVersion:{version:"2025/01"}}]}`
    - `allowMissing:true` = 업서트(생성 겸 수정). `newRegionsConfig`는 넣지 말 것(enum 값이 문서와 달라 400 — 생략하면 통과).
  - 활성화: `POST .../oneTimeProducts/{productId}/purchaseOptions:batchUpdateStates` body `{requests:[{activatePurchaseOptionRequest:{packageName, productId, purchaseOptionId}}]}`
  - 소모성 상품도 같은 API — 소모 처리는 클라이언트(expo-iap consume) + 자체 서버 장부 몫.
- **등록정보/이미지 (미실행, API 존재 확인)**: Edits API — `edits.insert → edits.listings.update`(제목·설명) / `edits.images.upload`(icon, featureGraphic, phoneScreenshots) / `edits.commit`.
- **릴리스**: `edits.tracks.update`로 internal→production 승격 가능. 첫 업로드·트랙 배정은 `eas submit`이 이미 커버(첫 AAB API 업로드 성공 사례 검증).
- **API 없음**: 앱 최초 등록, 데이터 보안 폼, 등급 설문, App access 선언, **라이선스 테스터 등록** → L2/L3.

### 2.2 Apple (인증: ASC API 키 — ES256 JWT)
- 키 2종을 구분할 것 (실수 포인트):
  - **In-App Purchase 키** (Integrations → In-App Purchase): App Store **Server** API 전용 = 영수증 검증용. 관리 작업엔 못 쓴다.
  - **App Store Connect API 키** (Integrations → App Store Connect API, 역할 App Manager): **관리용** — IAP 생성, 메타데이터·스크린샷 업로드, TestFlight 관리. 앱마다/팀마다 보유 여부가 다르므로 **위저드가 보유 점검 → 미보유 시 발급 안내** (§7.3).
- 제출은 키 불요: EAS가 제출용 ASC 키를 자동 생성해 자기 서버에 보관 — `eas submit -p ios` 비대화 동작 확인(2026-07-18).
- App Manager 키로 열리는 것: `inAppPurchasesV2`(IAP CRUD·가격), `appScreenshotSets`/`appStoreVersionLocalizations`(스크린샷·설명문), 심사 제출(`appStoreVersionSubmissions`)까지 이론상 전부. fastlane deliver도 같은 키로 동작 — 직접 REST가 부담이면 fastlane을 부품으로.
- **API 없음**: 앱 레코드 최초 생성, 계약·세금·은행 → L2/L3.

### 2.3 빌드·배포 (EAS — 전부 검증됨)
- `eas build -p android --profile production --non-interactive --no-wait` / `eas submit --profile internal --latest --non-interactive`
- ⚠️ **모노레포 함정**: EAS는 repo 루트째 아카이브. gitignore 산출물(게임 번들)은 **루트 `.easignore`** 로 포함시켜야 한다 — app/ 안의 .easignore는 무시됨. 자격증명 제외 유지 필수.
- ⚠️ expo-* 모듈은 메이저가 SDK 트랙: 설치 후 `npx expo install --check` 습관 (expo-iap 3.4.8 exact 사례).
- expo-updates 설치 권유는 거절 — OTA 불사용, SDK 함정 회피.

### 2.4 스토어 자산 생성 (검증됨 — 스크립트 존재)
- **스크린샷**: playwright-core + headless chromium으로 실게임 자동 캡처. 스크립트 = 세션 스크래치 `shots*.js` (구현 시 플러그인으로 이관할 것 — 게임별 어댑터 패턴: "타이틀 진입/전투 진입/UI 열기" 훅만 게임마다 주입).
  - 해상도 레시피: Play 폰 = 360×640 @3x(1080×1920), iOS 6.7" = 430×932 @3x(1290×2796), 가로 UI = 640×360 @3x.
  - 함정: 스텁 없는 실브라우저라 자연 플로우로 진입해야 배경이 렌더됨(전역 함수 직접 호출로 맵 직행 시 검은 화면). 대화 오버레이는 `#dialog` display:none 처리 후 촬영.
- **Feature graphic/아이콘 리사이즈**: PIL 스크립트 (`feature_graphic.py` 패턴 — 아이콘 아트 + AppleMyungjo 조판), `sips`.

## 3. L2 — 브라우저 반자동 (Claude in Chrome)

- 대상: Play 앱 등록 마법사, 설문 폼 6종, 라이선스 테스터 / ASC 앱 생성.
- 방식: Dan이 콘솔 로그인 상태로 페이지 열어두면 Claude가 조작. 답(데이터 보안·프라이버시 라벨·App access 문안·등급 설문)은 앱별 답안 시트(`launch/answers/`)의 `console_answers`에서 읽는다.
- 규칙: 제출/결제 등 비가역 버튼은 반드시 사람 컨펌 후 클릭.

## 4. 플러그인 형태 (구현 스케치)

```
store-launcher/
├─ CLAUDE.md                 # 진입점 — 이 스펙 이관본
├─ answers/                  # 앱별 답안 시트 (표기명·설문답·심사노트·가격) = SSOT
├─ scripts/
│  ├─ google/ (token.js, otp-upsert.js, otp-activate.js, listings-push.js, images-push.js)
│  ├─ apple/  (asc-token.js, iap-upsert.js, screenshots-push.js, metadata-push.js)
│  └─ assets/ (shots-runner.js + 게임별 어댑터, feature-graphic.py)
└─ skills/    # /store-launch (신규 앱 전 과정), /store-iap-add (상품 추가), /store-shots (스크린샷 재생성)
```
- 스킬 3개가 사용자 인터페이스. 각 스킬 = 답안 시트 읽기 → L1 스크립트 실행 → L2 구간은 Claude in Chrome → L3 체크리스트 출력.
- 자격증명은 앱별 답안 시트에 **경로만** 기록 (파일 자체는 커밋 금지, §7.3 위저드가 보유 점검).

## 4.5 앱 대시보드 — 모듈 1의 데이터 모델과 최종 UI (2026-07-22 Dan 확정, 구 대시보드 요구를 대체)

**비전**: "이미 되어 있는 건 불이 들어와 있고, 전체가 한눈에, 기본은 뇌를 빼놓고. 필요할 때만 콘솔 링크 클릭." 위저드(신규 여정)는 이 대시보드를 채워가는 안내자.

**위계 (Dan 원문 정규화)**:
```
앱 (N개)
└─ 플랫폼 (1~2: Android/iOS — 안드만·iOS만·둘 다 전부 가능)
   ├─ ③ API 연동 준비상태 (플랫폼당 1) — 자격증명
   ├─ ④ 설정 (플랫폼당 1) — 카테고리·등급 등 콘솔 config
   ├─ 5-2 국가별 메타 (locale×1세트) — title/short/full desc. 디폴트 en 하나면 전세계 OK. 히스토리는 보너스
   ├─ 5-3 자산 (1세트) — 아이콘·스크린샷·스플래시. 히스토리는 보너스
   ├─ ⑧ IAP → 상품(N) — 상품별 {현재 상태(실황), 내용(가격·국가별 문안), 히스토리}
   │    · 히스토리: 스토어에 이력 API 없음 → ZTO가 pull마다 스냅샷 저장해 이력 생성
   ├─ ⑨ [Android 한정] 클로즈드 테스트 요건 — {요구 여부, 시작 여부, 통과 여부}
   │    · 요구 여부 = 개인 신규 계정 성격(자가보고) / 시작 = tracks API로 closed 트랙 릴리스 존재 유추 ✅
   │    · 통과(프로덕션 접근 승인) = API 없음 → 콘솔 확인(L2)/수동 체크
   └─ 5-1 버전 (무한 가지)
      ├─ ⑥ 릴리스 노트 (버전당 1)
      └─ ⑦ 상태 (버전당 1: internal→closed→open→in review→prod→outdated)
```

**핵심 원리**: "불"은 수동 체크가 아니라 **스토어 실황 pull로 자동 점등**. API 커버리지: ③⑧ 구현됨 / 5-1·⑥·⑦ = Play tracks·ASC appStoreVersions 읽기 가능 / 5-2 = 양쪽 R/W / 5-3 = Play R/W·ASC 스크린샷 R/W(아이콘은 빌드 소속) / ④ = ASC 읽기 가능·Play는 콘솔(L2).

**UI**: 앱 선택 → 대시보드 = 아이콘+이름 헤더, Android/iOS 두 컬럼 트리, 노드별 상태 라이트(🟢 스토어 확인 / ⚪ 미설정 / 🟡 로컬≠스토어), 버전은 상태 배지 있는 타임라인, 노드 클릭 = 상세·편집 or 콘솔 바로가기.

**단계**: P1 읽기 전용(버전·상태·릴리스노트·메타 pull → 점등) → P2 편집·diff·push → P3 자산 push·버전 생성·제출. 스크린샷 "멋지게"(디바이스 프레임·캐치프레이즈 합성)는 P3+.

## 5. 로드맵

1. **v0 (이 문서)**: 지식 고정. ✅
2. **v1 — ZTO 모듈 1로 흡수 (§6)**: 스크립트 이관(✅ 1차) + 출시 위저드(§7.3) + 답안 시트 포맷(✅). 다음 신규 앱 런칭을 이전 대비 1/5 시간으로. 첫 실전 검증은 다음 신규 앱 IAP/런칭 때.

## 6. ZTO — Zero to One (2026-07-21, Dan 확정)

**서비스명 `ZTO` (Zero to One, 표기 `zto` 소문자 가능)** — "아무것도 없는 0에서 앱이 세상에 나가 첫 팬을 만나는 1까지"의 전 과정을 담는 **Electron 데스크톱 앱 (mac/windows)**. 스토어 런칭 자동화(이 문서 §0~4)는 그중 모듈 1.
알려진 이름 충돌: ZTO Express(중국 물류사, NYSE) — 개인 툴이라 무방, 검색·도메인만 유의.

### 6.1 모듈 5개 (Dan 요구, 2026-07-21 원문 순서)

| # | 모듈 | 내용 | 비고 |
|---|---|---|---|
| 1 | **첫 출시 작업** | 양대 스토어 앱 최초 생성·설정·자산·제출 자동화 | 이 문서 §0~4가 명세. L1 스크립트 검증 완료 |
| 2 | **계정 인벤토리** | 다양한 계정(Gmail 등) 목록 + 계정별 특징·용도 설명. **비밀번호는 우리 서비스에 저장하지 않는다** — OS 키체인(Electron safeStorage → 맥 Keychain/윈 Credential Manager)이나 사용자의 비밀번호 관리자에 안전 저장되도록 안내·연동 | 저장하는 건 메타데이터(용도·복구경로·연결 서비스)만 |
| 3 | **소셜 매트릭스** | 계정→소셜미디어 프로필 / 소셜미디어→내 계정, 양방향 한눈 뷰 + 가져올 수 있는 메트릭은 다 가져오기 | Postiz 채널 연동·분석 재활용 (§6.2) |
| 4 | **브랜딩 발행** | 글 올리기 전 대화 → 본인 스타일을 **pre-context prompt로 영속 저장** → 계속 같은 목소리로 브랜딩 | 페르소나별 프롬프트 = 답안 시트와 같은 SSOT 패턴 |
| 5 | **Postiz 활용** | 아래 §6.2 | |

### 6.2 Postiz 조사 결과 (2026-07-21, github.com/gitroomhq/postiz-app)

- **AGPL-3.0** · 33.6k★ · 활발(최신 v2.21.10, 2026-06). Next.js+NestJS+Prisma+PostgreSQL+Temporal, 셀프호스트 가능.
- 커버: 14개 플랫폼 OAuth 연동(X·Instagram·YouTube·TikTok·Threads·LinkedIn·Reddit·Bluesky·Mastodon 등)·스케줄 발행·분석·API(N8N/Zapier).
- 미커버(ZTO 고유): 모듈 1(스토어), 모듈 2(계정 인벤토리·키체인), 모듈 3의 "루트 계정별 묶음" 뷰, 모듈 4의 개인 브랜딩 pre-context.
- **라이선스 전략**: 코드를 ZTO에 복사하면 앱 전체 AGPL(소스 공개 의무). → **로컬 셀프호스트로 띄우고 API로 연동** = 의무 없이 그대로 활용. 14개 플랫폼 OAuth 유지보수를 통째로 아웃소싱하는 효과. 배포·판매 전환 시에도 안전.

### 6.3 아키텍처 스케치

```
zto/  (Electron, mac/win — 워크스페이스 독립 프로젝트)
├─ 모듈1 launch/   : 이 문서 §4 구조 이관 (answers/, scripts/google|apple|assets/)
├─ 모듈2 accounts/ : 계정 메타 저장(로컬) + safeStorage/키체인 연동 (비번 비저장 원칙)
├─ 모듈3+5 social/ : 로컬 Postiz(docker) API 클라이언트 — 채널·발행·메트릭 + 계정별 묶음 뷰
└─ 모듈4 brand/    : 페르소나 pre-context 저장 + 발행 전 Claude 대화 → Postiz로 발행
```

### 6.4 다음 단계

- [ ] `zto/` 프로젝트 생성 (자체 CLAUDE.md + 워크스페이스 루트 표에 한 줄) — 이 문서 이관·링크
- [x] Electron 뼈대 (electron-vite + React + TS — 2026-07-21 확정, 07-22 완료)

## 7. v1 스코프 결정 (2026-07-21, Dan 인터뷰 기반)

### 7.1 인터뷰 요지 (원문 답변 3개)

1. **계정 증식 패턴**: Threads·X 운영 중. 기존 계정이 "언어학습" 성격으로 굳어 새 브랜드용으로 둘 다 새로 팠음. 이 패턴(프로젝트/브랜드마다 계정 신설)은 앞으로도 반복될 것. 니즈의 정체 = 발행 자동화가 아니라 **계정 라이프사이클 관리**.
2. **"1"의 정의**: 첫 팬을 만나는 1 = **커뮤니티 입소문으로 디스트리뷰션이 도는 순간**. 커뮤니티 시딩은 사람이 맥락 맞춰 쓰는 게 생명 → 자동 발행 도구 가치 낮음.
3. **핵심 고통**: "구글 계정이 많다는 사실 자체가 마음의 짐" — 기능 요구가 아닌 감정 요구. 해법 = 전 계정 한눈 파악 + 존재 이유 기록 + 신규 등록 10초. 부담의 정체는 계정 수가 아니라 *파악 안 됨*.

### 7.2 결정

| 모듈 | v1 판정 | 근거 |
|---|---|---|
| **2 계정 인벤토리** | ✅ **v1 심장** | 현재 진행형 고통. 계정↔소셜 프로필 매핑(구 모듈 3의 절반)을 메타데이터로 흡수 |
| **1 앱 출시 준비** | ✅ v1 | 실행 검증 완료된 API 부품 보유 |
| 3 소셜 매트릭스 | ⏸ 매핑 뷰만 모듈 2에 흡수 | 메트릭 자동 수집은 보류 |
| 4 브랜딩 발행 | ⏸ 보류 | ~~계정 메타 "페르소나 노트" 필드~~ → **2026-07-31 Dan: 만들지 않는다.** 소셜 AI 패널의 pre-context 페르소나로 충분하고, 계정별로 목소리를 갈라 저장할 만큼 계정이 나뉘지 않는다 |
| 5 Postiz | ⏸ **보류** | 현재 2플랫폼 + 커뮤니티 중심 전략에선 Temporal+Postgres 상시 구동 비용 > 가치. **재논의 조건: 실사용 발행 플랫폼 ≥3 또는 수동 발행 반복 고통 체감 시** |

### 7.3 추가 결정 (2026-07-22, Dan)

- **모듈 1 명칭 변경**: "첫 출시" → **"앱 출시 준비"**. 작업 우선순위도 모듈 1 먼저 (스크립트 이관부터), 모듈 2가 그다음.
- **비밀번호 정책 확정**: "기기에서만, 네트워크 없이, 보여주고 버리기" 모델. **(계정, 앱) 쌍 단위로 저장** (2026-07-22 Dan — "비번 꺼내오는 건 앱마다").
  - 등록 시 1회 입력 → safeStorage 암호화. **암호화 키는 OS 키체인**(맥 Keychain / 윈 DPAPI), 암호문은 `userData/zto-secrets.json`(계정 파일과 분리). 계정 데이터 파일에는 비밀번호 필드 자체가 없다.
  - 조회 시 Touch ID(맥) 관문 → 표시/복사 → 메모리 즉시 폐기. 클립보드 복사 시 30초 자동 클리어.
  - **2FA 필수 정책 (2026-07-22 Dan)**: 생체인증 불가 기기(Touch ID 미지원 포함)에서는 조회 자체 거부 — "미지원이면 통과" 구멍 제거. 승인 시 **30분 잠금 해제 세션** (재인증 없이 사용), 단 **화면 잠금·잠자기 시 즉시 세션 무효화**(powerMonitor). **전부 구현됨 (2026-07-22)**: 보기(평문 표시)는 세션 무시하고 항상 재인증 / 복사만 30분 세션 / "보안" 패널(계정 인벤토리) = 처리 방식 전면 공개 + 실시간 상태(Touch ID·잠금 세션·저장 개수) + 즉시 잠금 버튼 + 접근·변경 로그(성공·거부 모두, 로컬 500건). 투명성 원칙: 로컬 단일 사용자 앱이라 전면 공개가 순이익 (Kerckhoffs — 방식의 비밀에 기대지 않는다). 암호문 파일 경로는 패널에서 제외(가치 0, UI 소음 — Dan).
  - **쓰기 보호 (2026-07-22 Dan Q에서 도출)**: 첫 저장 = 무인증(기존 비밀 안 건드림, 등록 마찰 최소), **변경·삭제 = 인증 필요**(파괴적 — 덮어쓰면 진짜 비밀번호 유실). 삭제는 UI 2단 확인. 저장/변경/삭제 전부 접근 로그에 기록 = 수정 히스토리.
  - 전 과정 로컬 — ZTO는 서버 없는 로컬 앱이라 네트워크 전송 자체가 없음.
  - ⚠️ 한계 명시: 타 앱이 저장한 비번(iCloud 키체인·Chrome)은 OS가 앱 간 접근을 차단하므로 **가져오기 불가**. 1Password는 공식 CLI(`op`)로 연동 가능(선택).
  - **"기기 안내" 모드 추가 (2026-07-22 Dan)**: 기기에 이미 저장돼 있다고 믿고, 앱별로 [Chrome]/[암호 앱] 버튼 → 검색어(대표 도메인, `PLATFORM_DOMAINS`)를 클립보드 복사 + 해당 관리자 창 열기 (`open -a "Google Chrome" chrome://password-manager/passwords` / `open -a Passwords` — 실기기 검증). 검색어 주입 딥링크는 양쪽 다 없음 → 복사+열기가 최선. ZTO 로컬 저장(+비밀번호)은 옵션으로 공존. 이 구조 덕에 타기기 동기화 문제는 기기 관리자(이미 동기화됨)에 위임됨 — 암호화 백업(A안)은 로컬 저장 사용자용 후순위 백로그.
  - **Windows 분기 (미구현)**: Windows엔 시스템 암호 앱이 없음 — 웹 비밀번호는 브라우저 소관. [Chrome] 버튼은 동일 동작, "암호 앱" 버튼은 [Edge](`edge://wallet/passwords`)로 치환, Edge 없으면 자격 증명 관리자(`control /name Microsoft.CredentialManager`) 폴백. Windows 빌드 시 구현.
- **모듈 2 추가 니즈**: 계정 신규 생성을 ZTO가 대행 또는 가이드 — Google 등은 봇 차단으로 완전 자동화가 불가/위험하므로 **생성 체크리스트 + 반자동(Claude in Chrome) 가이드** 방식이 현실적. 백로그에 등재.
- **모듈 1 실행 주체(구 D2)**: 스크립트는 "인자 받고 JSON 뱉는 순수 CLI"로 이관 — Electron 버튼과 Claude 세션 양쪽에서 호출 가능한 혼합(C)안. L2(콘솔 폼)는 Claude in Chrome 전담.
- **모듈 1은 위저드형 플로우다 (2026-07-22, Dan)**: 스크립트 모음이 아니라 단계별 플로우. **출발점은 "개발자 계정조차 없는 0"** — 1단계에서 Play Console($25 일회성)·Apple Developer Program($99/년) 보유를 확인하고, 없으면 등록 절차(비용·신분증 인증·개인 신규 계정의 클로즈드 테스트 의무 등 함정 포함)를 안내한다. 계정 존재는 API로 확인 불가(자격증명이 없는 게 전제) → 자가보고 + 가이드, 상태는 로컬 저장(`userData/zto-state.json`). 개발자 계정은 앱이 아니라 사용자/브랜드 소유이므로 답안 시트가 아닌 전역 상태. **"있음" 선택 시 소유 이메일을 그 자리에서 입력받아 모듈 2 계정 인벤토리에 자동 등록·연동한다 (2026-07-22 Dan — 모듈 1→2 첫 데이터 연동).** 계정 저장소는 `userData/zto-accounts.json` (메타데이터만, 비밀번호 필드 없음). 이후 **IAP 여부는 플로우 중간에 사용자가 선택**하고, Yes를 고르면 필요한 자격증명(Google SA·ASC App Manager 키 등)을 자동 점검 → **미보유 시 발급 과정을 ZTO가 안내·수행**한다(키 발급은 콘솔 작업이라 가이드+L2, 결과 경로·ID는 답안 시트에 기록). 전제조건 준비까지가 ZTO 스코프. **개별 앱의 콘텐츠(상품 가격·문안 등)와 특정 앱 관련 정보는 각 앱 프로젝트 소관 — ZTO 문서·코드에 두지 않는다 (2026-07-22).**

### 7.4 스코프 제외 (명시)

- **엔게이지먼트 자동화(상호 좋아요·리포스트 봇)**: X·Meta 규정상 조작적 행위 → 연결 계정 일괄 정지 리스크. 여러 브랜드 계정의 *관리 부담 제거*까지가 ZTO 책임, 상호작용 자동화는 하지 않는다.

