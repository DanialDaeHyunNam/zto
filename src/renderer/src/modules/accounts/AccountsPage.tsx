import { useEffect, useMemo, useRef, useState } from 'react'
import {
  PLATFORM_DOMAINS,
  PLATFORMS,
  type AccessLogEntry,
  type Account,
  type SecretVersion
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
    { key: 'saas', label: m.accounts.catSaas },
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
  // 교체된 옛 비밀번호 — 목록(시각만)은 카드를 열면 바로, 값은 [보기]마다 생체 관문
  const [prev, setPrev] = useState<SecretVersion[]>([])
  const [prevOpen, setPrevOpen] = useState(false)
  const [prevShown, setPrevShown] = useState<Record<string, string>>({})
  const hideTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    return () => {
      if (hideTimer.current) clearTimeout(hideTimer.current)
    }
  }, [])

  useEffect(() => {
    if (open && hasSecret) {
      window.zto.secrets.updatedAt(email, appId).then(setUpdatedAt)
      window.zto.secrets.history(email, appId).then(setPrev)
    }
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
          window.zto.secrets.history(email, appId).then(setPrev)
          setPrevShown({}) // 방금 값이 옛 값 자리로 내려간다 — 열려 있던 평문은 접는다
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

  // 옛 값 하나를 연다. 30분 세션을 무시하고 매번 인증(main의 strict 관문) — 현재 값과 같은 규칙
  const revealPrev = (at: string): void => {
    if (prevShown[at]) {
      setPrevShown((v) => {
        const next = { ...v }
        delete next[at]
        return next
      })
      return
    }
    window.zto.secrets
      .revealPrev(email, appId, at)
      .then((v) => v !== null && setPrevShown((cur) => ({ ...cur, [at]: v })))
      .catch(() => flash(m.accounts.authFailed))
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
      delete: m.accounts.actionDelete,
      'reveal-prev': m.accounts.actionRevealPrev
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
          {hasSecret && prev.length > 0 && (
            <div className="pw-row">
              <span className="pw-label">{m.accounts.prevTitle}</span>
              <span className="pw-value">
                <button className="ghost-btn" onClick={() => setPrevOpen(!prevOpen)}>
                  {prevOpen
                    ? m.accounts.prevHide
                    : m.accounts.prevShow.replace('{n}', String(prev.length))}
                </button>
              </span>
            </div>
          )}
          {hasSecret && prevOpen && (
            <div className="sec-log">
              {prev.map((v) => (
                <div key={v.at} className="sec-log-row">
                  <span className="sec-log-time">
                    {m.accounts.prevReplaced.replace('{d}', fmtDate(v.at))}
                  </span>
                  <span className="sec-log-what">
                    {prevShown[v.at] ? (
                      <code className="secret-value">{prevShown[v.at]}</code>
                    ) : (
                      <span className="pw-mask">••••••••••</span>
                    )}
                  </span>
                  <button className="ghost-btn" onClick={() => revealPrev(v.at)}>
                    {prevShown[v.at] ? m.accounts.secretHide : m.accounts.secretReveal}
                  </button>
                </div>
              ))}
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
                  {(['reveal', 'reveal-prev', 'copy', 'save', 'update', 'delete'] as const)
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
  showMemo,
  onSetApps,
  onSetMemo,
  onRename,
  onDelete
}: {
  account: Account
  showMemo: boolean
  onSetApps: (id: string, apps: string[]) => void
  onSetMemo: (id: string, memo: string) => void
  onRename: (id: string, email: string) => Promise<string | null> // 실패 사유 키 or null
  onDelete: (id: string) => void
}): React.JSX.Element {
  const { m } = useI18n()
  const [open, setOpen] = useState(false)
  const [editingApps, setEditingApps] = useState(false)
  const [memoEditing, setMemoEditing] = useState(false)
  const [confirmDeleteAcc, setConfirmDeleteAcc] = useState(false)
  const [idEditing, setIdEditing] = useState(false)
  const [idDraft, setIdDraft] = useState('')
  const [idErr, setIdErr] = useState<string | null>(null)
  const [idBusy, setIdBusy] = useState(false)
  const [memoDraft, setMemoDraft] = useState('')
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
          {showMemo &&
            (account.memo ? (
              <span className="acc-memo">{account.memo}</span>
            ) : (
              <span className="acc-memo empty">{m.accounts.noMemo}</span>
            ))}
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
          {/* 식별자(이메일/핸들) 편집. 값이 비밀번호 키·접근 로그의 열쇠라 main이 셋을 함께 옮긴다 —
              화면은 그 사실을 알려주기만 하면 된다(비밀번호가 있으면 인증 관문이 뜬다) */}
          <div className="acc-detail-head">
            <span className="form-label">{m.accounts.identifier}</span>
            <button
              className={`choice tiny ${idEditing ? 'toggled' : ''}`}
              onClick={() => {
                setIdErr(null)
                setIdDraft(account.email)
                setIdEditing(!idEditing)
              }}
            >
              {idEditing ? m.accounts.cancel : m.accounts.idEdit}
            </button>
          </div>
          {idEditing ? (
            <div className="memo-edit">
              <input
                className="email-input"
                value={idDraft}
                onChange={(e) => {
                  setIdDraft(e.target.value)
                  setIdErr(null)
                }}
                autoFocus
              />
              <span className="memo-actions">
                <button
                  className="choice small active"
                  disabled={idBusy || !idDraft.trim() || idDraft.trim() === account.email}
                  onClick={async () => {
                    setIdBusy(true)
                    const err = await onRename(account.id, idDraft.trim())
                    setIdBusy(false)
                    if (err) setIdErr(err)
                    else setIdEditing(false)
                  }}
                >
                  {m.accounts.save}
                </button>
              </span>
              {idErr && <span className="id-err">{m.accounts.idErrors[idErr] ?? idErr}</span>}
              {secretApps.length > 0 && (
                <span className="secret-note-inline">{m.accounts.idRenameSecrets}</span>
              )}
            </div>
          ) : (
            <span className="acc-id-view">{account.email}</span>
          )}

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

          <div className="memo-row">
            <span className="form-label">{m.accounts.memoLabel}</span>
            {memoEditing ? (
              <span className="memo-edit">
                <textarea
                  className="email-input memo-area"
                  rows={3}
                  placeholder={m.accounts.memoPlaceholder}
                  value={memoDraft}
                  onChange={(e) => setMemoDraft(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                      onSetMemo(account.id, memoDraft.trim())
                      setMemoEditing(false)
                    }
                  }}
                  autoFocus
                />
                <span className="memo-actions">
                  <button
                    className="choice tiny active"
                    onClick={() => {
                      onSetMemo(account.id, memoDraft.trim())
                      setMemoEditing(false)
                    }}
                  >
                    {m.accounts.save}
                  </button>
                  <button className="choice tiny" onClick={() => setMemoEditing(false)}>
                    {m.accounts.cancel}
                  </button>
                </span>
              </span>
            ) : (
              <span className="memo-view">
                {account.memo && <span className="memo-text">{account.memo}</span>}
                <button
                  className="ghost-btn"
                  onClick={() => {
                    setMemoDraft(account.memo)
                    setMemoEditing(true)
                  }}
                >
                  {account.memo ? m.accounts.memoEdit : m.accounts.memoAdd}
                </button>
              </span>
            )}
          </div>

          <div className="acc-detail-foot">
            <button
              className={`act-btn delete ${confirmDeleteAcc ? 'arm' : ''}`}
              onClick={() => {
                if (!confirmDeleteAcc) {
                  setConfirmDeleteAcc(true)
                  setTimeout(() => setConfirmDeleteAcc(false), 3000)
                  return
                }
                onDelete(account.id)
              }}
            >
              {confirmDeleteAcc ? m.accounts.deleteSure : m.accounts.deleteAccount}
            </button>
          </div>
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

// gated = 체험 만료(공식 빌드) — 열람·복사·검색은 그대로 두고 **계정 추가만** 잠근다.
// 이미 맡긴 데이터는 사용자 것이라 결제 뒤에 가두지 않는다(인질 금지)
export default function AccountsPage({ gated = false }: { gated?: boolean }): React.JSX.Element {
  const { m } = useI18n()
  const [accounts, setAccounts] = useState<Account[]>([])
  const [showForm, setShowForm] = useState(false)
  const [showSecurity, setShowSecurity] = useState(false)
  const [filter, setFilter] = useState<string | null>(null)
  const [showMemos, setShowMemos] = useState(() => localStorage.getItem('zto-show-memos') !== '0')

  const toggleMemos = (): void => {
    const next = !showMemos
    localStorage.setItem('zto-show-memos', next ? '1' : '0')
    setShowMemos(next)
  }

  useEffect(() => {
    window.zto.accounts.list().then(setAccounts)
  }, [])

  const setAccountApps = (id: string, next: string[]): void => {
    window.zto.accounts.setApps(id, next).then(setAccounts)
  }

  const setAccountMemo = (id: string, memo: string): void => {
    window.zto.accounts.setMemo(id, memo).then(setAccounts)
  }

  // 실패 사유를 그대로 돌려준다 — 화면이 "왜 안 됐는지"를 말할 수 있어야 한다
  // (중복·인증취소·빈 값이 각각 다른 대응을 요구한다)
  const renameAccount = async (id: string, email: string): Promise<string | null> => {
    const r = await window.zto.accounts.rename(id, email)
    setAccounts(r.accounts)
    return r.ok ? null : (r.error ?? 'failed')
  }

  const deleteAccount = (id: string): void => {
    window.zto.accounts
      .delete(id)
      .then(setAccounts)
      .catch(() => {
        /* 인증 취소 — 아무것도 안 함 */
      })
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
          {!showForm && accounts.length > 0 && !gated && (
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

      {accounts.length > 0 && (
        <div className="list-tools">
          <span className="switch-row">
            <span className="switch-label">{m.accounts.showMemos}</span>
            <button
              className={`switch ${showMemos ? 'on' : ''}`}
              onClick={toggleMemos}
              role="switch"
              aria-checked={showMemos}
            >
              <span className="knob" />
            </button>
          </span>
        </div>
      )}

      {accounts.length === 0 && !showForm ? (
        <div className="empty-state">
          <p>{m.accounts.empty}</p>
          {!gated && (
            <button className="choice active" onClick={() => setShowForm(true)}>
              {m.accounts.addAccount}
            </button>
          )}
        </div>
      ) : (
        <div className="panel">
          {visible.map((a) => (
            <AccountRow
              key={a.id}
              account={a}
              showMemo={showMemos}
              onSetApps={setAccountApps}
              onSetMemo={setAccountMemo}
              onRename={renameAccount}
              onDelete={deleteAccount}
            />
          ))}
        </div>
      )}
    </section>
  )
}
