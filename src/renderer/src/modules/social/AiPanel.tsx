import { useEffect, useRef, useState } from 'react'
import type { AiModel, AiProviderId } from '../../../../shared/launch-types'
import { useI18n } from '../../i18n'

// provider 표기는 브랜드명이라 번역하지 않는다(설정 페이지와 같은 문자열).
const PROVIDER_LABEL: Record<AiProviderId, string> = {
  claude: 'Claude',
  chatgpt: 'ChatGPT',
  gemini: 'Gemini'
}

// 소셜 코파일럿의 우측 AI 패널 — active provider로 대화(구독 CLI/API 키). resume로 맥락 이어감.
// 멀티모달 입력: 왼쪽 화면을 [화면 캡처]로 첨부하거나 이미지를 붙여넣으면 AI가 그림으로 본다(stream-json 검증됨).
interface Msg {
  role: 'user' | 'assistant'
  text: string
  imgs?: string[] // dataURL 썸네일 (표시용)
}

// data:image/png;base64,XXXX → { mediaType, data }
function splitDataUrl(dataUrl: string): { mediaType: string; data: string } | null {
  const m = dataUrl.match(/^data:(.+?);base64,(.*)$/)
  return m ? { mediaType: m[1], data: m[2] } : null
}

export default function AiPanel(): React.JSX.Element {
  const { m } = useI18n()
  const [msgs, setMsgs] = useState<Msg[]>([])
  const [input, setInput] = useState('')
  const [busy, setBusy] = useState(false)
  const [session, setSession] = useState<string | undefined>(undefined)
  const [imgs, setImgs] = useState<string[]>([]) // 전송 전 첨부된 이미지 dataURL
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

  const send = async (): Promise<void> => {
    const text = input.trim()
    if ((!text && imgs.length === 0) || busy) return
    const sending = imgs
    const prompt = text || (sending.length > 0 ? m.social.imgPrompt : '')
    setInput('')
    setImgs([])
    setMsgs((prev) => [...prev, { role: 'user', text, imgs: sending }])
    setBusy(true)

    const images = sending.map(splitDataUrl).filter((x): x is { mediaType: string; data: string } => !!x)
    const r = await window.zto.ai.chat(prompt, {
      resume: session,
      images: images.length > 0 ? images : undefined,
      feature: 'social'
    })
    setBusy(false)
    if (r.ok) {
      setMsgs((prev) => [...prev, { role: 'assistant', text: r.text }])
      if (r.sessionId) setSession(r.sessionId)
    } else {
      setMsgs((prev) => [...prev, { role: 'assistant', text: '⚠ ' + (r.error ?? 'failed') }])
    }
  }

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
      <div className="ai-msgs" ref={listRef}>
        {msgs.length === 0 && <div className="ai-empty">{m.social.aiEmpty}</div>}
        {msgs.map((mm, i) => (
          <div key={i} className={`ai-msg ${mm.role}`}>
            {mm.imgs && mm.imgs.length > 0 && (
              <div className="ai-msg-imgs">
                {mm.imgs.map((src, k) => (
                  <img key={k} src={src} alt="" />
                ))}
              </div>
            )}
            {mm.text}
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
