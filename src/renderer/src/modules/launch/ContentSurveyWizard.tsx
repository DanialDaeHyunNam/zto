import { useEffect, useState } from 'react'
import type { ConsoleAnswers, QuestionDef, Questionnaire } from '../../../../shared/launch-types'
import { useI18n } from '../../i18n'

// 앱 콘텐츠 설문 (ROADMAP #2, 결정형 코어) — API 없는 콘솔 전용 설정을 질문으로 채운다.
// 질문별 "?" 도움은 지금은 help 텍스트, 다음 슬라이스에서 AI 팝오버(위저드 세션 컨텍스트 공유)로.

const LEVEL_OPTS = ['NONE', 'INFREQUENT_OR_MILD', 'FREQUENT_OR_INTENSE'] as const
const BOOL_OPTS = ['YES', 'NO'] as const

type ChatMsg = { role: 'user' | 'ai'; text: string }

// 질문별 AI 팝오버 — 깨끗한 새 대화처럼 보이나 위저드 세션의 이전 답을 숨은 컨텍스트로 공유,
// 답을 이끌어내면 "이 답으로 설정"으로 위저드에 되돌린다 (Dan 2026-07-23). ai:chat(구독 CLI) 사용.
function QuestionHelp({
  q,
  def,
  answers,
  opts,
  optLabel,
  label,
  onPick
}: {
  q: Questionnaire
  def: QuestionDef
  answers: Record<string, string>
  opts: readonly string[]
  optLabel: (o: string) => string
  label: (d: { label: string; labelEn?: string }) => string
  onPick: (val: string) => void
}): React.JSX.Element {
  const { m } = useI18n()
  const [msgs, setMsgs] = useState<ChatMsg[]>([])
  const [input, setInput] = useState('')
  const [busy, setBusy] = useState(false)
  const [session, setSession] = useState<string | undefined>()
  const [suggestion, setSuggestion] = useState<string | null>(null)

  // 첫 턴에만 붙는 숨은 컨텍스트 — 설문·현재 질문·선택지·이미 답한 것
  const buildContext = (): string => {
    const answered = q.questions
      .filter((x) => x.id !== def.id && answers[x.id])
      .map((x) => `${label(x)}=${optLabel(answers[x.id])}`)
      .join(', ')
    const optList = opts.map((o) => `${o}(${optLabel(o)})`).join(' / ')
    return [
      '당신은 앱 스토어 콘텐츠 등급/개인정보 설문 작성을 돕는 조수입니다.',
      "사용자가 자기 앱을 설명하면 '현재 질문'에 어떤 선택지를 골라야 할지 함께 판단하세요. 짧고 친근하게, 꼭 필요한 것만 되물으세요.",
      '확신이 서면 답변 맨 마지막 줄에 정확히 이 형식 한 줄만 덧붙이세요: 추천: <옵션id>  (확신이 없으면 붙이지 마세요.)',
      '',
      `[설문] ${label({ label: q.title, labelEn: q.titleEn })}`,
      `[현재 질문] ${label(def)}${def.help ? ' — ' + def.help : ''}`,
      `[선택지] ${optList}`,
      `[이미 답한 것] ${answered || '없음'}`
    ].join('\n')
  }

  const send = (): void => {
    const text = input.trim()
    if (!text || busy) return
    setInput('')
    setMsgs((prev) => [...prev, { role: 'user', text }])
    setBusy(true)
    setSuggestion(null)
    const prompt = session ? text : `${buildContext()}\n\n사용자: ${text}`
    window.zto.ai.chat(prompt, session ? { resume: session } : undefined).then((r) => {
      setBusy(false)
      if (r.sessionId) setSession(r.sessionId)
      const body = r.text || (r.error ? m.launch.helpNoAi : '')
      const shown = body.replace(/\n?추천:\s*[A-Z_]+\s*$/i, '').trim()
      setMsgs((prev) => [...prev, { role: 'ai', text: shown || m.launch.helpNoAi }])
      const mtch = r.text.match(/추천:\s*([A-Z_]+)/i)
      if (mtch && opts.includes(mtch[1].toUpperCase())) setSuggestion(mtch[1].toUpperCase())
    })
  }

  return (
    <div className="qhelp">
      {def.help && <p className="survey-help-text">{def.help}</p>}
      <div className="qhelp-chat">
        {msgs.length === 0 && <p className="qhelp-starter">{m.launch.helpStarter}</p>}
        {msgs.map((mm, i) => (
          <div key={i} className={`qhelp-msg ${mm.role}`}>
            {mm.text}
          </div>
        ))}
        {busy && <div className="qhelp-msg ai busy">{m.launch.helpThinking}</div>}
        {suggestion && (
          <button
            className="choice small active qhelp-apply"
            onClick={() => onPick(suggestion)}
          >
            {m.launch.helpApply}: {optLabel(suggestion)}
          </button>
        )}
      </div>
      <div className="qhelp-input">
        <input
          className="email-input"
          placeholder={m.launch.helpPlaceholder}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && send()}
          autoFocus
        />
        <button className="choice small" disabled={!input.trim() || busy} onClick={send}>
          {m.launch.helpSend}
        </button>
      </div>
    </div>
  )
}

export default function ContentSurveyWizard({
  file,
  questionnaireId,
  consoleUrl,
  prefill,
  noAutoFetch,
  onClose,
  onSaved
}: {
  file: string
  questionnaireId: string
  consoleUrl?: string
  prefill?: Record<string, string> | null // 스토어에서 읽은 현재 설정 (iOS 연령 등급)
  noAutoFetch?: boolean // Play — 자동 조회 불가 안내
  onClose: () => void
  onSaved: () => void
}): React.JSX.Element {
  const { m, locale } = useI18n()
  const [q, setQ] = useState<Questionnaire | null>(null)
  const [answers, setAnswers] = useState<Record<string, string>>({})
  const [helpOpen, setHelpOpen] = useState<string | null>(null)

  useEffect(() => {
    window.zto.launch.questionnaire(questionnaireId).then(setQ)
    // 스토어 프리필을 기반으로, 로컬 저장 답이 있으면 그게 우선(유저 편집 보존)
    window.zto.launch.getConsoleAnswers(file, questionnaireId).then((a) => {
      setAnswers({ ...(prefill ?? {}), ...(a?.answers ?? {}) })
    })
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
    // prefill은 열릴 때 확정되어 넘어옴 — 마운트 시 1회 병합
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
    const open = helpOpen === def.id
    return (
      <div key={def.id} className={`survey-q ${cur ? 'answered' : ''}`}>
        <div className="survey-q-head">
          <span className="survey-q-label">{label(def)}</span>
          <button
            className={`survey-help ${open ? 'on' : ''}`}
            title={m.launch.helpStarter}
            onClick={() => setHelpOpen((h) => (h === def.id ? null : def.id))}
          >
            ?
          </button>
        </div>
        <div className="seg survey-seg">
          {opts.map((o) => (
            <button key={o} className={cur === o ? 'active' : ''} onClick={() => set(def.id, o)}>
              {optLabel(o)}
            </button>
          ))}
        </div>
        {open && q && (
          <QuestionHelp
            q={q}
            def={def}
            answers={answers}
            opts={opts}
            optLabel={optLabel}
            label={label}
            onPick={(val) => {
              set(def.id, val)
              setHelpOpen(null)
            }}
          />
        )}
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
        {prefill && Object.keys(prefill).length > 0 && (
          <p className="survey-note prefill">✓ {m.launch.surveyPrefilled}</p>
        )}
        {noAutoFetch && <p className="survey-note nofetch">{m.launch.surveyNoAutoFetch}</p>}
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
