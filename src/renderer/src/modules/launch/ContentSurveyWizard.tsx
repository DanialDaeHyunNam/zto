import { useEffect, useState } from 'react'
import type { ConsoleAnswers, QuestionDef, Questionnaire } from '../../../../shared/launch-types'
import { useI18n } from '../../i18n'

// 앱 콘텐츠 설문 (ROADMAP #2, 결정형 코어) — API 없는 콘솔 전용 설정을 질문으로 채운다.
// 질문별 "?" 도움은 지금은 help 텍스트, 다음 슬라이스에서 AI 팝오버(위저드 세션 컨텍스트 공유)로.

const LEVEL_OPTS = ['NONE', 'INFREQUENT_OR_MILD', 'FREQUENT_OR_INTENSE'] as const
const BOOL_OPTS = ['YES', 'NO'] as const

export default function ContentSurveyWizard({
  file,
  questionnaireId,
  consoleUrl,
  onClose,
  onSaved
}: {
  file: string
  questionnaireId: string
  consoleUrl?: string
  onClose: () => void
  onSaved: () => void
}): React.JSX.Element {
  const { m, locale } = useI18n()
  const [q, setQ] = useState<Questionnaire | null>(null)
  const [answers, setAnswers] = useState<Record<string, string>>({})
  const [helpOpen, setHelpOpen] = useState<string | null>(null)

  useEffect(() => {
    window.zto.launch.questionnaire(questionnaireId).then(setQ)
    window.zto.launch.getConsoleAnswers(file, questionnaireId).then((a) => {
      if (a) setAnswers(a.answers)
    })
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [file, questionnaireId, onClose])

  const label = (def: { label: string; labelEn?: string }): string =>
    locale === 'en' && def.labelEn ? def.labelEn : def.label

  const optLabel = (opt: string): string =>
    opt === 'NONE'
      ? m.launch.levelNone
      : opt === 'INFREQUENT_OR_MILD'
        ? m.launch.levelMild
        : opt === 'FREQUENT_OR_INTENSE'
          ? m.launch.levelIntense
          : opt === 'YES'
            ? m.launch.boolYes
            : m.launch.boolNo

  const set = (id: string, val: string): void => setAnswers((a) => ({ ...a, [id]: val }))

  const answeredCount = q ? q.questions.filter((qq) => answers[qq.id]).length : 0
  const total = q?.questions.length ?? 0
  const complete = total > 0 && answeredCount === total

  const save = (): void => {
    if (!q) return
    const data: ConsoleAnswers = {
      version: q.version,
      answers,
      completedAt: complete ? new Date().toISOString() : ''
    }
    window.zto.launch.setConsoleAnswers(file, questionnaireId, data).then(() => {
      onSaved()
      onClose()
    })
  }

  const questionRow = (def: QuestionDef): React.JSX.Element => {
    const opts: readonly string[] = def.type === 'level' ? LEVEL_OPTS : BOOL_OPTS
    const cur = answers[def.id]
    return (
      <div key={def.id} className={`survey-q ${cur ? 'answered' : ''}`}>
        <div className="survey-q-head">
          <span className="survey-q-label">{label(def)}</span>
          {def.help && (
            <button
              className="survey-help"
              onClick={() => setHelpOpen((h) => (h === def.id ? null : def.id))}
            >
              ?
            </button>
          )}
        </div>
        {helpOpen === def.id && def.help && <p className="survey-help-text">{def.help}</p>}
        <div className="seg survey-seg">
          {opts.map((o) => (
            <button key={o} className={cur === o ? 'active' : ''} onClick={() => set(def.id, o)}>
              {optLabel(o)}
            </button>
          ))}
        </div>
      </div>
    )
  }

  return (
    <div className="lightbox" onClick={onClose}>
      <div className="survey-modal" onClick={(e) => e.stopPropagation()}>
        <div className="survey-head">
          <div>
            <strong>{q ? label({ label: q.title, labelEn: q.titleEn }) : m.launch.surveyBtn}</strong>
            {q && (
              <span className="survey-progress">
                {m.launch.surveyProgress
                  .replace('{a}', String(answeredCount))
                  .replace('{b}', String(total))}
              </span>
            )}
          </div>
          <button className="modal-close" onClick={onClose}>
            ✕
          </button>
        </div>
        <p className="survey-intro">{m.launch.surveyIntro}</p>
        {!q ? (
          <p className="survey-intro">…</p>
        ) : (
          <div className="survey-list">{q.questions.map(questionRow)}</div>
        )}
        <div className="survey-foot">
          {consoleUrl && (
            <button className="link-btn" onClick={() => window.zto.launch.openExternal(consoleUrl)}>
              {m.launch.surveyOpenConsole}
            </button>
          )}
          <button className="choice small active" onClick={save} disabled={answeredCount === 0}>
            {m.launch.surveySave}
          </button>
        </div>
      </div>
    </div>
  )
}
