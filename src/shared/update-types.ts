// 렌더러가 보는 업데이트 상태 (main의 updater.ts와 모양을 맞춘다)
export type UpdatePhase = 'idle' | 'checking' | 'available' | 'downloading' | 'ready' | 'error'

export interface UpdateStatus {
  phase: UpdatePhase
  version: string
  newVersion?: string
  percent?: number
  error?: string
  disabled?: boolean // 개발 빌드 등 — 업데이트를 확인할 수 없는 상태
}
