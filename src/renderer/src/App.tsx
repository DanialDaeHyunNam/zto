import { useEffect, useState } from 'react'
import AccountsPage from './modules/accounts/AccountsPage'
import LaunchPage from './modules/launch/LaunchPage'
import { useI18n, type Locale } from './i18n'

type ModuleId = 'accounts' | 'launch'

const LOCALES: Locale[] = ['ko', 'en']

export default function App(): React.JSX.Element {
  const { m, locale, setLocale } = useI18n()
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
    { id: 'launch', label: m.nav.launch, desc: m.nav.launchDesc }
  ]

  const ipcLabel =
    ipcStatus === 'checking' ? m.ipc.checking : ipcStatus === 'ok' ? m.ipc.ok : ipcStatus

  return (
    <div className="app">
      <nav className="sidebar">
        <div className="logo">
          zto<span className="logo-sub">zero to one</span>
        </div>
        {modules.map((mod) => (
          <button
            key={mod.id}
            className={`nav-item ${active === mod.id ? 'active' : ''}`}
            onClick={() => setActive(mod.id)}
          >
            <span className="nav-label">{mod.label}</span>
            <span className="nav-desc">{mod.desc}</span>
          </button>
        ))}
        <div className="sidebar-footer">
          <div className="locale-row">
            {LOCALES.map((l) => (
              <button
                key={l}
                className={`locale-btn ${locale === l ? 'active' : ''}`}
                onClick={() => setLocale(l)}
              >
                {l.toUpperCase()}
              </button>
            ))}
          </div>
          {ipcLabel}
        </div>
      </nav>
      <main className="content">
        {active === 'launch' && <LaunchPage />}
        {active === 'accounts' && <AccountsPage />}
      </main>
    </div>
  )
}
