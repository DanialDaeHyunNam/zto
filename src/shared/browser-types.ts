// #4 ZTO 자체 브라우저 — main ↔ preload ↔ renderer 공유 타입

// 렌더러가 예약한 '구멍'(placeholder)의 사각형 — WebContentsView를 여기에 얹는다 (CSS px = 콘텐츠 영역 기준)
export interface BrowserBounds {
  x: number
  y: number
  width: number
  height: number
}

// 탭 하나 — 각 탭이 자체 WebContentsView를 가진다 (main 소유)
export interface BrowserTab {
  id: string
  title: string
  url: string
  loading: boolean
}

// 렌더러로 통지하는 브라우저 상태. url·title·loading·canGo*는 '활성 탭' 기준(기존 소비자 호환).
export interface BrowserState {
  tabs: BrowserTab[]
  activeId: string | null
  url: string
  title: string
  canGoBack: boolean
  canGoForward: boolean
  loading: boolean
}

// eval/cdp/navigate 공통 결과
export interface BrowserResult {
  ok: boolean
  result?: unknown
  error?: string
}
