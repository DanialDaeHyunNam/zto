import { useEffect, useState } from 'react'
import AccountsPage from './modules/accounts/AccountsPage'
import LaunchPage from './modules/launch/LaunchPage'
import SocialPage from './modules/social/SocialPage'
import SettingsPage from './modules/settings/SettingsPage'
import { BrowserOverlayProvider } from './browser-overlay'
import { useI18n } from './i18n'

type ModuleId = 'accounts' | 'launch' | 'social' | 'settings'

export default function App(): React.JSX.Element {
  const { m } = useI18n()
  const [active, setActive] = useState<ModuleId>('accounts')
  const [ipcStatus, setIpcStatus] = useState<'checking' | 'ok' | string>('checking')

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
