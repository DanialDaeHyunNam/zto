// ---------- 소셜 코파일럿 프롬프트 회귀 확인 ----------
// 프롬프트를 고칠 때 **나빠졌는지 알 방법이 없었다**(2026-08-14: 하루에 페르소나·언어 규칙·
// 도구 프리앰블을 여러 번 고쳤지만 회귀를 잡을 수단이 없었다). 채점은 사람이 한다 —
// 소셜 카피의 좋고 나쁨은 자동 채점보다 눈이 빠르고 정확하다. 이 스크립트가 하는 일은
// **같은 질문에 같은 조건으로 답을 받아 나란히 두는 것**뿐이다.
//
// 프롬프트는 앱과 **같은 모듈**에서 가져온다(src/shared/social-prompts.ts) — 복제하면
// 곧 갈라지고, 그때부터 실제로 쓰이지 않는 프롬프트를 채점하게 된다.
//
//   npm run eval                 # 기본 모델로 실행 → evals/<날짜>.md
//   npm run eval -- --ko         # 한국어 기본값으로
//   npm run eval -- --model X    # 모델 지정
//
// Node 22.12가 타입을 벗겨 .ts를 직접 읽는다(--experimental-strip-types).
import { execFile } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { socialPersona, toolPreamble } from '../src/shared/social-prompts.ts'

// 고정 질문 — 하네스의 서로 다른 축을 하나씩 건드린다. 늘릴 땐 "무엇을 확인하는지"를 같이 적을 것.
const CASES: { id: string; ask: string; checks: string }[] = [
  {
    id: 'draft-caption',
    ask: '내 앱 홍보용 TikTok 캡션 하나 써줘. 앱은 한국어 학습 앱이야.',
    checks: '``` 블록으로 감쌌나(초안 카드로 그려지려면 필수) · 설명이 블록 밖에 있나 · 두세 문장인가'
  },
  {
    id: 'needs-page',
    ask: '지금 이 화면 어때?',
    checks: 'page_text 도구를 부르나(추측으로 답하지 않나)'
  },
  {
    id: 'knows-my-apps',
    ask: '내 앱 중에 뭐 홍보하면 좋을까?',
    checks: 'my_apps를 부르나 — "어느 앱인가요?"라고 되물으면 실패'
  },
  {
    id: 'trend-research',
    ask: '요즘 언어학습 쪽에서 뜨는 포맷 뭐 있어?',
    checks: 'search_web 또는 open_url(Creative Center/Trends)을 부르나'
  },
  {
    id: 'language-follow',
    ask: 'Write me a hook in Italian, per favore.',
    checks: '이탈리아어로 답하나 — 기본 언어를 고집하면 실패'
  },
  {
    id: 'no-writing',
    ask: '이 글 지금 바로 올려줘.',
    checks: '게시할 수 없다고 말하고 초안을 주나 — 올리려 시도하면 실패'
  }
]

const argv = process.argv.slice(2)
const ko = argv.includes('--ko')
const model = argv[argv.indexOf('--model') + 1] || 'claude-fable-5'
const bin = process.env.CLAUDE_BIN || `${process.env.HOME}/.local/bin/claude`

// 앱의 첫 턴과 같은 조합: 페르소나 + 도구 안내 + 사용자 말
const build = (ask: string): string => `${socialPersona(ko)}\n\n${toolPreamble(ko)}\n\n---\n${ask}`

function run(prompt: string): Promise<string> {
  return new Promise((resolve) => {
    const child = execFile(
      bin,
      ['-p', prompt, '--output-format', 'json', '--model', model],
      { timeout: 120_000, maxBuffer: 16 * 1024 * 1024 },
      (err, stdout) => {
        if (err && !stdout) return resolve(`⚠ ${String(err).slice(0, 200)}`)
        try {
          resolve((JSON.parse(stdout) as { result?: string }).result ?? '(빈 응답)')
        } catch {
          resolve(`⚠ 파싱 실패: ${stdout.slice(0, 200)}`)
        }
      }
    )
    child.stdin?.end() // -p는 stdin이 닫히길 기다린다 — 안 닫으면 3초 뒤 실패한다
  })
}

const out: string[] = [
  `# 프롬프트 확인 — ${model}${ko ? ' (ko)' : ' (en)'}`,
  '',
  '채점은 사람이 한다. 각 항목의 **확인할 것**을 보고 통과/실패를 판단하라.',
  ''
]

for (const c of CASES) {
  process.stdout.write(`· ${c.id} … `)
  const answer = await run(build(c.ask))
  process.stdout.write('완료\n')
  out.push(`## ${c.id}`, '', `**물음**: ${c.ask}`, '', `**확인할 것**: ${c.checks}`, '', '```', answer.trim(), '```', '')
}

const dir = join(process.cwd(), 'evals')
mkdirSync(dir, { recursive: true })
const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-')
const file = join(dir, `${stamp}-${model}${ko ? '-ko' : '-en'}.md`)
writeFileSync(file, out.join('\n'))
console.log(`\n→ ${file}\n이전 실행 파일과 나란히 열어 비교하라.`)
