import { useEffect, useMemo, useRef, useState } from 'react'
import {
  PLATFORM_DOMAINS,
  PLATFORMS,
  type AccessLogEntry,
  type Account
} from '../../../../shared/launch-types'
import { useI18n } from '../../i18n'
import { KeyGlyph, PlatformIcon, PLATFORM_NAMES, platformTint } from '../../platform-icons'

const IS_MAC = window.zto.platform === 'darwin'

const AVATAR_GRADIENTS = [
  'linear-gradient(135deg, #7c3aed, #a855f7)',
  'linear-gradient(135deg, #2563eb, #38bdf8)',
  'linear-gradient(135deg, #059669, #34d399)',
  'linear-gradient(135deg, #d97706, #fbbf24)',
  'linear-gradient(135deg, #db2777, #f472b6)',
  'linear-gradient(135deg, #0891b2, #67e8f9)'
]

function avatarGradient(email: string): string {
  let h = 0
  for (const c of email) h = (h * 31 + c.charCodeAt(0)) >>> 0
  return AVATAR_GRADIENTS[h % AVATAR_GRADIENTS.length]
}

function AppPicker({
  selected,
  onToggle
}: {
  selected: string[]
  onToggle: (id: string) => void
}): React.JSX.Element {
  const { m } = useI18n()
  const groups = [
    { key: 'console', label: m.accounts.catConsole },
    { key: 'mail', label: m.accounts.catMail },
    { key: 'social', label: m.accounts.catSocial }
  ] as const
  return (
    <div className="picker-groups">
      {groups.map((g) => (
        <div key={g.key} className="picker-group">
          <div className="picker-cat">{g.label}</div>
          <div className="app-picker">
            {PLATFORMS.filter((p) => p.category === g.key).map((p) => (
              <button
                key={p.id}
                className={`app-chip ${selected.includes(p.id) ? 'active' : ''}`}
                onClick={() => onToggle(p.id)}
                type="button"
              >
                <PlatformIcon id={p.id} />
                {p.name}
              </button>
            ))}
          </div>
        </div>
      ))}
    </div>
  )
}

// 계정 상세 안의 앱 한 줄 — 경로 3개(Chrome / 암호 앱 / 직접 입력), 직접 입력은 상세 카드로 펼침
function AppSecretRow({
  email,
  appId,
  hasSecret,
  onStored
}: {
  email: string
  appId: string
  hasSecret: boolean
  onStored: () => void
}): React.JSX.Element {
  const { m, locale } = useI18n()
  const [open, setOpen] = useState(false)
  const [editMode, setEditMode] = useState(false)
  const [draft, setDraft] = useState('')
  const [revealed, setRevealed] = useState<string | null>(null)
  const [notice, setNotice] = useState('')
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [updatedAt, setUpdatedAt] = useState<string | null>(null)
  const [log, setLog] = useState<AccessLogEntry[] | null>(null)
  const [logFilter, setLogFilter] = useState<string | null>(null)
  const hideTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    return () => {
      if (hideTimer.current) clearTimeout(hideTimer.current)
    }
  }, [])

  useEffect(() => {
    if (open && hasSecret) window.zto.secrets.updatedAt(email, appId).then(setUpdatedAt)
  }, [open, hasSecret, email, appId])

  const flash = (msg: string): void => {
    setNotice(msg)
    setTimeout(() => setNotice(''), 4000)
  }

  const fmtDate = (ts: string): string =>
    new Date(ts).toLocaleDateString(locale === 'ko' ? 'ko-KR' : 'en-US', {
      year: 'numeric',
      month: 'short',
      day: 'numeric'
    })

  const save = (): void => {
    if (!draft) return
    window.zto.secrets
      .set(email, appId, draft)
      .then((ok) => {
        if (ok) {
          setDraft('')
          setEditMode(false)
          flash(m.accounts.secretSaved)
          window.zto.secrets.updatedAt(email, appId).then(setUpdatedAt)
          onStored()
        }
      })
      .catch(() => flash(m.accounts.authFailed)) // 기존 값 변경은 인증 필요
  }

  const del = (): void => {
    if (!confirmDelete) {
      setConfirmDelete(true)
      setTimeout(() => setConfirmDelete(false), 3000)
      return
    }
    window.zto.secrets
      .delete(email, appId)
      .then(() => {
        setConfirmDelete(false)
        setRevealed(null)
        setOpen(false)
        onStored()
      })
      .catch(() => flash(m.accounts.authFailed))
  }

  const reveal = (): void => {
    window.zto.secrets
      .reveal(email, appId)
      .then((value) => {
        if (value === null) return
        setRevealed(value)
        if (hideTimer.current) clearTimeout(hideTimer.current)
        hideTimer.current = setTimeout(() => setRevealed(null), 15_000)
      })
      .catch(() => flash(m.accounts.authFailed))
  }

  const copy = (): void => {
    window.zto.secrets
      .copy(email, appId)
      .then((ok) => ok && flash(m.accounts.secretCopied))
      .catch(() => flash(m.accounts.authFailed))
  }

  const locate = (target: 'chrome' | 'keychain'): void => {
    window.zto.secrets
      .locate(appId, target)
      .then((term) => flash(m.accounts.searchCopied.replace('{term}', term)))
  }

  const toggleLog = (): void => {
    setLogFilter(null)
    if (log) {
      setLog(null)
    } else {
      window.zto.secrets.accessLog(email, appId).then(setLog)
    }
  }

  const actionLabel = (a: AccessLogEntry['action']): string =>
    ({
      reveal: m.accounts.actionReveal,
      copy: m.accounts.actionCopy,
      save: m.accounts.actionSave,
      update: m.accounts.actionUpdate,
      delete: m.accounts.actionDelete
    })[a]

  const domain = PLATFORM_DOMAINS[appId]

  return (
    <div className="app-row-wrap">
      <div className="app-row">
        <div className="app-row-id">
          <span className="tile-ic sm" style={{ background: platformTint(appId) }}>
            <PlatformIcon id={appId} size={15} />
          </span>
          {PLATFORM_NAMES[appId] ?? appId}
        </div>
        <div className="app-row-mid">
          {notice && <span className="secret-note-inline">{notice}</span>}
        </div>
        <div className="app-row-actions">
          <button className="ghost-btn" onClick={() => locate('chrome')}>
            <PlatformIcon id="chrome" size={12} />
            {m.accounts.findChrome}
          </button>
          {IS_MAC && (
            <button className="ghost-btn" onClick={() => locate('keychain')}>
              <PlatformIcon id="apple" size={12} />
              {m.accounts.findKeychain}
            </button>
          )}
          <button
            className={`ghost-btn ${hasSecret ? 'stored' : ''} ${open ? 'on' : ''}`}
            onClick={() => {
              setOpen(!open)
              setLog(null)
              setEditMode(false)
              setRevealed(null)
            }}
          >
            {hasSecret && <KeyGlyph size={11} />}
            {hasSecret ? m.accounts.storedEntry : m.accounts.directEntry}
          </button>
        </div>
      </div>

      {open && (
        <div className="pw-card">
          <div className="pw-row">
            <span className="pw-label">{m.accounts.userName}</span>
            <span>{email}</span>
          </div>
          <div className="pw-row">
            <span className="pw-label">{m.accounts.passwordLabel}</span>
            {!hasSecret || editMode ? (
              <span className="pw-edit">
                <input
                  className="email-input"
                  type="password"
                  placeholder={m.accounts.secretPlaceholder}
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && save()}
                  autoFocus
                />
                <button className="choice tiny active" onClick={save} disabled={!draft}>
                  {m.accounts.save}
                </button>
                {hasSecret && (
                  <button className="choice tiny" onClick={() => setEditMode(false)}>
                    {m.accounts.cancel}
                  </button>
                )}
              </span>
            ) : (
              <span className="pw-value">
                {revealed !== null ? (
                  <code className="secret-value">{revealed}</code>
                ) : (
                  <span className="pw-mask">••••••••••</span>
                )}
                {revealed === null ? (
                  <button className="ghost-btn" onClick={reveal}>
                    {m.accounts.secretReveal}
                  </button>
                ) : (
                  <button className="ghost-btn" onClick={() => setRevealed(null)}>
                    {m.accounts.secretHide}
                  </button>
                )}
                <button className="ghost-btn" onClick={copy}>
                  {m.accounts.secretCopy}
                </button>
                <button className="ghost-btn" onClick={() => setEditMode(true)}>
                  {m.accounts.secretChange}
                </button>
              </span>
            )}
          </div>
          {domain && (
            <div className="pw-row">
              <span className="pw-label">{m.accounts.website}</span>
              <span>{domain}</span>
            </div>
          )}
          {hasSecret && updatedAt && (
            <div className="pw-row">
              <span className="pw-label">{m.accounts.modifiedAt}</span>
              <span>{fmtDate(updatedAt)}</span>
            </div>
          )}
          {hasSecret && (
            <div className="pw-footer">
              <button className="choice tiny" onClick={toggleLog}>
                {log ? m.accounts.hideLog : m.accounts.viewLog}
              </button>
              {!editMode && (
                <button className={`act-btn delete ${confirmDelete ? 'arm' : ''}`} onClick={del}>
                  {confirmDelete ? m.accounts.deleteSure : m.accounts.secretDelete}
                </button>
              )}
            </div>
          )}
          {log &&
            (log.length === 0 ? (
              <p className="secret-note-inline">{m.accounts.noLogYet}</p>
            ) : (
              <>
                <div className="log-chips">
                  <button
                    className={`app-chip ${logFilter === null ? 'active' : ''}`}
                    onClick={() => setLogFilter(null)}
                  >
                    {m.accounts.all} ({log.length})
                  </button>
                  {(['reveal', 'copy', 'save', 'update', 'delete'] as const)
                    .filter((a) => log.some((e) => e.action === a))
                    .map((a) => (
                      <button
                        key={a}
                        className={`app-chip ${logFilter === a ? 'active' : ''}`}
                        onClick={() => setLogFilter(logFilter === a ? null : a)}
                      >
                        {actionLabel(a)} ({log.filter((e) => e.action === a).length})
                      </button>
                    ))}
                </div>
                <div className="sec-log">
                  {(logFilter ? log.filter((e) => e.action === logFilter) : log).map((e, i) => (
                    <div key={i} className={`sec-log-row ${e.ok ? '' : 'denied'}`}>
                      <span className="sec-log-time">
                        {new Date(e.ts).toLocaleString(locale === 'ko' ? 'ko-KR' : 'en-US', {
                          month: 'short',
                          day: 'numeric',
                          hour: '2-digit',
                          minute: '2-digit'
                        })}
                      </span>
                      <span className="sec-log-what">
                        {actionLabel(e.action)}
                        {!e.ok && ` (${m.accounts.deniedLabel})`}
                      </span>
                      <span />
                    </div>
                  ))}
                </div>
              </>
            ))}
        </div>
      )}
    </div>
  )
}

// 보안 상태 패널 — 처리 방식·실시간 상태·접근 기록의 전면 공개 (로컬 앱이라 보는 사람은 주인뿐)
function SecurityPanel(): React.JSX.Element {
  const { m, locale } = useI18n()
  const [status, setStatus] = useState<{
    biometry: boolean
    secretCount: number
    secretsPath: string
  } | null>(null)
  const [lock, setLock] = useState<{ unlocked: boolean; remainingMs: number }>({
    unlocked: false,
    remainingMs: 0
  })
  const [log, setLog] = useState<AccessLogEntry[]>([])

  const refresh = (): void => {
    window.zto.secrets.securityStatus().then(setStatus)
    window.zto.secrets.lockState().then(setLock)
    window.zto.secrets.accessLog().then(setLog)
  }

  useEffect(() => {
    refresh()
    const t = setInterval(refresh, 10_000)
    return () => clearInterval(t)
  }, [])

  const lockNow = (): void => {
    window.zto.secrets.lock().then(refresh)
  }

  const fmtTime = (ts: string): string =>
    new Date(ts).toLocaleString(locale === 'ko' ? 'ko-KR' : 'en-US', {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit'
    })

  return (
    <div className="sec-panel">
      <div className="sec-col">
        <div className="form-label">{m.accounts.secPolicyTitle}</div>
        <ul className="sec-policies">
          {m.accounts.secPolicies.map((p, i) => (
            <li key={i}>{p}</li>
          ))}
        </ul>
      </div>
      <div className="sec-col">
        <div className="form-label">{m.accounts.secStateTitle}</div>
        <div className="sec-state">
          <div className="sec-row">
            <span>{m.accounts.secBiometry}</span>
            <span className={`status-chip ${status?.biometry ? 'ok' : 'warn'}`}>
              {status?.biometry ? m.accounts.secAvailable : m.accounts.secUnavailable}
            </span>
          </div>
          <div className="sec-row">
            <span>{m.accounts.secLockLabel}</span>
            <span className="sec-lock">
              <span className={`status-chip ${lock.unlocked ? 'warn' : 'ok'}`}>
                {lock.unlocked
                  ? m.accounts.secUnlockedFor.replace(
                      '{m}',
                      String(Math.ceil(lock.remainingMs / 60_000))
                    )
                  : m.accounts.secLocked}
              </span>
              {lock.unlocked && (
                <button className="choice tiny" onClick={lockNow}>
                  {m.accounts.lockNow}
                </button>
              )}
            </span>
          </div>
          <div className="sec-row">
            <span>{m.accounts.secCount}</span>
            <span>{m.accounts.secCountUnit.replace('{n}', String(status?.secretCount ?? 0))}</span>
          </div>
        </div>
        <div className="form-label" style={{ marginTop: 14 }}>
          {m.accounts.accessLogTitle}
        </div>
        {log.length === 0 ? (
          <p className="secret-note-inline">{m.accounts.accessLogEmpty}</p>
        ) : (
          <div className="sec-log">
            {log.map((e, i) => (
              <div key={i} className={`sec-log-row ${e.ok ? '' : 'denied'}`}>
                <span className="sec-log-time">{fmtTime(e.ts)}</span>
                <span className="sec-log-what">
                  {e.email} · {PLATFORM_NAMES[e.appId] ?? e.appId}
                </span>
                <span>
                  {
                    {
                      reveal: m.accounts.actionReveal,
                      copy: m.accounts.actionCopy,
                      save: m.accounts.actionSave,
                      update: m.accounts.actionUpdate,
                      delete: m.accounts.actionDelete
                    }[e.action]
                  }
                  {!e.ok && ` (${m.accounts.deniedLabel})`}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

function AccountRow({
  account,
  onSetApps
}: {
  account: Account
  onSetApps: (id: string, apps: string[]) => void
}): React.JSX.Element {
  const { m } = useI18n()
  const [open, setOpen] = useState(false)
  const [editingApps, setEditingApps] = useState(false)
  const [secretApps, setSecretApps] = useState<string[]>([])
  const apps = account.apps ?? []

  const loadSecrets = (): void => {
    window.zto.secrets.list(account.email).then(setSecretApps)
  }

  useEffect(() => {
    if (open) loadSecrets()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, account.email])

  const toggle = (appId: string): void => {
    const next = apps.includes(appId) ? apps.filter((a) => a !== appId) : [...apps, appId]
    onSetApps(account.id, next)
  }

  return (
    <div className="acc-block">
      <button className="acc-row" onClick={() => setOpen(!open)}>
        <span className="avatar" style={{ background: avatarGradient(account.email) }}>
          {account.email[0]?.toUpperCase()}
        </span>
        <span className="acc-main">
          <span className="acc-email">{account.email}</span>
          {account.memo && <span className="acc-memo">{account.memo}</span>}
        </span>
        <span className="acc-apps">
          {apps.slice(0, 6).map((id) => (
            <span
              key={id}
              className="mini-ic"
              style={{ background: platformTint(id) }}
              title={PLATFORM_NAMES[id] ?? id}
            >
              <PlatformIcon id={id} size={13} />
            </span>
          ))}
          {apps.length > 6 && <span className="more-count">+{apps.length - 6}</span>}
        </span>
        <span className={`chevron ${open ? 'open' : ''}`}>›</span>
      </button>

      {open && (
        <div className="acc-detail">
          <div className="acc-detail-head">
            <span className="form-label">{m.accounts.connectedApps}</span>
            <button
              className={`choice tiny ${editingApps ? 'toggled' : ''}`}
              onClick={() => setEditingApps(!editingApps)}
            >
              {editingApps ? m.accounts.done : m.accounts.editApps}
            </button>
          </div>
          {editingApps ? (
            <AppPicker selected={apps} onToggle={toggle} />
          ) : apps.length === 0 ? (
            <span className="no-apps">{m.accounts.noApps}</span>
          ) : (
            <div className="app-rows">
              {apps.map((id) => (
                <AppSecretRow
                  key={id}
                  email={account.email}
                  appId={id}
                  hasSecret={secretApps.includes(id)}
                  onStored={loadSecrets}
                />
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

function AddAccountForm({
  onSaved,
  onCancel
}: {
  onSaved: (list: Account[]) => void
  onCancel: () => void
}): React.JSX.Element {
  const { m } = useI18n()
  const [email, setEmail] = useState('')
  const [memo, setMemo] = useState('')
  const [apps, setApps] = useState<string[]>([])

  const save = (): void => {
    const trimmed = email.trim()
    if (!trimmed) return
    window.zto.accounts.add(trimmed, memo.trim(), apps).then(onSaved)
  }

  const toggleApp = (id: string): void => {
    setApps((prev) => (prev.includes(id) ? prev.filter((a) => a !== id) : [...prev, id]))
  }

  return (
    <div className="form-card">
      <div className="form-card-title">{m.accounts.formTitle}</div>
      <label className="form-field">
        <span className="form-label">{m.accounts.emailLabel}</span>
        <input
          className="email-input"
          type="email"
          placeholder={m.accounts.emailPlaceholder}
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && save()}
          autoFocus
        />
      </label>
      <label className="form-field">
        <span className="form-label">{m.accounts.memoLabel}</span>
        <input
          className="email-input"
          type="text"
          placeholder={m.accounts.memoPlaceholder}
          value={memo}
          onChange={(e) => setMemo(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && save()}
        />
      </label>
      <div className="form-field">
        <span className="form-label">{m.accounts.connectedApps}</span>
        <AppPicker selected={apps} onToggle={toggleApp} />
      </div>
      <div className="form-actions">
        <button className="choice small" onClick={onCancel}>
          {m.accounts.cancel}
        </button>
        <button className="choice small active" onClick={save} disabled={!email.trim()}>
          {m.accounts.add}
        </button>
      </div>
    </div>
  )
}

export default function AccountsPage(): React.JSX.Element {
  const { m } = useI18n()
  const [accounts, setAccounts] = useState<Account[]>([])
  const [showForm, setShowForm] = useState(false)
  const [showSecurity, setShowSecurity] = useState(false)
  const [filter, setFilter] = useState<string | null>(null)

  useEffect(() => {
    window.zto.accounts.list().then(setAccounts)
  }, [])

  const setAccountApps = (id: string, next: string[]): void => {
    window.zto.accounts.setApps(id, next).then(setAccounts)
  }

  // 앱별 통계 — "이 소셜미디어에 내 계정이 몇 개" 뷰의 재료
  const usedApps = useMemo(() => {
    const counts = new Map<string, number>()
    for (const a of accounts)
      for (const app of a.apps ?? []) counts.set(app, (counts.get(app) ?? 0) + 1)
    return PLATFORMS.filter((p) => counts.has(p.id)).map((p) => ({
      ...p,
      count: counts.get(p.id)!
    }))
  }, [accounts])

  const visible = filter ? accounts.filter((a) => (a.apps ?? []).includes(filter)) : accounts

  return (
    <section>
      <div className="page-head">
        <div>
          <h1>{m.accounts.title}</h1>
          <p className="placeholder">{m.accounts.subtitle}</p>
        </div>
        <div className="head-actions">
          <button
            className={`choice small nowrap ${showSecurity ? 'toggled' : ''}`}
            onClick={() => setShowSecurity(!showSecurity)}
          >
            {m.accounts.security}
          </button>
          {!showForm && accounts.length > 0 && (
            <button className="choice active nowrap" onClick={() => setShowForm(true)}>
              {m.accounts.addAccount}
            </button>
          )}
        </div>
      </div>

      {showSecurity && <SecurityPanel />}

      {showForm && (
        <AddAccountForm
          onSaved={(list) => {
            setAccounts(list)
            setShowForm(false)
          }}
          onCancel={() => setShowForm(false)}
        />
      )}

      {usedApps.length > 0 && (
        <div className="stat-grid">
          <button
            className={`stat-tile ${filter === null ? 'active' : ''}`}
            onClick={() => setFilter(null)}
          >
            <span className="tile-ic all">@</span>
            <span className="tile-count">{accounts.length}</span>
            <span className="tile-name">{m.accounts.all}</span>
          </button>
          {usedApps.map((p) => (
            <button
              key={p.id}
              className={`stat-tile ${filter === p.id ? 'active' : ''}`}
              onClick={() => setFilter(filter === p.id ? null : p.id)}
            >
              <span className="tile-ic" style={{ background: platformTint(p.id) }}>
                <PlatformIcon id={p.id} size={18} />
              </span>
              <span className="tile-count">{p.count}</span>
              <span className="tile-name">{p.name}</span>
            </button>
          ))}
        </div>
      )}

      {accounts.length === 0 && !showForm ? (
        <div className="empty-state">
          <p>{m.accounts.empty}</p>
          <button className="choice active" onClick={() => setShowForm(true)}>
            {m.accounts.addAccount}
          </button>
        </div>
      ) : (
        <div className="panel">
          {visible.map((a) => (
            <AccountRow key={a.id} account={a} onSetApps={setAccountApps} />
          ))}
        </div>
      )}
    </section>
  )
}
