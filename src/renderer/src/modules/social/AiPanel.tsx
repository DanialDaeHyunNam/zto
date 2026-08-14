import { useEffect, useRef, useState } from 'react'
import type { AiFeature, AiModel, AiProviderId, CopilotTask } from '../../../../shared/launch-types'
import type { FormSnapshot } from '../../../../shared/console-types'
import { useI18n } from '../../i18n'
// 프롬프트는 공용 모듈에 산다 — evals가 같은 것을 돌려야 회귀를 잡는다(복제하면 곧 갈라진다)
import {
  consolePersona,
  isResearchUrl,
  langLine,
  socialPersona,
  TOOL_TAG,
  toolPreamble
} from '../../../../shared/social-prompts'
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
  // 'need' = 사람이 손을 대야 진행되는 줄(읽기 토글을 켜달라 등). 관찰 줄과 톤이 다르다 —
  // 조용한 회색 칩으로 두면 **읽히지 않고 넘어간다**(2026-08-14 Dan: "눈에 확 띄게")
  tone?: 'need'
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
  task,
  inject,
  onNeedPage
}: {
  // 콘솔 코파일럿 모드 — 왼쪽 폼을 따라가며 사람이 고른 것을 감지한다(기본 켜짐)
  watch?: boolean
  // 따라가기를 **쓸 수 있게만** 한다(기본 꺼짐). 소셜용 —
  // 피드는 남의 글·DM이 섞여 있고 provider가 API 키면 그게 밖으로 나간다. 그래서 옵트인이다.
  // 게다가 피드에서 '바뀐 것'은 대개 스크롤이라, 콘솔 폼과 달리 자동 질문이 신호가 아니라 소음이다
  watchable?: boolean
  // 왼쪽 툴바가 "이 화면을 넘겨줘"라고 보낸 신호. seq가 바뀔 때마다 한 번 처리한다
  inject?: { kind: 'text' | 'html'; seq: number } | null
  // 읽기가 꺼진 채 AI가 화면을 필요로 할 때 — 왼쪽 버튼을 빛나게 해 사람이 누르게 한다
  onNeedPage?: (kind: 'text' | 'html') => void
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
  // 프라이버시 게이트가 볼 값. 소셜은 화면의 토글(follow), 콘솔은 prop(watch)이 기준이다.
  // ⚠️ 이 둘을 헷갈려 **게이트가 소셜에서 항상 막혀 있었다** — 도구가 전부 거부되어
  // AI가 "저는 화면 자체를 못 봅니다"라고 답했다(2026-08-14 실사용, provider와 무관했다).
  const reading = watchable ? follow : watch
  // 읽기가 꺼진 채 AI가 화면을 필요로 하면 **토글 자체**를 빛나게 한다 — 눌러야 할 자리가
  // 안내 문장 바로 위에 있는데 그걸 글로만 말하면 사람이 찾아야 한다
  const [hintToggle, setHintToggle] = useState(false)
  useEffect(() => {
    if (!hintToggle) return
    if (follow) return setHintToggle(false) // 켜는 순간 힌트는 할 일을 다 했다
    const t = setTimeout(() => setHintToggle(false), 8000)
    return () => clearTimeout(t)
  }, [hintToggle, follow])
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
  // 화면 내용을 프롬프트로 옮기는 형식. **제목을 앞세우지 않는다** — SPA에서 document.title은
  // 낡는다: TikTok 로그인 모달을 닫아도 탭 제목이 "가입하기"로 남아, AI가 본문(영상·댓글)을
  // 받고도 "지금은 가입 페이지"라고 답했다(2026-08-14 실사용). 본문이 사실이고 제목은 참고다.
  const pageContext = (pg: { url: string; title: string; text: string }): string =>
    [
      `URL: ${pg.url}`,
      pg.title ? `(${m.social.staleTitle.replace('{t}', pg.title)})` : '',
      '',
      pg.text
    ]
      .filter(Boolean)
      .join('\n')

  // 도구 한 건 실행 — 모델이 짠 코드를 돌리지 않는다. 이름으로 우리 함수를 고를 뿐이다.
  const runTool = async (
    spec: { tool?: string; dy?: number; q?: string; url?: string } | null
  ): Promise<{ note: string; text?: string; image?: string; need?: 'text' | 'html' }> => {
    const kind = spec?.tool

    // 우리 데이터 — 토글과 무관하다. 사용자가 ZTO에 직접 적어둔 것이고 밖으로 나갈 일이 없다.
    // 이게 없으면 AI가 "어느 앱이죠?"를 되묻는다 — 콘솔에서 이미 고쳤던 실수의 반복이다.
    if (kind === 'my_accounts') {
      const list = await window.zto.accounts.list()
      const lines = list.map((a) => `${a.email}${a.memo ? ` — ${a.memo}` : ''} · ${(a.apps ?? []).join(', ')}`)
      return { note: m.social.toolAccounts, text: lines.join('\n') || '(none)' }
    }
    if (kind === 'my_apps') {
      const sheets = await window.zto.launch.listSheets()
      const lines = sheets.map((x) => `${x.appName} (${x.packageName})`)
      return { note: m.social.toolApps, text: lines.join('\n') || '(none)' }
    }

    // 찾아보러 가기 — 공개 리서치 소스는 토글 없이, 그 밖은 로그인 상태가 묻어날 수 있어 토글 필요
    if (kind === 'search_web' || kind === 'open_url') {
      const url =
        kind === 'search_web'
          ? `https://www.google.com/search?q=${encodeURIComponent(String(spec?.q ?? ''))}`
          : String(spec?.url ?? '')
      if (!url) return { note: m.social.toolFailed }
      if (!reading && !isResearchUrl(url)) {
        setHintToggle(true)
        onNeedPage?.('text')
        return { note: m.social.needPage, need: 'text' }
      }
      const r = await window.zto.browser.openAndRead(url)
      const pg = r.ok ? (r.result as { url: string; title: string; text: string }) : null
      if (!pg?.text) return { note: m.social.toolFailed }
      return {
        note: m.social.toolOpened.replace('{u}', pg.title || pg.url),
        text: pageContext(pg)
      }
    }

    // **토글이 꺼져 있으면 내 화면을 읽지 않는다.** 이 스위치는 편의가 아니라 약속이다 —
    // 피드엔 남의 글·DM이 섞여 있고, provider가 API 키면 그게 밖으로 나간다.
    // 대신 사람에게 요청한다: 왼쪽 버튼이 빛나고, 누른 순간에만 화면이 나간다.
    if (!reading && kind) {
      const want = kind === 'page_html' ? 'html' : 'text'
      setHintToggle(true)
      onNeedPage?.(want)
      return { note: want === 'html' ? m.social.needHtml : m.social.needPage, need: want }
    }
    if (kind === 'screenshot') {
      const d = await window.zto.browser.capture()
      return d
        ? { note: m.social.toolShot, image: d, text: m.social.toolShotResult }
        : { note: m.social.toolFailed }
    }
    if (kind === 'scroll') {
      const dy = typeof spec?.dy === 'number' ? Math.max(-4000, Math.min(4000, spec.dy)) : 800
      await window.zto.browser.eval(`window.scrollBy(0, ${dy}); ''`)
      const r = await window.zto.browser.pageText('text')
      const pg = r.ok ? (r.result as { text: string }) : null
      return { note: m.social.toolScroll, text: pg?.text ?? '' }
    }
    if (kind === 'page_text' || kind === 'page_html') {
      const r = await window.zto.browser.pageText(kind === 'page_html' ? 'html' : 'text')
      const pg = r.ok ? (r.result as { url: string; title: string; text: string }) : null
      if (!pg?.text) return { note: m.social.toolFailed }
      return {
        note: kind === 'page_html' ? m.social.toolHtml : m.social.toolText,
        text: pageContext(pg)
      }
    }
    return { note: m.social.toolUnknown }
  }

  // 한 턴에 도구가 쓸 수 있는 총량. 도구별 상한(글 8k·HTML 12k)만으로는 **누적**을 못 막는다 —
  // HTML을 세 번 부르면 한 질문에 36k가 실린다. Plus에선 그 원가를 우리가 내므로 돈 문제이기도 하다.
  // 넘으면 자르고 **잘렸다고 모델에게 알린다**(모르면 없는 내용을 있다고 여긴다).
  const TOOL_BUDGET = 20000

  // 한 번 물으면 **모델이 필요한 만큼 도구를 부르고** 우리가 실행해 되먹인다.
  // provider별 tool-calling에 기대지 않는 얇은 루프 — 어느 모델이든 같은 방식으로 돈다.
  // 상한 3회: 모르는 화면에서 무한히 훑는 것보다 "못 찾겠다"가 낫고, 토큰이 새지 않는다.
  const ask = async (prompt: string, sending: string[], show?: Msg): Promise<void> => {
    if (busyRef.current || !prompt) return
    busyRef.current = true
    setBusy(true)
    if (show) setMsgs((prev) => [...prev, show])
    let nextPrompt = prompt
    let nextImgs = sending
    let budget = TOOL_BUDGET
    for (let round = 0; round <= 3; round++) {
      const images = nextImgs
        .map(splitDataUrl)
        .filter((x): x is { mediaType: string; data: string } => !!x)
      const r = await window.zto.ai.chat(nextPrompt, {
        resume: sessionRef.current,
        images: images.length > 0 ? images : undefined,
        feature,
        // 역할·도구 규약은 **시스템 프롬프트로** 보낸다. 프롬프트 앞에 붙이면 CLI의 기본
        // 시스템 프롬프트(코딩 에이전트)가 그대로 남아, 모델이 자기 파일 도구를 우리 규약보다
        // 앞세운다 — "지금 열 수 있는 건 .pen 파일뿐"이 그 증상이었다(2026-08-14).
        system: `${watchable ? socialPersona(ko) : consolePersona(ko)}\n\n${toolPreamble(ko)}`
      })
      if (!r.ok) {
        setMsgs((prev) => [...prev, { role: 'assistant', text: '⚠ ' + (r.error ?? 'failed') }])
        break
      }
      if (r.sessionId) {
        sessionRef.current = r.sessionId
        setSession(r.sessionId)
      }
      const hit = round < 3 ? TOOL_TAG.exec(r.text) : null
      const said = hit ? r.text.replace(TOOL_TAG, '').trim() : r.text
      if (said) setMsgs((prev) => [...prev, { role: 'assistant', text: said }])
      if (!hit) break
      let spec: { tool?: string; dy?: number; q?: string; url?: string } | null = null
      let broken = false
      try {
        spec = JSON.parse(hit[1])
      } catch {
        broken = true // 조용히 넘기지 않는다 — 왜 실패했는지 모르면 모델은 같은 실수를 반복한다
      }
      if (broken) {
        setMsgs((prev) => [...prev, { role: 'system', text: m.social.toolBadFormat }])
        nextPrompt = m.social.toolBadFormatPrompt
        nextImgs = []
        continue
      }
      const res = await runTool(spec)
      // 화면엔 무엇을 했는지 한 줄만 — 본문은 프롬프트로만 간다
      setMsgs((prev) => [
        ...prev,
        { role: 'system', text: res.note, ...(res.need ? { tone: 'need' as const } : {}) }
      ])
      if (res.need) break // 사람이 버튼을 누를 차례다 — AI에게 되묻지 않는다(왕복도 토큰도 낭비)
      let body = res.text ?? ''
      if (body.length > budget) {
        body = body.slice(0, Math.max(0, budget)) + `\n\n${m.social.toolTruncated}`
        budget = 0
      } else {
        budget -= body.length
      }
      nextPrompt = body ? `${m.social.toolResult}\n\n${body}` : m.social.toolFailed
      nextImgs = res.image ? [res.image] : []
    }
    busyRef.current = false
    setBusy(false)
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
    if (reading) {
      // **소셜에선 폼이 아니라 글이다.** 폼 프로브는 어느 페이지에서든 컨트롤 몇 개(검색창 등)를
      // 잡아내는데, 그걸 우선하면 TikTok에서 AI에게 "탐색 탭"만 전달되고 정작 영상·캡션·댓글은
      // 안 간다 — AI가 "영상 내용이 저한테는 안 보여요"라고 답한 이유다(2026-08-14 실사용).
      // 콘솔은 반대다: 거기선 폼 구조가 곧 내용이다.
      if (!watchable && form && form.controls.length > 0) context = describeForm(form)
      else {
        const r = await window.zto.browser.pageText()
        const pg = r.ok ? (r.result as { url: string; title: string; text: string }) : null
        if (pg?.text?.trim()) context = pageContext(pg)
      }
    }
    const withForm = context ? `${prompt}\n\n---\n${context}` : prompt
    // 토글을 안 켜고 바로 말을 걸어도 역할은 앞서야 한다 — 첫 답부터 결이 달라진다
    await ask(withForm, sending, { role: 'user', text, imgs: sending })
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

  // ---- 왼쪽 툴바가 넘긴 화면을 대화에 얹기 ----
  // "읽기" 토글과 다른 물건이다: 토글은 **물을 때마다** 자동으로 붙이고, 이 버튼은 **지금 한 번**
  // 넘긴다. 크롤링이 막히거나 글로는 구조가 사라지는 사이트에서, 사람이 직접 복붙하던 일을 대신한다.
  const injectSeq = useRef(0)
  useEffect(() => {
    if (!inject || inject.seq === injectSeq.current) return
    injectSeq.current = inject.seq
    void (async () => {
      const r = await window.zto.browser.pageText(inject.kind)
      const pg = r.ok ? (r.result as { url: string; title: string; text: string }) : null
      if (!pg?.text?.trim()) {
        setMsgs((prev) => [...prev, { role: 'system', text: m.social.injectEmpty }])
        return
      }
      const label = inject.kind === 'html' ? m.browser.sendHtml : m.browser.sendText
      // 화면에는 짧은 줄만, 프롬프트에는 본문 전체 — 대화가 기계 텍스트로 도배되면 못 읽는다
      void ask(
        [
          `${m.social.injectPrompt}`,
          pageContext(pg),
          langLine(ko)
        ].join('\n\n'),
        [],
        { role: 'user', text: `${label} — ${pg.title || pg.url}` }
      )
    })()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [inject])

  // ---- 콘솔 코파일럿: 왼쪽 폼 따라가기 ----
  // main이 1.5초마다 폼을 읽어 **달라졌을 때만** 알려준다. 여기서는 그걸 대화로 옮긴다.
  useEffect(() => {
    // **폴링은 콘솔에서만.** 소셜은 자동으로 말 걸지 않으므로(피드의 '변경'은 대개 스크롤이라
    // 신호가 아니라 소음이고 매번 토큰이다) 1.5초마다 폼을 긁을 이유가 없다. 소셜의 읽기는
    // 물을 때 그 자리에서 한다 — 토글이 약속하는 것과 실제 행위가 그래야 일치한다.
    if (!watch || !follow) return
    void window.zto.browser.watchForm(true)
    const off = window.zto.browser.onFormChanged((c) => {
      setForm(c.snapshot)
      // 화면에 남기는 건 짧은 한 줄 — 사람이 대화를 읽을 수 있어야 한다
      // 이동 알림("Moved to …")은 그리지 않는다 — 화면이 이미 말해주고, 대화만 지저분해진다.
      // 게다가 SPA 제목은 낡아서 엉뚱한 이름이 남는다("가입하기"). 바뀐 값만 짧게 남긴다.
      const line = c.navigated ? '' : c.changed.join(' · ')
      if (line) setMsgs((prev) => [...prev, { role: 'system', text: line }])
      if (!followRef.current) return
      // 자동 질문 — 바뀐 것 + 남은 항목만. 전체를 매번 보내면 토큰이 그대로 샌다.
      // **소셜과 콘솔은 물어볼 것이 다르다**: 콘솔은 "다음에 뭘 고르나", 소셜은 쓰고 있는 글이
      // 사람들에게 어떻게 읽힐지다. 같은 프롬프트를 쓰면 소셜에서 "다음 항목을 고르세요"라는
      // 엉뚱한 말이 나온다
      const prompt = watchable
        ? [
            c.navigated ? '사용자가 다른 화면으로 이동했습니다.' : `왼쪽 화면이 바뀌었습니다: ${c.changed.join(', ')}`,
            describeForm(c.snapshot),
            '사용자가 소셜미디어에 올릴 글을 쓰는 중일 수 있습니다. 쓰고 있는 글이 있으면 훅(첫 문장)·읽히는 매력·퍼질 만한 요소를 한두 문장으로 짚고, 고칠 곳을 하나만 제안하세요. 쓰는 글이 없으면 **지금 화면이 무엇인지 한 줄로만** 알려주세요(예: "릴스 편집 화면으로 넘어오셨네요"). 빈 답이나 기호만 보내지 마세요.',
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
              className={`switch ${follow ? 'on' : ''} ${hintToggle ? 'wanted' : ''}`}
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
          <div key={i} className={`ai-msg ${mm.role} ${mm.tone ?? ''}`}>
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
