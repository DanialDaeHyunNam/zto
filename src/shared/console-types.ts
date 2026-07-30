// 콘솔 브라우저 오케스트레이션 공유 타입 (main ↔ preload ↔ renderer).
// main 파일에서 직접 import하면 preload가 속한 web 프로젝트가 main 전체를 끌어와 컴파일이 깨진다.

// ---------- Play 데이터 안전 (CSV 왕복) ----------
export interface DsOption {
  responseId: string
  label: string
  selected: boolean
}

export interface DsQuestion {
  id: string
  label: string
  requirement: string // REQUIRED | MAYBE_REQUIRED | MULTIPLE_CHOICE | SINGLE_CHOICE | OPTIONAL
  value: string // 질문 자체에 값이 있는 경우(true/false/URL 등)
  options: DsOption[]
  answered: boolean
}

export interface DataSafetyDoc {
  at: string
  rows: number
  questions: DsQuestion[]
  answeredCount: number
}

// ---------- 라이브 폼 정찰(form-probe) ----------
// main/form-probe.ts가 이 타입들을 재수출한다. 여기 두는 이유는 위와 같다 —
// 정찰 결과가 preload를 거쳐 렌더러까지 가야 하는데 main 모듈은 그 경로에 못 낀다.
export interface ProbedOption {
  label: string
  value: string
  checked: boolean
}

export interface ProbedControl {
  kind: string // radio | radiogroup | checkbox | textbox | combobox | select | input …
  label: string // 사람이 보는 질문 문구 (aria-label → <label> → 가까운 제목 순)
  name: string // name/id/aria 식별자 (있으면)
  value: string // 현재 값 (텍스트/선택)
  checked: boolean | null
  options: ProbedOption[] // radiogroup·select의 선택지
  selector: string // 되짚어 찾아갈 선택자 후보
  path: string // 조상 섹션 제목들 — 문항이 어느 묶음에 속하는지
}

export interface ProbedLink {
  text: string
  href: string
}

export interface FormProbe {
  url: string
  title: string
  at: string
  headings: string[]
  links: ProbedLink[] // 콘솔 내비게이션 — 폼 페이지를 스스로 찾기 위한 지도
  controls: ProbedControl[]
  counts: Record<string, number>
}

// ---------- 폼 따라가기 (콘솔 코파일럿) ----------
// 진짜 콘솔 폼 옆에서 AI가 거드는 구조. 사람이 콘솔에서 고르면 그걸 감지해 대화가 한 칸 나아간다.
// **AI에 원문을 밀어 넣지 않는다** — 2026-07-24에 "텍스트 자동읽기는 토큰 부담"으로 폐기했고,
// 그 판단은 지금도 유효하다. 대신 form-probe가 뽑은 **구조**(문항·선택지·현재값)만 보낸다.
// 폼 하나가 컨트롤 20개 안팎이라 원문의 수십분의 일이고, "뭐가 안 채워졌나"가 그대로 드러난다.
export interface WatchedControl {
  kind: string
  label: string
  value: string // 현재 값(선택된 옵션 라벨 포함)
  answered: boolean
  options: string[] // 고를 수 있는 것들 — AI가 "이 중에 뭘 고르라"고 말하려면 필요하다
}

export interface FormSnapshot {
  url: string
  title: string
  controls: WatchedControl[]
  answered: number
  total: number
}

export interface FormChange {
  snapshot: FormSnapshot
  navigated: boolean // 페이지가 바뀐 것인지, 같은 화면에서 값만 바뀐 것인지
  changed: string[] // 사람이 읽는 변경 요약 ("폭력 → 가끔·약함")
}

// ---------- 앱 콘텐츠 선언 정찰 ----------
// 콘텐츠 등급(IARC)·타깃 연령 등은 데이터 안전과 달리 **공식 CSV가 없다**(2026-07-30).
// 그래서 DOM 경로이고, 콘솔 개정에 약하다 → 먼저 폼 구조를 회수해 매핑 가능성을 판단한다.
export interface AppContentForm {
  slug: string // app-content/{slug} — 화면 링크에서 수확한 값(조립하지 않는다)
  label: string // 링크 텍스트(사람이 읽는 이름)
  url: string
  reached: boolean // 도착 검증 통과 여부 — 없는 경로는 홈으로 조용히 리다이렉트된다
  title: string
  // 컨트롤 0개일 때 '위저드 뒤에 문항이 있다'와 '안 그려졌다'를 가르는 값
  textLen: number
  headings: string[]
  counts: Record<string, number>
  controls: ProbedControl[]
}

export interface AppContentProbeDoc {
  at: string
  packageName: string
  consoleBase: string
  forms: AppContentForm[]
}

// ---------- 가져오기 진행 단계 ----------
export type PullStep =
  | 'opening'
  | 'login-required'
  | 'needs-user' // 자동화가 못 하는 한 걸음을 사람에게 넘기고 기다리는 중
  | 'finding-app'
  | 'opening-form'
  | 'exporting'
  | 'probing' // 폼 구조 회수 중 (detail = 지금 읽는 폼 이름)
  | 'parsing'
  | 'done'
  | 'failed'

export interface PullResult {
  ok: boolean
  step: PullStep
  doc?: DataSafetyDoc
  consoleBase?: string // .../developers/{dev}/app/{appId} — 다음부터 직행하려고 기억해둔다
  formUrl?: string // 실패 시 사람이 이어받을 자리
  error?: string
}
