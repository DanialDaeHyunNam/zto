// ---------- #4 ZTO 자체 브라우저 (공용 기반) ----------
// Electron 자체가 Chromium이므로 WebContentsView를 임베드하고 executeJavaScript·CDP로 직접 제어한다.
// 외부 Chrome·플러그인에 의존하지 않는다(포터블). 이 한 기반이 두 곳에 쓰인다:
//   ① L2 콘솔 폼 — 라이브 폼을 '읽어' 우리 JSON으로 거꾸로 싱크(reverse-sync) + 답을 폼에 채우기
//   ② 소셜 코파일럿 — 유저가 직접 로그인한 x·threads 위에서 AI가 글·댓글을 도움
// 탭: 각 탭이 자체 WebContentsView. 활성 탭만 창에 붙인다. ⌘T 새 탭 / ⌘1..9 전환 / ⌘W 닫기.
import { WebContentsView, ipcMain, type BrowserWindow, type WebContents } from 'electron'
import type { BrowserBounds as Bounds, BrowserState, BrowserResult } from '../shared/browser-types'

interface Tab {
  id: string
  view: WebContentsView
}

let tabs: Tab[] = []
let activeId: string | null = null
let attached = false // 활성 뷰가 창에 붙어 있나 (다른 모듈로 나가면 뗀다)
let lastBounds: Bounds | null = null // 렌더러가 보고한 '구멍' 사각형
let winWired = false // 메인 창 webContents에 단축키 바인딩했나
const debugAttached = new Set<string>() // CDP 디버거 연결된 탭 id
let getWin: () => BrowserWindow | null = () => null
let seq = 0

const roundBounds = (b: Bounds): Bounds => ({
  x: Math.round(b.x),
  y: Math.round(b.y),
  width: Math.round(b.width),
  height: Math.round(b.height)
})

const normalizeUrl = (raw: string): string => {
  const s = raw.trim()
  if (!s) return 'about:blank'
  if (/^[a-z]+:\/\//i.test(s) || s === 'about:blank') return s
  if (/^[\w-]+(\.[\w-]+)+(\/.*)?$/.test(s) || s.includes('.')) return 'https://' + s
  return 'https://www.google.com/search?q=' + encodeURIComponent(s)
}

const activeTab = (): Tab | null => tabs.find((t) => t.id === activeId) ?? null
const activeWc = (): WebContents | null => activeTab()?.view.webContents ?? null
const isStartWc = (wc: WebContents): boolean => {
  const u = wc.getURL()
  return !u || u === 'about:blank'
}

function emit(): void {
  const w = getWin()
  if (!w || w.isDestroyed()) return
  const list = tabs.map((t) => ({
    id: t.id,
    title: t.view.webContents.getTitle(),
    url: t.view.webContents.getURL(),
    loading: t.view.webContents.isLoading()
  }))
  const a = activeWc()
  const state: BrowserState = {
    tabs: list,
    activeId,
    url: a?.getURL() ?? '',
    title: a?.getTitle() ?? '',
    loading: a?.isLoading() ?? false,
    canGoBack: a?.navigationHistory.canGoBack() ?? false,
    canGoForward: a?.navigationHistory.canGoForward() ?? false
  }
  w.webContents.send('browser:state', state)
}

// 단축키 — 페이지·렌더러 어디에 포커스가 있든 잡히도록 각 webContents에 바인딩. 브라우저가 보일 때만 동작.
function wireShortcuts(wc: WebContents): void {
  wc.on('before-input-event', (event, input) => {
    if (!attached || input.type !== 'keyDown') return
    if (!(input.meta || input.control)) return
    const k = input.key.toLowerCase()
    if (k === 't') {
      event.preventDefault()
      newTab()
    } else if (k === 'w') {
      event.preventDefault()
      if (activeId) closeTab(activeId)
    } else if (/^[1-9]$/.test(input.key)) {
      event.preventDefault()
      selectIndex(parseInt(input.key, 10) - 1)
    }
  })
}

// CDP 디버거 연결(멱등) — 라이트 모드 강제·합성 입력이 공유한다.
function ensureDebugger(tab: Tab): boolean {
  if (debugAttached.has(tab.id)) return true
  const wc = tab.view.webContents
  try {
    wc.debugger.attach('1.3')
    debugAttached.add(tab.id)
    wc.debugger.on('detach', () => debugAttached.delete(tab.id))
    return true
  } catch {
    return false
  }
}

// 임베드 페이지는 항상 라이트 모드. ZTO 셸(다크 전용)은 건드리지 않는다 —
// nativeTheme.themeSource는 앱 창까지 뒤집으므로 쓰지 않고, 뷰 단위 CDP 에뮬레이션으로 가둔다.
// 이유 ① ASC·Play 콘솔의 다크 렌더링이 깨진다(앱 이름이 어두운 배경에 어두운 글자로 뭉갬, 2026-07-24 실측)
//      ② reverse-sync가 읽을 폼과 AI가 캡처할 화면의 테마가 고정돼 변수가 준다.
function forceLightMode(tab: Tab): void {
  if (!ensureDebugger(tab)) return
  tab.view.webContents.debugger
    .sendCommand('Emulation.setEmulatedMedia', {
      features: [{ name: 'prefers-color-scheme', value: 'light' }]
    })
    .catch(() => {
      /* 실패해도 페이지는 뜬다 — 테마만 사이트 기본값 */
    })
}

function makeTab(): Tab {
  const id = 'tab' + ++seq
  const view = new WebContentsView()
  // 캔버스는 흰색 — 웹 페이지는 흰 배경을 전제하고 그린다. 앱 셸 색(#0d0d12)을 깔면
  // 배경을 직접 칠하지 않는 영역이 그대로 비쳐 어두운 글자가 사라진다(ASC 앱 목록, 2026-07-24 실측).
  view.setBackgroundColor('#ffffff')
  const wc = view.webContents
  wc.setWindowOpenHandler(({ url }) => {
    wc.loadURL(url)
    return { action: 'deny' }
  })
  const tab: Tab = { id, view }
  forceLightMode(tab)
  // 내비게이션마다 재적용 — 오버라이드가 타깃 교체 시 날아가는 경우 대비(멱등).
  wc.on('did-navigate', () => forceLightMode(tab))
  wc.on('did-navigate', emit)
  wc.on('did-navigate-in-page', emit)
  wc.on('page-title-updated', emit)
  wc.on('did-start-loading', emit)
  wc.on('did-stop-loading', emit)
  wireShortcuts(wc)
  return tab
}

// 활성 탭만 창에 붙인다 — 나머지는 뗀다(한 번에 하나만 보임). 활성 뷰 bounds는 lastBounds(시작이면 0×0).
function showActive(): void {
  const w = getWin()
  if (!w || w.isDestroyed()) return
  for (const t of tabs) {
    try {
      w.contentView.removeChildView(t.view)
    } catch {
      /* 안 붙어 있었으면 무시 */
    }
  }
  const a = activeTab()
  if (a) {
    w.contentView.addChildView(a.view)
    if (lastBounds) {
      const b = isStartWc(a.view.webContents)
        ? { x: lastBounds.x, y: lastBounds.y, width: 0, height: 0 }
        : roundBounds(lastBounds)
      a.view.setBounds(b)
    }
    attached = true
  }
}

export function newTab(url?: string): void {
  const t = makeTab()
  tabs.push(t)
  activeId = t.id
  showActive()
  t.view.webContents.loadURL(url ? normalizeUrl(url) : 'about:blank')
  emit()
}

export function selectTab(id: string): void {
  if (!tabs.find((t) => t.id === id)) return
  activeId = id
  showActive()
  emit()
}

export function selectIndex(i: number): void {
  if (i >= 0 && i < tabs.length) selectTab(tabs[i].id)
}

export function closeTab(id: string): void {
  const idx = tabs.findIndex((t) => t.id === id)
  if (idx < 0) return
  const [removed] = tabs.splice(idx, 1)
  const w = getWin()
  try {
    if (w && !w.isDestroyed()) w.contentView.removeChildView(removed.view)
  } catch {
    /* 무시 */
  }
  debugAttached.delete(removed.id)
  try {
    removed.view.webContents.close()
  } catch {
    /* 무시 */
  }
  if (activeId === id) {
    const next = tabs[idx] ?? tabs[idx - 1] ?? null
    if (next) {
      activeId = next.id
    } else {
      // 마지막 탭을 닫으면 빈 탭 하나 유지
      const t = makeTab()
      tabs.push(t)
      activeId = t.id
      t.view.webContents.loadURL('about:blank')
    }
    showActive()
  }
  emit()
}

export function registerBrowserIpc(winGetter: () => BrowserWindow | null): void {
  getWin = winGetter

  ipcMain.handle('browser:attach', (_e, bounds: Bounds): boolean => {
    const w = getWin()
    if (!w) return false
    lastBounds = bounds
    if (!winWired) {
      wireShortcuts(w.webContents)
      winWired = true
    }
    if (tabs.length === 0) {
      const t = makeTab()
      tabs.push(t)
      activeId = t.id
      t.view.webContents.loadURL('about:blank')
    }
    showActive()
    emit()
    return true
  })

  ipcMain.handle('browser:setBounds', (_e, bounds: Bounds): void => {
    lastBounds = bounds
    const a = activeTab()
    if (a && attached) {
      const b = isStartWc(a.view.webContents)
        ? { x: bounds.x, y: bounds.y, width: 0, height: 0 }
        : roundBounds(bounds)
      a.view.setBounds(b)
    }
  })

  ipcMain.handle('browser:detach', (): void => {
    const w = getWin()
    const a = activeTab()
    if (a && w && !w.isDestroyed()) {
      try {
        w.contentView.removeChildView(a.view)
      } catch {
        /* 무시 */
      }
    }
    attached = false
  })

  ipcMain.handle('browser:newTab', (_e, url?: string): void => newTab(url))
  ipcMain.handle('browser:closeTab', (_e, id: string): void => closeTab(id))
  ipcMain.handle('browser:selectTab', (_e, id: string): void => selectTab(id))

  ipcMain.handle('browser:navigate', async (_e, url: string): Promise<BrowserResult> => {
    const wc = activeWc()
    if (!wc) return { ok: false, error: 'no-view' }
    try {
      await wc.loadURL(normalizeUrl(url))
      return { ok: true }
    } catch (e) {
      return { ok: false, error: String(e).slice(0, 200) }
    }
  })

  ipcMain.handle('browser:back', (): void => {
    const h = activeWc()?.navigationHistory
    if (h?.canGoBack()) h.goBack()
  })
  ipcMain.handle('browser:forward', (): void => {
    const h = activeWc()?.navigationHistory
    if (h?.canGoForward()) h.goForward()
  })
  ipcMain.handle('browser:reload', (): void => {
    activeWc()?.reload()
  })

  // 활성 탭 화면 캡처 → PNG data URL. AI 패널에 멀티모달로 첨부(=AI가 보고 있는 화면을 봄).
  ipcMain.handle('browser:capture', async (): Promise<string | null> => {
    const wc = activeWc()
    if (!wc) return null
    try {
      const img = await wc.capturePage()
      return img.isEmpty() ? null : img.toDataURL()
    } catch {
      return null
    }
  })

  // 제어·읽기 증명 — 활성 탭에서 JS 실행해 값 회수. reverse-sync·AI 페이지 컨텍스트의 최소 단위.
  ipcMain.handle('browser:eval', async (_e, js: string): Promise<BrowserResult> => {
    const wc = activeWc()
    if (!wc) return { ok: false, error: 'no-view' }
    try {
      const result = await wc.executeJavaScript(js, true)
      return { ok: true, result }
    } catch (e) {
      return { ok: false, error: String(e).slice(0, 300) }
    }
  })

  // CDP 패스스루 — 합성 입력 등 강한 제어(폼필). 활성 탭 기준.
  ipcMain.handle('browser:cdp', async (_e, method: string, params?: object): Promise<BrowserResult> => {
    const a = activeTab()
    if (!a) return { ok: false, error: 'no-view' }
    const wc = a.view.webContents
    try {
      if (!ensureDebugger(a)) return { ok: false, error: 'debugger-attach-failed' }
      const result = await wc.debugger.sendCommand(method, params ?? {})
      return { ok: true, result }
    } catch (e) {
      return { ok: false, error: String(e).slice(0, 300) }
    }
  })
}
