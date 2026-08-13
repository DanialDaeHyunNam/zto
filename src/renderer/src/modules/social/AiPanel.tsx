import { useEffect, useRef, useState } from 'react'
import type { AiFeature, AiModel, AiProviderId, CopilotTask } from '../../../../shared/launch-types'
import type { FormSnapshot } from '../../../../shared/console-types'
import { useI18n } from '../../i18n'
import Markdown from './Markdown'

// provider 표기는 브랜드명이라 번역하지 않는다(설정 페이지와 같은 문자열).
const PROVIDER_LABEL: Record<AiProviderId, string> = {
  claude: 'Claude',
  chatgpt: 'ChatGPT',
  gemini: 'Gemini',
  hosted: 'ZTO Hosted'
}

// 소셜 코파일럿의 우측 AI 패널 — active provider로 대화(구독 CLI/API 키). resume로 맥락 이어감.
// 멀티모달 입력: 왼쪽 화면을 [화면 캡처]로 첨부하거나 이미지를 붙여넣으면 AI가 그림으로 본다(stream-json 검증됨).
interface Msg {
  // system = ZTO가 관찰한 사실(화면 이동·사용자 선택). AI 말도 사람 말도 아니라 톤이 따로다.
  role: 'user' | 'assistant' | 'system'
  text: string
  imgs?: string[] // dataURL 썸네일 (표시용)
}

// data:image/png;base64,XXXX → { mediaType, data }
function splitDataUrl(dataUrl: string): { mediaType: string; data: string } | null {
  const m = dataUrl.match(/^data:(.+?);base64,(.*)$/)
  return m ? { mediaType: m[1], data: m[2] } : null
}

// 코파일럿 모드에서 AI에 보내는 현재 화면 — **구조만, 원문 없이.**
// 안 채워진 것부터 보여준다. AI가 할 말은 "다음에 뭘 고르라"이므로 그게 앞에 와야 한다.
function describeForm(s: FormSnapshot): string {
  const todo = s.controls.filter((c) => !c.answered)
  const line = (c: FormSnapshot['controls'][number]): string =>
    `- ${c.label}${c.options.length ? ` [${c.options.join(' / ')}]` : ''}${c.value ? ` = ${c.value}` : ''}`
  return [
    `현재 화면: ${s.title}`,
    `진행: ${s.answered}/${s.total} 답함`,
    todo.length ? `아직 안 채운 항목:\n${todo.slice(0, 12).map(line).join('\n')}` : '모든 항목이 채워졌습니다.'
  ].join('\n')
}

// 목적 브리핑 — 대화의 **첫 턴**에 딱 한 번. 여는 것과 이끄는 것의 차이가 여기 있다.
// 마지막 줄이 핵심이다: 우리가 이미 아는 걸 되묻지 말라고 못 박는다. 안 그러면 AI가
// "어느 앱인가요? 패키지명을 알려주세요"로 시작한다 — 우리가 아는 것을 사용자에게 시키는 것이다.
// ZTO가 **직접 만드는** 프롬프트는 화면 언어를 따라야 한다. 지금까지 프롬프트가 한국어
// 하드코딩이라 영어 UI에서도 AI가 한국어로 답했다(2026-07-31 Dan). 사용자가 직접 친 말에는
// 안 붙인다 — 그건 사용자의 언어가 곧 지시다.
const langLine = (ko: boolean): string =>
  ko ? '한국어로 답하세요.' : 'Answer in English.'

// 소셜 패널의 **역할 규정**. 화면에 안내 문구를 띄우는 것과 다르다 — 문구는 읽고 넘기지만
// 페르소나는 이후 모든 답의 결을 바꾼다(무엇을 볼지, 무엇을 먼저 말할지).
// 대화 한 세션에 한 번만 실어 보낸다(resume로 맥락이 이어지므로 반복은 낭비다).
const socialPersona = (ko: boolean): string =>
  [
    '당신은 소셜미디어 그로스 마케터이자 카피라이터입니다. X·Threads·Instagram에서 무엇이 읽히고 무엇이 퍼지는지를 실무로 아는 사람입니다.',
    '이 대화에서 당신이 하는 일:',
    '- 사용자가 올리려는 글의 **훅(첫 문장)**이 손을 멈추게 하는지 본다',
    '- 문장이 짧고 읽히는지, 군더더기·전문용어·자기소개식 도입을 걷어낼 곳이 있는지 짚는다',
    '- 저장·공유·답글을 부를 요소(구체적 숫자, 의외성, 반박 여지, 질문)가 있는지 본다',
    '- 플랫폼별 관습(글자 수, 스레드로 쪼갤 지점, 해시태그 남용 금지)을 반영한다',
    '규칙: 칭찬으로 시작하지 말고 **고칠 곳 하나**를 먼저 말한다. 대안 문장은 예시로 직접 써서 보여준다.',
    '길게 쓰지 않는다 — 한 번에 두세 문장.',
    langLine(ko)
  ].join('\n')

function briefing(t: CopilotTask, ko: boolean): string {
  return [
    '사용자가 ZTO(앱 스토어 관리 도구)에서 이 콘솔 화면으로 넘어왔습니다.',
    `하려는 일: ${t.goal}`,
    t.app ? `대상 앱: ${t.app}` : '',
    t.platform ? `스토어: ${t.platform === 'android' ? 'Google Play Console' : 'App Store Connect'}` : '',
    t.why ? `ZTO에서 못 하고 콘솔에서 해야 하는 이유: ${t.why}` : '',
    t.exact
      ? '지금 화면이 그 작업을 하는 화면입니다. 여기서 무엇을 눌러야 하는지부터 짚어주세요.'
      : '지금은 목적지가 아니라 콘솔의 다른 화면(대개 홈)입니다. 목적지까지 가는 경로를 먼저 안내하세요.',
    '한두 문장으로 다음 한 걸음만 말하세요. 위에 이미 알려준 것(앱·목적)은 되묻지 마세요.',
    '작업이 되돌릴 수 없는 것이면(제출·게시·삭제) 누르기 전에 확인할 것을 함께 알려주세요.',
    langLine(ko)
  ]
    .filter(Boolean)
    .join('\n')
}

export default function AiPanel({
  watch = false,
  watchable = false,
  feature = 'social',
  task
}: {
  // 콘솔 코파일럿 모드 — 왼쪽 폼을 따라가며 사람이 고른 것을 감지한다(기본 켜짐)
  watch?: boolean
  // 따라가기를 **쓸 수 있게만** 한다(기본 꺼짐). 소셜용 —
  // 피드는 남의 글·DM이 섞여 있고 provider가 API 키면 그게 밖으로 나간다. 그래서 옵트인이다.
  // 게다가 피드에서 '바뀐 것'은 대개 스크롤이라, 콘솔 폼과 달리 자동 질문이 신호가 아니라 소음이다
  watchable?: boolean
  feature?: AiFeature
  // 무엇을 하러 왔는지. 있으면 대화를 이걸로 연다
  task?: CopilotTask
} = {}): React.JSX.Element {
  const { m, locale } = useI18n()
  const ko = locale === 'ko'
  const [msgs, setMsgs] = useState<Msg[]>([])
  const [input, setInput] = useState('')
  const [busy, setBusy] = useState(false)
  const [, setSession] = useState<string | undefined>(undefined)
  const [imgs, setImgs] = useState<string[]>([]) // 전송 전 첨부된 이미지 dataURL
  const [form, setForm] = useState<FormSnapshot | null>(null)
  // 화면이 바뀔 때마다 자동으로 물어볼지 — 기본 켜짐이되 **끌 수 있어야 한다**.
  // 자동 질문은 토큰을 쓰므로 사용자가 통제권을 가져야 하고, 생각을 정리하는 동안
  // AI가 계속 끼어드는 것도 방해다.
  const [follow, setFollow] = useState(watch)
  const followRef = useRef(watch)
  useEffect(() => {
    followRef.current = follow
  }, [follow])
  // provider별 모델 전부 — 한 드롭다운에서 두뇌(provider)와 모델을 같이 고른다.
  // 값은 "provider:modelId"로 인코딩해 어느 그룹에서 골랐는지 잃지 않는다.
  const [groups, setGroups] = useState<[AiProviderId, AiModel[]][]>([])
  const [pick, setPick] = useState('')
  const listRef = useRef<HTMLDivElement | null>(null)

  const loadAi = (): void => {
    window.zto.ai.status().then((s) => {
      setGroups(Object.entries(s.providerModels) as [AiProviderId, AiModel[]][])
      setPick(`${s.active}:${s.model}`)
    })
  }
  useEffect(loadAi, [])

  // provider가 바뀌면 active부터 옮기고 모델을 설정한다(순서 중요 — setModel은 active 기준으로 저장된다)
  const changePick = async (value: string): Promise<void> => {
    const [provider, id] = [value.slice(0, value.indexOf(':')), value.slice(value.indexOf(':') + 1)]
    setPick(value)
    await window.zto.ai.setActive(provider as AiProviderId)
    await window.zto.ai.setModel(id)
    loadAi()
  }

  useEffect(() => {
    listRef.current?.scrollTo(0, listRef.current.scrollHeight)
  }, [msgs, busy])

  const addImg = (dataUrl: string): void => setImgs((prev) => [...prev, dataUrl])
  const removeImg = (i: number): void => setImgs((prev) => prev.filter((_, idx) => idx !== i))

  // 현재 브라우저 화면(활성 탭)을 캡처해 첨부 — "AI가 내가 보는 걸 본다"
  const capture = async (): Promise<void> => {
    const d = await window.zto.browser.capture()
    if (d) addImg(d)
  }

  // 파일 → data URL (붙여넣기·드롭 공용)
  const readFile = (file: File): void => {
    const reader = new FileReader()
    reader.onload = () => typeof reader.result === 'string' && addImg(reader.result)
    reader.readAsDataURL(file)
  }

  // 드래그&드롭 첨부 — 떨어뜨리면 바로 붙는다. 기본 동작(파일을 창에 여는 것)은 막는다
  const onDrop = (e: React.DragEvent): void => {
    const files = [...(e.dataTransfer?.files ?? [])].filter((f) => f.type.startsWith('image/'))
    if (files.length === 0) return
    e.preventDefault()
    files.forEach(readFile)
  }

  // 클립보드 이미지 붙여넣기
  const onPaste = (e: React.ClipboardEvent): void => {
    for (const item of e.clipboardData.items) {
      if (item.type.startsWith('image/')) {
        const file = item.getAsFile()
        if (file) readFile(file)
      }
    }
  }

  // busy·session을 ref로도 든다 — 자동 질문은 이벤트 콜백에서 불리므로 state 클로저가 낡는다
  const busyRef = useRef(false)
  const sessionRef = useRef<string | undefined>(undefined)

  // 한 턴 보내기. `show`는 화면에 남길 사용자 말풍선 — 자동 질문일 땐 폼 덤프 대신
  // 짧은 시스템 줄만 남기려고 프롬프트와 표시를 분리했다(대화가 기계 텍스트로 도배되면 못 읽는다).
  const ask = async (prompt: string, sending: string[], show?: Msg): Promise<void> => {
    if (busyRef.current || !prompt) return
    busyRef.current = true
    setBusy(true)
    if (show) setMsgs((prev) => [...prev, show])
    const images = sending
      .map(splitDataUrl)
      .filter((x): x is { mediaType: string; data: string } => !!x)
    const r = await window.zto.ai.chat(prompt, {
      resume: sessionRef.current,
      images: images.length > 0 ? images : undefined,
      feature
    })
    busyRef.current = false
    setBusy(false)
    if (r.ok) {
      setMsgs((prev) => [...prev, { role: 'assistant', text: r.text }])
      if (r.sessionId) {
        sessionRef.current = r.sessionId
        setSession(r.sessionId)
      }
    } else {
      setMsgs((prev) => [...prev, { role: 'assistant', text: '⚠ ' + (r.error ?? 'failed') }])
    }
  }

  // 토글을 켠 순간 = 도움을 요청한 순간. 페르소나를 심고 **AI가 먼저 말을 건다**.
  // 화면에 "이런 걸 도와드려요"를 적는 대신 AI가 그 역할로 입을 여는 게 이 패널의 방식이다.
  useEffect(() => {
    if (!watchable || !follow || personaRef.current) return
    personaRef.current = true
    void ask(
      [
        socialPersona(ko),
        '사용자가 방금 화면 읽기를 켰습니다. 아직 글은 못 봤을 수 있습니다.',
        '한두 문장으로 먼저 말을 거세요 — 무엇을 도와줄 수 있는지 당신의 역할로 말하고, 초안을 보여달라고 청하세요. 목록·머리말 없이.'
      ].join('\n\n'),
      []
    )
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [watchable, follow])

  const send = async (): Promise<void> => {
    const text = input.trim()
    if ((!text && imgs.length === 0) || busy) return
    const sending = imgs
    const prompt = text || (sending.length > 0 ? m.social.imgPrompt : '')
    setInput('')
    setImgs([])
    // 코파일럿 모드에선 지금 화면을 프롬프트에 얹는다 — 사람이 "이거 뭐 골라?"라고만 해도
    // AI가 무슨 화면인지 알아야 답이 된다.
    //
    // 콘솔이면 폼 **구조**로 충분하고 그게 싸다. 소셜 페이지엔 폼이 없어서 그동안 아무것도
    // 안 실렸고, AI가 "영상 내용을 볼 수 없다"고 답했다(2026-08-13 실사용). 그럴 땐 화면의
    // **글**을 그 자리에서 읽어 붙인다 — 주기적으로 긁지 않으므로 토글이 곧 약속 그대로다.
    let context = ''
    if (watch) {
      if (form && form.controls.length > 0) context = describeForm(form)
      else {
        const r = await window.zto.browser.pageText()
        const pg = r.ok ? (r.result as { url: string; title: string; text: string }) : null
        if (pg?.text?.trim()) context = `[${pg.title}] ${pg.url}\n${pg.text}`
      }
    }
    const withForm = context ? `${prompt}\n\n---\n${context}` : prompt
    // 토글을 안 켜고 바로 말을 걸어도 역할은 앞서야 한다 — 첫 답부터 결이 달라진다
    const withPersona =
      watchable && !personaRef.current
        ? ((personaRef.current = true), `${socialPersona(ko)}\n\n---\n${withForm}`)
        : withForm
    await ask(withPersona, sending, { role: 'user', text, imgs: sending })
  }

  // ---- 목적 브리핑 — 열리자마자 한 번 ----
  // 화면에는 목적 한 줄만 남기고(사람이 읽을 수 있게) 상세 지시는 프롬프트로만 보낸다.
  const briefed = useRef(false)
  // 소셜 페르소나를 이 대화에 한 번만 심는다
  const personaRef = useRef(false)
  useEffect(() => {
    if (!task || briefed.current) return
    briefed.current = true
    setMsgs((prev) => [...prev, { role: 'system', text: task.goal }])
    void ask(briefing(task, ko), [])
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [task])

  // ---- 콘솔 코파일럿: 왼쪽 폼 따라가기 ----
  // main이 1.5초마다 폼을 읽어 **달라졌을 때만** 알려준다. 여기서는 그걸 대화로 옮긴다.
  useEffect(() => {
    // **꺼져 있으면 읽지도 않는다** — '자동 질문만 끈다'로는 화면을 계속 읽는 셈이라
    // 프라이버시 약속이 되지 못한다
    if ((!watch && !watchable) || !follow) return
    void window.zto.browser.watchForm(true)
    const off = window.zto.browser.onFormChanged((c) => {
      setForm(c.snapshot)
      // 화면에 남기는 건 짧은 한 줄 — 사람이 대화를 읽을 수 있어야 한다
      const line = c.navigated
        ? m.social.formMoved.replace('{t}', c.snapshot.title.split('|')[0].trim())
        : c.changed.join(' · ')
      if (!line) return
      setMsgs((prev) => [...prev, { role: 'system', text: line }])
      if (!followRef.current) return
      // 자동 질문 — 바뀐 것 + 남은 항목만. 전체를 매번 보내면 토큰이 그대로 샌다.
      // **소셜과 콘솔은 물어볼 것이 다르다**: 콘솔은 "다음에 뭘 고르나", 소셜은 쓰고 있는 글이
      // 사람들에게 어떻게 읽힐지다. 같은 프롬프트를 쓰면 소셜에서 "다음 항목을 고르세요"라는
      // 엉뚱한 말이 나온다
      const prompt = watchable
        ? [
            c.navigated ? '사용자가 다른 화면으로 이동했습니다.' : `왼쪽 화면이 바뀌었습니다: ${c.changed.join(', ')}`,
            describeForm(c.snapshot),
            '사용자가 소셜미디어에 올릴 글을 쓰는 중일 수 있습니다. 쓰고 있는 글이 있으면 훅(첫 문장)·읽히는 매력·퍼질 만한 요소를 한두 문장으로 짚고, 고칠 곳을 하나만 제안하세요. 쓰는 글이 없으면 아무 말도 하지 말고 "—"만 답하세요.',
            langLine(ko)
          ].join('\n\n')
        : [
            c.navigated ? '콘솔 화면이 바뀌었습니다.' : `사용자가 방금 골랐습니다: ${c.changed.join(', ')}`,
            describeForm(c.snapshot),
            '다음에 무엇을 고르면 되는지 한두 문장으로 짚어주세요. 확실하지 않으면 무엇을 확인해야 하는지 물어보세요.',
            langLine(ko)
          ].join('\n\n')
      void ask(prompt, [])
    })
    return () => {
      off()
      void window.zto.browser.watchForm(false)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [watch, watchable, follow, ko])

  return (
    <aside className="ai-panel">
      <div className="ai-panel-head">
        <strong>{m.social.aiTitle}</strong>
        {groups.length > 0 && (
          <select
            className="ai-model-select"
            value={pick}
            onChange={(e) => void changePick(e.target.value)}
          >
            {groups.map(([provider, list]) => (
              <optgroup key={provider} label={PROVIDER_LABEL[provider]}>
                {list.map((mo) => (
                  <option key={`${provider}:${mo.id}`} value={`${provider}:${mo.id}`}>
                    {mo.label}
                  </option>
                ))}
              </optgroup>
            ))}
          </select>
        )}
      </div>
      {/* 소셜에서는 폼 띠가 없으므로 토글만 따로 낸다. **끄고 켜는 게 눈에 보여야** 한다 —
          화면을 읽는 기능이 어딘가 묻혀 있으면 그건 몰래 읽는 것과 구분되지 않는다 */}
      {watchable && (
        <div className="ai-form-strip" title={m.social.watchTitle}>
          {/* 라벨 + 스위치. 전엔 라벨과 버튼이 같은 말을 두 번 하면서 켜짐/꺼짐이 안 보였다(Dan) —
              계정 인벤토리의 토글 스위치와 같은 부품을 써서 상태가 모양으로 읽히게 한다 */}
          <span className="switch-row">
            <span className="switch-label">{m.social.watchLabel}</span>
            <button
              className={`switch ${follow ? 'on' : ''}`}
              onClick={() => setFollow((v) => !v)}
              role="switch"
              aria-checked={follow}
            >
              <span className="knob" />
            </button>
          </span>
          <span className="ai-watch-state">{follow ? m.social.watchOn : m.social.watchOff}</span>
        </div>
      )}
      {/* 코파일럿 진행 띠 — 왼쪽 폼의 현재 상태. 대화를 안 걸어도 "몇 개 남았나"가 늘 보인다 */}
      {watch && form && (
        <div className="ai-form-strip">
          <span className="ai-form-title">{form.title.split('|')[0].trim()}</span>
          <span className="ai-form-count">
            {m.social.formProgress
              .replace('{a}', String(form.answered))
              .replace('{n}', String(form.total))}
          </span>
          <button
            className={`ai-follow ${follow ? 'on' : ''}`}
            onClick={() => setFollow((v) => !v)}
            title={m.social.followTitle}
          >
            {m.social.follow}
          </button>
        </div>
      )}
      <div className="ai-msgs" ref={listRef}>
        {msgs.length === 0 && (
          <div className="ai-empty">{watch ? m.social.aiEmptyConsole : m.social.aiEmpty}</div>
        )}
        {msgs.map((mm, i) => (
          <div key={i} className={`ai-msg ${mm.role}`}>
            {mm.imgs && mm.imgs.length > 0 && (
              <div className="ai-msg-imgs">
                {mm.imgs.map((src, k) => (
                  <img key={k} src={src} alt="" />
                ))}
              </div>
            )}
            {/* AI 답변만 마크다운으로 — 사람이 친 글과 ZTO 관찰 줄은 원문 그대로가 맞다
                (사용자가 별표를 쳤으면 별표를 보여줘야 하고, 관찰 줄엔 문법이 없다) */}
            {mm.role === 'assistant' ? <Markdown text={mm.text} /> : mm.text}
          </div>
        ))}
        {busy && <div className="ai-msg assistant thinking">{m.social.aiThinking}</div>}
      </div>
      {imgs.length > 0 && (
        <div className="ai-attachments">
          {imgs.map((src, i) => (
            <div key={i} className="ai-attach">
              <img src={src} alt="" />
              <button className="ai-attach-x" onClick={() => removeImg(i)}>
                ✕
              </button>
            </div>
          ))}
        </div>
      )}
      <div className="ai-input-row">
        <button className="br-nav" onClick={capture} title={m.social.captureTitle}>
          ▣
        </button>
        <textarea
          className="email-input ai-input"
          value={input}
          placeholder={m.social.aiPlaceholder}
          onChange={(e) => setInput(e.target.value)}
          onPaste={onPaste}
          onDragOver={(e) => e.preventDefault()}
          onDrop={onDrop}
          onKeyDown={(e) => {
            // IME 조합 중 Enter는 확정이지 전송이 아니다 — 조합 확정분이 비운 입력창에
            // 도로 꽂히는 버그(2026-08-03 실측: 전송됐는데 텍스트가 남음)의 원인
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault()
              send()
            }
          }}
        />
        <button className="choice small active" onClick={send} disabled={busy}>
          {m.social.aiSend}
        </button>
      </div>
    </aside>
  )
}
