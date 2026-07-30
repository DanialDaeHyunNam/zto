import { useEffect, useRef, useState } from 'react'
import type { AiFeature, AiModel, AiProviderId } from '../../../../shared/launch-types'
import type { FormSnapshot } from '../../../../shared/console-types'
import { useI18n } from '../../i18n'
import Markdown from './Markdown'

// provider 표기는 브랜드명이라 번역하지 않는다(설정 페이지와 같은 문자열).
const PROVIDER_LABEL: Record<AiProviderId, string> = {
  claude: 'Claude',
  chatgpt: 'ChatGPT',
  gemini: 'Gemini'
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

export default function AiPanel({
  watch = false,
  feature = 'social'
}: {
  // 콘솔 코파일럿 모드 — 왼쪽 폼을 따라가며 사람이 고른 것을 감지한다
  watch?: boolean
  feature?: AiFeature
} = {}): React.JSX.Element {
  const { m } = useI18n()
  const [msgs, setMsgs] = useState<Msg[]>([])
  const [input, setInput] = useState('')
  const [busy, setBusy] = useState(false)
  const [, setSession] = useState<string | undefined>(undefined)
  const [imgs, setImgs] = useState<string[]>([]) // 전송 전 첨부된 이미지 dataURL
  const [form, setForm] = useState<FormSnapshot | null>(null)
  // 화면이 바뀔 때마다 자동으로 물어볼지 — 기본 켜짐이되 **끌 수 있어야 한다**.
  // 자동 질문은 토큰을 쓰므로 사용자가 통제권을 가져야 하고, 생각을 정리하는 동안
  // AI가 계속 끼어드는 것도 방해다.
  const [follow, setFollow] = useState(true)
  const followRef = useRef(true)
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

  // 클립보드 이미지 붙여넣기
  const onPaste = (e: React.ClipboardEvent): void => {
    for (const item of e.clipboardData.items) {
      if (item.type.startsWith('image/')) {
        const file = item.getAsFile()
        if (file) {
          const reader = new FileReader()
          reader.onload = () => typeof reader.result === 'string' && addImg(reader.result)
          reader.readAsDataURL(file)
        }
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

  const send = async (): Promise<void> => {
    const text = input.trim()
    if ((!text && imgs.length === 0) || busy) return
    const sending = imgs
    const prompt = text || (sending.length > 0 ? m.social.imgPrompt : '')
    setInput('')
    setImgs([])
    // 코파일럿 모드에선 지금 화면을 프롬프트에 얹는다 — 사람이 "이거 뭐 골라?"라고만 해도
    // AI가 무슨 화면인지 알아야 답이 된다. 원문이 아니라 구조라 값이 싸다.
    const withForm =
      watch && form ? `${prompt}\n\n---\n${describeForm(form)}` : prompt
    await ask(withForm, sending, { role: 'user', text, imgs: sending })
  }

  // ---- 콘솔 코파일럿: 왼쪽 폼 따라가기 ----
  // main이 1.5초마다 폼을 읽어 **달라졌을 때만** 알려준다. 여기서는 그걸 대화로 옮긴다.
  useEffect(() => {
    if (!watch) return
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
      const prompt = [
        c.navigated ? '콘솔 화면이 바뀌었습니다.' : `사용자가 방금 골랐습니다: ${c.changed.join(', ')}`,
        describeForm(c.snapshot),
        '다음에 무엇을 고르면 되는지 한두 문장으로 짚어주세요. 확실하지 않으면 무엇을 확인해야 하는지 물어보세요.'
      ].join('\n\n')
      void ask(prompt, [])
    })
    return () => {
      off()
      void window.zto.browser.watchForm(false)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [watch])

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
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
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
