import { useCallback, useEffect, useState } from 'react'
import {
  EMAIL_RE,
  suggestEmailDomain,
  type CredentialStatus,
  type DevAccounts,
  type RunResult,
  type SheetIapInfo,
  type SheetSummary,
  type StoreKind
} from '../../../../shared/launch-types'
import { useI18n } from '../../i18n'
import type { Messages } from '../../i18n/en'
import { PlatformIcon } from '../../platform-icons'

type IapChoice = 'undecided' | 'yes' | 'no'

const STORE_URLS: Record<StoreKind, string> = {
  play: 'https://play.google.com/console/signup',
  apple: 'https://developer.apple.com/programs/enroll/'
}

// 로그인 검증용 콘솔 주소 — "가서 실제로 로그인되는지 확인"
const CONSOLE_URLS: Record<StoreKind, string> = {
  play: 'https://play.google.com/console',
  apple: 'https://appstoreconnect.apple.com'
}

function storeGuide(m: Messages, store: StoreKind): { name: string; cost: string; steps: string[] } {
  return store === 'play'
    ? { name: m.launch.playName, cost: m.launch.playCost, steps: m.launch.playSteps }
    : { name: m.launch.appleName, cost: m.launch.appleCost, steps: m.launch.appleSteps }
}

function DevAccountRow({
  store,
  state,
  onSet
}: {
  store: StoreKind
  state?: { status: 'yes' | 'no'; email?: string }
  onSet: (store: StoreKind, status: 'yes' | 'no', email?: string) => void
}): React.JSX.Element {
  const { m } = useI18n()
  const guide = storeGuide(m, store)
  const status = state?.status
  const iconId = store === 'play' ? 'play-console' : 'app-store-connect'
  const [editing, setEditing] = useState(false)
  const [emailDraft, setEmailDraft] = useState('')
  const [err, setErr] = useState('')
  const [suggestion, setSuggestion] = useState<string | null>(null)

  const commit = (val: string | undefined): void => {
    onSet(store, 'yes', val || undefined)
    setEditing(false)
    setErr('')
    setSuggestion(null)
  }

  const saveEmail = (): void => {
    const val = emailDraft.trim()
    if (!val) return commit(undefined)
    if (!EMAIL_RE.test(val)) {
      setErr(m.launch.emailInvalid)
      setSuggestion(null)
      return
    }
    const sug = suggestEmailDomain(val)
    if (sug && suggestion !== sug) {
      setErr('')
      setSuggestion(sug) // 오타 추정 — 한 번은 확인을 거치게 한다
      return
    }
    commit(val)
  }

  return (
    <div className="store-block">
      <div className="store-row">
        <div className="store-ic">
          <PlatformIcon id={iconId} />
        </div>
        <div className="store-info">
          <div className="store-name">
            {guide.name}
            <span className="store-cost">{guide.cost}</span>
          </div>
          <div className="store-sub-line">
            {status === 'yes' ? (
              <>
                {state?.email ? (
                  <>
                    <span className="sub-email">{state.email}</span>
                    <span className="sub-linked">✓ {m.launch.linkedToInventory}</span>
                  </>
                ) : (
                  <span className="store-sub warn">{m.launch.ownerNotSet}</span>
                )}
                {!editing && (
                  <span className="sub-actions">
                    <button
                      className="ghost-btn mini"
                      onClick={() => {
                        setEmailDraft(state?.email ?? '')
                        setEditing(true)
                      }}
                    >
                      {m.launch.editEmail}
                    </button>
                    {state?.email && (
                      <button
                        className="ghost-btn mini"
                        onClick={() => window.zto.launch.openExternal(CONSOLE_URLS[store])}
                      >
                        {m.launch.verifyLogin}
                      </button>
                    )}
                  </span>
                )}
              </>
            ) : (
              <span className={`store-sub ${status === 'no' ? 'warn' : ''}`}>
                {status === 'no' ? m.launch.notHaveHint : m.launch.selectPrompt}
              </span>
            )}
          </div>
        </div>
        <div className="seg">
          <button
            className={status === 'yes' ? 'active' : ''}
            onClick={() => {
              setEmailDraft(state?.email ?? '')
              setEditing(true)
            }}
          >
            {m.launch.have}
          </button>
          <button
            className={status === 'no' ? 'active' : ''}
            onClick={() => {
              setEditing(false)
              onSet(store, 'no')
            }}
          >
            {m.launch.notHave}
          </button>
        </div>
      </div>
      {editing && (
        <>
          <div className="email-row">
            <input
              className="email-input"
              type="email"
              placeholder={m.launch.ownerEmailPlaceholder}
              value={emailDraft}
              onChange={(e) => {
                setEmailDraft(e.target.value)
                setErr('')
                setSuggestion(null)
              }}
              onKeyDown={(e) => e.key === 'Enter' && saveEmail()}
              autoFocus
            />
            <button className="choice small active" onClick={saveEmail}>
              {m.launch.save}
            </button>
          </div>
          {err && <p className="field-err">{err}</p>}
          {suggestion && (
            <div className="suggest-row">
              <span>{m.launch.didYouMean.replace('{s}', suggestion)}</span>
              <button className="choice tiny active" onClick={() => commit(suggestion)}>
                {m.launch.applySuggestion}
              </button>
              <button className="choice tiny" onClick={() => commit(emailDraft.trim())}>
                {m.launch.saveAsIs}
              </button>
            </div>
          )}
        </>
      )}
      {status === 'no' && !editing && (
        <div className="guide">
          <ol>
            {guide.steps.map((s, i) => (
              <li key={i}>{s}</li>
            ))}
          </ol>
          <button
            className="link-btn"
            onClick={() => window.zto.launch.openExternal(STORE_URLS[store])}
          >
            {m.launch.openEnrollPage}
          </button>
          <button
            className="link-btn"
            onClick={() => {
              setEmailDraft('')
              setEditing(true)
            }}
          >
            {m.launch.enrolledNowLink}
          </button>
        </div>
      )}
    </div>
  )
}

function CredRow({
  title,
  ok,
  detail,
  guideIntro,
  steps,
  linkLabel,
  url
}: {
  title: string
  ok: boolean
  detail?: string
  guideIntro: string
  steps: string[]
  linkLabel: string
  url: string
}): React.JSX.Element {
  const { m } = useI18n()
  return (
    <div className="store-block">
      <div className="store-row">
        <div className="store-info">
          <div className="store-name">
            {title}
            <span className={`status-chip ${ok ? 'ok' : 'warn'}`}>
              {ok ? m.launch.credOk : m.launch.credMissing}
            </span>
          </div>
          {ok && detail && <div className="store-sub">{detail}</div>}
        </div>
      </div>
      {!ok && (
        <div className="guide">
          <p>{guideIntro}</p>
          <ol>
            {steps.map((s, i) => (
              <li key={i}>{s}</li>
            ))}
          </ol>
          <button className="link-btn" onClick={() => window.zto.launch.openExternal(url)}>
            {linkLabel}
          </button>
        </div>
      )}
    </div>
  )
}



// 2단계 인라인 시트 생성 폼 — 파일 작업 없이 GUI에서 완결
function NewSheetForm({
  onCreated,
  onCancel
}: {
  onCreated: (file: string) => void
  onCancel: () => void
}): React.JSX.Element {
  const { m } = useI18n()
  const [name, setName] = useState('')
  const [pkg, setPkg] = useState('')
  const [bundle, setBundle] = useState('')
  const [err, setErr] = useState('')

  const create = (): void => {
    if (!name.trim() || !pkg.trim()) {
      setErr(m.launch.sheetInvalid)
      return
    }
    window.zto.launch.createSheet(name.trim(), pkg.trim(), bundle.trim()).then((r) => {
      if (r.ok && r.file) onCreated(r.file)
      else setErr(r.error === 'exists' ? m.launch.sheetExists : m.launch.sheetInvalid)
    })
  }

  return (
    <div className="form-card slim">
      <div className="form-card-title">{m.launch.newAppTitle}</div>
      <label className="form-field">
        <span className="form-label">{m.launch.appNameLabel}</span>
        <input
          className="email-input"
          value={name}
          placeholder={m.launch.appNamePlaceholder}
          onChange={(e) => setName(e.target.value)}
          autoFocus
        />
      </label>
      <label className="form-field">
        <span className="form-label">{m.launch.packageLabel}</span>
        <input
          className="email-input"
          value={pkg}
          placeholder={m.launch.packagePlaceholder}
          onChange={(e) => setPkg(e.target.value)}
        />
      </label>
      <label className="form-field">
        <span className="form-label">{m.launch.bundleLabel}</span>
        <input
          className="email-input"
          value={bundle}
          placeholder={pkg || m.launch.packagePlaceholder}
          onChange={(e) => setBundle(e.target.value)}
        />
      </label>
      {err && <p className="field-err no-indent">{err}</p>}
      <div className="form-actions">
        <button className="choice small" onClick={onCancel}>
          {m.accounts.cancel}
        </button>
        <button className="choice small active" onClick={create} disabled={!name.trim() || !pkg.trim()}>
          {m.launch.create}
        </button>
      </div>
    </div>
  )
}


// 기존 앱 가져오기 — 패키지명 + (선택) SA 검증
function ImportSheetForm({
  onCreated,
  onCancel
}: {
  onCreated: (file: string) => void
  onCancel: () => void
}): React.JSX.Element {
  const { m } = useI18n()
  const [name, setName] = useState('')
  const [pkg, setPkg] = useState('')
  const [saPath, setSaPath] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')

  const [ascApps, setAscApps] = useState<{ name: string; bundleId: string }[]>([])

  useEffect(() => {
    window.zto.launch.lastSa().then(setSaPath)
    window.zto.launch.listAscApps().then(setAscApps)
  }, [])

  const doImport = (): void => {
    if (!pkg.trim()) {
      setErr(m.launch.importPkgRequired)
      return
    }
    setBusy(true)
    setErr('')
    window.zto.launch.importApp(name.trim(), pkg.trim(), saPath.trim()).then((r) => {
      setBusy(false)
      if (r.ok && r.file) {
        onCreated(r.file)
        return
      }
      if (r.error === 'exists') setErr(m.launch.sheetExists)
      else if (r.error === 'verify-failed')
        setErr(m.launch.verifyFailed.replace('{d}', r.detail ?? ''))
      else setErr(m.launch.importPkgRequired)
    })
  }

  return (
    <div className="form-card slim">
      <div className="form-card-title">{m.launch.importTitle}</div>
      {ascApps.length > 0 && (
        <div className="form-field">
          <span className="form-label">{m.launch.ascPickLabel}</span>
          <div className="app-picker">
            {ascApps.map((a) => (
              <button
                key={a.bundleId}
                type="button"
                className={`app-chip ${pkg === a.bundleId ? 'active' : ''}`}
                onClick={() => {
                  setName(a.name)
                  setPkg(a.bundleId)
                }}
              >
                <PlatformIcon id="app-store-connect" />
                {a.name}
              </button>
            ))}
          </div>
        </div>
      )}
      <label className="form-field">
        <span className="form-label">{m.launch.packageLabel}</span>
        <input
          className="email-input"
          value={pkg}
          placeholder={m.launch.packagePlaceholder}
          onChange={(e) => setPkg(e.target.value)}
          autoFocus
        />
      </label>
      <label className="form-field">
        <span className="form-label">{m.launch.appNameLabel}</span>
        <input
          className="email-input"
          value={name}
          placeholder={m.launch.appNamePlaceholder}
          onChange={(e) => setName(e.target.value)}
        />
      </label>
      <label className="form-field">
        <span className="form-label">{m.launch.saPathLabel}</span>
        <input
          className="email-input"
          value={saPath}
          placeholder={m.launch.saPathPlaceholder}
          onChange={(e) => setSaPath(e.target.value)}
        />
      </label>
      {err && <p className="field-err no-indent">{err}</p>}
      <div className="form-actions">
        <button className="choice small" onClick={onCancel} disabled={busy}>
          {m.accounts.cancel}
        </button>
        <button className="choice small active" onClick={doImport} disabled={busy || !pkg.trim()}>
          {busy ? m.launch.verifying : m.launch.importBtn}
        </button>
      </div>
    </div>
  )
}

interface LiveIap {
  google: { id: string; title: string; state: string }[] | null
  googleError?: string
  apple: { id: string; name: string; state: string }[] | null
  appleError?: string
}

// 스토어 실황 IAP — 기존 앱은 스토어가 진실. iOS/Android를 따로 보여준다.
function LiveIapStatus({ file, stepNo }: { file: string; stepNo: number }): React.JSX.Element {
  const { m } = useI18n()
  const [live, setLive] = useState<LiveIap | null>(null)

  useEffect(() => {
    setLive(null)
    window.zto.launch.storeIap(file).then(setLive)
  }, [file])

  const errLabel = (e?: string): string =>
    e === 'no-key' ? m.launch.liveNoCreds : m.launch.liveError.replace('{d}', e ?? '')

  const block = (
    iconId: string,
    label: string,
    items: { id: string; label: string; state: string }[] | null,
    error?: string
  ): React.JSX.Element => (
    <div className="store-block">
      <div className="store-row">
        <div className="store-ic">
          <PlatformIcon id={iconId} />
        </div>
        <div className="store-info">
          <div className="store-name">
            {label}
            {items && (
              <span className="status-chip ok">
                {items.length}
              </span>
            )}
            {error && <span className="status-chip warn">{errLabel(error)}</span>}
          </div>
          {items && items.length === 0 && <div className="store-sub">{m.launch.liveNone}</div>}
        </div>
      </div>
      {items && items.length > 0 && (
        <div className="product-list live">
          {items.map((p) => (
            <div key={p.id} className="product-row">
              <code>{p.id}</code>
              <span className="product-title">{p.label}</span>
              <span className={`status-chip ${p.state.toUpperCase().includes('APPROVED') || p.state === 'ACTIVE' ? 'ok' : 'warn'}`}>
                {p.state.toLowerCase().replace(/_/g, ' ')}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  )

  return (
    <div className="step">
      <div className="step-head">
        <span className="step-no">{stepNo}</span> {m.launch.stepStoreStatus}
      </div>
      {!live ? (
        <p className="step-empty">{m.launch.liveLoading}</p>
      ) : (
        <div className="rows">
          {block(
            'play-console',
            'Google Play',
            live.google?.map((g) => ({ id: g.id, label: g.title, state: g.state })) ?? null,
            live.googleError
          )}
          {block(
            'app-store-connect',
            'App Store',
            live.apple?.map((a) => ({ id: a.id, label: a.name, state: a.state })) ?? null,
            live.appleError
          )}
        </div>
      )}
    </div>
  )
}

type IapAction = 'upsert' | 'activate'


// 5단계 — 검증된 CLI 실행. 비가역 액션이라 2단 컨펌 게이트 (SPEC §3)
function ApplyStep({
  file,
  googleOk,
  stepNo
}: {
  file: string
  googleOk: boolean
  stepNo: number
}): React.JSX.Element {
  const { m } = useI18n()
  const [info, setInfo] = useState<SheetIapInfo | null>(null)
  const [runState, setRunState] = useState<Record<IapAction, 'idle' | 'confirm' | 'running'>>({
    upsert: 'idle',
    activate: 'idle'
  })
  const [results, setResults] = useState<Partial<Record<IapAction, RunResult>>>({})

  useEffect(() => {
    window.zto.launch.sheetIap(file).then(setInfo)
  }, [file])

  const run = (action: IapAction): void => {
    if (runState[action] === 'running') return
    if (runState[action] === 'idle') {
      setRunState((s) => ({ ...s, [action]: 'confirm' }))
      setTimeout(() => setRunState((s) => (s[action] === 'confirm' ? { ...s, [action]: 'idle' } : s)), 4000)
      return
    }
    setRunState((s) => ({ ...s, [action]: 'running' }))
    window.zto.launch.runIap(file, action).then((r) => {
      setResults((prev) => ({ ...prev, [action]: r }))
      setRunState((s) => ({ ...s, [action]: 'idle' }))
    })
  }

  const actionRow = (action: IapAction, label: string): React.JSX.Element => {
    const state = runState[action]
    const result = results[action]
    return (
      <div className="run-block">
        <div className="run-row">
          <button
            className={`choice small ${state === 'confirm' ? 'danger-confirm' : ''}`}
            disabled={!googleOk || state === 'running'}
            onClick={() => run(action)}
          >
            {state === 'running'
              ? m.launch.running
              : state === 'confirm'
                ? m.launch.reallyRun
                : label}
          </button>
          {result && (
            <span className={`status-chip ${result.ok ? 'ok' : 'warn'}`}>
              {result.ok ? m.launch.resultOk : m.launch.resultFail}
            </span>
          )}
        </div>
        {result && (
          <pre className="run-output">
            {typeof result.output === 'string'
              ? result.output
              : JSON.stringify(result.output, null, 2)}
            {result.stderr ? `\n--- stderr ---\n${result.stderr}` : ''}
          </pre>
        )}
      </div>
    )
  }

  return (
    <div className="step">
      <div className="step-head">
        <span className="step-no">{stepNo}</span> {m.launch.stepApply}
      </div>
      {!info ? (
        <p className="step-empty">{m.launch.checking}</p>
      ) : info.products.length === 0 ? (
        <p className="step-empty">{m.launch.noProducts}</p>
      ) : (
        <>
          <div className="form-label">{m.launch.applyProducts}</div>
          <div className="product-list">
            {info.products.map((p) => (
              <div key={p.productId} className="product-row">
                <code>{p.productId}</code>
                <span className="product-title">{p.title}</span>
                <span className="product-price">{p.priceLabel}</span>
              </div>
            ))}
          </div>
          <p className="step-note warn-note">{m.launch.applyIrreversible}</p>
          {!googleOk && <p className="step-note">{m.launch.noGoogleSaRun}</p>}
          {actionRow('upsert', m.launch.runUpsert)}
          {actionRow('activate', m.launch.runActivate)}
        </>
      )}
      <p className="step-note">{m.launch.ascApplyPending}</p>
    </div>
  )
}

export default function LaunchPage(): React.JSX.Element {
  const { m } = useI18n()
  const [mode, setModeState] = useState<'none' | 'new' | 'existing'>(
    () => (localStorage.getItem('zto-launch-mode') as 'none' | 'new' | 'existing') ?? 'none'
  )
  const [devAccounts, setDevAccounts] = useState<DevAccounts>({})
  const [sheets, setSheets] = useState<SheetSummary[]>([])
  const [selected, setSelected] = useState<string | null>(null)
  const [iapChoice, setIapChoice] = useState<IapChoice>('undecided')
  const [creds, setCreds] = useState<CredentialStatus | null>(null)
  const [sheetForm, setSheetForm] = useState<'none' | 'new' | 'import'>('none')
  const [registered, setRegistered] = useState(false)

  useEffect(() => {
    window.zto.launch.getDevAccounts().then(setDevAccounts)
    window.zto.launch.listSheets().then(setSheets)
  }, [])

  const setMode = (next: 'none' | 'new' | 'existing'): void => {
    localStorage.setItem('zto-launch-mode', next)
    setModeState(next)
    setSelected(null)
    setIapChoice('undecided')
    setCreds(null)
    setSheetForm('none')
  }

  const setDevAccount = useCallback((store: StoreKind, status: 'yes' | 'no', email?: string) => {
    window.zto.launch.setDevAccount(store, { status, email }).then(setDevAccounts)
  }, [])

  const selectSheet = useCallback((file: string) => {
    setSelected(file)
    setIapChoice('undecided')
    setCreds(null)
    window.zto.launch.getJourney(file).then((j) => setRegistered(j.registered))
    // 아이콘이 없으면 스토어에서 가져와 캐시 (출시된 앱만 성공)
    window.zto.launch.fetchIcon(file).then((ok) => {
      if (ok) window.zto.launch.listSheets().then(setSheets)
    })
  }, [])

  const onSheetCreated = (file: string): void => {
    setSheetForm('none')
    window.zto.launch.listSheets().then(setSheets)
    selectSheet(file)
  }

  useEffect(() => {
    if (selected && iapChoice === 'yes') {
      window.zto.launch.checkCredentials(selected).then(setCreds)
    }
  }, [selected, iapChoice])

  const toggleRegistered = (): void => {
    if (!selected) return
    window.zto.launch.setJourney(selected, !registered).then((j) => setRegistered(j.registered))
  }

  const bothStoresReady = devAccounts.play?.status === 'yes' && devAccounts.apple?.status === 'yes'

  // 입구 — 신규/기존 모드 선택 (새 앱을 낼 때마다 이 여정을 다시 탄다)
  if (mode === 'none') {
    return (
      <section>
        <h1>{m.launch.title}</h1>
        <p className="placeholder">{m.launch.subtitle}</p>
        <div className="mode-grid">
          <button className="mode-card" onClick={() => setMode('new')}>
            <strong>{m.launch.modeNew}</strong>
            <span>{m.launch.modeNewDesc}</span>
          </button>
          <button className="mode-card" onClick={() => setMode('existing')}>
            <strong>{m.launch.modeExisting}</strong>
            <span>{m.launch.modeExistingDesc}</span>
          </button>
        </div>
      </section>
    )
  }

  const isNew = mode === 'new'
  const iapUnlocked = selected !== null && (!isNew || registered)
  let stepNo = 0
  const n = (): number => ++stepNo

  return (
    <section>
      <div className="page-head">
        <div>
          <h1>{isNew ? m.launch.modeNew : m.launch.modeExisting}</h1>
          <p className="placeholder">{isNew ? m.launch.modeNewDesc : m.launch.modeExistingDesc}</p>
        </div>
        <button className="choice small nowrap" onClick={() => setMode('none')}>
          {m.launch.changeMode}
        </button>
      </div>

      <div className="wizard">
        {isNew && (
          <div className="step">
            <div className="step-head">
              <span className="step-no">{n()}</span> {m.launch.stepDevAccounts}
            </div>
            <div className="rows">
              <DevAccountRow store="play" state={devAccounts.play} onSet={setDevAccount} />
              <DevAccountRow store="apple" state={devAccounts.apple} onSet={setDevAccount} />
            </div>
            {!bothStoresReady && <p className="step-note">{m.launch.stepDevAccountsNote}</p>}
          </div>
        )}

        <div className="step">
          <div className="step-head">
            <span className="step-no">{n()}</span>{' '}
            {isNew ? m.launch.stepDefineApp : m.launch.stepSelectApp}
          </div>
          <div className="sheet-list">
            {sheets.map((s) => (
              <button
                key={s.file}
                className={`sheet-card ${selected === s.file ? 'active' : ''}`}
                onClick={() => selectSheet(s.file)}
              >
                <span className="sheet-head">
                  {s.icon && <img className="sheet-icon" src={s.icon} alt="" />}
                  <strong>{s.appName}</strong>
                </span>
                <span>{s.packageName || m.launch.noPackageName}</span>
                <span>{m.launch.iapDefined.replace('{n}', String(s.iapCount))}</span>
              </button>
            ))}
            {sheetForm === 'none' &&
              (isNew ? (
                <button className="sheet-card new" onClick={() => setSheetForm('new')}>
                  <strong>{m.launch.newApp}</strong>
                </button>
              ) : (
                <button className="sheet-card new" onClick={() => setSheetForm('import')}>
                  <strong>{m.launch.importApp}</strong>
                </button>
              ))}
          </div>
          {sheetForm === 'new' && (
            <NewSheetForm onCreated={onSheetCreated} onCancel={() => setSheetForm('none')} />
          )}
          {sheetForm === 'import' && (
            <ImportSheetForm onCreated={onSheetCreated} onCancel={() => setSheetForm('none')} />
          )}
        </div>

        {!isNew && selected && <LiveIapStatus file={selected} stepNo={n()} />}

        {isNew && selected && (
          <div className="step">
            <div className="step-head">
              <span className="step-no">{n()}</span> {m.launch.stepRegister}
              {registered && <span className="status-chip ok">{m.launch.registeredBadge}</span>}
            </div>
            {!registered && (
              <div className="guide no-indent">
                <p>{m.launch.registerIntro}</p>
                <ol>
                  <li>{m.launch.registerPlay}</li>
                  <li>{m.launch.registerAsc}</li>
                </ol>
                <button
                  className="link-btn"
                  onClick={() => window.zto.launch.openExternal('https://play.google.com/console')}
                >
                  {m.launch.openPlayConsole}
                </button>
                <button
                  className="link-btn"
                  onClick={() =>
                    window.zto.launch.openExternal('https://appstoreconnect.apple.com/apps')
                  }
                >
                  {m.launch.openAscApps}
                </button>
              </div>
            )}
            <div className="choice-row" style={{ marginTop: 12 }}>
              <button
                className={`choice small ${registered ? 'toggled' : ''}`}
                onClick={toggleRegistered}
              >
                {registered ? m.launch.registerUndo : m.launch.registerDone}
              </button>
            </div>
          </div>
        )}

        {iapUnlocked && (
          <div className="step">
            <div className="step-head">
              <span className="step-no">{n()}</span> {m.launch.stepIap}
            </div>
            <div className="seg wide">
              <button
                className={iapChoice === 'yes' ? 'active' : ''}
                onClick={() => setIapChoice('yes')}
              >
                {m.launch.iapYes}
              </button>
              <button
                className={iapChoice === 'no' ? 'active' : ''}
                onClick={() => setIapChoice('no')}
              >
                {m.launch.iapNo}
              </button>
            </div>
          </div>
        )}

        {iapUnlocked && iapChoice === 'yes' && (
          <div className="step">
            <div className="step-head">
              <span className="step-no">{n()}</span> {m.launch.stepCredentials}
            </div>
            {!creds ? (
              <p className="step-empty">{m.launch.checking}</p>
            ) : (
              <div className="rows">
                <CredRow
                  title={m.launch.googleSaTitle}
                  ok={creds.googleSa.ok}
                  detail={creds.googleSa.path}
                  guideIntro={m.launch.googleSaGuideIntro}
                  steps={m.launch.googleSaSteps}
                  linkLabel={m.launch.openPlayConsole}
                  url="https://play.google.com/console"
                />
                <CredRow
                  title={m.launch.ascTitle}
                  ok={creds.asc.ok}
                  detail={`${creds.asc.keyPath} (Key ID: ${creds.asc.keyId})`}
                  guideIntro={m.launch.ascGuideIntro}
                  steps={m.launch.ascSteps}
                  linkLabel={m.launch.openAscIntegrations}
                  url="https://appstoreconnect.apple.com/access/integrations/api"
                />
              </div>
            )}
          </div>
        )}

        {iapUnlocked && iapChoice === 'yes' && creds && selected && (
          <ApplyStep file={selected} googleOk={creds.googleSa.ok} stepNo={n()} />
        )}

        {iapUnlocked && iapChoice !== 'undecided' && (
          <div className="step dim">
            <div className="step-head">
              <span className="step-no">{n()}</span> {m.launch.stepNext}
            </div>
            <ul className="todo-list">
              {isNew && <li>{m.launch.todoForms}</li>}
              {isNew && <li>{m.launch.todoBuild}</li>}
              <li>{m.launch.todoListing}</li>
              <li>{m.launch.todoChecklist}</li>
            </ul>
          </div>
        )}
      </div>
    </section>
  )
}
