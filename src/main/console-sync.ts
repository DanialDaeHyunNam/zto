// ---------- Play 콘솔 오케스트레이션 (ROADMAP #4) ----------
// "언제 CSV를 내보내야 하나"를 사용자가 판단하게 두지 않는다(Dan 2026-07-29). 버튼 하나로
// 콘솔 열기 → 로그인 확인 → 앱 찾기 → 내보내기 → 파싱까지 ZTO가 대신한다.
//
// 설계 규칙 셋 — 전부 이번 정찰에서 실측으로 얻었다:
//  ① 없는 경로는 404가 아니라 홈으로 조용히 리다이렉트된다 → 이동 후 반드시 도착지를 검증한다
//  ② 미로그인이면 accounts.google.com으로 튕긴다 → 그걸 로그인 감지에 그대로 쓴다
//  ③ 어느 단계가 실패해도 막다른 길이 아니라 사람에게 넘긴다(브라우저를 그 페이지에 열어둔 채)
import { readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { app, type WebContents } from 'electron'
import { expectDownload, openAutomationTab } from './browser'
import { parseDataSafetyCsv } from './data-safety'
import { EXPAND_JS, FORM_PROBE_JS } from './form-probe'

import type {
  AppContentForm,
  AppContentProbeDoc,
  FormProbe,
  PullResult,
  PullStep
} from '../shared/console-types'
export type { PullResult, PullStep } from '../shared/console-types'

const CONSOLE_HOME = 'https://play.google.com/console' // 맨 URL — 리다이렉트로 개발자 id를 얻는다
const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

// 앱 목록에서 (패키지명 → 콘솔 경로)를 찾는다. 이름이 아니라 **패키지명**으로 맞춘다 —
// 이름은 로케일·표기가 흔들리지만 패키지명은 유일하다.
//
// 링크에서 조상으로 내려가며 행 텍스트를 모으는 방식은 실패했다(app-not-found, 2026-07-29):
// 콘솔 앱 목록이 <table>이 아니라 div 더미라 `closest('tr')`이 없고, 몇 단계를 올라가야
// 패키지명이 같은 조상 안에 들어오는지 페이지마다 다르다.
// 그래서 방향을 뒤집는다 — **패키지명이 적힌 요소를 먼저 찾고**, 거기서 위로 올라가며
// 앱 링크를 품은 첫 조상을 잡는다. "가장 가까운 공통 조상"이라 오탐이 없다.
const findAppJs = (packageName: string): string => `(() => {
  const pkg = ${JSON.stringify(packageName)};
  const all = Array.prototype.slice.call(document.querySelectorAll('*'));
  const leaves = all.filter((e) => e.children.length === 0 && (e.textContent || '').indexOf(pkg) >= 0);
  const linkCount = document.querySelectorAll('a[href*="/app/"]').length;
  if (!leaves.length) return { found: false, reason: 'package-text-not-on-page', linkCount: linkCount };
  // ① 패키지명 요소에서 위로 — 공통 조상이 생각보다 높을 수 있다(Angular Material 테이블은
  //    행 하나가 10단계를 훌쩍 넘는다. 10단계로 잘랐다가 link-not-near-package로 실패, 2026-07-30)
  for (const leaf of leaves) {
    let el = leaf;
    for (let i = 0; i < 25 && el && el !== document.body; i++) {
      const a = el.querySelector ? el.querySelector('a[href*="/app/"]') : null;
      if (a) {
        const m = (a.href || '').match(/\\/developers\\/(\\d+)\\/app\\/(\\d+)\\//);
        if (m) return { found: true, dev: m[1], app: m[2], via: 'ancestor' };
      }
      el = el.parentElement;
    }
  }
  // ② 반대 방향 — 각 앱 링크에서 위로 올라가며 조상 텍스트에 패키지명이 있는지 본다.
  //    ①과 대칭이지만 DOM이 비대칭일 때(링크가 별도 컬럼) 이쪽이 걸린다.
  const links = Array.prototype.slice.call(document.querySelectorAll('a[href*="/app/"]'));
  for (const a of links) {
    let el = a.parentElement;
    for (let i = 0; i < 25 && el && el !== document.body; i++) {
      if ((el.textContent || '').indexOf(pkg) >= 0) {
        const m = (a.href || '').match(/\\/developers\\/(\\d+)\\/app\\/(\\d+)\\//);
        if (m) return { found: true, dev: m[1], app: m[2], via: 'link-up' };
      }
      el = el.parentElement;
    }
  }
  return { found: false, reason: 'link-not-near-package', linkCount: linkCount };
})()`

// 개발자 id를 **페이지 링크에서** 읽는다. URL로는 못 얻는다 —
// `play.google.com/console`은 `/console/developers`에서 멈추고 id가 URL에 안 박힌다(2026-07-29 실측,
// 20초 관찰해도 그대로). 반면 화면의 링크에는 `/developers/{id}/...`가 들어 있다.
// 여기서도 규칙은 같다: **경로를 조립하지 말고 화면이 알려주는 값을 쓴다.**
const FIND_DEV_ID_JS = `(() => {
  const hrefs = Array.prototype.slice.call(document.querySelectorAll('a[href*="/developers/"]'))
    .map((a) => a.href || '');
  for (const h of hrefs) {
    const m = h.match(/\\/developers\\/(\\d+)/);
    if (m) return { devId: m[1], links: hrefs.length };
  }
  // 링크가 없을 때 페이지가 '아직 안 그려진 것'인지 '원래 비어 있는 것'인지 구분해야
  // 더 기다릴지 다른 진입점을 쓸지 정할 수 있다 → 본문 길이·전체 링크 수도 같이 올린다.
  return {
    devId: null,
    links: hrefs.length,
    anchors: document.querySelectorAll('a').length,
    textLen: (document.body ? document.body.innerText.length : 0),
    title: document.title,
    url: location.href
  };
})()`

// `/console/developers`는 **"Choose developer account" 선택 화면**이다(2026-07-30 실측).
// 계정 항목이 <a>가 아니라 클릭 요소라 앵커가 0개였고, 사람이면 누르는 자리에서 자동화가 멈춰 있었다.
// 계정이 하나뿐이면 눌러서 통과한다. 계정 이메일 칩(@ 포함)·제목은 후보에서 제외한다.
const PICK_DEVELOPER_JS = `(() => {
  const text = (document.body && document.body.innerText) || '';
  if (!/choose developer account/i.test(text)) return { chooser: false };
  const cands = Array.prototype.slice
    .call(document.querySelectorAll('[role="button"], button, li, a, [role="listitem"]'))
    .filter((e) => {
      const t = (e.textContent || '').replace(/\\s+/g, ' ').trim();
      if (!t || t.length > 60) return false;
      if (/choose developer account/i.test(t)) return false;
      if (/google play console/i.test(t)) return false;
      if (t.indexOf('@') >= 0) return false; // 계정 이메일 칩(계정 전환 드롭다운)
      return true;
    });
  if (!cands.length) return { chooser: true, clicked: false, count: 0 };
  // 계정이 여럿이면 고르는 건 사람의 판단이다 — 자동으로 아무거나 누르지 않는다
  if (cands.length > 1) return { chooser: true, clicked: false, count: cands.length };
  cands[0].click();
  return { chooser: true, clicked: true, count: 1, label: (cands[0].textContent || '').trim().slice(0, 40) };
})()`

// 페이지에 씌우는 레이어는 **차단막 하나뿐**이고, 글자도 하이라이트도 담지 않는다.
//  - 안내 문구: 브라우저 밖(ZTO 안내 바) — 페이지에 띄우면 조작할 자리를 가린다
//  - 스포트라이트: **폐기**(2026-07-30 Dan). "무엇을 눌러야 하는가"를 안정적으로 특정하지 못해
//    엉뚱한 곳(설명 문구·제목)을 밝히는 일이 반복됐다. 틀린 하이라이트는 안내가 아니라 방해다.
//    핸드오프 중에는 페이지를 아예 건드리지 않는다 — 사용자가 평소처럼 쓰면 된다.
const veilJs = (mode: 'block' | 'off'): string => `(() => {
  var ID = 'zto-automation-veil';
  var old = document.getElementById(ID);
  if (old) old.remove();
  if (${JSON.stringify(mode)} === 'off') return { mode: 'off' };
  var d = document.createElement('div');
  d.id = ID;
  d.setAttribute('style', [
    'position:fixed', 'inset:0', 'z-index:2147483647',
    'background:rgba(10,10,15,0.45)', 'backdrop-filter:blur(1px)', 'cursor:progress'
  ].join(';'));
  (document.body || document.documentElement).appendChild(d);
  return { mode: 'block' };
})()`

// 텍스트로 버튼을 찾아 누른다 — 클래스·구조는 개편마다 바뀌지만 라벨은 오래간다.
// ⚠️ **정확히 일치(===)로 하면 안 된다.** 이 콘솔은 머티리얼 아이콘을 폰트 리거처로 렌더해서
// textContent에 아이콘 이름이 섞여 나온다(예: 사이드바가 "arrow_rightdashboardDashboard").
// 그래서 '포함' 매칭을 쓰고, 후보 중 **가장 작은 요소**(= 가장 구체적)를 누른다.
// (`=== 'export to csv'`로 뒀다가 export-button-not-found, 2026-07-30)
const clickByTextJs = (label: string): string => `(() => {
  const want = ${JSON.stringify(label.toLowerCase())};
  const norm = (e) => (e.textContent || '').replace(/\\s+/g, ' ').trim().toLowerCase();
  const clickable = Array.prototype.slice.call(
    document.querySelectorAll('a,button,[role="button"],[role="menuitem"]')
  );
  let cands = clickable.filter((e) => norm(e).indexOf(want) >= 0);
  // 클릭 가능한 태그가 아니라 <span> 같은 데 라벨이 있을 수도 있다 → 그 조상 중 클릭 가능한 것
  if (!cands.length) {
    const any = Array.prototype.slice.call(document.querySelectorAll('*'))
      .filter((e) => e.children.length === 0 && norm(e).indexOf(want) >= 0);
    for (const el of any) {
      const c = el.closest('a,button,[role="button"],[role="menuitem"]') || el.parentElement;
      if (c) cands.push(c);
    }
  }
  if (!cands.length) {
    // 실패해도 무엇이 있었는지는 남긴다 — 다음 수정을 추측으로 하지 않게
    const sample = clickable.slice(0, 40).map(norm).filter(Boolean).slice(0, 12);
    return { clicked: false, clickable: clickable.length, sample: sample };
  }
  cands.sort((a, b) => {
    const ra = a.getBoundingClientRect(), rb = b.getBoundingClientRect();
    return ra.width * ra.height - rb.width * rb.height;
  });
  cands[0].click();
  return { clicked: true, label: norm(cands[0]).slice(0, 60) };
})()`

// ---------- 자동화 한 판이 쓰는 도구 묶음 ----------
// 이동·대기·차단막·핸드오프는 어느 폼을 다루든 똑같다. 폼마다 다른 건 목표 URL과 도착 검증뿐.
interface Ctx {
  wc: WebContents
  reveal: () => void
  dispose: () => void
  go: (url: string, settle?: number) => Promise<string>
  waitForUrl: (test: (u: string) => boolean, timeoutMs?: number) => Promise<string>
  handOff: (ask: string, done: () => Promise<boolean>, timeoutMs?: number) => Promise<boolean>
  veil: (mode: 'block' | 'off') => Promise<void>
}

function makeCtx(onStep: (step: PullStep, detail?: string) => void): Ctx {
  // **자동화 전용 뷰 — 화면에 붙지 않는다.** 사용자의 탭을 가로채지도, 창을 앞으로 끌지도 않는다.
  // 예전엔 렌더러가 오버레이를 열어 브라우저를 띄운 뒤 자동화를 돌렸는데, 그건 스로틀 때문에
  // 어쩔 수 없다고 믿던 시절의 습관이었다(setBackgroundThrottling(false) 이후로는 근거가 없다).
  // 자동화가 1분씩 화면과 포커스를 점거하면 그건 대신 해주는 게 아니라 컴퓨터를 뺏는 것이다.
  const tab = openAutomationTab()
  const wc = tab.wc

  const veil = async (mode: 'block' | 'off'): Promise<void> => {
    await wc.executeJavaScript(veilJs(mode), true).catch(() => false)
  }

  const go = async (url: string, settle = 1800): Promise<string> => {
    await wc.loadURL(url)
    await wait(settle)
    // 이동하면 베일이 날아간다 — 매번 다시 씌운다
    await veil('block')
    return wc.getURL()
  }

  // 고정 대기는 못 믿는다 — 콘솔은 여러 번 리다이렉트하고 SPA 라우팅까지 겹쳐서
  // "몇 초면 된다"가 성립하지 않는다(`/console/developers`에서 2.6초에 읽었다가 실패, 2026-07-29).
  // 원하는 URL 모양이 될 때까지 관찰하고, 시간이 다하면 마지막 값을 그대로 돌려준다(진단용).
  const waitForUrl = async (test: (u: string) => boolean, timeoutMs = 20_000): Promise<string> => {
    const start = Date.now()
    for (;;) {
      const u = wc.getURL()
      if (test(u)) return u
      if (Date.now() - start > timeoutMs) return u
      await wait(300)
    }
  }

  // 자동화가 못 하는 한 걸음을 사람에게 넘기고 기다린다 — 조건이 채워지면 이어간다.
  // **여기가 뷰를 처음 화면에 내는 유일한 지점이다.** 사람이 눌러야 할 게 있을 때만 나타난다.
  // 그때는 차단막(주입한 전체화면 fixed 요소)을 걷어 사용자가 페이지를 만질 수 있게 한다.
  // (Electron의 setIgnoreInputEvents는 BrowserWindow 전용이라 WebContentsView엔 못 쓴다.)
  const handOff = async (
    ask: string,
    done: () => Promise<boolean>,
    timeoutMs = 180_000
  ): Promise<boolean> => {
    onStep('needs-user', ask) // 문구는 브라우저 밖 안내 바에 뜬다
    tab.reveal()
    await veil('off')
    const start = Date.now()
    while (Date.now() - start < timeoutMs) {
      await wait(900)
      if (await done()) {
        // 사람이 마친 뒤엔 다시 차단 모드로 — 이어지는 자동 단계 중 클릭이 끼지 않게
        await veil('block')
        return true
      }
      // 이동하면 배너가 날아가므로 다시 씌운다
      await veil('off')
    }
    return false
  }

  return { wc, reveal: tab.reveal, dispose: tab.dispose, go, waitForUrl, handOff, veil }
}

// ---------- 로그인 → 개발자 id → 앱 찾기 ----------
// 어느 폼을 읽든 여기까지는 완전히 같다. 데이터 안전에서 실증된 경로를 그대로 재사용한다.
async function reachApp(
  ctx: Ctx,
  packageName: string,
  onStep: (step: PullStep, detail?: string) => void,
  asks: { login: string; chooseDev: string }
): Promise<{ base: string } | { fail: PullResult }> {
  const { wc, go, waitForUrl, handOff, veil } = ctx

  // 1) 콘솔 홈 — 여기서 로그인 여부가 갈린다
  await go(CONSOLE_HOME, 600)
  // 로그인으로 튕기는지만 잠깐 살핀다. 콘솔에 머무르면 그게 곧 '로그인됨'이다 —
  // 개발자 id는 URL에 안 박히므로(아래 참고) URL로 더 기다려봐야 시간만 버린다.
  let here = await waitForUrl((u) => /accounts\.google\.com/.test(u), 6_000)
  if (/accounts\.google\.com/.test(here)) {
    // 세션이 퍼시스턴트라 한 번만 하면 된다 — 로그인해 달라고 부탁하고 끝날 때까지 기다린다.
    const ok = await handOff(asks.login, async () => !/accounts\.google\.com/.test(wc.getURL()))
    if (!ok) return { fail: { ok: false, step: 'login-required', formUrl: wc.getURL() } }
    here = wc.getURL()
  }

  // 개발자 id — URL이 아니라 **화면의 링크**에서 읽는다(위 FIND_DEV_ID_JS 주석 참고).
  // 링크가 아직 안 그려졌을 수 있어 몇 번 다시 본다.
  onStep('finding-app')
  // (DevProbe는 아래 handOff 콜백에서도 쓰인다)
  type DevProbe = {
    devId: string | null
    links?: number
    anchors?: number
    textLen?: number
    title?: string
    url?: string
  }
  let dev: DevProbe = { devId: null }
  // 콘솔은 번들이 커서 늦게 그려진다. 진입점을 바꿔가며 넉넉히 기다린다 —
  // 7초로는 부족했다(links=0, 2026-07-30). 각 진입점마다 최대 20초.
  const entries = [CONSOLE_HOME, 'https://play.google.com/console/u/0/developers']
  for (const entry of entries) {
    if (entry !== CONSOLE_HOME) await go(entry, 1000)
    for (let attempt = 0; attempt < 20; attempt++) {
      dev = (await wc.executeJavaScript(FIND_DEV_ID_JS, true)) as DevProbe
      if (dev.devId) break
      // 개발자 계정 선택 화면 — 하나뿐이면 대신 눌러주고, 여럿이면 고르는 건 사람 몫이다
      const pick = (await wc.executeJavaScript(PICK_DEVELOPER_JS, true)) as {
        chooser: boolean
        clicked?: boolean
        count?: number
      }
      if (pick.chooser && pick.clicked) {
        await wait(2500)
        await veil('block')
      } else if (pick.chooser) {
        // 못 눌렀으면(후보 0개=선택자에 안 잡힘, 또는 2개 이상=사람의 판단) 사람에게 넘긴다.
        // count>1만 넘기게 해뒀다가 0일 때 차단막만 쓴 채 멈춰 있었다(2026-07-30).
        await handOff(asks.chooseDev, async () => {
          const p = (await wc.executeJavaScript(FIND_DEV_ID_JS, true)) as DevProbe
          return !!p.devId
        })
      }
      await wait(1000)
    }
    if (dev.devId) break
  }
  if (!dev.devId) {
    return {
      fail: {
        ok: false,
        step: 'failed',
        error: `no-developer-id (a=${dev.anchors ?? 0}, text=${dev.textLen ?? 0}, ${(dev.url ?? here).slice(0, 70)})`,
        formUrl: dev.url ?? here
      }
    }
  }
  // 이미 앱 목록이 그려져 있을 수도 있으니, 아니면 명시적으로 이동한다
  if (!here.includes('app-list')) {
    await go(`https://play.google.com/console/u/0/developers/${dev.devId}/app-list`, 1200)
    await waitForUrl((u) => u.includes('app-list'), 15_000)
  }

  // 2) 패키지명으로 앱 찾기 — 목록이 늦게 그려질 수 있어 몇 번 다시 본다
  let hit: { found: boolean; dev?: string; app?: string; reason?: string; linkCount?: number } = {
    found: false
  }
  for (let attempt = 0; attempt < 3; attempt++) {
    hit = (await wc.executeJavaScript(findAppJs(packageName), true)) as typeof hit
    if (hit.found) break
    await wait(1200)
  }
  if (!hit.found || !hit.dev || !hit.app) {
    return {
      fail: {
        ok: false,
        step: 'failed',
        // 왜 못 찾았는지까지 올린다 — 목록이 안 그려진 건지, 그 계정에 없는 앱인지 구분돼야 한다
        error: `app-not-found (${hit.reason ?? 'unknown'}, links=${hit.linkCount ?? 0})`,
        formUrl: wc.getURL()
      }
    }
  }
  return { base: `https://play.google.com/console/u/0/developers/${hit.dev}/app/${hit.app}` }
}

export async function pullDataSafety(
  packageName: string,
  onStep: (step: PullStep, detail?: string) => void,
  // 안내 문구는 **렌더러가 i18n 사전에서 넘긴다** — main에 기본값(한국어)을 두면
  // 영어 로케일에서 한국어가 새어 나온다. 기본값 없이 필수 인자로 둬서 컴파일이 강제하게 한다.
  asks: { login: string; chooseDev: string; export: string }
): Promise<PullResult> {
  if (!packageName) return { ok: false, step: 'failed', error: 'no-package-name' }
  const ctx = makeCtx(onStep)
  const { wc, go, waitForUrl, veil } = ctx

  try {
    onStep('opening')
    const reached = await reachApp(ctx, packageName, onStep, asks)
    if ('fail' in reached) return reached.fail
    const base = reached.base
    const formUrl = `${base}/app-content/data-privacy-security`

    // 3) 데이터 안전 폼 — 도착 검증(없는 경로면 조용히 홈으로 튕긴다)
    onStep('opening-form')
    await go(formUrl, 800)
    const here = await waitForUrl((u) => u.includes('data-privacy-security'), 15_000)
    if (!here.includes('data-privacy-security')) {
      return { ok: false, step: 'failed', error: 'form-not-reached', consoleBase: base, formUrl }
    }

    // 4) Export to CSV — 다운로드를 먼저 예약하고 누른다(클릭 후 예약하면 놓칠 수 있다).
    //    자동 클릭이 실패해도 **에러로 끝내지 않는다** — 안내로 바꾸고 사람이 누르길 기다린다.
    //    자동이든 손이든 파일만 오면 그다음은 ZTO가 이어받는다(Dan 2026-07-30).
    onStep('exporting')
    const downloaded = expectDownload('data-safety.csv', 300_000)
    const click = (await wc.executeJavaScript(clickByTextJs('Export to CSV'), true)) as {
      clicked: boolean
      clickable?: number
      sample?: string[]
      label?: string
    }
    if (!click.clicked) {
      // 못 눌렀으면 사람에게 부탁한다 — 이때만 뷰를 앞에 내고 차단막을 걷는다.
      // 기다림은 아래 `downloaded` 하나로 통일된다(자동/수동 어느 쪽이든 파일이 오면 끝).
      onStep('needs-user', asks.export)
      ctx.reveal()
      await veil('off')
    }
    let file: string
    try {
      file = await downloaded
    } catch {
      return {
        ok: false,
        step: 'failed',
        error: click.clicked
          ? 'download-not-received'
          : `export-click-needed (clickable=${click.clickable ?? 0})`,
        consoleBase: base,
        formUrl
      }
    }
    // 사람이 눌러준 경우엔 다시 차단막을 씌우고 마무리한다
    await veil('block')

    // 5) 파싱 + 보관
    onStep('parsing')
    const doc = parseDataSafetyCsv(readFileSync(file, 'utf8'))
    try {
      writeFileSync(
        join(app.getPath('userData'), `zto-data-safety-${packageName}.json`),
        JSON.stringify({ packageName, consoleBase: base, ...doc }, null, 2)
      )
    } catch {
      /* 보관 실패가 결과를 막지는 않는다 */
    }
    onStep('done')
    return { ok: true, step: 'done', doc, consoleBase: base, formUrl }
  } catch (e) {
    onStep('failed')
    return { ok: false, step: 'failed', error: String(e).slice(0, 300) }
  } finally {
    // 자동화 뷰는 반드시 치운다 — 베일째로 사라지므로 따로 걷을 필요가 없고,
    // 사용자가 보던 탭으로 돌아간다. 이어서 직접 할 일은 렌더러가 [폼 열기]로 새로 연다.
    ctx.dispose()
  }
}

// ---------- 앱 콘텐츠 선언 정찰 (콘텐츠 등급·타깃 연령 등) ----------
// 데이터 안전과 달리 이쪽은 **공식 CSV가 없다** → DOM 경로라 콘솔 개정에 약하다.
// 그래서 코드를 쓰기 전에 폼이 실제로 어떻게 생겼는지부터 회수한다.
//
// 경로는 조립하지 않는다. `app-content/overview`에 가서 **거기 링크에서** 하위 선언 폼을
// 수확한다 — `app-content` 단독이 존재하지 않았듯(2026-07-29) 하위 슬러그도 추측하면
// 404가 아니라 홈으로 조용히 리다이렉트된다. 화면이 알려주는 href만 따라간다.
export async function probeAppContent(
  packageName: string,
  onStep: (step: PullStep, detail?: string) => void,
  asks: { login: string; chooseDev: string }
): Promise<{
  ok: boolean
  step: PullStep
  doc?: AppContentProbeDoc
  consoleBase?: string
  error?: string
}> {
  if (!packageName) return { ok: false, step: 'failed', error: 'no-package-name' }
  const ctx = makeCtx(onStep)
  const { wc, go, waitForUrl } = ctx

  const expandAndProbe = async (): Promise<FormProbe> => {
    // 접힌 영역은 DOM에 아예 없다 — 펼치고 읽는다. 한 번 펼치면 또 접힌 게 드러나므로 반복.
    for (let round = 0; round < 3; round++) {
      const opened = (await wc.executeJavaScript(EXPAND_JS, true).catch(() => 0)) as number
      if (!opened) break
      await wait(700)
    }
    return (await wc.executeJavaScript(FORM_PROBE_JS, true)) as FormProbe
  }

  try {
    onStep('opening')
    const reached = await reachApp(ctx, packageName, onStep, asks)
    if ('fail' in reached) return { ok: false, step: reached.fail.step, error: reached.fail.error }
    const base = reached.base

    // 1) 목차 페이지 — 여기서 하위 폼 경로를 수확한다
    onStep('opening-form')
    const overview = `${base}/app-content/overview`
    await go(overview, 1200)
    const here = await waitForUrl((u) => u.includes('app-content'), 15_000)
    if (!here.includes('app-content')) {
      return { ok: false, step: 'failed', error: 'overview-not-reached', consoleBase: base }
    }
    const map = await expandAndProbe()

    // 같은 앱의 app-content 하위만 — 다른 앱·개발자 페이지로 새면 순회가 폭주한다
    const found = new Map<string, string>() // slug → 링크 텍스트
    for (const l of map.links) {
      const m = l.href.match(/\/app\/\d+\/app-content\/([A-Za-z0-9._-]+)(?:[/?#]|$)/)
      if (!m || m[1] === 'overview') continue
      if (!found.has(m[1])) found.set(m[1], l.text)
    }
    if (found.size === 0) {
      return {
        ok: false,
        step: 'failed',
        // 링크가 0개면 '이 앱엔 선언이 없다'가 아니라 '페이지가 안 그려졌다'일 가능성이 크다 —
        // 구분이 되게 관측치를 함께 올린다(문서 §8)
        error: `no-app-content-links (a=${map.links.length}, ctrl=${map.controls.length}, ${map.title.slice(0, 40)})`,
        consoleBase: base
      }
    }

    // 2) 폼마다 들어가서 통째로 회수한다 — '어디 있나'만이 아니라 '무엇을 묻나'까지 있어야
    //    설문 매핑을 설계할 수 있다(1차 콘솔 지도가 링크만 담아 판단을 못 했다)
    onStep('probing')
    const forms: AppContentForm[] = []
    for (const [slug, label] of found) {
      const url = `${base}/app-content/${slug}`
      onStep('probing', label || slug)
      try {
        await go(url, 1600)
        const landed = await waitForUrl((u) => u.includes(`app-content/${slug}`), 12_000)
        const probe = await expandAndProbe()
        forms.push({
          slug,
          label,
          url,
          reached: landed.includes(`app-content/${slug}`),
          title: probe.title,
          headings: probe.headings.slice(0, 30),
          counts: probe.counts,
          controls: probe.controls
        })
      } catch (e) {
        forms.push({
          slug,
          label,
          url,
          reached: false,
          title: String(e).slice(0, 120),
          headings: [],
          counts: {},
          controls: []
        })
      }
    }

    const doc: AppContentProbeDoc = {
      at: new Date().toISOString(),
      packageName,
      consoleBase: base,
      forms
    }
    try {
      writeFileSync(
        join(app.getPath('userData'), `zto-app-content-${packageName}.json`),
        JSON.stringify(doc, null, 2)
      )
    } catch {
      /* 보관 실패가 결과를 막지는 않는다 */
    }
    onStep('done')
    return { ok: true, step: 'done', doc, consoleBase: base }
  } catch (e) {
    onStep('failed')
    return { ok: false, step: 'failed', error: String(e).slice(0, 300) }
  } finally {
    ctx.dispose()
  }
}
