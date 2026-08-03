import { useEffect, useState } from 'react'
import AccountsPage from './modules/accounts/AccountsPage'
import LaunchPage from './modules/launch/LaunchPage'
import SocialPage from './modules/social/SocialPage'
import SettingsPage from './modules/settings/SettingsPage'
import { BrowserOverlayProvider } from './browser-overlay'
import { useI18n } from './i18n'
import type { LicenseInfo } from '../../shared/license-types'

type ModuleId = 'accounts' | 'launch' | 'social' | 'settings'

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

  // 정상·확인중은 유저에게 노이즈라 숨기고, 진짜 IPC 오류일 때만 노출
  const ipcError = ipcStatus !== 'ok' && ipcStatus !== 'checking' ? ipcStatus : null

  // 만료 잠금 — 공식 빌드만. 무료 사용 3일은 첫 실행부터 카운트(2026-08-03 단순화).
  // 소스 빌드는 게이트 자체가 없다(LICENSE.md). 예외 화면 2곳: 설정(키 등록 입구가
  // 없으면 산 사람도 못 들어온다), 계정 인벤토리(영구 무료 — 비밀번호 인질 금지)
  const gated = !!lic && lic.official && !lic.entitled && !!lic.trialStartedAt
  const gateCovers = gated && active !== 'settings' && active !== 'accounts'

  const buyUrl = 'https://zto-umber.vercel.app/#pricing'

  const navBtn = (id: ModuleId, label: string, desc: string): React.JSX.Element => (
    <button
      key={id}
      className={`nav-item ${active === id ? 'active' : ''}`}
      onClick={() => setActive(id)}
    >
      <span className="nav-label">{label}</span>
      <span className="nav-desc">{desc}</span>
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
          {modules.map((mod) => navBtn(mod.id, mod.label, mod.desc))}
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
