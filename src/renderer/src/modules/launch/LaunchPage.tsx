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
import { useBrowserOverlay } from '../../browser-overlay'
import type { Messages } from '../../i18n/en'
import { PlatformIcon } from '../../platform-icons'
import AppDashboard from './AppDashboard'
import EditScope from './EditScope'
import ListingForm from './ListingForm'
import JourneyApply from './JourneyApply'
import CredentialSetup from './CredentialSetup'

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
  // "이 앱이 뭔지" 자연어 — 신규 앱은 스토어 설명이 없어 AI가 기준 삼을 게 없다(2026-08-15 Dan).
  // 여기서 한 번 받아두면 이후 메타 초안·설문 답 추론이 전부 이 문장을 기준으로 돈다.
  const [about, setAbout] = useState('')
  const [err, setErr] = useState('')
  // 시트가 만들어지면 그 자리에서 Bundle ID를 ASC에 등록하고 결과를 보여준다(신규 앱 여정 ①).
  // 조용히 등록하고 넘어가면 Apple 계정에 뭔가 생겼다는 걸 사용자가 모른다 — 한 줄은 보여야 한다.
  const [reg, setReg] = useState<'' | 'busy' | 'ok' | 'already' | 'skipped' | 'failed'>('')
  const [regDetail, setRegDetail] = useState('')
  const [createdFile, setCreatedFile] = useState('')

  const create = (): void => {
    if (!name.trim() || !pkg.trim()) {
      setErr(m.launch.sheetInvalid)
      return
    }
    window.zto.launch.createSheet(name.trim(), pkg.trim(), bundle.trim(), about).then(async (r) => {
      if (r.ok && r.file) {
        setErr('')
        setCreatedFile(r.file)
        setReg('busy')
        const b = await window.zto.launch.registerBundleId(r.file)
        if (b.ok) setReg(b.already ? 'already' : 'ok')
        else if (b.error === 'no-asc-creds') setReg('skipped')
        else {
          setReg('failed')
          setRegDetail([b.detail, b.error].filter(Boolean).join(' · '))
        }
        return
      }
      // 번들 ID 선점은 **누가 쓰고 있는지**까지 말해준다 — "안 됩니다"만으로는 다음 수를 못 정한다
      const msg =
        r.error === 'exists'
          ? m.launch.sheetExists
          : r.error === 'bundle-taken'
            ? m.launch.bundleTaken
            : r.error === 'bundle-mine'
              ? m.launch.bundleMine
              : m.launch.sheetInvalid
      setErr(r.detail ? `${msg} — ${r.detail}` : msg)
    })
  }

  // 등록 결과 화면 — 실패해도 시트는 이미 있으므로 여정은 [계속]으로 이어진다
  if (reg) {
    const line =
      reg === 'busy'
        ? m.launch.bundleRegBusy
        : reg === 'ok'
          ? m.launch.bundleRegOk
          : reg === 'already'
            ? m.launch.bundleRegAlready
            : reg === 'skipped'
              ? m.launch.bundleRegSkipped
              : `${m.launch.bundleRegFailed}${regDetail ? ` — ${regDetail}` : ''}`
    return (
      <div className="form-card slim">
        <div className="form-card-title">{name.trim()}</div>
        <p className="settings-intro">{line}</p>
        <div className="form-actions">
          <button
            className="choice small active"
            disabled={reg === 'busy'}
            onClick={() => onCreated(createdFile)}
          >
            {m.launch.sheetContinue}
          </button>
        </div>
      </div>
    )
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
      <label className="form-field">
        <span className="form-label">{m.launch.aboutLabel}</span>
        <textarea
          className="email-input"
          rows={3}
          value={about}
          placeholder={m.launch.aboutPlaceholder}
          onChange={(e) => setAbout(e.target.value)}
        />
        <span className="step-note no-indent">{m.launch.aboutHint}</span>
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

  // null = 아직 불러오는 중 (Apple 계정 앱 목록)
  const [ascApps, setAscApps] = useState<{ name: string; bundleId: string }[] | null>(null)
  // 선택 전엔 폼을 숨긴다: null=미선택 / 'manual'=직접 추가 / bundleId=ASC 앱 선택
  const [chosen, setChosen] = useState<string | null>(null)

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
      <div className="form-field">
        <span className="form-label">{m.launch.ascPickLabel}</span>
        {ascApps === null ? (
          <span className="no-apps">{m.launch.ascLoading}</span>
        ) : (
          <div className="app-picker">
            {/* 칩 클릭 = 즉시 임포트(2026-08-14 Dan) — ASC가 준 이름·번들ID를 사람이 다시
                확인할 이유가 없다. 필드 확인은 직접 추가(manual)에서만. 실패하면 그때 폼이 열린다 */}
            {ascApps.map((a) => (
              <button
                key={a.bundleId}
                type="button"
                className={`app-chip ${chosen === a.bundleId ? 'active' : ''}`}
                disabled={busy}
                onClick={() => {
                  setName(a.name)
                  setPkg(a.bundleId)
                  setErr('')
                  setChosen(a.bundleId)
                  setBusy(true)
                  window.zto.launch.importApp(a.name, a.bundleId, saPath.trim()).then((r) => {
                    setBusy(false)
                    if (r.ok && r.file) return onCreated(r.file)
                    if (r.error === 'verify-failed')
                      setErr(m.launch.verifyFailed.replace('{d}', r.detail ?? ''))
                    else setErr(m.launch.importPkgRequired)
                  })
                }}
              >
                <PlatformIcon id="app-store-connect" />
                {a.name}
              </button>
            ))}
            <button
              type="button"
              className={`app-chip ${chosen === 'manual' ? 'active' : ''}`}
              onClick={() => {
                setName('')
                setPkg('')
                setErr('')
                setChosen('manual')
              }}
            >
              + {m.launch.manualAdd}
            </button>
          </div>
        )}
      </div>
      {chosen === 'manual' && (
        <>
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
        </>
      )}
      {err && <p className="field-err no-indent">{err}</p>}
      <div className="form-actions">
        <button className="choice small" onClick={onCancel} disabled={busy}>
          {m.accounts.cancel}
        </button>
        {/* [Import]는 직접 추가에서만 — 칩은 클릭이 곧 임포트다 */}
        {chosen === 'manual' && (
          <button
            className="choice small active"
            onClick={doImport}
            disabled={busy || !pkg.trim()}
          >
            {busy ? m.launch.verifying : m.launch.importBtn}
          </button>
        )}
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
// 자격증명이 없는 사용자를 **밖으로 내보내지 않는다** — 키 발급은 콘솔 여러 화면을 오가는
// 일이라(Play는 Cloud 프로젝트까지 건너간다) 링크만 던지면 거기서 길을 잃는다.
// 그래서 [연결]도 다른 콘솔 작업과 같은 모드 B로 흐른다: 내부 브라우저 + 옆에서 거드는 AI.
function ApiStatusBar(): React.JSX.Element {
  const { m } = useI18n()
  const [status, setStatus] = useState<ApiStatus | null>(null)
  const [setup, setSetup] = useState<StoreKind | null>(null)
  useEffect(() => {
    window.zto.launch.apiStatus().then(setStatus)
  }, [])

  const row = (
    iconId: string,
    label: string,
    st: { connected: boolean; detail: string } | undefined,
    store: StoreKind
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
        <button className="link-btn api-connect" onClick={() => setSetup(store)}>
          {m.launch.apiConnect}
        </button>
      )}
    </div>
  )

  return (
    <div className="api-status">
      {row('play-console', m.launch.apiPlay, status?.play, 'play')}
      {row('app-store-connect', m.launch.apiApple, status?.apple, 'apple')}
      {/* 발급(콘솔로)과 등록(파일 선택)이 한 화면에 — 발급까지 데려다 놓고 등록에서 막히면 반쪽이다 */}
      {setup && (
        <CredentialSetup
          store={setup}
          onClose={() => setSetup(null)}
          onSaved={() => window.zto.launch.apiStatus().then(setStatus)}
        />
      )}
    </div>
  )
}

export default function LaunchPage(): React.JSX.Element {
  const { m } = useI18n()
  const { open: openBrowser, setGuide } = useBrowserOverlay()

  // 앱 레코드 생성은 API가 없어 콘솔에서만 되는 일 — 그래도 **밖의 브라우저로 내보내지 않는다**.
  // ZTO 브라우저 + AI 패널로 열고, 무엇을 하러 왔는지(앱·플랫폼·왜 콘솔인지)를 같이 넘긴다.
  // 여는 것과 이끄는 것은 다르다: task 없이 열면 AI가 우리가 이미 아는 걸 되묻는다(2026-07-31).
  // 경계는 그대로다 — 콘솔 폼만 임베드하고, 개발자 등록·결제·스토어 공개 페이지는 외부 브라우저.
  const openConsole = (platform: 'android' | 'ios', url: string): void => {
    const sh = sheets.find((x) => x.file === selected)
    openBrowser(url, {
      copilot: true,
      task: {
        goal: platform === 'android' ? m.launch.registerPlay : m.launch.registerAsc,
        app: sh ? `${sh.appName} (${sh.packageName})` : undefined,
        platform,
        why: m.launch.registerWhy,
        // 콘솔 홈까지만 데려간다 — 앱이 아직 없어 목적지 URL을 만들 수 없다
        exact: false
      }
    })
    setGuide({ text: m.launch.guideRegister, tone: 'ask' })
  }
  // '앱 스토어 관리'가 홈 — 신규 여정은 [+ 앱 추가 → 신규 앱 출시]로만 진입 (2026-07-22 Dan)
  const [view, setViewState] = useState<'manage' | 'new'>(
    () => (localStorage.getItem('zto-launch-view') as 'manage' | 'new') ?? 'manage'
  )
  const [devAccounts, setDevAccounts] = useState<DevAccounts>({})
  const [sheets, setSheets] = useState<SheetSummary[]>([])
  // 편집 범위 표. 플랫폼 탭은 대시보드 안에 있어 여기선 모르므로 Android로 열고
  // 표 안에서 바꾸게 둔다 — 두 스토어를 나란히 비교하는 게 이 표의 쓰임 절반이다
  const [scopeOpen, setScopeOpen] = useState(false)
  const [iosInfo, setIosInfo] = useState<{ appId: string; editableVersion?: string }>()
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
    // 신규 여정은 빈 손으로 시작한다 — 관리 홈의 선택이 남아 있으면 기존 앱 카드도 없는
    // 화면에서 그 앱의 뒷단계(콘텐츠·등록)가 유령처럼 뜬다
    if (next === 'new') setSelected(null)
    // 되돌아온 관리 홈은 첫 진입과 같아야 한다 — 선택이 비었으면 첫 앱 자동 선택
    // (비워둔 채 두면 칩만 있고 대시보드가 없는 빈 화면이 된다, 2026-08-15 실사용)
    else if (!selected && sheets.length > 0) selectSheet(sheets[0].file)
  }

  const setDevAccount = useCallback((store: StoreKind, status: 'yes' | 'no', email?: string) => {
    window.zto.launch.setDevAccount(store, { status, email }).then(setDevAccounts)
  }, [])

  const onSheetCreated = (file: string): void => {
    setSheetForm('none')
    window.zto.launch.listSheets().then(setSheets)
    selectSheet(file)
  }

  // 테스트 앱 청소 — 시트·아이콘(로컬)+미사용 Bundle ID까지 ZTO가 지운다(2026-08-15 Dan).
  // 2단 컨펌: 지우기는 비가역이라 한 번 눌렀다고 나가지 않는다(4초 안에 한 번 더)
  const [delArmed, setDelArmed] = useState(false)
  const deleteSelected = (): void => {
    if (!selected) return
    if (!delArmed) {
      setDelArmed(true)
      setTimeout(() => setDelArmed(false), 4000)
      return
    }
    setDelArmed(false)
    window.zto.launch.deleteSheet(selected).then(() => {
      window.zto.launch.listSheets().then((list) => {
        setSheets(list)
        // 관리 홈에서 지웠으면 남은 첫 앱으로 — 빈 화면을 만들지 않는다
        if (view === 'manage' && list.length > 0) selectSheet(list[0].file)
        else setSelected(null)
      })
    })
  }

  // ⌥1..9 = 앱 칩 전환 (2026-08-14 Dan). 층 구분은 브라우저와 같은 규칙 — 바깥(모듈)이 ⌘,
  // 안(탭·칩)이 ⌥. 브라우저 오버레이가 열려 있으면 ⌥n은 그쪽 탭 몫이라 여기 안 온다(뷰가 키를
  // 먼저 받는다). 입력창에 포커스 중이면 ⌥숫자가 특수문자 입력일 수 있어 건드리지 않는다.
  useEffect(() => {
    if (view !== 'manage') return
    const onKey = (e: KeyboardEvent): void => {
      if (!e.altKey || e.metaKey || e.ctrlKey) return
      const hit = /^Digit([1-9])$/.exec(e.code)
      if (!hit) return
      const t = e.target as HTMLElement | null
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA')) return
      const i = parseInt(hit[1], 10) - 1
      if (i < sheets.length) {
        e.preventDefault()
        selectSheet(sheets[i].file)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [view, sheets, selectSheet])

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
          <div className="head-actions">
            {/* 코파일럿으로 연다 — 콘솔 폼은 ZTO가 대신 채워줄 수 없으므로(API 없음),
                폼을 복제해 두 번 입력시키는 대신 **진짜 콘솔 옆에서 거든다**(Dan 2026-07-30) */}
            {/* "여긴 왜 편집이 안 되지"를 화면 안에서 답한다 — 이 지식이 문서나 대화에만
                있으면 사용자는 매번 시도해 보고 나서야 알게 된다 */}
            <button
              className="choice small"
              onClick={() => setScopeOpen(true)}
              title={m.launch.capOpenTitle}
            >
              {m.launch.capOpen}
            </button>
            <button
              className="choice small"
              onClick={() => openBrowser('https://play.google.com/console', { copilot: true })}
              title={m.launch.openBrowserTitle}
            >
              {m.launch.openBrowser}
            </button>
            <ApiStatusBar />
          </div>
        </div>
        {scopeOpen && (
          <EditScope
            platform="android"
            file={selected}
            ascAppId={iosInfo?.appId}
            iosEditableVersion={iosInfo?.editableVersion}
            appLabel={(() => {
              const sh = sheets.find((x) => x.file === selected)
              return sh ? `${sh.appName} (${sh.packageName})` : undefined
            })()}
            onClose={() => setScopeOpen(false)}
          />
        )}
        <div className="wizard wide">
          <div className="app-picker">
            {sheets.map((s, i) => (
              <button
                key={s.file}
                className={`app-chip big ${selected === s.file ? 'active' : ''}`}
                onClick={() => selectSheet(s.file)}
              >
                {s.icon && <img className="chip-app-icon" src={s.icon} alt="" />}
                {s.appName}
                {i < 9 && <span className="chip-kbd">⌥{i + 1}</span>}
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
              onAscAppId={setIosInfo}
            />
          )}
          {/* 삭제는 화면 맨 아래 구석 — 위험 액션은 눈에 밟히지 않는 자리에(여정 끝과 같은 부품) */}
          {selected && (
            <div className="choice-row" style={{ marginTop: 10 }}>
              <button className="ghost-btn mini" onClick={deleteSelected}>
                {delArmed ? m.launch.sheetDeleteSure : m.launch.sheetDelete}
              </button>
            </div>
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
          {/* 신규 여정에선 기존 앱을 늘어놓지 않는다(2026-08-15 Dan) — 여기는 만드는 곳이지
              고르는 곳이 아니다. 기존 앱은 관리 홈이 담당. 만들고 나면 그 앱 카드 하나만 남는다 */}
          {selected ? (
            <div className="sheet-list">
              {sheets
                .filter((s) => s.file === selected)
                .map((s) => (
                  <button key={s.file} className="sheet-card active">
                    <span className="sheet-head">
                      {s.icon && <img className="sheet-icon" src={s.icon} alt="" />}
                      <strong>{s.appName}</strong>
                    </span>
                    <span>{s.packageName || m.launch.noPackageName}</span>
                    <span>{m.launch.iapDefined.replace('{n}', String(s.iapCount))}</span>
                  </button>
                ))}
            </div>
          ) : (
            <NewSheetForm onCreated={onSheetCreated} onCancel={() => setView('manage')} />
          )}
        </div>

        {/* 여정 ② — 콘텐츠 입력. 스토어 등록(콘솔) 전에 받는다: 여기 적힌 값이
            앱 레코드 생성 폼과 이후 메타 반영의 재료가 된다 */}
        {selected && (
          <div className="step">
            <div className="step-head">
              <span className="step-no">{n()}</span> {m.launch.stepContent}
            </div>
            <ListingForm file={selected} />
          </div>
        )}

        {/* 여정 ③④ — 스토어 감지·초안 반영·핸드오프. 앱 레코드 생성만 콘솔(코파일럿 동행) */}
        {selected && (
          <div className="step">
            <div className="step-head">
              <span className="step-no">{n()}</span> {m.launch.stepStoreApply}
            </div>
            <JourneyApply
              file={selected}
              onMakeInConsole={(p) =>
                openConsole(
                  p,
                  p === 'android'
                    ? 'https://play.google.com/console'
                    : 'https://appstoreconnect.apple.com/apps'
                )
              }
            />
          </div>
        )}

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
                  onClick={() => openConsole('android', 'https://play.google.com/console')}
                >
                  {m.launch.openPlayConsole}
                </button>
                <button
                  className="link-btn"
                  onClick={() =>
                    openConsole('ios', 'https://appstoreconnect.apple.com/apps')
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

        {/* 남은 일 안내 — 여정이 끝나도 출시까지는 스토어별 숙제(설문·자산·심사)가 남는다.
            무엇이 남았고 각각 ZTO 어디서 푸는지까지 짚는다(2026-08-15 Dan) — 안내 없이 끝나면
            "다 된 건가?"가 된다. 출구는 대시보드, 테스트 앱 청소도 여정의 끝에서 */}
        {selected && (
          <div className="step">
            <div className="step-head">
              <span className="step-no">{n()}</span> {m.launch.stepNext}
            </div>
            <p className="step-note no-indent">{m.launch.nextIntro}</p>
            <div className="meta-cols">
              <div className="meta-col">
                <div className="meta-col-head">{m.launch.jaPlay}</div>
                <div className="guide no-indent">
                  <ol>
                    {m.launch.nextPlay.map((t, i) => (
                      <li key={i}>{t}</li>
                    ))}
                  </ol>
                </div>
              </div>
              <div className="meta-col">
                <div className="meta-col-head">{m.launch.jaAsc}</div>
                <div className="guide no-indent">
                  <ol>
                    {m.launch.nextIos.map((t, i) => (
                      <li key={i}>{t}</li>
                    ))}
                  </ol>
                </div>
              </div>
            </div>
            <p className="step-note no-indent">{m.launch.nextOutro}</p>
            <div className="choice-row">
              <button className="choice small" onClick={() => setView('manage')}>
                {m.launch.goDashboard}
              </button>
              <button className="ghost-btn mini" onClick={deleteSelected}>
                {delArmed ? m.launch.sheetDeleteSure : m.launch.sheetDelete}
              </button>
            </div>
          </div>
        )}
      </div>
    </section>
  )
}
