import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { BrowserState } from '../../../../shared/browser-types'
import { PLATFORMS, PLATFORM_DOMAINS } from '../../../../shared/launch-types'
import { PlatformIcon, platformTint, PLATFORM_NAMES } from '../../platform-icons'
import { useI18n } from '../../i18n'

// #4 ZTO 자체 브라우저의 렌더러 부품 — 재사용(소셜미디어 관리 / 후에 앱스토어 콘솔 싱크).
// WebContentsView는 main이 소유해 이 '구멍'(surface) 위에 얹힌다. 시작 상태(about:blank)일 땐 뷰를
// 0×0으로 접어 숨기고 스피드다이얼(내 소셜 계정 바로가기)을 노출한다 — 뷰가 React 위를 덮기 때문.
const SOCIAL_IDS = new Set(PLATFORMS.filter((p) => p.category === 'social').map((p) => p.id))
const isStartUrl = (s: BrowserState | null): boolean => !s || !s.url || s.url === 'about:blank'

export default function BrowserSurface(): React.JSX.Element {
  const { m } = useI18n()
  const surfaceRef = useRef<HTMLDivElement | null>(null)
  const inputRef = useRef<HTMLInputElement | null>(null)
  const stateRef = useRef<BrowserState | null>(null)
  const [state, setState] = useState<BrowserState | null>(null)
  const [addr, setAddr] = useState('')
  const [shortcuts, setShortcuts] = useState<string[]>([])

  // 내가 보유한 계정들의 소셜미디어를 모아 바로가기로 (계정 인벤토리 apps 중 social 카테고리, dedupe)
  useEffect(() => {
    window.zto.accounts.list().then((accts) => {
      const seen: string[] = []
      for (const a of accts) {
        for (const app of a.apps ?? []) {
          if (SOCIAL_IDS.has(app) && !seen.includes(app)) seen.push(app)
        }
      }
      setShortcuts(seen)
    })
  }, [])

  // 시작 상태면 뷰를 0×0으로 접어 스피드다이얼이 보이게, 아니면 surface 사각형에 맞춘다
  const applyView = useCallback((first: boolean): void => {
    const el = surfaceRef.current
    if (!el) return
    const r = el.getBoundingClientRect()
    const b = isStartUrl(stateRef.current)
      ? { x: r.left, y: r.top, width: 0, height: 0 }
      : { x: r.left, y: r.top, width: r.width, height: r.height }
    if (first) window.zto.browser.attach(b)
    else window.zto.browser.setBounds(b)
  }, [])

  useLayoutEffect(() => {
    applyView(true)
    const unsub = window.zto.browser.onState((s) => {
      stateRef.current = s
      setState(s)
      setAddr((cur) => (document.activeElement === inputRef.current ? cur : s.url))
      applyView(false)
    })
    const onResize = (): void => applyView(false)
    const ro = new ResizeObserver(onResize)
    if (surfaceRef.current) ro.observe(surfaceRef.current)
    window.addEventListener('resize', onResize)
    return () => {
      unsub()
      ro.disconnect()
      window.removeEventListener('resize', onResize)
      window.zto.browser.detach()
    }
  }, [applyView])

  const go = (): void => {
    if (addr.trim()) window.zto.browser.navigate(addr.trim())
  }
  const openShortcut = (id: string): void => {
    const domain = PLATFORM_DOMAINS[id]
    if (domain) window.zto.browser.navigate('https://' + domain)
  }

  const showStart = isStartUrl(state)
  const tabLabel = (t: { title: string; url: string }): string =>
    t.title || (t.url && t.url !== 'about:blank' ? t.url.replace(/^https?:\/\//, '') : m.browser.newTab)

  return (
    <div className="browser-col">
      {state && state.tabs.length > 0 && (
        <div className="browser-tabs">
          {state.tabs.map((t) => (
            <div
              key={t.id}
              className={`br-tab ${t.id === state.activeId ? 'active' : ''}`}
              onClick={() => window.zto.browser.selectTab(t.id)}
              title={tabLabel(t)}
            >
              <span className="br-tab-title">{tabLabel(t)}</span>
              <button
                className="br-tab-close"
                onClick={(e) => {
                  e.stopPropagation()
                  window.zto.browser.closeTab(t.id)
                }}
              >
                ✕
              </button>
            </div>
          ))}
          <button className="br-tab-add" onClick={() => window.zto.browser.newTab()} title={m.browser.newTabTitle}>
            +
          </button>
        </div>
      )}
      <div className="browser-bar">
        <button className="br-nav" onClick={() => window.zto.browser.back()} disabled={!state?.canGoBack} title={m.browser.back}>
          ‹
        </button>
        <button className="br-nav" onClick={() => window.zto.browser.forward()} disabled={!state?.canGoForward} title={m.browser.forward}>
          ›
        </button>
        <button className="br-nav" onClick={() => window.zto.browser.reload()} title={m.browser.reload}>
          {state?.loading ? '×' : '⟳'}
        </button>
        <input
          ref={inputRef}
          className="email-input br-url"
          value={addr}
          placeholder={m.browser.urlPlaceholder}
          onChange={(e) => setAddr(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && go()}
        />
        <button className="choice small active" onClick={go}>
          {m.browser.go}
        </button>
      </div>
      {/* WebContentsView가 이 위에 얹힌다 — 시작 상태(뷰 0×0)일 때만 아래 스피드다이얼이 보인다 */}
      <div ref={surfaceRef} className="browser-surface">
        {showStart &&
          (shortcuts.length > 0 ? (
            <div className="speed-dial">
              <div className="speed-grid">
                {shortcuts.map((id) => (
                  <button key={id} className="speed-tile" onClick={() => openShortcut(id)}>
                    <span className="speed-icon" style={{ background: platformTint(id) }}>
                      <PlatformIcon id={id} size={30} />
                    </span>
                    <span className="speed-name">{PLATFORM_NAMES[id] ?? id}</span>
                  </button>
                ))}
              </div>
            </div>
          ) : (
            <span className="browser-hint">{m.browser.noSocial}</span>
          ))}
      </div>
    </div>
  )
}
