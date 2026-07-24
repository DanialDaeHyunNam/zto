import { createContext, useContext, useEffect, useLayoutEffect, useState } from 'react'
import BrowserSurface from './modules/social/BrowserSurface'
import { useI18n } from './i18n'

// 앱스토어 관리 등에서 브라우저를 '슬라이딩 캐비닛 속 TV'처럼 불러내는 오버레이.
// 사이드바는 그대로 두고 콘텐츠 영역만 덮는다(= .content 사각형을 측정해 fixed). 문(패널)이 슬라이드로
// 열린 뒤에야 BrowserSurface를 마운트(뷰 attach = TV on), 닫을 땐 역순. 소셜 모듈과 같은 뷰·부품 재사용.

interface OverlayApi {
  open: (url?: string) => void
  close: () => void
  isOpen: boolean
}

const Ctx = createContext<OverlayApi>({ open: () => {}, close: () => {}, isOpen: false })
export const useBrowserOverlay = (): OverlayApi => useContext(Ctx)

export function BrowserOverlayProvider({
  children,
  closeKey
}: {
  children: React.ReactNode
  closeKey?: unknown // 이 값이 바뀌면 오버레이를 닫는다 (모듈 전환 시)
}): React.JSX.Element {
  const [url, setUrl] = useState<string | null>(null) // null = 닫힘

  useEffect(() => {
    setUrl(null)
  }, [closeKey])

  const api: OverlayApi = {
    open: (u) => setUrl(u ?? 'about:blank'),
    close: () => setUrl(null),
    isOpen: url !== null
  }
  return (
    <Ctx.Provider value={api}>
      {children}
      {url !== null && <BrowserOverlay url={url} onClose={() => setUrl(null)} />}
    </Ctx.Provider>
  )
}

type Rect = { top: number; left: number; width: number; height: number }

function BrowserOverlay({ url, onClose }: { url: string; onClose: () => void }): React.JSX.Element {
  const { m } = useI18n()
  const [rect, setRect] = useState<Rect | null>(null)
  const [phase, setPhase] = useState<'opening' | 'shown' | 'closing'>('opening')

  // 콘텐츠 영역(.content) 사각형을 측정 — fixed로 그 위만 덮는다(사이드바 제외)
  useLayoutEffect(() => {
    const measure = (): void => {
      const el = document.querySelector('main.content')
      if (el) {
        const r = el.getBoundingClientRect()
        setRect({ top: r.top, left: r.left, width: r.width, height: r.height })
      }
    }
    measure()
    window.addEventListener('resize', measure)
    return () => window.removeEventListener('resize', measure)
  }, [])

  // 문이 다 열린(shown) 뒤 목표 URL로 이동
  useEffect(() => {
    if (phase === 'shown' && url && url !== 'about:blank') window.zto.browser.navigate(url)
  }, [phase, url])

  const onAnimEnd = (e: React.AnimationEvent): void => {
    if (e.target !== e.currentTarget) return
    if (phase === 'opening') setPhase('shown')
    else if (phase === 'closing') onClose()
  }

  if (!rect) return <></>
  return (
    <div
      className={`browser-overlay ${phase}`}
      style={{ top: rect.top, left: rect.left, width: rect.width, height: rect.height }}
      onAnimationEnd={onAnimEnd}
    >
      <button className="overlay-close" onClick={() => setPhase('closing')} title={m.browser.close}>
        ✕
      </button>
      {/* 슬라이드가 끝나야 뷰를 붙인다(TV on) — 닫힐 땐 먼저 떼고 문을 닫는다 */}
      {phase === 'shown' ? (
        <BrowserSurface />
      ) : (
        <div className="overlay-curtain">{m.browser.opening}</div>
      )}
    </div>
  )
}
