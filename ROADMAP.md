# ZTO 로드맵 (실행 순서 + 비전)

> 이 문서 = "지금 뭘 어떤 순서로 짓고 있나"의 단일 소스. 완료 체크리스트는 `CLAUDE.md 현황`, 세션 서사는 `.omniscitus/history/`, 데이터 모델 SSOT는 `SPEC.md`.
> 원칙: 어차피 다 한다 — 순서대로 하나씩, 기록하며. (2026-07-23 Dan)

## 관통하는 아키텍처 결정 (2026-07-23)

- **AI는 교체 가능한 두뇌, 브라우저는 ZTO 소유의 손.** 둘을 분리한다.
- **AI provider = BYO 2방식**: ① 구독(로컬 CLI 스폰 — Claude=`claude`, ChatGPT=`codex`) / ② API 키(OS 키체인 암호화 저장 + 직접 호출). 설정에서 provider·방식 선택. 키·글은 네트워크 안 탐(로컬 원칙).
- **브라우저 자동화 = ZTO 자체 소유.** Electron 자체가 Chromium이므로 `BrowserView`/`webview`를 임베드하고 `webContents.debugger`(CDP)·`executeJavaScript`로 직접 제어. 외부 Chrome·gstack 플러그인·특정 LLM 환경에 의존하지 않는다 → 포터블. 이 **한 기반이 L2 콘솔 폼 자동입력과 소셜 코파일럿 양쪽**에 쓰인다.
- **업데이트 = ZTO 자체 릴리스**(electron-updater + 릴리스 채널). gstack 등 외부를 좇지 않는다. 스토어 설문 등 데이터 변동은 질문 JSON만 갱신(앱 업데이트 또는 데이터-only 페치).

## 소셜 코파일럿 비전 (모듈 3/4, 미리 준비) — Dan 원문 2026-07-23

> 중앙에 **실제 브라우저를 렌더** → x·threads 등 유저가 관리하는 사이트로 바로 클릭해 들어가고, **로그인은 유저가 직접**. 우측에 **AI 패널** — 물어가며, **멀티모달**이라 필요하면 첨부 이미지 넣어가며 글도 같이 정제하고 댓글도 준비. 위 브라우저 기반(BrowserView+CDP) + AI provider로 실현.

---

## 실행 순서 (순차)

### 1. AI provider 설정 — 🔨 거의 완료 (ai:chat만 남음, #2와 함께)
- [x] 설정 페이지 + 사이드바 하단 "설정" 진입 + 언어 이동 (2026-07-23)
- [x] Claude 구독 방식 — 로컬 `claude` CLI 감지(`--version`)·모델 선택(Fable/Opus/Sonnet/Haiku)
- [x] **provider 토글 `[구독 | API 키]`** — Claude·ChatGPT 둘 다 (2026-07-23). active provider 선택 + 모델 선택
- [x] ChatGPT 구독 = `codex` CLI 감지(claude와 대칭, 미감지 안내), Gemini는 API 키 전용
- [x] API 키 모드 = 키체인(safeStorage) 저장 `zto-ai-keys.json`(암호문만)·삭제. `ai:setKey`/`hasKey`. 실측 앱 환경서 저장·삭제 검증
- [ ] `ai:chat` — provider 추상화한 한 턴 실행(구독=CLI spawn `-p --resume` / 키=Anthropic·OpenAI API). **#2 팝오버에서 첫 소비 → 거기서 구현**

### 2. 앱 콘텐츠 설문 위저드 (콘솔 전용 L2 설정) — 🔨 결정형 코어 완료
- [x] 결정형 위저드 — 질문 세트 **버전 관리 JSON**(`launch/questionnaires/`). 파일럿 = ASC 연령 등급(14문항, ageRatingDeclaration 필드명 그대로 → 후에 API 자동 적용까지). `launch:questionnaire`/`getConsoleAnswers`/`setConsoleAnswers` (2026-07-23)
- [x] 답 → 시트 `console_answers[id]`(version·answers·completedAt) 저장, iOS 설정 노드에 "앱 콘텐츠 설문 ✓ 작성됨" + 콘솔 딥링크. 실측 앱 검증(14문항 저장·완료·재로드)
- [x] 질문별 "?" 도움(현재 help 텍스트) — 팝오버 자리 마련됨
- [ ] **질문별 AI 팝오버** — "?"를 대화형으로: 깨끗한 새 대화처럼 보이나 위저드 세션의 이전 답을 숨은 컨텍스트로 공유, 답을 이끌어 위저드로 되돌림 (Dan). **여기서 `ai:chat` 첫 구현**(구독=CLI spawn `-p --resume` / 키=API)
- [ ] 나머지 설문 인코딩: Play(콘텐츠 등급 IARC·데이터 보안·타깃 연령) / ASC(앱 개인정보). Android 설정 노드에도 버튼

### 3. 적용 실제 API 연결 (P2 편집 — 메타부터)
- [ ] `launch:applyEdits` 실제 write: Play는 한 edit에 묶어 `listings.patch`→`commit`(원자적) / ASC는 `appStoreVersionLocalizations`·`appInfoLocalizations` PATCH(개별). 결과 항목별 보고 → 성공분 재-pull
- [ ] IAP·자산 편집도 같은 `stage()` 인프라에 연결

### 4. ZTO 자체 브라우저 자동화 (공용 기반)
- [ ] Electron `BrowserView`/`webview` 임베드 + `webContents.debugger`(CDP)·`executeJavaScript` 제어 래퍼
- [ ] L2 콘솔 폼 자동입력(설문·데이터 안전 등)에 우선 적용

### 5. to-do board (적용 오케스트레이션)
- [ ] "수정 적용하기" → 대기 항목을 **API 되는 것 / 브라우저 필요한 것**으로 분리해 태스크 보드 렌더
- [ ] 위→아래 진행: 진행전 → 진행중 → 완료/에러(에러부터 재시도 — 위까진 성공 보존)
- [ ] 브라우저 태스크: ① ZTO 자체 CDP+AI 자동 시도 → ② 실패 시 유저 수동 + 체크박스(상태 수정)

### 6. 소셜 코파일럿 (모듈 3/4)
- [ ] 중앙 임베드 브라우저(x·threads 등, 유저 직접 로그인) + 우측 AI 패널(멀티모달·이미지 첨부)
- [ ] 글 정제·댓글 준비 워크플로. #4 브라우저 기반 + #1 AI provider 사용

### 7. 앱 자동 업데이트
- [ ] electron-updater + 릴리스 채널(GitHub Releases 등), 업데이트 확인·다운로드·재시작
- [ ] 질문 데이터(설문 JSON) 갱신 경로

---

## 기타 백로그 (순서 무관, 위 진행 중 흡수)
- 대시보드 설정 항목 자동 점등(L2 콘솔 읽기) — API 없는 등급·데이터보안·타깃연령
- listings/images/스크린샷 push 스크립트, ASC `iap-upsert.js`
- 시트 편집 UI(IAP 상품 정의 폼), 콘솔 답안(L2) 시트 표준화
- 계정 인벤토리 잔여(SPEC): 페르소나 노트·복구경로, 이메일 편집, 소셜 프로필 심화, 암호화 백업
- Windows 분기(암호 관리자 [Edge] 치환 등)
