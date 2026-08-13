// ---------- #4 ZTO 자체 브라우저 (공용 기반) ----------
// Electron 자체가 Chromium이므로 WebContentsView를 임베드하고 executeJavaScript·CDP로 직접 제어한다.
// 외부 Chrome·플러그인에 의존하지 않는다(포터블). 이 한 기반이 두 곳에 쓰인다:
//   ① L2 콘솔 폼 — 라이브 폼을 '읽어' 우리 JSON으로 거꾸로 싱크(reverse-sync) + 답을 폼에 채우기
//   ② 소셜 코파일럿 — 유저가 직접 로그인한 x·threads 위에서 AI가 글·댓글을 도움
// 탭: 각 탭이 자체 WebContentsView. 활성 탭만 창에 붙인다. ⌘T 새 탭 / ⌘1..9 전환 / ⌘W 닫기.
import {
  app,
  session,
  WebContentsView,
  ipcMain,
  type BrowserWindow,
  type WebContents
} from 'electron'
import { mkdirSync, writeFileSync } from 'fs'
import { join } from 'path'
import type { BrowserBounds as Bounds, BrowserState, BrowserResult } from '../shared/browser-types'
import { EXPAND_JS, FORM_PROBE_JS, type FormProbe } from './form-probe'
import type { FormChange, FormSnapshot, WatchedControl } from '../shared/console-types'

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

// Play 콘솔 앱 레벨 섹션 — 추측이 아니라 사이드바에서 실제로 긁어온 경로들(2026-07-29).
// 각 섹션에 '들어가야' 하위 메뉴가 렌더되므로, 순회하며 하위 링크를 수확한다.
//
// ⚠️ 이 목록을 처음엔 '한 번 본 사이드바'로 만들었다가 "Policy and programs" 섹션을 통째로
// 놓쳤다. 그 섹션은 접혀 있었고, EXPAND_JS가 페이지 이탈을 막으려고 <a href> 안의 토글을
// 제외해서 펴지지도 않았다 — 안전장치가 발견을 막은 사례. 앱 콘텐츠 선언(데이터 안전·
// 콘텐츠 등급 등)이 전부 그 아래 있어서 한참 헤맸다.
// 또 하나: `app-content` 단독은 존재하지 않는 라우트라 홈으로 조용히 리다이렉트된다.
// 실제 경로는 `app-content/overview` — 부분 경로를 추측하면 안 된다는 증거.
const CONSOLE_SECTIONS = [
  'app-dashboard',
  'publishing',
  'test-and-release',
  'grow-overview',
  'monetize',
  'monitor',
  'protect-with-play',
  'statistics',
  // Policy and programs — 앱 콘텐츠 선언이 사는 곳
  'policy-center',
  'app-content/overview',
  'teacher-approved'
]

// ---------- 다운로드 가로채기 ----------
// 평소엔 브라우저 기본 동작(사용자 다운로드 폴더)을 건드리지 않는다 — 사용자가 직접 받는 파일까지
// 우리 폴더로 빼돌리면 "어디 갔지?"가 된다. ZTO가 스스로 받아 읽어야 할 때만(예: 데이터 안전
// Export to CSV) expectDownload()로 예약해 userData/downloads에 정해진 이름으로 받는다.
let pendingDownload: {
  target: string
  resolve: (p: string) => void
  reject: (e: Error) => void
  timer: NodeJS.Timeout
} | null = null

export function expectDownload(name: string, timeoutMs = 60_000): Promise<string> {
  const dir = join(app.getPath('userData'), 'downloads')
  try {
    mkdirSync(dir, { recursive: true })
  } catch {
    /* 이미 있으면 무시 */
  }
  const target = join(dir, name)
  return new Promise<string>((resolve, reject) => {
    if (pendingDownload) clearTimeout(pendingDownload.timer) // 앞선 예약은 버린다
    const timer = setTimeout(() => {
      pendingDownload = null
      reject(new Error('download-timeout'))
    }, timeoutMs)
    pendingDownload = { target, resolve, reject, timer }
  })
}

let downloadsWired = false
function wireDownloads(): void {
  if (downloadsWired) return
  downloadsWired = true
  session.defaultSession.on('will-download', (_e, item) => {
    const p = pendingDownload
    if (!p) return // 예약이 없으면 평소대로 (사용자 다운로드 폴더 + 저장 대화상자)
    pendingDownload = null
    item.setSavePath(p.target)
    item.once('done', (_ev, state) => {
      clearTimeout(p.timer)
      if (state === 'completed') p.resolve(p.target)
      else p.reject(new Error('download-' + state))
    })
  })
}

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
    // 편집 단축키를 **뷰에 직접** 건다. 앱 메뉴의 role은 '포커스된 webContents'에 작용하는데,
    // 임베드 뷰는 클릭해도 포커스를 못 받는 경우가 있어 ⌘C가 렌더러(빈 선택)로 새어나갔다.
    // 여기서 처리하면 뷰가 키를 받는 그 순간에 뷰 자신에게 실행된다(2026-08-13 실사용 발견).
    if (k === 'c') {
      event.preventDefault()
      wc.copy()
    } else if (k === 'v') {
      event.preventDefault()
      wc.paste()
    } else if (k === 'x') {
      event.preventDefault()
      wc.cut()
    } else if (k === 'a') {
      event.preventDefault()
      wc.selectAll()
    } else if (k === 't') {
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
  // 팝업은 진짜 창으로 연다. 같은 탭에 로드해버리면 두 가지가 동시에 깨진다:
  // ① window.opener가 없어 결과를 돌려줄 상대가 사라지고 ② 결과를 받을 원래 페이지도 navigate돼 없어진다.
  // 구글 GSI(accounts.google.com/gsi/select)에서 흰 화면으로 굳는 것으로 실증(2026-07-29).
  // 콘솔 로그인(Play·ASC)이 통과했던 건 그쪽이 전체 페이지 리다이렉트라 opener가 필요 없어서였다.
  wc.setWindowOpenHandler(({ url }) => {
    if (!app.isPackaged) console.log('[popup] request', url)
    if (!/^https?:\/\//i.test(url)) return { action: 'deny' } // 외부 스킴은 열지 않는다
    const parent = getWin()
    return {
      action: 'allow',
      overrideBrowserWindowOptions: {
        width: 520,
        height: 680,
        // 부모에 물려 스택 순서를 유지 (모달은 아님 — 로그인이 막히면 그냥 닫을 수 있어야 한다)
        parent: parent && !parent.isDestroyed() ? parent : undefined,
        autoHideMenuBar: true,
        backgroundColor: '#ffffff' // 로그인 페이지는 흰 캔버스를 전제한다(탭과 같은 이유)
      }
    }
  })
  // 세션은 기본 세션을 공유하므로 팝업에서 로그인해도 탭 쪽에 그대로 반영된다.
  wc.on('did-create-window', (win, details) => {
    win.setMenuBarVisibility(false)
    // 팝업엔 주소창이 없다 — 안에서 터지면 **창 제목 말고는 단서가 0**이다(구글 로그인
    // "Use another account"가 400으로 떨어지는데 어느 URL인지 볼 수 없었다, 2026-08-08).
    // 그래서 여기서만 흐름을 찍는다. **dev 전용** — 로그인 URL 쿼리에는 토큰이 실릴 수 있어
    // 패키징 빌드의 stdout(시스템 로그로 샐 수 있는 곳)에는 내보내지 않는다.
    if (app.isPackaged) return
    const pwc = win.webContents
    console.log('[popup] open', details.disposition, details.postBody ? '(POST)' : '(GET)', details.url)
    // UA에 Electron이 실려 구글이 축소 플로우를 내리는지 확인하는 용도 (2026-07-27 실증의 후속)
    console.log('[popup] ua', pwc.getUserAgent())
    pwc.on('did-navigate', (_e, url, code, status) => console.log('[popup] nav', code, status, url))
    pwc.on('did-fail-load', (_e, code, desc, url) => console.log('[popup] fail', code, desc, url))
    pwc.on('page-title-updated', (_e, title) => console.log('[popup] title', title))
  })
  // 보이지 않는 뷰는 Chromium이 렌더링·타이머를 스로틀해서 무거운 SPA가 부트스트랩을 못 끝낸다
  // (Play 콘솔이 앵커 0개·본문 49자로 멈춤, 2026-07-30 실측). 자동화가 화면 뒤에서도 돌아야 하므로 끈다.
  wc.setBackgroundThrottling(false)
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
    // 키보드 포커스를 뷰로 넘긴다 — 안 하면 ⌘C·타이핑이 뒤의 렌더러로 간다
    try {
      a.view.webContents.focus()
    } catch {
      /* 파괴 직후면 무시 */
    }
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

// ---------- 폼 따라가기 (콘솔 코파일럿) ----------
// 사람이 진짜 콘솔 폼에서 고르면 그걸 감지해 렌더러(AI 패널)에 흘린다.
//
// **주입이 아니라 폴링이다.** MutationObserver를 페이지에 심는 쪽이 더 정확해 보이지만,
// 주입한 스크립트는 내비게이션마다 날아간다(오늘 차단막에서 겪었다 — 이동할 때마다 다시 씌워야 했다).
// 위저드는 단계마다 라우팅이 걸리므로 재주입 관리가 통째로 붙는다. 폴링은 그 문제가 없고,
// form-probe는 DOM 질의 몇 번이라 1.5초 간격이면 비용이 무시할 수준이다.
//
// 그리고 **바뀐 것만** 올린다 — 매번 전체를 보내면 AI 토큰이 그대로 새어 나간다.
let watchTimer: NodeJS.Timeout | null = null
let watchSig = '' // 직전 스냅샷의 지문 (값이 같으면 아무것도 안 보낸다)
let watchUrl = ''

const compactControls = (probe: FormProbe): WatchedControl[] =>
  probe.controls
    .filter((c) => c.label) // 라벨 없는 건 사람에게도 AI에게도 의미가 없다
    .slice(0, 120)
    .map((c) => ({
      kind: c.kind,
      label: c.label.slice(0, 120),
      value: c.value.slice(0, 120),
      answered: !!c.value || c.checked === true,
      options: c.options.map((o) => o.label.slice(0, 60)).slice(0, 12)
    }))

function stopWatch(): void {
  if (watchTimer) clearInterval(watchTimer)
  watchTimer = null
  watchSig = ''
  watchUrl = ''
}

function startWatch(): void {
  stopWatch()
  watchTimer = setInterval(() => {
    void (async () => {
      const wc = activeWc()
      const w = getWin()
      if (!wc || !w || w.isDestroyed()) return
      let probe: FormProbe
      try {
        probe = (await wc.executeJavaScript(FORM_PROBE_JS, true)) as FormProbe
      } catch {
        return // 이동 중이면 실패한다 — 다음 틱에 다시 본다
      }
      const controls = compactControls(probe)
      const sig = JSON.stringify(controls.map((c) => [c.label, c.value, c.answered]))
      if (sig === watchSig) return
      // 무엇이 달라졌는지 사람이 읽는 문장으로 — AI에도 이 줄만 보내면 된다
      const before = new Map<string, string>(
        (JSON.parse(watchSig || '[]') as [string, string, boolean][]).map((r) => [r[0], r[1]])
      )
      const navigated = probe.url !== watchUrl
      const changed = navigated
        ? []
        : controls
            .filter((c) => before.has(c.label) && before.get(c.label) !== c.value)
            .map((c) => `${c.label} → ${c.value || '(비움)'}`)
            .slice(0, 12)
      watchSig = sig
      watchUrl = probe.url
      const snapshot: FormSnapshot = {
        url: probe.url,
        title: probe.title,
        controls,
        answered: controls.filter((c) => c.answered).length,
        total: controls.length
      }
      const payload: FormChange = { snapshot, navigated, changed }
      w.webContents.send('browser:formChanged', payload)
    })()
  }, 1500)
}

// ---------- 자동화 전용 탭 ----------
// 자동화는 **자기 탭에서 돈다** — 사용자가 보던 탭을 가로채지 않고, 끝나면 그 탭으로 돌려놓는다.
//
// ⚠️ **화면에 붙여야 한다(2026-07-30 실측).** 창에 붙이지 않고 돌려봤더니 Play 콘솔이
// `no-developer-id (a=0, text=49)`로 죽었다 — 문서 §8이 "페이지가 아예 실행되지 않았다"로
// 분류해둔 바로 그 신호다. `setBackgroundThrottling(false)`는 **창에 붙은 뷰가 가려졌을 때**의
// 스로틀만 막는다. 아예 붙지 않은 뷰는 컴포지터가 없어 렌더 자체가 돌지 않으므로 무거운 SPA는
// 부팅을 못 끝낸다. 문서 §4의 두 처방 중 "띄운다"가 실제로 값을 하고 있었다.
export function openAutomationTab(): {
  wc: WebContents
  reveal: () => void
  dispose: () => void
} {
  const restore = activeId // 끝나면 사용자가 보던 탭으로 돌려놓는다
  const t = makeTab()
  tabs.push(t)
  activeId = t.id
  showActive()
  emit()
  return {
    wc: t.view.webContents,
    // 핸드오프용 — 도중에 사용자가 다른 탭으로 옮겼어도 다시 앞으로 가져온다
    reveal: (): void => {
      if (activeId === t.id) return
      activeId = t.id
      showActive()
      emit()
    },
    dispose: (): void => {
      if (activeId === t.id && restore && tabs.some((x) => x.id === restore)) activeId = restore
      closeTab(t.id)
    }
  }
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

// 탭 순서 바꾸기 — 배열 자체를 옮긴다. ⌘1..9가 인덱스 기준이라 이래야
// 화면에 보이는 순서와 단축키 번호가 어긋나지 않는다(뷰는 활성 탭만 붙으므로 순서와 무관).
export function moveTab(id: string, toIndex: number): void {
  const from = tabs.findIndex((t) => t.id === id)
  if (from < 0) return
  const to = Math.max(0, Math.min(tabs.length - 1, toIndex))
  if (from === to) return
  const [moved] = tabs.splice(from, 1)
  tabs.splice(to, 0, moved)
  emit()
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
  wireDownloads()

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
  ipcMain.handle('browser:moveTab', (_e, id: string, toIndex: number): void => moveTab(id, toIndex))

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

  // 폼 따라가기 on/off — 코파일럿 화면이 켜질 때만 돈다(안 볼 때 폴링할 이유가 없다)
  ipcMain.handle('browser:watchForm', (_e, on: boolean): boolean => {
    if (on) startWatch()
    else stopWatch()
    return on
  })

  // 지금 화면의 **글**을 읽어온다. 폼 프로브(FORM_PROBE_JS)는 콘솔 폼 컨트롤을 세는 물건이라
  // 소셜 페이지에선 아무것도 못 읽는다 — TikTok에서 AI가 "영상 내용을 볼 수 없다"고 답한 이유다
  // (2026-08-13 실사용). 주기적으로 긁지 않고 **사용자가 물을 때만** 부른다: 토큰도 아끼고,
  // "읽는다"는 약속이 토글에 정확히 대응한다.
  ipcMain.handle('browser:pageText', async (): Promise<BrowserResult> => {
    const wc = activeWc()
    if (!wc) return { ok: false, error: 'no-view' }
    try {
      const r = (await wc.executeJavaScript(
        `(() => ({
          url: location.href,
          title: document.title,
          text: (document.body?.innerText || '').replace(/\n{3,}/g, '\n\n').slice(0, 8000)
        }))()`,
        true
      )) as { url: string; title: string; text: string }
      return { ok: true, result: r }
    } catch (e) {
      return { ok: false, error: String(e).slice(0, 300) }
    }
  })

  // reverse-sync 1단계 — 현재 페이지의 폼을 읽어 구조화 JSON으로 회수한다(ROADMAP #4).
  // 결과를 userData/zto-form-probe.json에도 남긴다: 콘솔 폼은 로그인 뒤에 있어 밖에서 볼 수 없고,
  // 매핑 설계를 하려면 실제 DOM 구조를 파일로 꺼내 봐야 하기 때문.
  ipcMain.handle('browser:probeForm', async (): Promise<BrowserResult> => {
    const wc = activeWc()
    if (!wc) return { ok: false, error: 'no-view' }
    try {
      const probe = (await wc.executeJavaScript(FORM_PROBE_JS, true)) as FormProbe
      try {
        writeFileSync(
          join(app.getPath('userData'), 'zto-form-probe.json'),
          JSON.stringify(probe, null, 2)
        )
      } catch {
        /* 파일 저장 실패가 회수 자체를 막지는 않는다 */
      }
      return { ok: true, result: probe }
    } catch (e) {
      return { ok: false, error: String(e).slice(0, 300) }
    }
  })

  // reverse-sync '발견' 단계 — Play 콘솔의 앱 레벨 섹션을 순회하며 링크·폼을 수확해 지도를 만든다.
  // 왜 필요한가: 콘솔은 같은 성격의 설정이 여러 섹션에 흩어져 있고(보안·출시·스토어표기),
  // 사이드바는 접혀 있으면 하위 링크가 DOM에 없으며, 없는 경로는 404가 아니라 홈으로 조용히
  // 리다이렉트된다 — 즉 사람이든 AI든 '기억한 경로'로 찾아가면 반드시 틀린다(2026-07-29 실측 4회).
  // 그래서 한 번 훑어 지도를 만들고, 그 지도의 실제 href로만 이동한다.
  ipcMain.handle('browser:crawlConsole', async (): Promise<BrowserResult> => {
    const wc = activeWc()
    if (!wc) return { ok: false, error: 'no-view' }
    const start = wc.getURL()
    const base = start.match(/^(https:\/\/play\.google\.com\/console\/u\/\d+\/developers\/\d+\/app\/\d+)\//)
    if (!base) return { ok: false, error: 'not-on-play-console-app-page' }

    const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
    const pages: unknown[] = []
    // 큐는 순회하면서 자란다 — `app-content/overview`에 도착하면 **그 페이지의 링크에서**
    // 하위 선언 폼(콘텐츠 등급·타깃 연령·광고·앱 액세스…) 경로를 수확해 뒤에 붙인다.
    // 슬러그를 기억으로 적지 않는 이유가 여기서도 같다: `app-content` 단독이 존재하지 않았듯
    // 하위 경로도 추측하면 조용히 홈으로 튕긴다. 화면이 알려주는 href만 따라간다.
    const queue = [...CONSOLE_SECTIONS]
    const queued = new Set(queue)
    // 상한은 폭주 방지용 — 앱 콘텐츠 선언은 보통 10여 개라 넉넉하다
    for (let qi = 0; qi < queue.length && qi < 40; qi++) {
      const section = queue[qi]
      const url = `${base[1]}/${section}`
      try {
        await wc.loadURL(url)
        await wait(1800) // Angular 렌더 대기 — 로드 완료 직후엔 아직 메뉴가 비어 있다
        // 접힌 메뉴를 펼친다. 한 번 펼치면 그 안에서 또 접힌 게 드러나므로 반복(렌더 대기 포함).
        for (let round = 0; round < 3; round++) {
          const opened = (await wc.executeJavaScript(EXPAND_JS, true)) as number
          if (!opened) break
          await wait(700)
        }
        const probe = (await wc.executeJavaScript(FORM_PROBE_JS, true)) as FormProbe
        pages.push({
          section,
          requested: url,
          landed: probe.url, // 요청과 다르면 리다이렉트된 것 — 그 섹션은 존재하지 않는다
          redirected: !probe.url.includes(`/${section}`),
          title: probe.title,
          counts: probe.counts,
          headings: probe.headings.slice(0, 20),
          links: probe.links,
          // 폼 컨트롤까지 싣는다 — 지도는 '어디에 있나'만이 아니라 '무엇을 묻나'까지 답해야
          // 설문 매핑을 설계할 수 있다. 링크만 있던 1차 지도로는 그 판단을 못 했다.
          controls: probe.controls
        })
        for (const l of probe.links) {
          // 같은 앱의 app-content 하위만 — 다른 앱·개발자 페이지로 새면 순회가 폭주한다
          const sub = l.href.match(/\/app\/\d+\/(app-content\/[A-Za-z0-9._-]+)(?:[/?#]|$)/)
          if (sub && !queued.has(sub[1])) {
            queued.add(sub[1])
            queue.push(sub[1])
          }
        }
      } catch (e) {
        pages.push({ section, requested: url, error: String(e).slice(0, 200) })
      }
    }
    try {
      await wc.loadURL(start) // 원래 보던 화면으로 돌려놓는다
    } catch {
      /* 돌아가기 실패는 치명적이지 않다 */
    }
    try {
      writeFileSync(
        join(app.getPath('userData'), 'zto-console-map.json'),
        JSON.stringify({ base: base[1], at: new Date().toISOString(), pages }, null, 2)
      )
    } catch {
      /* 무시 */
    }
    return { ok: true, result: { sections: pages.length } }
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
