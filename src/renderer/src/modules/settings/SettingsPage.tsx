import { useEffect, useState } from 'react'
import type { AiStatus } from '../../../../shared/launch-types'
import { useI18n, type Locale } from '../../i18n'

const LOCALES: Locale[] = ['ko', 'en']

// ZTO 서비스 config — AI provider(BYO 구독), 언어. 소셜미디어 도우미 등 향후 기능의 AI 백엔드.
export default function SettingsPage(): React.JSX.Element {
  const { m, locale, setLocale } = useI18n()
  const [ai, setAi] = useState<AiStatus | null>(null)

  useEffect(() => {
    window.zto.ai.status().then(setAi)
  }, [])

  const pickModel = (id: string): void => {
    window.zto.ai.setModel(id).then(() => window.zto.ai.status().then(setAi))
  }

  return (
    <section>
      <h1>{m.settings.title}</h1>

      <div className="settings-card">
        <h2 className="settings-h2">{m.settings.aiTitle}</h2>
        <p className="settings-intro">{m.settings.aiIntro}</p>

        <div className="settings-row">
          <div className="settings-row-body">
            <div className="settings-row-name">
              {m.settings.claudeName}
              <span className="settings-row-sub-inline">{m.settings.claudeSub}</span>
            </div>
            <div className={`settings-row-status ${ai?.available ? 'ok' : 'warn'}`}>
              {ai
                ? ai.available
                  ? `${m.settings.connected} ${ai.version}`
                  : m.settings.notDetected
                : '…'}
            </div>
          </div>
          {ai?.available && <span className="settings-dot g" />}
        </div>

        {ai && ai.models.length > 0 && (
          <>
            <div className="settings-sub-title">
              {m.settings.defaultModel}
              <span className="settings-sub-note">{m.settings.defaultModelSub}</span>
            </div>
            <div className="settings-models">
              {ai.models.map((mod) => (
                <button
                  key={mod.id}
                  className={`settings-model ${mod.id === ai.model ? 'sel' : ''}`}
                  onClick={() => pickModel(mod.id)}
                >
                  <span className="settings-radio">{mod.id === ai.model ? '●' : '○'}</span>
                  <span className="settings-model-label">{mod.label}</span>
                  <code className="settings-model-id">{mod.id}</code>
                </button>
              ))}
            </div>
          </>
        )}

        <div className="settings-sub-title">
          {m.settings.otherAi}
          <span className="settings-sub-note">{m.settings.comingSoon}</span>
        </div>
        <div className="settings-row locked">
          <div className="settings-row-body">
            <div className="settings-row-name">
              ChatGPT
              <span className="settings-row-sub-inline">{m.settings.chatgptSub}</span>
            </div>
            <div className="settings-row-status">{m.settings.chatgptSoon}</div>
          </div>
        </div>
        <div className="settings-row locked">
          <div className="settings-row-body">
            <div className="settings-row-name">
              Gemini
              <span className="settings-row-sub-inline">{m.settings.geminiSub}</span>
            </div>
            <div className="settings-row-status">{m.settings.geminiSoon}</div>
          </div>
          <input className="settings-key" type="password" placeholder={m.settings.apiKeyPlaceholder} disabled />
        </div>
      </div>

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
