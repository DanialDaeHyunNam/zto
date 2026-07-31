import { useEffect, useState } from 'react'
import type { AiProviderId, AiProviderStatus, AiStatus } from '../../../../shared/launch-types'
import type { LicenseInfo } from '../../../../shared/license-types'
import { useI18n, type Locale } from '../../i18n'
import AiUsage from './AiUsage'

const LOCALES: Locale[] = ['ko', 'en']

const PROVIDER_LABEL: Record<AiProviderId, string> = {
  claude: 'Claude',
  chatgpt: 'ChatGPT',
  gemini: 'Gemini'
}
// provider 구독 = 어느 CLI인지 (안내 문구용)
const PROVIDER_CLI: Record<AiProviderId, string> = {
  claude: 'claude',
  chatgpt: 'codex',
  gemini: ''
}

// ZTO 서비스 config — AI provider(BYO 2방식: 구독 CLI / API 키), 언어.

// ---------- 라이선스 (SPEC §8) ----------
// 상태를 **사실 그대로** 보여준다: 체험 중이면 남은 날짜, 등록됐으면 마스킹된 키와 마지막 확인,
// 오프라인이면 언제까지 쓸 수 있는지. 결제 유도 문구보다 "지금 내 상태가 뭔가"가 먼저다.
function LicenseCard(): React.JSX.Element {
  const { m } = useI18n()
  const [info, setInfo] = useState<LicenseInfo | null>(null)
  const [draft, setDraft] = useState('')
  const [busy, setBusy] = useState(false)

  const load = (): void => {
    window.zto.license.info().then(setInfo)
  }
  useEffect(load, [])

  const activate = async (): Promise<void> => {
    setBusy(true)
    setInfo(await window.zto.license.activate(draft))
    setBusy(false)
    setDraft('')
  }
  const remove = async (): Promise<void> => {
    setBusy(true)
    setInfo(await window.zto.license.deactivate())
    setBusy(false)
  }

  const daysLeft = (iso?: string): number =>
    iso ? Math.max(0, Math.ceil((new Date(iso).getTime() - Date.now()) / 86400000)) : 0

  return (
    <div className="settings-card">
      <h2 className="settings-h2">{m.settings.licenseTitle}</h2>
      <p className="settings-intro">{m.settings.licenseIntro}</p>
      {!info ? (
        <p className="settings-intro">…</p>
      ) : info.state === 'active' ? (
        <div className="lic-row">
          <span className="status-chip ok">{m.settings.licenseActive}</span>
          <code className="cred-path">{info.keyMasked}</code>
          {info.plan && <span className="iap-kind">{info.plan === 'plus' ? 'Plus' : 'BYO'}</span>}
          <button className="ghost-btn mini" disabled={busy} onClick={remove}>
            {m.settings.licenseRemove}
          </button>
        </div>
      ) : (
        <>
          {/* 체험은 **첫 스토어 연결부터** 센다 — 아직 연결 전이면 시작조차 안 한 것이다 */}
          <div className="lic-row">
            {info.trialActive ? (
              <span className="status-chip warn">
                {m.settings.licenseTrialLeft.replace('{d}', String(daysLeft(info.trialEndsAt)))}
              </span>
            ) : info.trialStartedAt ? (
              <span className="status-chip off">{m.settings.licenseTrialOver}</span>
            ) : (
              <span className="status-chip off">{m.settings.licenseTrialNotStarted}</span>
            )}
          </div>
          <div className="cred-file">
            <input
              className="email-input"
              placeholder={m.settings.licensePlaceholder}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
            />
            <button
              className="choice small active"
              disabled={!draft.trim() || busy}
              onClick={activate}
            >
              {busy ? m.settings.licenseChecking : m.settings.licenseActivate}
            </button>
          </div>
          {info.error && <div className="asset-edit-err">{m.settings.licenseErrors[info.error] ?? info.error}</div>}
        </>
      )}
      {/* 오프라인 유예는 숨기지 않는다 — 언제 잠기는지 모르는 게 가장 나쁘다 */}
      {info?.state === 'active' && info.offlineUntil && (
        <p className="settings-intro">
          {m.settings.licenseOffline.replace('{d}', String(daysLeft(info.offlineUntil)))}
        </p>
      )}
    </div>
  )
}

export default function SettingsPage(): React.JSX.Element {
  const { m, locale, setLocale } = useI18n()
  const [ai, setAi] = useState<AiStatus | null>(null)
  const [keyDraft, setKeyDraft] = useState<Record<string, string>>({})

  const refresh = (fresh?: boolean): void => {
    window.zto.ai.status(fresh).then(setAi)
  }
  useEffect(() => refresh(), [])

  const setMode = (p: AiProviderId, mode: 'subscription' | 'apikey'): void => {
    window.zto.ai.setMode(p, mode).then(() => refresh())
  }
  const setActive = (p: AiProviderId): void => {
    window.zto.ai.setActive(p).then(() => refresh())
  }
  const pickModel = (id: string): void => {
    window.zto.ai.setModel(id).then(() => refresh())
  }
  const saveKey = (p: AiProviderId): void => {
    window.zto.ai.setKey(p, (keyDraft[p] ?? '').trim()).then(() => {
      setKeyDraft((d) => ({ ...d, [p]: '' }))
      refresh()
    })
  }
  const clearKey = (p: AiProviderId): void => {
    window.zto.ai.setKey(p, '').then(() => refresh())
  }

  // 구독 방식이면 CLI 감지, API 키 방식이면 키 저장 여부 — provider가 "쓸 준비"됐는지
  const ready = (p: AiProviderStatus): boolean =>
    p.mode === 'subscription' ? p.subscriptionAvailable : p.hasKey

  const providerCard = (p: AiProviderStatus): React.JSX.Element => {
    const name = PROVIDER_LABEL[p.id]
    const isActive = ai?.active === p.id
    return (
      <div key={p.id} className={`ai-provider ${isActive ? 'active' : ''}`}>
        <div className="ai-provider-head">
          <div className="ai-provider-name">
            {name}
            <span className="ai-provider-via">
              {p.mode === 'subscription' ? m.settings.subVia.replace('{p}', name) : m.settings.keyVia}
            </span>
          </div>
          {p.supportsSubscription ? (
            <div className="seg small">
              <button
                className={p.mode === 'subscription' ? 'active' : ''}
                onClick={() => setMode(p.id, 'subscription')}
              >
                {m.settings.modeSub}
              </button>
              <button
                className={p.mode === 'apikey' ? 'active' : ''}
                onClick={() => setMode(p.id, 'apikey')}
              >
                {m.settings.modeKey}
              </button>
            </div>
          ) : (
            <span className="settings-row-sub-inline">{m.settings.modeKey}</span>
          )}
        </div>

        {p.mode === 'subscription' ? (
          <div className={`ai-provider-status ${p.subscriptionAvailable ? 'ok' : 'warn'}`}>
            {p.subscriptionAvailable ? (
              <>
                <span className="settings-dot g" /> {m.settings.connected} {p.subscriptionVersion}
              </>
            ) : (
              m.settings.cliMissing.replace('{c}', PROVIDER_CLI[p.id])
            )}
          </div>
        ) : (
          <div className="ai-key-row">
            {p.hasKey ? (
              <>
                <span className="ai-provider-status ok">
                  <span className="settings-dot g" /> {m.settings.keyStored}
                </span>
                <button className="ghost-btn danger" onClick={() => clearKey(p.id)}>
                  {m.settings.keyClear}
                </button>
              </>
            ) : (
              <>
                <input
                  className="settings-key wide"
                  type="password"
                  placeholder={m.settings.keyPlaceholder}
                  value={keyDraft[p.id] ?? ''}
                  onChange={(e) => setKeyDraft((d) => ({ ...d, [p.id]: e.target.value }))}
                  onKeyDown={(e) => e.key === 'Enter' && saveKey(p.id)}
                />
                <button
                  className="choice small active"
                  disabled={!(keyDraft[p.id] ?? '').trim()}
                  onClick={() => saveKey(p.id)}
                >
                  {m.settings.keySave}
                </button>
              </>
            )}
          </div>
        )}

        <div className="ai-provider-foot">
          {isActive ? (
            <span className="ai-inuse">✓ {m.settings.inUse}</span>
          ) : (
            <button
              className="choice small"
              disabled={!ready(p)}
              onClick={() => setActive(p.id)}
            >
              {m.settings.use}
            </button>
          )}
          {/* active provider가 모델을 제공하면 모델 선택 (목록은 main이 provider별로 내려준다) */}
          {isActive && ai && ai.models.length > 0 && (
            <div className="ai-models">
              {ai.models.map((mod) => (
                <button
                  key={mod.id}
                  className={`ai-model ${mod.id === ai.model ? 'sel' : ''}`}
                  onClick={() => pickModel(mod.id)}
                >
                  {mod.id === ai.model ? '●' : '○'} {mod.label}
                </button>
              ))}
            </div>
          )}
        </div>
      </div>
    )
  }

  return (
    <section>
      <h1>{m.settings.title}</h1>

      <LicenseCard />

      <div className="settings-card">
        <h2 className="settings-h2">{m.settings.aiTitle}</h2>
        <p className="settings-intro">{m.settings.aiIntro}</p>
        {ai ? (
          <div className="ai-providers">{ai.providers.map(providerCard)}</div>
        ) : (
          <p className="settings-intro">…</p>
        )}
      </div>

      <AiUsage />

      <div className="settings-card">
        <h2 className="settings-h2">{m.settings.langTitle}</h2>
        <p className="settings-intro">{m.settings.langSub}</p>
        <div className="seg">
          {LOCALES.map((l) => (
            <button key={l} className={locale === l ? 'active' : ''} onClick={() => setLocale(l)}>
              {l.toUpperCase()}
            </button>
          ))}
        </div>
      </div>
    </section>
  )
}
