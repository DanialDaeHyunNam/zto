// ---------- 최소 마크다운 렌더러 ----------
// AI 답변이 `**굵게**`를 그대로 뱉어 화면에 별표가 보였다(2026-07-30 Dan). 모델은 마크다운으로
// 답하는 게 기본값이라, 안 그리면 원문이 새는 게 아니라 **읽기가 나빠진다**.
//
// 라이브러리를 안 쓰는 이유 둘:
//  ① AI 출력은 신뢰할 수 없는 텍스트다 — `dangerouslySetInnerHTML` 경로를 아예 만들지 않는다.
//     여기서는 문자열을 파싱해 **React 노드로만** 만들므로 HTML 주입이 원천적으로 불가능하다.
//  ② 채팅 말풍선에 필요한 문법은 몇 개뿐이다(굵게·기울임·코드·목록·링크). 전체 스펙은 짐이다.
//
// 지원: **굵게** · *기울임* · `코드` · [링크](url) · - 목록 · 1. 목록 · ``` 코드블록 · 줄바꿈
import React, { useState } from 'react'
import { useI18n } from '../../i18n'

// ---------- 초안 카드 ----------
// 코드블록으로 온 것은 소셜 패널에서 사실상 **바로 쓸 글**(캡션·댓글·스레드)이다.
// 읽기만 되는 <pre>로 두면 결국 드래그해서 복사하고 다른 데 붙여 고치게 되는데,
// 그 왕복이 이 패널을 쓰는 이유를 깎는다. 그래서 복사·편집을 카드 안에서 끝낸다.
// 편집은 **로컬**이다 — 대화에 되돌려 보내지 않는다(고친 건 사람 것이고, AI가 다시 손대면 안 된다).
function DraftCard({ text }: { text: string }): React.JSX.Element {
  const { m } = useI18n()
  const [val, setVal] = useState(text)
  const [editing, setEditing] = useState(false)
  const [copied, setCopied] = useState(false)
  const [open, setOpen] = useState(false)
  const long = val.length > 600 || val.split('\n').length > 14

  const copy = (): void => {
    void navigator.clipboard.writeText(val)
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }

  return (
    <div className="draft-card">
      <div className="draft-head">
        <button className="ghost-btn mini" onClick={() => setEditing(!editing)}>
          {editing ? m.social.draftDone : m.social.draftEdit}
        </button>
        <span className="draft-head-right">
          {copied && <span className="draft-copied">{m.social.draftCopied}</span>}
          <button className="ghost-btn mini" onClick={copy} title={m.social.draftCopy}>
            <svg viewBox="0 0 16 16" className="draft-ic" aria-hidden="true">
              <rect x="5.5" y="5.5" width="8" height="8" rx="1.6" fill="none" stroke="currentColor" strokeWidth="1.4" />
              <path d="M10.5 3.5H3.6a1 1 0 0 0-1 1V11" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
            </svg>
          </button>
          {long && (
            <button
              className="ghost-btn mini"
              onClick={() => setOpen(!open)}
              title={open ? m.social.draftCollapse : m.social.draftExpand}
            >
              <svg viewBox="0 0 16 16" className="draft-ic" aria-hidden="true">
                <path
                  d={open ? 'M9 7h4M3 9h4M11 3v4M5 9v4' : 'M10 2h4v4M6 14H2v-4M14 2l-5 5M2 14l5-5'}
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.4"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
            </button>
          )}
        </span>
      </div>
      {editing ? (
        <textarea
          className="draft-ta"
          value={val}
          onChange={(e) => setVal(e.target.value)}
          rows={Math.min(24, val.split('\n').length + 2)}
          autoFocus
        />
      ) : (
        <pre className={`draft-body ${long && !open ? 'clipped' : ''}`}>{val}</pre>
      )}
    </div>
  )
}

// 인라인 문법 — 굵게가 기울임보다 먼저다(`**`를 `*` 두 번으로 잘못 먹지 않게).
// 링크는 http/https만 받는다(javascript: 등 스킴을 통과시키지 않는다).
const INLINE = /(\*\*[^*]+\*\*|\*[^*\n]+\*|`[^`\n]+`|\[[^\]\n]+\]\(https?:\/\/[^)\s]+\))/g

function inline(text: string, keyBase: string): React.ReactNode[] {
  const out: React.ReactNode[] = []
  let last = 0
  let m: RegExpExecArray | null
  INLINE.lastIndex = 0
  while ((m = INLINE.exec(text)) !== null) {
    if (m.index > last) out.push(text.slice(last, m.index))
    const t = m[0]
    const key = `${keyBase}-${m.index}`
    if (t.startsWith('**')) out.push(<strong key={key}>{t.slice(2, -2)}</strong>)
    else if (t.startsWith('`')) out.push(<code key={key}>{t.slice(1, -1)}</code>)
    else if (t.startsWith('[')) {
      const cut = t.indexOf('](')
      const label = t.slice(1, cut)
      const href = t.slice(cut + 2, -1)
      // 렌더러에서 열면 앱이 그 페이지로 날아간다 → 기본 브라우저로 내보낸다
      out.push(
        <a
          key={key}
          href={href}
          onClick={(e) => {
            e.preventDefault()
            window.zto.launch.openExternal(href)
          }}
        >
          {label}
        </a>
      )
    } else out.push(<em key={key}>{t.slice(1, -1)}</em>)
    last = m.index + t.length
  }
  if (last < text.length) out.push(text.slice(last))
  return out
}

export default function Markdown({ text }: { text: string }): React.JSX.Element {
  const blocks: React.ReactNode[] = []
  const lines = text.split('\n')
  let i = 0
  let key = 0

  while (i < lines.length) {
    const line = lines[i]

    // 코드블록 — 닫히지 않아도 끝까지 코드로 본다(스트리밍 중 잘린 답을 원문 그대로 보여주려고)
    if (line.trimStart().startsWith('```')) {
      const body: string[] = []
      i++
      while (i < lines.length && !lines[i].trimStart().startsWith('```')) body.push(lines[i++])
      i++ // 닫는 ```
      blocks.push(<DraftCard key={key++} text={body.join('\n')} />)
      continue
    }

    // 목록 — 연속된 항목을 한 덩어리로 묶는다
    const bullet = /^\s*[-*]\s+(.*)$/
    const numbered = /^\s*\d+\.\s+(.*)$/
    if (bullet.test(line) || numbered.test(line)) {
      const ordered = numbered.test(line)
      const re = ordered ? numbered : bullet
      const items: string[] = []
      while (i < lines.length && re.test(lines[i])) {
        items.push((lines[i].match(re) as RegExpMatchArray)[1])
        i++
      }
      const kids = items.map((it, n) => <li key={n}>{inline(it, `${key}-${n}`)}</li>)
      blocks.push(ordered ? <ol key={key++}>{kids}</ol> : <ul key={key++}>{kids}</ul>)
      continue
    }

    // 빈 줄은 문단 사이 간격으로만 쓰고 버린다(빈 <p>가 쌓이면 말풍선이 헐렁해진다)
    if (!line.trim()) {
      i++
      continue
    }

    // 문단 — 다음 빈 줄/목록/코드블록 전까지. 줄바꿈은 그대로 살린다(채팅에선 의미가 있다)
    const para: string[] = []
    while (
      i < lines.length &&
      lines[i].trim() &&
      !bullet.test(lines[i]) &&
      !numbered.test(lines[i]) &&
      !lines[i].trimStart().startsWith('```')
    ) {
      para.push(lines[i++])
    }
    blocks.push(
      <p key={key++}>
        {para.map((l, n) => (
          <span key={n}>
            {inline(l, `${key}-${n}`)}
            {n < para.length - 1 && <br />}
          </span>
        ))}
      </p>
    )
  }

  return <>{blocks}</>
}
