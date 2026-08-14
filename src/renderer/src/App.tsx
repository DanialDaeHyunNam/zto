import { useEffect, useState } from 'react'
import AccountsPage from './modules/accounts/AccountsPage'
import LaunchPage from './modules/launch/LaunchPage'
import SocialPage from './modules/social/SocialPage'
import SettingsPage from './modules/settings/SettingsPage'
import { BrowserOverlayProvider } from './browser-overlay'
import { useI18n } from './i18n'
import type { LicenseInfo } from '../../shared/license-types'
import type { UpdateStatus } from '../../shared/update-types'

type ModuleId = 'accounts' | 'launch' | 'social' | 'settings'

// ---------- 사이드바 업데이트 배지 + 버전 ----------
// 설정에만 두면 아무도 안 본다 — 새 버전이 있다는 사실은 **찾아가지 않아도** 보여야 한다.
// 다만 재시작은 여전히 사람이 누른다(updater.ts): ZTO는 라이브 스토어를 비가역으로 바꾸므로
// 자산 업로드·IAP 반영 중에 앱이 재시작하면 무엇이 반영됐는지 모르는 상태가 된다.
// 그래서 배지는 **두 번 눌러야** 설치한다 — 사이드바는 오조작하기 쉬운 자리다.
function UpdateChip(): React.JSX.Element | null {
  const { m } = useI18n()
  const [st, setSt] = useState<UpdateStatus | null>(null)
  const [confirming, setConfirming] = useState(false)

  useEffect(() => {
    window.zto.update.status().then(setSt)
    return window.zto.update.onStatus(setSt)
  }, [])

  // 확인 상태로 둔 채 잊어버리면 다음 클릭이 곧 재시작이 된다 — 6초 뒤 원래대로
  useEffect(() => {
    if (!confirming) return
    const t = setTimeout(() => setConfirming(false), 6000)
    return () => clearTimeout(t)
  }, [confirming])

  const version = st?.version ? `v${st.version}` : ''
  const downloading = st?.phase === 'available' || st?.phase === 'downloading'
  const ready = st?.phase === 'ready'

  // 버전 한 줄이 상태의 자리다 — 진행률은 그 오른쪽에 조용히, 다 받으면 같은 자리에 버튼이 생긴다.
  // 별도 블록으로 띄우면 아무것도 누를 게 없는 동안에도 사이드바가 소리를 지른다(Dan 2026-08-12).
  // 예외는 확인 단계 하나 — 다음 클릭이 곧 재시작이므로 그 순간만 줄 전체를 가져간다.
  const arrow = (
    <svg className="update-chip-icon" viewBox="0 0 16 16" aria-hidden="true">
      <path
        d="M8 2v7m0 0 3-3M8 9 5 6m-2 6h10"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )

  return (
    <>
      <div className="version-row">
        {version && !(ready && confirming) && (
          <button
            className="version-line"
            disabled={!!st?.disabled || st?.phase === 'checking' || downloading || ready}
            onClick={() => window.zto.update.check().then(setSt)}
            title={st?.disabled ? '' : m.nav.versionCheck}
          >
            {st?.phase === 'checking' ? m.nav.versionChecking : version}
          </button>
        )}
        {downloading && (
          <span
            className="version-progress"
            title={m.nav.updateDownloading.replace('{p}', String(st?.percent ?? 0))}
          >
            {arrow}
            {st?.percent ?? 0}%
          </span>
        )}
        {ready && (
          <button
            className={`update-chip mini ${confirming ? 'confirm' : ''}`}
            onClick={() => (confirming ? window.zto.update.install() : setConfirming(true))}
            title={confirming ? m.nav.updateConfirm : m.nav.updateReady.replace('{v}', st?.newVersion ?? '')}
          >
            {/* 확인 단계에서도 **줄 높이가 변하지 않는다** — 버튼 하나 때문에 사이드바 바닥이
                들썩이면 눌러야 할 자리가 움직인다. 색과 아이콘만 바뀐다 */}
            {confirming ? (
              <svg className="update-chip-icon" viewBox="0 0 16 16" aria-hidden="true">
                <path
                  d="M13 8a5 5 0 1 1-1.6-3.7M13 2v3h-3"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.6"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
            ) : (
              arrow
            )}
            {confirming ? m.nav.updateConfirmShort : (st?.newVersion ?? '')}
          </button>
        )}
      </div>
    </>
  )
}

// 맥은 ⌘/⌥, 그 외는 Ctrl/Alt — 키 조합 자체는 main이 meta·control 둘 다 받는다
const MOD_KEY = window.zto.platform === 'darwin' ? '⌘' : 'Ctrl+'

export default function App(): React.JSX.Element {
  const { m } = useI18n()
  const [active, setActive] = useState<ModuleId>('accounts')
  const [ipcStatus, setIpcStatus] = useState<'checking' | 'ok' | string>('checking')
  // 사이드바 플랜 칩 — "내가 지금 뭘 쓰고 있나"를 항상 한눈에 (Dan 2026-08-03)
  const [lic, setLic] = useState<LicenseInfo | null>(null)
  useEffect(() => {
    window.zto.license.info().then(setLic)
  }, [active]) // 설정에서 등록·해제하고 나오면 자연히 갱신된다

  // 한 기기에 공식 빌드와 소스 빌드가 같이 있으면 겉으로 구분이 안 된다(실사례) —
  // 창 제목이 가장 싼 구분자다. Dock·⌘Tab·창 전환 어디서든 보인다
  useEffect(() => {
    if (lic) document.title = lic.official ? 'ZTO' : m.nav.titleSource
  }, [lic, m])

  useEffect(() => {
    window.zto
      .ping()
      .then((r) => setIpcStatus(r === 'pong' ? 'ok' : m.ipc.unexpected + r))
      .catch((e) => setIpcStatus(m.ipc.error + e))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const modules: { id: ModuleId; label: string; desc: string }[] = [
    { id: 'accounts', label: m.nav.accounts, desc: m.nav.accountsDesc },
    { id: 'launch', label: m.nav.launch, desc: m.nav.launchDesc },
    { id: 'social', label: m.nav.social, desc: m.nav.socialDesc }
  ]

  // ⌘1..3 = 모듈 전환. 임베드 브라우저가 키보드를 쥐고 있을 땐 그쪽이 못 받으므로
  // main(browser.ts)이 같은 조합을 가로채 'app:module'로 넘겨준다 — 어디에 포커스가 있든 같게 동작
  useEffect(() => {
    const go = (n: number): void => {
      const mod = modules[n - 1]
      if (mod) setActive(mod.id)
    }
    const onKey = (e: KeyboardEvent): void => {
      if (!(e.metaKey || e.ctrlKey) || e.altKey || e.shiftKey) return
      const n = parseInt(e.key, 10)
      if (n >= 1 && n <= modules.length) {
        e.preventDefault()
        go(n)
      }
    }
    window.addEventListener('keydown', onKey)
    const off = window.zto.onModuleKey(go)
    return () => {
      window.removeEventListener('keydown', onKey)
      off()
    }
  }, [modules])


  // 정상·확인중은 유저에게 노이즈라 숨기고, 진짜 IPC 오류일 때만 노출
  const ipcError = ipcStatus !== 'ok' && ipcStatus !== 'checking' ? ipcStatus : null

  // 만료 잠금 — 공식 빌드만. 무료 사용 3일은 첫 실행부터 카운트(2026-08-03 단순화).
  // 소스 빌드는 게이트 자체가 없다(LICENSE.md). 예외 화면 2곳: 설정(키 등록 입구가
  // 없으면 산 사람도 못 들어온다), 계정 인벤토리(영구 무료 — 비밀번호 인질 금지)
  const gated = !!lic && lic.official && !lic.entitled && !!lic.trialStartedAt
  const gateCovers = gated && active !== 'settings' && active !== 'accounts'

  const buyUrl = 'https://zto-umber.vercel.app/#pricing'

  const navBtn = (id: ModuleId, label: string, desc: string, n = 0): React.JSX.Element => (
    <button
      key={id}
      className={`nav-item ${active === id ? 'active' : ''}`}
      onClick={() => setActive(id)}
    >
      <span className="nav-text">
        <span className="nav-label">{label}</span>
        <span className="nav-desc">{desc}</span>
      </span>
      {/* 모듈은 ⌘1..3, 브라우저 탭은 ⌥1..9 — 바깥(앱)이 ⌘, 안(브라우저)이 ⌥ */}
      {n > 0 && <span className="nav-key">{MOD_KEY}{n}</span>}
    </button>
  )

  return (
    <BrowserOverlayProvider closeKey={active}>
      <div className="app">
        <nav className="sidebar">
          <div className="logo">
            zto
            {lic && !lic.official && <span className="logo-badge">{m.nav.sourceBadge}</span>}
            <span className="logo-sub">zero to one</span>
          </div>
          {modules.map((mod, i) => navBtn(mod.id, mod.label, mod.desc, i + 1))}
          <div className="sidebar-bottom">
            {lic &&
              (lic.state === 'active' && lic.plan ? (
                <button
                  className={`plan-chip ${lic.plan}`}
                  onClick={() => setActive('settings')}
                  title={m.nav.planTitle}
                >
                  {lic.plan === 'plus' ? 'ZTO Plus' : 'ZTO'}
                </button>
              ) : !lic.official ? null : lic.trialActive ? ( // 소스 빌드 — 체험 칩은 거짓말이라 안 단다
                <button className="plan-chip trial" onClick={() => setActive('settings')}>
                  {m.nav.planTrial.replace(
                    '{d}',
                    String(
                      Math.max(
                        0,
                        Math.ceil(
                          (new Date(lic.trialEndsAt ?? 0).getTime() - Date.now()) / 86400000
                        )
                      )
                    )
                  )}
                </button>
              ) : (
                <button className="plan-chip over" onClick={() => setActive('settings')}>
                  {m.nav.planTrialOver}
                </button>
              ))}
            {navBtn('settings', m.nav.settings, m.nav.settingsDesc)}
            <UpdateChip />
            {ipcError && <div className="sidebar-footer error">{ipcError}</div>}
          </div>
        </nav>
        <main className={`content ${active === 'social' ? 'flush' : ''}`}>
          {gated && active === 'accounts' && (
            <div className="gate-banner">
              <span>{m.gate.accountsNote}</span>
              <button
                className="ghost-btn mini"
                onClick={() => window.zto.launch.openExternal(buyUrl)}
              >
                {m.gate.cta}
              </button>
            </div>
          )}
          {/* 잠금 중엔 뒤 화면을 흐려서 보여준다 — 뭘 잃는지가 보여야 결제할 이유가 보인다.
              소셜만은 통째로 뺀다: 네이티브 WebContentsView는 DOM 위에 떠서 blur가 못 덮는다 */}
          <div className={gateCovers ? 'gate-blur' : undefined}>
            {active === 'launch' && <LaunchPage />}
            {active === 'accounts' && <AccountsPage gated={gated} />}
            {active === 'social' && !gateCovers && <SocialPage />}
            {active === 'settings' && <SettingsPage />}
          </div>
          {gateCovers && (
            <div className="gate-overlay">
              <div className="gate-card">
                <div className="gate-title">{m.gate.title}</div>
                <p className="gate-body">{m.gate.body}</p>
                <button
                  className="choice active"
                  onClick={() => window.zto.launch.openExternal(buyUrl)}
                >
                  {m.gate.cta}
                </button>
                <button className="ghost-btn" onClick={() => setActive('settings')}>
                  {m.gate.haveKey}
                </button>
              </div>
            </div>
          )}
        </main>
      </div>
    </BrowserOverlayProvider>
  )
}
