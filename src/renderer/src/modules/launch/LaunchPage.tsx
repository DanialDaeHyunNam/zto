import { useCallback, useEffect, useState } from 'react'
import {
  EMAIL_RE,
  suggestEmailDomain,
  type ApiStatus,
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
import AppDashboard from './AppDashboard'

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
  // 키 파일 경로는 유저에게 주요 정보가 아님 — 기본 숨김, 필요할 때만 보기
  const [showPath, setShowPath] = useState(false)
  return (
    <div className="store-block">
      <div className="store-row">
        <div className="store-info">
          <div className="store-name">
            {title}
            <span className={`status-chip ${ok ? 'ok' : 'warn'}`}>
              {ok ? m.launch.credOk : m.launch.credMissing}
            </span>
            {ok && detail && (
              <button className="ghost-btn mini" onClick={() => setShowPath((v) => !v)}>
                {showPath ? m.launch.hidePath : m.launch.showPath}
              </button>
            )}
          </div>
          {ok && detail && showPath && <div className="store-sub">{detail}</div>}
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
// 전역 API 연결 상태 — 자격증명은 앱이 아니라 계정 단위(플랫폼당 하나). 타이틀 우측 config
function ApiStatusBar(): React.JSX.Element {
  const { m } = useI18n()
  const [status, setStatus] = useState<ApiStatus | null>(null)
  useEffect(() => {
    window.zto.launch.apiStatus().then(setStatus)
  }, [])

  const row = (
    iconId: string,
    label: string,
    st: { connected: boolean; detail: string } | undefined,
    consoleUrl: string
  ): React.JSX.Element => (
    <div className="api-stat" title={st?.detail}>
      <span className="api-ic">
        <PlatformIcon id={iconId} />
      </span>
      <span className="api-label">{label}</span>
      {status === null ? (
        // 아직 조회 중 — "미연결"로 오인되지 않게 확인중 표시
        <span className="api-checking">{m.launch.apiChecking}</span>
      ) : st?.connected ? (
        <span className="dash-dot g" />
      ) : (
        <button
          className="link-btn api-connect"
          onClick={() => window.zto.launch.openExternal(consoleUrl)}
        >
          {m.launch.apiConnect}
        </button>
      )}
    </div>
  )

  return (
    <div className="api-status">
      {row('play-console', m.launch.apiPlay, status?.play, 'https://play.google.com/console')}
      {row(
        'app-store-connect',
        m.launch.apiApple,
        status?.apple,
        'https://appstoreconnect.apple.com/access/integrations/api'
      )}
    </div>
  )
}

export default function LaunchPage(): React.JSX.Element {
  const { m } = useI18n()
  // '앱 스토어 관리'가 홈 — 신규 여정은 [+ 앱 추가 → 신규 앱 출시]로만 진입 (2026-07-22 Dan)
  const [view, setViewState] = useState<'manage' | 'new'>(
    () => (localStorage.getItem('zto-launch-view') as 'manage' | 'new') ?? 'manage'
  )
  const [devAccounts, setDevAccounts] = useState<DevAccounts>({})
  const [sheets, setSheets] = useState<SheetSummary[]>([])
  const [selected, setSelected] = useState<string | null>(null)
  const [iapChoice, setIapChoice] = useState<IapChoice>('undecided')
  const [creds, setCreds] = useState<CredentialStatus | null>(null)
  const [sheetForm, setSheetForm] = useState<'none' | 'new' | 'import'>('none')
  const [addOpen, setAddOpen] = useState(false)
  const [registered, setRegistered] = useState(false)

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

  useEffect(() => {
    window.zto.launch.getDevAccounts().then(setDevAccounts)
    window.zto.launch.listSheets().then((list) => {
      setSheets(list)
      // 관리 홈은 첫 앱을 자동 선택 — 진입 즉시 대시보드가 뜬다
      if (list.length > 0 && localStorage.getItem('zto-launch-view') !== 'new') {
        selectSheet(list[0].file)
      }
    })
  }, [selectSheet])

  const setView = (next: 'manage' | 'new'): void => {
    localStorage.setItem('zto-launch-view', next)
    setViewState(next)
    setIapChoice('undecided')
    setCreds(null)
    setSheetForm('none')
    setAddOpen(false)
  }

  const setDevAccount = useCallback((store: StoreKind, status: 'yes' | 'no', email?: string) => {
    window.zto.launch.setDevAccount(store, { status, email }).then(setDevAccounts)
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
  const iapUnlocked = view === 'new' && selected !== null && registered

  // 관리 홈 — 앱 칩 + 플랫폼 탭 대시보드
  if (view === 'manage') {
    return (
      <section>
        <div className="page-head wide">
          <div>
            <h1>{m.launch.title}</h1>
            <p className="placeholder">{m.launch.subtitle}</p>
          </div>
          <ApiStatusBar />
        </div>
        <div className="wizard wide">
          <div className="app-picker">
            {sheets.map((s) => (
              <button
                key={s.file}
                className={`app-chip big ${selected === s.file ? 'active' : ''}`}
                onClick={() => selectSheet(s.file)}
              >
                {s.icon && <img className="chip-app-icon" src={s.icon} alt="" />}
                {s.appName}
              </button>
            ))}
            <button
              className={`app-chip big add ${addOpen || sheetForm === 'import' ? 'open' : ''}`}
              onClick={() => {
                setAddOpen((v) => !v)
                setSheetForm('none')
              }}
            >
              + {m.launch.addApp}
            </button>
          </div>
          {addOpen && (
            <div className="mode-grid slim">
              <button className="mode-card" onClick={() => setView('new')}>
                <strong>{m.launch.modeNew}</strong>
                <span>{m.launch.modeNewDesc}</span>
              </button>
              <button
                className="mode-card"
                onClick={() => {
                  setAddOpen(false)
                  setSheetForm('import')
                }}
              >
                <strong>{m.launch.importApp}</strong>
                <span>{m.launch.importDesc}</span>
              </button>
            </div>
          )}
          {sheetForm === 'import' && (
            <ImportSheetForm onCreated={onSheetCreated} onCancel={() => setSheetForm('none')} />
          )}
          {selected && (
            <AppDashboard
              file={selected}
              summary={sheets.find((s) => s.file === selected)}
              onPulled={() => window.zto.launch.listSheets().then(setSheets)}
            />
          )}
        </div>
      </section>
    )
  }

  // 신규 앱 출시 여정 (스텝 위저드)
  let stepNo = 0
  const n = (): number => ++stepNo

  return (
    <section>
      <div className="page-head">
        <div>
          <h1>{m.launch.modeNew}</h1>
          <p className="placeholder">{m.launch.modeNewDesc}</p>
        </div>
        <button className="ghost-btn" onClick={() => setView('manage')}>
          ← {m.launch.title}
        </button>
      </div>

      <div className="wizard">
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

        <div className="step">
          <div className="step-head">
            <span className="step-no">{n()}</span> {m.launch.stepDefineApp}
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
            {sheetForm === 'none' && (
              <button className="sheet-card new" onClick={() => setSheetForm('new')}>
                <strong>{m.launch.newApp}</strong>
              </button>
            )}
          </div>
          {sheetForm === 'new' && (
            <NewSheetForm onCreated={onSheetCreated} onCancel={() => setSheetForm('none')} />
          )}
        </div>

        {selected && (
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
              <li>{m.launch.todoForms}</li>
              <li>{m.launch.todoBuild}</li>
              <li>{m.launch.todoListing}</li>
              <li>{m.launch.todoChecklist}</li>
            </ul>
          </div>
        )}
      </div>
    </section>
  )
}
