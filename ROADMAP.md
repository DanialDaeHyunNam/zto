# ZTO 로드맵 (실행 순서 + 비전)

> 이 문서 = "지금 뭘 어떤 순서로 짓고 있나"의 단일 소스. 완료 체크리스트는 `CLAUDE.md 현황`, 세션 서사는 `.omniscitus/history/`, 데이터 모델 SSOT는 `SPEC.md`.
> 원칙: 어차피 다 한다 — 순서대로 하나씩, 기록하며. (2026-07-23 Dan)

## 관통하는 아키텍처 결정 (2026-07-23)

- **AI는 교체 가능한 두뇌, 브라우저는 ZTO 소유의 손.** 둘을 분리한다.
- **AI provider = BYO 2방식**: ① 구독(로컬 CLI 스폰 — Claude=`claude`, ChatGPT=`codex`) / ② API 키(OS 키체인 암호화 저장 + 직접 호출). 설정에서 provider·방식 선택. 키·글은 네트워크 안 탐(로컬 원칙).
- **브라우저 자동화 = ZTO 자체 소유.** Electron 자체가 Chromium이므로 `WebContentsView`를 임베드하고(Electron 43, `BrowserView`는 deprecated) `executeJavaScript`·`webContents.debugger`(CDP)로 직접 제어. 외부 Chrome·gstack 플러그인·특정 LLM 환경에 의존하지 않는다 → 포터블. 이 **한 기반이 L2 콘솔 폼 자동입력과 소셜 코파일럿 양쪽**에 쓰인다.
  - **로그인 = ZTO 안에서 1회, 세션은 ZTO 소유(A안 확정 2026-07-24 Dan).** Chromium이지만 Google Chrome이 아니라 저장소가 격리됨 — 크롬 프로필·쿠키·비번을 승계하지 않는다. 퍼시스턴트 세션이라 서비스당 한 번만 로그인하면 유지. **실증 완료(2026-07-27)** — Play 콘솔·ASC 양쪽 실제 로그인 통과. 구글의 임베드 브라우저 차단(`disallowed_useragent`)이 우려됐으나 **강등까지만**이었다: UA에 `Electron/43.1.1`이 실려 나가면 축소 플로우(`flowName=WebLiteSignIn`, 정상 브라우저는 `GlifWebSignIn`)를 받지만 인증 자체는 막히지 않는다. 두 요청의 차이가 이 토큰 하나뿐임을 실측으로 확인 — 즉 **UA에서 Electron 토큰을 지우면 완전 플로우를 받지만, 구글의 임베드 브라우저 정책을 UA로 우회하는 회색지대라 하지 않는다**(막히지 않았으므로 할 이유도 없음). 이 판단은 구글이 정책을 조이면 재검토 대상. **크롬 쿠키 임포트(B안)는 기각** — Keychain 암호화 복호화·크롬 프로세스 잠금·버전 취약성 + 비번은 SPEC §7.3(타 앱 저장 비번 읽기 불가)와 충돌. 포터블성·보안이 1회 로그인보다 값짐.
- **콘솔 폼은 "미러링"이 아니라 "reverse-sync" (2026-07-23 Dan 확정).** 설문은 JSON으로 두어 depth를 유연하게 관리하되(콘솔 폼 복제가 SSOT가 아님), **진실은 라이브 콘솔 화면**이다. ZTO 브라우저가 실제 폼을 *읽어* 우리 JSON 구조로 거꾸로 싱크한다 → 애플·구글이 폼을 개정해도 우리가 조사·재인코딩으로 쫓는 게 아니라 **화면을 다시 읽어 싱크**하면 흡수된다. 핵심 프리미티브 = `browser:eval`(페이지에서 JS 실행→값 회수)이 곧 싱크의 최소 단위. 손 인코딩 설문(데이터안전·앱개인정보 요지)은 이 싱크 전까지의 얇은 다리.
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
- [x] `ai:chat` — Claude 구독 경로 구현(`claude -p --output-format json --model --resume`, is_error 전달). 실측 앱 환경서 대화·resume·추천 파싱 검증 (2026-07-23). codex 구독·API 키 경로는 잔여

### 2. 앱 콘텐츠 설문 위저드 (콘솔 전용 L2 설정) — 🔨 결정형 코어 완료
- [x] 결정형 위저드 — 질문 세트 **버전 관리 JSON**(`launch/questionnaires/`). 파일럿 = ASC 연령 등급(14문항, ageRatingDeclaration 필드명 그대로 → 후에 API 자동 적용까지). `launch:questionnaire`/`getConsoleAnswers`/`setConsoleAnswers` (2026-07-23)
- [x] 답 → 시트 `console_answers[id]`(version·answers·completedAt) 저장, iOS 설정 노드에 "앱 콘텐츠 설문 ✓ 작성됨" + 콘솔 딥링크. 실측 앱 검증(14문항 저장·완료·재로드)
- [x] 질문별 "?" 도움(현재 help 텍스트) — 팝오버 자리 마련됨
- [x] **질문별 AI 팝오버** (2026-07-23) — "?" → 대화 팝오버(`QuestionHelp`): 숨은 컨텍스트(설문·현재 질문·선택지·이미 답한 것)를 첫 턴에 주입, resume로 이어감, 답변 끝 `추천: <옵션id>` 파싱 → "이 답으로 설정" 한 번에 위저드 반영. 실측 앱 실검증(도트 SRPG 설명 → INFREQUENT_OR_MILD 추천 → 반영)
- [x] Play 콘텐츠 등급(IARC) 설문 + Android 설정 노드 버튼 (2026-07-23)
- [x] **기존 앱 프리필 비대칭** (2026-07-23) — iOS 연령 등급은 스토어에서 읽힘(`ageRatingDeclaration`, 필드 그대로) → 기존 앱 설문 **자동 프리필**(실측 앱 실검증: 만화폭력·무기=자주·강함 등 15/15). Play는 콘텐츠 등급·데이터안전·타깃연령에 read API 없음 → 프리필 불가, "자동 못 가져옴 + 콘솔 어디서 보는지" 안내로 처리. `launch:ageRatingDeclaration`
- [x] 나머지 설문 인코딩 (2026-07-23) — `play-data-safety`(14문)·`play-target-audience`(6문)·`asc-app-privacy`(12문) JSON 추가(요지, 콘솔 개정 시 파일만 갱신). **설문 N개/플랫폼 일반화**: `launch:questionnaireList`(디렉터리 스캔)→설정 노드가 설문별 라벨 버튼(`SurveyButtons`)로 렌더. iOS 연령 등급만 스토어 프리필, 나머지는 read API 없어 자동조회 불가 안내(문구 provider-중립화 + 콘솔 딥링크). 로컬 저장·재로드 검증
- [ ] codex(ChatGPT 구독)·API 키 경로의 `ai:chat` — 로컬 미검증 환경(codex 미설치·저장 키 없음)이라 보류

### 3. 적용 실제 API 연결 (P2 편집 — 메타부터)
- [x] `launch:applyEdits` 실제 write (2026-07-23, `applyPlayEdits`/`applyAscEdits`) — 플랫폼별 라우팅. **Play**: 리스팅 메타(title·short·full)를 한 edit에 모아 현재 값 read→변경 필드 병합→`listings` PUT→`:commit`(원자적, 하나라도 실패 시 edit 폐기해 전체 롤백). **ASC**: 리소스별 PATCH(부분 성공) — `name·subtitle`→`appInfoLocalizations`(라이브 아닌 appInfo), `description·promotionalText·keywords·whatsNew`→**편집 가능한 상태**(PREPARE_FOR_SUBMISSION 등, 라이브 READY_FOR_SALE 제외)의 최신 버전 `appStoreVersionLocalizations`. 로케일별 id 재해석 후 같은 로케일 여러 필드는 PATCH 한 번으로 병합. 결과 항목별 `{ok,message}` → 렌더러가 성공분만 대기서 제거 + 재-pull
- [ ] **Android 릴리스 노트 보류** — Play 릴리스 노트는 라이브 트랙 릴리스를 수정해야 해(심사·롤아웃 위험) 이번 단계 제외, 콘솔 안내 메시지 반환. iOS whatsNew는 초안 버전만 편집해 안전하므로 구현됨(비대칭 의도). 후속: 초안/테스트 트랙 릴리스에 한해 안전 편집 허용
- [x] **iOS 버전 생성으로 잠금 해제 (2026-07-24)** — 앱 이름 등 '버전 종속 메타'는 라이브 버전에 못 대 409(current state). 결과 패널이 이 실패를 감지해 **"새 버전 만들어 반영"** 바 노출(제안 버전=최고 버전 패치+1, 애플은 라이브보다 높은 번호만 받음, 수정 가능) → `launch:createIosVersion`(`POST appStoreVersions`)로 새 버전 생성 → 편집 가능해진 뒤 iOS 대기 편집 재-applyEdits → 결과 갱신. 실패 행엔 **콘솔 딥링크**("콘솔에서 수정 →", iOS는 `/apps/{appId}/distribution/info`). **빌드 업로드·제출은 사람이**(빌드=개발자 Xcode 산출물, 제출은 비가역 SPEC §3). 프로모션 텍스트는 버전 무관이라 원래 됨
- [ ] IAP·자산 편집도 같은 `stage()` 인프라에 연결 (같은 `applyEdits` 라우팅에 section 추가)

### 4. ZTO 자체 브라우저 자동화 (공용 기반)
- [x] **뼈대 (2026-07-23, `src/main/browser.ts`)** — `WebContentsView` 임베드(main 소유, 퍼시스턴트 세션이라 유저 로그인 유지). 렌더러가 '구멍'(surface div) 사각형을 보고 → `browser:attach`/`setBounds`로 뷰를 그 위에 얹음, 모듈 이탈 시 `detach`. IPC: `navigate`(스킴 없으면 https·검색어면 구글)·`back`/`forward`/`reload`·`state` 통지(URL바·로딩·뒤로가기 활성)·`eval`(executeJavaScript 값 회수 = **reverse-sync 프리미티브**)·`cdp`(디버거 패스스루, 합성 입력 등 강한 제어 기반). **브라우저는 공용 인프라** — 렌더러 재사용 부품 `BrowserSurface`(툴바+구멍+attach). typecheck·build·실행 검증
- [x] **소셜미디어 관리 모듈 (2026-07-23) — #6의 1차 뼈대** — 사이드바 "브라우저"가 아니라 **"소셜미디어 관리"**(Dan 확정). `SocialPage` = `BrowserSurface`(좌, 유저 직접 로그인) + `AiPanel`(우 360px, active provider로 대화·resume 맥락 유지). 뷰 bounds가 surface 사각형만 따라가 우측 AI 패널은 안 덮임. **시작 화면 스피드다이얼**(2026-07-23): about:blank일 땐 뷰를 0×0으로 접고 **내 소셜 계정 바로가기**를 모바일 홈처럼 아이콘 그리드로(계정 인벤토리 apps 중 social, dedupe · 클릭→navigate). **탭**(2026-07-23): 각 탭이 자체 WebContentsView, 활성 탭만 창에 붙임. **⌘T 새 탭 / ⌘1..9 전환 / ⌘W 닫기**(main `before-input-event`로 페이지·렌더러 포커스 양쪽 캐치) + 탭 바 UI. **AI 멀티모달 입력**(2026-07-23): 텍스트 자동읽기(토큰 부담)는 폐기하고 **이미지 입력**으로 전환. 구독 `claude` CLI가 이미지를 받는지 실증 확인(빨간 이미지→"Red") → `-p --input-format stream-json --output-format stream-json --verbose`로 image content 블록을 stdin에 주입. `ai:chat`이 `images` 있으면 이 stream-json 경로(spawn), 없으면 기존 가벼운 `--output-format json`. 렌더러: **[▣ 화면 캡처]**(`browser:capture`=활성 탭 `capturePage()` → PNG dataURL) + **붙여넣기**(onPaste)로 이미지 첨부, 썸네일·삭제·전송. `browser.eval`(텍스트 읽기)은 API에 남아 reverse-sync용. **다음**: codex·API키 경로 멀티모달
- [x] **앱스토어 관리의 브라우저 UX = 슬라이드-오버 (2026-07-23 Dan 확정, `browser-overlay.tsx`)** — "슬라이딩 캐비닛 속 TV" 은유. 사이드바는 그대로, **콘텐츠 영역(.content 사각형 측정)만 fixed로 덮으며** 브라우저가 우→좌 슬라이드. 문(패널)이 다 열린 뒤에야 `BrowserSurface` 마운트(뷰 attach=TV on), 닫을 땐 역순(뷰 detach→문 닫힘) — WebContentsView가 CSS로 못 움직이는 걸 마운트 게이팅으로 해결. `BrowserOverlayProvider`(context, `useBrowserOverlay().open(url)`)를 App 루트에 두고 모듈 전환 시 자동 닫힘(`closeKey`). 앱스토어 헤더에 [브라우저] 트리거(→ Play 콘솔). 소셜 모듈과 **같은 뷰·`BrowserSurface` 재사용**
- [ ] **reverse-sync 엔진** — 콘솔 폼 페이지에서 `eval`로 필드·선택지·현재값을 긁어 설문 JSON 스키마에 매핑(읽어 싱크). 폼 개정 시 다시 읽어 흡수
- [ ] 폼 채우기 — 설문 답을 콘솔 폼에 입력(CDP 합성 입력으로 사이트 검증 통과). 비가역 제출은 사람 컨펌
- [x] **로그인 실증 + 임베드 렌더링 규칙 (2026-07-27)** — 콘솔 두 곳 실제 로그인 통과(위 A안 실증 참조), reverse-sync 앞 관문 해제. 함께 잡은 두 규칙: ① **임베드 캔버스는 흰색**(`setBackgroundColor('#ffffff')`) — 앱 셸 색(`#0d0d12`)을 깔았더니 배경을 직접 칠하지 않는 영역에 그게 비쳐 어두운 글자가 사라졌다(ASC 앱 목록에서 앱 이름이 안 보임). 웹 페이지는 흰 캔버스를 전제하고 그린다. ② **임베드 페이지는 라이트 모드 고정** — 뷰 단위 CDP `Emulation.setEmulatedMedia`(`prefers-color-scheme: light`), 탭 생성 시 + `did-navigate`마다 재적용. `nativeTheme.themeSource`는 **쓰지 않는다**(앱 창까지 뒤집혀 다크 전용 원칙과 충돌). 부수 이득 = reverse-sync가 읽을 폼과 AI가 캡처할 화면의 테마가 고정돼 변수가 준다. CDP 디버거 연결은 `ensureDebugger()`로 통일(라이트 모드·합성 입력 공용) — `browser:cdp` 경로가 실사용으로 검증된 셈
- [ ] 팝업 로그인(OAuth 새 창)·다중 탭 대응, 뷰 상태 영속 — 현재 `setWindowOpenHandler`가 새 창을 **같은 탭 로드로 치환**(deny). 콘솔 로그인 두 곳은 이걸로 통과했으나 `window.opener` 의존 플로는 미검증

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
