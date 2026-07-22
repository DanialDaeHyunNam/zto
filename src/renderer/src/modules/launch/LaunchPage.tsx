import { useCallback, useEffect, useState } from 'react'
import type {
  CredentialStatus,
  DevAccounts,
  SheetSummary,
  StoreKind
} from '../../../../shared/launch-types'
import { useI18n } from '../../i18n'
import type { Messages } from '../../i18n/en'
import { PlatformIcon } from '../../platform-icons'

type IapChoice = 'undecided' | 'yes' | 'no'

const STORE_URLS: Record<StoreKind, string> = {
  play: 'https://play.google.com/console/signup',
  apple: 'https://developer.apple.com/programs/enroll/'
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

  const saveEmail = (): void => {
    onSet(store, 'yes', emailDraft.trim() || undefined)
    setEditing(false)
  }

  const sub =
    status === 'yes'
      ? state?.email
        ? state.email + m.launch.linkedToInventory
        : m.launch.ownerNotSet
      : status === 'no'
        ? m.launch.notHaveHint
        : m.launch.selectPrompt

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
          <div className={`store-sub ${status === 'yes' ? 'ok' : status === 'no' ? 'warn' : ''}`}>
            {sub}
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
        <div className="email-row">
          <input
            className="email-input"
            type="email"
            placeholder={m.launch.ownerEmailPlaceholder}
            value={emailDraft}
            onChange={(e) => setEmailDraft(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && saveEmail()}
            autoFocus
          />
          <button className="choice small active" onClick={saveEmail}>
            {m.launch.save}
          </button>
        </div>
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

export default function LaunchPage(): React.JSX.Element {
  const { m } = useI18n()
  const [devAccounts, setDevAccounts] = useState<DevAccounts>({})
  const [sheets, setSheets] = useState<SheetSummary[]>([])
  const [selected, setSelected] = useState<string | null>(null)
  const [iapChoice, setIapChoice] = useState<IapChoice>('undecided')
  const [creds, setCreds] = useState<CredentialStatus | null>(null)

  useEffect(() => {
    window.zto.launch.getDevAccounts().then(setDevAccounts)
    window.zto.launch.listSheets().then(setSheets)
  }, [])

  const setDevAccount = useCallback((store: StoreKind, status: 'yes' | 'no', email?: string) => {
    window.zto.launch.setDevAccount(store, { status, email }).then(setDevAccounts)
  }, [])

  const selectSheet = useCallback((file: string) => {
    setSelected(file)
    setIapChoice('undecided')
    setCreds(null)
  }, [])

  useEffect(() => {
    if (selected && iapChoice === 'yes') {
      window.zto.launch.checkCredentials(selected).then(setCreds)
    }
  }, [selected, iapChoice])

  const bothStoresReady = devAccounts.play?.status === 'yes' && devAccounts.apple?.status === 'yes'

  return (
    <section>
      <h1>{m.launch.title}</h1>
      <p className="placeholder">{m.launch.subtitle}</p>

      <div className="wizard">
        <div className="step">
          <div className="step-head">
            <span className="step-no">1</span> {m.launch.stepDevAccounts}
          </div>
          <div className="rows">
            <DevAccountRow store="play" state={devAccounts.play} onSet={setDevAccount} />
            <DevAccountRow store="apple" state={devAccounts.apple} onSet={setDevAccount} />
          </div>
          {!bothStoresReady && <p className="step-note">{m.launch.stepDevAccountsNote}</p>}
        </div>

        <div className="step">
          <div className="step-head">
            <span className="step-no">2</span> {m.launch.stepSelectApp}
          </div>
          {sheets.length === 0 ? (
            <p className="step-empty">
              {m.launch.sheetEmptyPre}
              <code>launch/answers/_template.json</code>
              {m.launch.sheetEmptyMid}
              <code>launch/answers/&lt;app&gt;.json</code>
              {m.launch.sheetEmptyPost}
            </p>
          ) : (
            <div className="sheet-list">
              {sheets.map((s) => (
                <button
                  key={s.file}
                  className={`sheet-card ${selected === s.file ? 'active' : ''}`}
                  onClick={() => selectSheet(s.file)}
                >
                  <strong>{s.appName}</strong>
                  <span>{s.packageName || m.launch.noPackageName}</span>
                  <span>{m.launch.iapDefined.replace('{n}', String(s.iapCount))}</span>
                </button>
              ))}
            </div>
          )}
        </div>

        {selected && (
          <div className="step">
            <div className="step-head">
              <span className="step-no">3</span> {m.launch.stepIap}
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

        {selected && iapChoice === 'yes' && (
          <div className="step">
            <div className="step-head">
              <span className="step-no">4</span> {m.launch.stepCredentials}
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

        {selected && iapChoice !== 'undecided' && (
          <div className="step dim">
            <div className="step-head">
              <span className="step-no">{iapChoice === 'yes' ? 5 : 4}</span> {m.launch.stepNext}
            </div>
            <ul className="todo-list">
              {iapChoice === 'yes' && <li>{m.launch.todoIap}</li>}
              <li>{m.launch.todoListing}</li>
              <li>{m.launch.todoChecklist}</li>
            </ul>
          </div>
        )}
      </div>
    </section>
  )
}
