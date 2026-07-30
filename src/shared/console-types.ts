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

// ---------- 가져오기 진행 단계 ----------
export type PullStep =
  | 'opening'
  | 'login-required'
  | 'needs-user' // 자동화가 못 하는 한 걸음을 사람에게 넘기고 기다리는 중
  | 'finding-app'
  | 'opening-form'
  | 'exporting'
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
