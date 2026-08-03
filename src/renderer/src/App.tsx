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
            zto<span className="logo-sub">zero to one</span>
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
              ) : lic.trialActive ? (
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
              ) : lic.trialStartedAt ? (
                <button className="plan-chip over" onClick={() => setActive('settings')}>
                  {m.nav.planTrialOver}
                </button>
              ) : null)}
            {navBtn('settings', m.nav.settings, m.nav.settingsDesc)}
            {ipcError && <div className="sidebar-footer error">{ipcError}</div>}
          </div>
        </nav>
        <main className={`content ${active === 'social' ? 'flush' : ''}`}>
          {active === 'launch' && <LaunchPage />}
          {active === 'accounts' && <AccountsPage />}
          {active === 'social' && <SocialPage />}
          {active === 'settings' && <SettingsPage />}
        </main>
      </div>
    </BrowserOverlayProvider>
  )
}
