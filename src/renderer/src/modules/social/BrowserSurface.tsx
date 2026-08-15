import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { BrowserState } from '../../../../shared/browser-types'
import { PLATFORMS, PLATFORM_DOMAINS } from '../../../../shared/launch-types'
import { PlatformIcon, platformTint, PLATFORM_NAMES } from '../../platform-icons'
import { useI18n } from '../../i18n'

// #4 ZTO 자체 브라우저의 렌더러 부품 — 재사용(소셜미디어 관리 / 후에 앱스토어 콘솔 싱크).
// WebContentsView는 main이 소유해 이 '구멍'(surface) 위에 얹힌다. 시작 상태(about:blank)일 땐 뷰를
// 0×0으로 접어 숨기고 스피드다이얼(내 소셜 계정 바로가기)을 노출한다 — 뷰가 React 위를 덮기 때문.
const SOCIAL_IDS = new Set(PLATFORMS.filter((p) => p.category === 'social').map((p) => p.id))
// 맥은 ⌥, 그 외는 Alt — main은 alt 플래그 하나로 받으므로 표기만 갈린다
const TAB_KEY = window.zto.platform === 'darwin' ? '⌥' : 'Alt+'
const isStartUrl = (s: BrowserState | null): boolean => !s || !s.url || s.url === 'about:blank'

// 툴바는 **쓰는 곳에 따라 다르다**. 폼 읽기·콘솔 지도는 콘솔 폼을 겨냥한 물건이라
// 소셜 페이지에선 아무것도 못 잡는다(TikTok에서 실측) — 거기선 화면을 통째로 AI에게
// 넘기는 버튼이 훨씬 쓸모 있다. 기본은 콘솔(기존 호출부 불변).
export default function BrowserSurface({
  mode = 'console',
  onSendToAi,
  highlight
}: {
  mode?: 'console' | 'social'
  onSendToAi?: (kind: 'text' | 'html') => void
  // AI가 요청한 버튼을 빛나게 — 채팅의 안내 문장과 눌러야 할 자리를 잇는다
  highlight?: 'text' | 'html' | null
} = {}): React.JSX.Element {
  const { m } = useI18n()
  const surfaceRef = useRef<HTMLDivElement | null>(null)
  const inputRef = useRef<HTMLInputElement | null>(null)
  const stateRef = useRef<BrowserState | null>(null)
  const [state, setState] = useState<BrowserState | null>(null)
  const [addr, setAddr] = useState('')
  const [shortcuts, setShortcuts] = useState<string[]>([])
  const [dragId, setDragId] = useState<string | null>(null) // 끌고 있는 탭
  const [overIdx, setOverIdx] = useState<number | null>(null) // 놓일 자리
  const [probeMsg, setProbeMsg] = useState('') // 폼 읽기 결과 알림

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
    // mode가 곧 방이다 — 콘솔과 소셜은 탭 세트를 공유하지 않는다(2026-08-14 Dan)
    if (first) window.zto.browser.attach(b, mode)
    else window.zto.browser.setBounds(b)
  }, [mode])

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

  // reverse-sync 1단계 — 현재 페이지의 폼을 읽어 JSON으로. 결과 개수만 인라인으로 알린다
  // (전문은 userData/zto-form-probe.json — 매핑 설계는 그 파일을 보고 한다).
  const probe = async (): Promise<void> => {
    setProbeMsg('…')
    const r = await window.zto.browser.probeForm()
    if (r.ok) {
      const n = (r.result as { controls?: unknown[] })?.controls?.length ?? 0
      setProbeMsg(m.browser.probeDone.replace('{n}', String(n)))
    } else {
      setProbeMsg(m.browser.probeFail.replace('{e}', r.error ?? ''))
    }
  }
  // 발견 단계 — 콘솔 섹션 순회(20초쯤). 끝나면 원래 보던 페이지로 돌아온다.
  const crawl = async (): Promise<void> => {
    setProbeMsg('…')
    const r = await window.zto.browser.crawlConsole()
    if (r.ok) {
      const n = (r.result as { sections?: number })?.sections ?? 0
      setProbeMsg(m.browser.crawlDone.replace('{n}', String(n)))
    } else {
      setProbeMsg(m.browser.probeFail.replace('{e}', r.error ?? ''))
    }
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
          {state.tabs.map((t, i) => (
            <div
              key={t.id}
              className={`br-tab ${t.id === state.activeId ? 'active' : ''}${
                dragId === t.id ? ' dragging' : ''
              }${overIdx === i && dragId && dragId !== t.id ? ' drop-target' : ''}`}
              onClick={() => window.zto.browser.selectTab(t.id)}
              title={tabLabel(t)}
              draggable
              onDragStart={(e) => {
                setDragId(t.id)
                e.dataTransfer.effectAllowed = 'move'
                // 파이어폭스 등은 데이터가 없으면 드래그를 시작하지 않는다
                e.dataTransfer.setData('text/plain', t.id)
              }}
              onDragOver={(e) => {
                if (!dragId) return
                e.preventDefault() // 기본값은 '드롭 불가' — 막아야 놓을 수 있다
                e.dataTransfer.dropEffect = 'move'
                setOverIdx(i)
              }}
              onDrop={(e) => {
                e.preventDefault()
                if (dragId && dragId !== t.id) window.zto.browser.moveTab(dragId, i)
                setDragId(null)
                setOverIdx(null)
              }}
              onDragEnd={() => {
                setDragId(null)
                setOverIdx(null)
              }}
            >
              {/* ⌘1..9 — 어느 탭이 몇 번인지 한눈에. 순서를 바꾸면 번호도 따라온다 */}
              {i < 9 && <span className="br-tab-key">{TAB_KEY}{i + 1}</span>}
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
        {mode === 'social' ? (
          <>
            {/* 크롤링이 막히거나 글이 구조를 잃는 사이트를 위해, 화면을 그대로 오른쪽 AI에게 넘긴다 */}
            <button
              className={`ghost-btn ${highlight === 'text' ? 'wanted' : ''}`}
              onClick={() => onSendToAi?.('text')}
              title={m.browser.sendTextTitle}
            >
              {m.browser.sendText}
            </button>
            <button
              className={`ghost-btn ${highlight === 'html' ? 'wanted' : ''}`}
              onClick={() => onSendToAi?.('html')}
              title={m.browser.sendHtmlTitle}
            >
              {m.browser.sendHtml}
            </button>
          </>
        ) : (
          <>
            {/* reverse-sync 1단계 — 현재 페이지 폼을 구조화 JSON으로 회수 (ROADMAP #4) */}
            <button className="ghost-btn" onClick={probe} title={m.browser.probeFormTitle}>
              {m.browser.probeForm}
            </button>
            {/* 발견 단계 — 콘솔 섹션을 순회하며 실제 링크 수확 */}
            <button className="ghost-btn" onClick={crawl} title={m.browser.crawlTitle}>
              {m.browser.crawlConsole}
            </button>
          </>
        )}
        <button className="choice small active" onClick={go}>
          {m.browser.go}
        </button>
      </div>
      {probeMsg && (
        <div className="br-probe-msg" onClick={() => setProbeMsg('')}>
          {probeMsg}
        </div>
      )}
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
