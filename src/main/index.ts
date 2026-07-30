import {
  app,
  shell,
  BrowserWindow,
  clipboard,
  dialog,
  ipcMain,
  net,
  powerMonitor,
  protocol,
  safeStorage,
  systemPreferences
} from 'electron'
import { basename, join } from 'path'
import { pathToFileURL } from 'url'
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'fs'
import { createHash, randomUUID } from 'crypto'
import { execFile, spawn, spawnSync } from 'child_process'
import { homedir } from 'os'
import { registerBrowserIpc } from './browser'
import { probeAppContent, pullDataSafety } from './console-sync'
import { imageInfo, PLAY_IMAGE_SPECS, replacePlayImages, validatePlayImage } from './store-assets'
import {
  mailAppForEmail,
  PLATFORM_DOMAINS,
  type AccessLogEntry,
  type Account,
  type AiChatResult,
  type AiFeature,
  type AiMode,
  type AiModel,
  type AiProviderId,
  type AiProviderStatus,
  type AiStatus,
  type AiUsageEntry,
  type ApiStatus,
  type ApplyResult,
  type AscVersionRow,
  type ConsoleAnswers,
  type Questionnaire,
  type QuestionnaireMeta,
  type DashApple,
  type DashboardData,
  type DashGoogle,
  type DevAccounts,
  type DevAccountState,
  type IapSnapshotInfo,
  type LiveIapProduct,
  type LockState,
  type MetaListing,
  type PendingEdit,
  type PlayReleaseRow,
  type RunResult,
  type SheetIapInfo,
  type StoreKind,
  type StoreSnapshotEntry
} from '../shared/launch-types'

const ANSWERS_DIR = join(app.getAppPath(), 'launch', 'answers')

// 전역 로컬 상태 (개발자 계정 보유 여부 등) — 비밀 없음, 메타데이터만
const stateFile = (): string => join(app.getPath('userData'), 'zto-state.json')

function readState(): Record<string, unknown> {
  try {
    return JSON.parse(readFileSync(stateFile(), 'utf8'))
  } catch {
    return {}
  }
}

function writeState(state: Record<string, unknown>): void {
  writeFileSync(stateFile(), JSON.stringify(state, null, 2))
}

// 모듈 2 — 계정 인벤토리 저장소 (메타데이터만)
const accountsFile = (): string => join(app.getPath('userData'), 'zto-accounts.json')

// 구 스키마(purpose/services) 마이그레이션 포함 정규화
function readAccounts(): Account[] {
  try {
    const raw: Record<string, unknown>[] = JSON.parse(readFileSync(accountsFile(), 'utf8')).accounts ?? []
    return raw.map((a) => {
      const legacyServices = ((a.services as string[]) ?? []).map((s) =>
        s === 'apple-developer' ? 'app-store-connect' : s
      )
      const email = a.email as string
      let apps = [...new Set([...((a.apps as string[]) ?? []), ...legacyServices])]
      // ID가 이메일이면 해당 메일 서비스를 강제 연결하고 항상 맨 앞에 (유저 설정 불요)
      const mailApp = mailAppForEmail(email)
      if (mailApp) apps = [mailApp, ...apps.filter((x) => x !== mailApp)]
      return {
        id: a.id as string,
        email,
        memo: (a.memo as string) ?? (a.purpose as string) ?? '',
        apps,
        createdAt: a.createdAt as string,
        updatedAt: a.updatedAt as string
      }
    })
  } catch {
    return []
  }
}

function writeAccounts(accounts: Account[]): void {
  writeFileSync(accountsFile(), JSON.stringify({ accounts }, null, 2))
}

// 이메일 기준 업서트 — 같은 이메일이면 새 항목 대신 메모·연결 앱을 병합
function upsertAccount(email: string, patch: { memo?: string; apps?: string[] }): Account[] {
  const accounts = readAccounts()
  const now = new Date().toISOString()
  let account = accounts.find((a) => a.email === email)
  if (!account) {
    account = { id: randomUUID(), email, memo: '', apps: [], createdAt: now, updatedAt: now }
    accounts.push(account)
  }
  if (patch.memo) account.memo = patch.memo
  if (patch.apps) account.apps = [...new Set([...account.apps, ...patch.apps])]
  account.updatedAt = now
  writeAccounts(accounts)
  return accounts
}

// 개발자 계정 이메일이 바뀌면 이전 계정에서 스토어 연결 해제.
// 남은 흔적(강제 메일 앱 제외 연결·비밀번호·메모)이 없으면 계정 자체를 정리한다.
function unlinkStoreFromAccount(email: string, storeApp: string): void {
  let accounts = readAccounts()
  const account = accounts.find((a) => a.email === email)
  if (!account) return
  account.apps = account.apps.filter((x) => x !== storeApp)
  account.updatedAt = new Date().toISOString()
  const mailApp = mailAppForEmail(email)
  const meaningfulApps = account.apps.filter((x) => x !== mailApp)
  const hasSecrets = Object.keys(readSecrets()).some((k) => k.startsWith(email + '::'))
  if (meaningfulApps.length === 0 && !hasSecrets && !account.memo) {
    accounts = accounts.filter((a) => a.id !== account.id)
  }
  writeAccounts(accounts)
}


// ---------- AI provider (BYO 2방식) — 구독(로컬 CLI spawn) / API 키(키체인). libertas 패턴 ----------
// Finder로 띄운 Electron은 셸 PATH를 못 물려받아서 흔한 설치 위치로 폴백한다.
// 모델은 provider별로 다르다 — active provider의 목록만 렌더러에 내보낸다.
// (섞어두면 ChatGPT가 active일 때 claude-* 모델 id를 OpenAI로 보내게 된다.)
// 각 목록의 첫 항목이 그 provider의 기본값.
const AI_MODELS_BY_PROVIDER: Record<AiProviderId, AiModel[]> = {
  claude: [
    { id: 'claude-fable-5', label: 'Fable 5' },
    { id: 'claude-opus-4-8', label: 'Opus 4.8' },
    { id: 'claude-sonnet-5', label: 'Sonnet 5' },
    { id: 'claude-haiku-4-5-20251001', label: 'Haiku 4.5' }
  ],
  // 2026-07-28 확인 — 둘 다 이미지 입력 지원(소셜 패널 첨부에 필수).
  // mini가 기본: ZTO 사용량에선 nano와의 요금 차이가 월 1달러 수준이라, 그걸 아끼려고
  // 지시 준수(추천: <옵션id> 파싱)와 한국어 문장 품질을 걸 이유가 없다.
  // nano는 남긴다 — reverse-sync의 폼 필드→설문 문항 매핑이 nano 공식 용도(추출·랭킹)라 그때 쓴다.
  // Luna·Terra는 뺐다: Terra의 '고품질' 자리는 Claude Opus·Fable과 중복이고,
  // Luna는 mini보다 비싸면서 강점(1.05M 컨텍스트)이 이 워크로드에 무의미하다.
  chatgpt: [
    { id: 'gpt-5.4-mini', label: 'GPT-5.4 mini' },
    { id: 'gpt-5.4-nano', label: 'GPT-5.4 nano (최저가)' }
  ],
  gemini: []
}

// provider 구독 = 로컬 CLI (Claude=claude, ChatGPT=codex). 감지 결과 캐시.
const CLI_CANDIDATES: Record<string, string[]> = {
  claude: [
    process.env.ZTO_CLAUDE_BIN ?? '',
    'claude',
    join(homedir(), '.claude', 'local', 'claude'),
    '/opt/homebrew/bin/claude',
    '/usr/local/bin/claude',
    join(homedir(), '.local', 'bin', 'claude')
  ],
  codex: [
    process.env.ZTO_CODEX_BIN ?? '',
    'codex',
    '/opt/homebrew/bin/codex',
    '/usr/local/bin/codex',
    join(homedir(), '.local', 'bin', 'codex')
  ]
}
const _cli: Record<string, { available: boolean; bin: string | null; version: string }> = {}
function cliInfo(name: 'claude' | 'codex', fresh = false): { available: boolean; bin: string | null; version: string } {
  if (_cli[name] && !fresh) return _cli[name]
  for (const bin of (CLI_CANDIDATES[name] ?? []).filter(Boolean)) {
    try {
      const r = spawnSync(bin, ['--version'], { encoding: 'utf8', timeout: 5000 })
      if (r.status === 0) {
        _cli[name] = { available: true, bin, version: String(r.stdout || '').match(/[\d.]+/)?.[0] ?? '' }
        return _cli[name]
      }
    } catch {
      /* 다음 후보 */
    }
  }
  _cli[name] = { available: false, bin: null, version: '' }
  return _cli[name]
}

// AI API 키 — 비밀번호와 같은 키체인(safeStorage) 저장, provider별. 계정 비번 파일과 분리.
const aiKeysFile = (): string => join(app.getPath('userData'), 'zto-ai-keys.json')
function readAiKeys(): Record<string, string> {
  try {
    return JSON.parse(readFileSync(aiKeysFile(), 'utf8'))
  } catch {
    return {}
  }
}
// 키는 쓸 때만 복호화하고 들고 있지 않는다 (비밀번호 정책과 같은 원칙 — SPEC §7.3).
function getAiKey(provider: AiProviderId): string | null {
  const enc = readAiKeys()[provider]
  if (!enc) return null
  try {
    return safeStorage.decryptString(Buffer.from(enc, 'base64'))
  } catch {
    return null
  }
}
function setAiKey(provider: string, key: string): boolean {
  if (!safeStorage.isEncryptionAvailable()) return false
  const keys = readAiKeys()
  if (key) keys[provider] = safeStorage.encryptString(key).toString('base64')
  else delete keys[provider]
  writeFileSync(aiKeysFile(), JSON.stringify(keys, null, 2))
  return true
}

// provider별 연결 방식·active·model 은 전역 상태에 (키 자체는 키체인)
// model은 provider마다 따로 기억한다 — provider를 바꿔 돌아와도 고르던 모델이 남는다.
interface AiConfig {
  active: AiProviderId
  models: Partial<Record<AiProviderId, string>>
  modes: Record<AiProviderId, AiMode>
}
// ChatGPT 구독(codex)은 모델을 우리가 고르지 않는다 — codex 자체 설정의 기본 모델을 쓴다.
// API 모델 목록(gpt-5.4-*)을 그대로 보여주면 고를 수 없는 걸 고르게 하는 거짓말이 된다.
const CODEX_MODELS: AiModel[] = [{ id: 'codex', label: 'Codex' }]
function modelsFor(cfg: AiConfig, p: AiProviderId): AiModel[] {
  if (p === 'chatgpt' && cfg.modes.chatgpt === 'subscription') return CODEX_MODELS
  return AI_MODELS_BY_PROVIDER[p]
}
function modelFor(cfg: AiConfig, p: AiProviderId): string {
  const list = modelsFor(cfg, p)
  const picked = cfg.models[p]
  return list.some((m) => m.id === picked) ? (picked as string) : (list[0]?.id ?? '')
}
function readAiConfig(): AiConfig {
  const c = (readState().aiConfig as Partial<AiConfig> & { model?: string }) ?? {}
  // 구 스키마 이관 — 단일 `model`은 claude 것이었다.
  const models = { ...(c.models ?? {}) }
  if (!models.claude && c.model) models.claude = c.model
  return {
    active: c.active ?? 'claude',
    models,
    modes: {
      claude: c.modes?.claude ?? 'subscription',
      chatgpt: c.modes?.chatgpt ?? 'subscription',
      gemini: 'apikey'
    }
  }
}
function writeAiConfig(patch: Partial<AiConfig>): void {
  writeState({ ...readState(), aiConfig: { ...readAiConfig(), ...patch } })
}

// claude CLI가 응답에 실어 주는 사용량·비용을 그대로 기록한다(2026-07-29 실측 스키마).
// 구독이라 한계비용은 0 — total_cost_usd는 "API로 환산하면 얼마"라는 참고값이므로 billed=false.
interface ClaudeCliUsage {
  total_cost_usd?: number
  usage?: {
    input_tokens?: number
    output_tokens?: number
    cache_read_input_tokens?: number
    cache_creation_input_tokens?: number
  }
}
function recordClaudeUsage(
  j: ClaudeCliUsage,
  model: string,
  feature: AiFeature,
  startedAt: number,
  ok: boolean
): void {
  const u = j.usage ?? {}
  appendAiUsage({
    at: new Date().toISOString(),
    provider: 'claude',
    mode: 'subscription',
    model,
    feature,
    inputTokens: u.input_tokens ?? 0,
    outputTokens: u.output_tokens ?? 0,
    cacheReadTokens: u.cache_read_input_tokens ?? 0,
    cacheWriteTokens: u.cache_creation_input_tokens ?? 0,
    costUsd: j.total_cost_usd ?? 0,
    billed: false,
    durationMs: Date.now() - startedAt,
    ok
  })
}

// ---------- AI 사용량 기록 (설정 대시보드) ----------
// 호출 1건씩 로컬 파일에 append. 네트워크 전송 없음(계정 비번 정책과 같은 로컬 원칙).
const aiUsageFile = (): string => join(app.getPath('userData'), 'zto-ai-usage.json')
const AI_USAGE_CAP = 2000 // 오래된 것부터 버린다 — 로그가 무한히 자라지 않게

function readAiUsage(): AiUsageEntry[] {
  try {
    const j = JSON.parse(readFileSync(aiUsageFile(), 'utf8'))
    return Array.isArray(j) ? (j as AiUsageEntry[]) : []
  } catch {
    return []
  }
}
function appendAiUsage(e: AiUsageEntry): void {
  try {
    const all = [...readAiUsage(), e]
    writeFileSync(aiUsageFile(), JSON.stringify(all.slice(-AI_USAGE_CAP), null, 2))
  } catch {
    /* 기록 실패가 대화를 막지는 않는다 */
  }
}

// OpenAI 가격표 (1M 토큰당 USD, 2026-07-28 확인). 응답이 토큰만 주므로 여기서 환산한다.
// 캐시된 입력은 10% — usage에 cached_tokens가 오면 그만큼 할인해 계산.
const OPENAI_PRICE: Record<string, { in: number; out: number }> = {
  'gpt-5.4-mini': { in: 0.75, out: 4.5 },
  'gpt-5.4-nano': { in: 0.2, out: 1.25 }
}
function openAiCost(model: string, inTok: number, cachedTok: number, outTok: number): number {
  const p = OPENAI_PRICE[model]
  if (!p) return 0 // 모르는 모델은 0 — 틀린 숫자를 지어내지 않는다
  const fresh = Math.max(0, inTok - cachedTok)
  return (fresh * p.in + cachedTok * p.in * 0.1 + outTok * p.out) / 1_000_000
}

// ---------- OpenAI API 키 경로 (ROADMAP #1 잔여) ----------
// Responses API는 무상태라 대화 이력을 main이 들고 있는다. 구독 경로(claude CLI --resume)의
// "불투명 sessionId" 계약을 그대로 흉내 내므로 렌더러는 두 경로를 구분하지 않는다.
// 이력은 메모리에만 — 앱을 끄면 사라진다(대화는 휘발성, 디스크에 남기지 않는다).
// previous_response_id(서버 보관)를 안 쓰는 이유: 대화가 OpenAI 쪽에 남지 않게 하려고.
// 대신 매 턴 이력을 재전송하는데, ZTO 대화 길이에선 요금 차이가 무시할 수준이다.
const openAiSessions = new Map<string, unknown[]>()
const OPENAI_MAX_MESSAGES = 24 // 이력 폭주 방지 — 오래된 턴부터 버린다

interface OpenAiPart {
  type: string
  text?: string
}
function openAiText(j: { output_text?: unknown; output?: { content?: OpenAiPart[] }[] }): string {
  if (typeof j.output_text === 'string' && j.output_text) return j.output_text
  const parts: string[] = []
  for (const item of j.output ?? []) {
    for (const c of item.content ?? []) {
      if (typeof c.text === 'string') parts.push(c.text)
    }
  }
  return parts.join('')
}

async function chatOpenAi(
  prompt: string,
  model: string,
  opts?: { resume?: string; images?: { mediaType: string; data: string }[]; feature?: AiFeature }
): Promise<AiChatResult> {
  const key = getAiKey('chatgpt')
  if (!key) return { ok: false, text: '', error: 'openai-key-missing' }
  const startedAt = Date.now()

  const content: Record<string, unknown>[] = [{ type: 'input_text', text: prompt }]
  for (const im of opts?.images ?? []) {
    content.push({ type: 'input_image', image_url: `data:${im.mediaType};base64,${im.data}` })
  }
  const history = (opts?.resume ? openAiSessions.get(opts.resume) : null) ?? []
  const input = [...history, { role: 'user', content }]

  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), 120_000)
  try {
    const r = await fetch('https://api.openai.com/v1/responses', {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, input }),
      signal: ctrl.signal
    })
    const j = (await r.json().catch(() => ({}))) as {
      error?: { message?: string }
      output_text?: unknown
      output?: { content?: OpenAiPart[] }[]
      usage?: {
        input_tokens?: number
        output_tokens?: number
        input_tokens_details?: { cached_tokens?: number }
      }
    }
    const inTok = j.usage?.input_tokens ?? 0
    const outTok = j.usage?.output_tokens ?? 0
    const cachedTok = j.usage?.input_tokens_details?.cached_tokens ?? 0
    // 실패한 호출도 토큰을 태웠으면 기록한다 — 대시보드가 실제 지출을 덜 보여주면 안 된다.
    appendAiUsage({
      at: new Date().toISOString(),
      provider: 'chatgpt',
      mode: 'apikey',
      model,
      feature: opts?.feature ?? 'other',
      inputTokens: inTok,
      outputTokens: outTok,
      cacheReadTokens: cachedTok,
      cacheWriteTokens: 0,
      costUsd: openAiCost(model, inTok, cachedTok, outTok),
      billed: true,
      durationMs: Date.now() - startedAt,
      ok: r.ok
    })
    // 실패는 그대로 드러낸다 — API 메시지가 있으면 그게 가장 진단에 쓸모 있다.
    if (!r.ok) {
      return { ok: false, text: '', error: (j.error?.message ?? `http-${r.status}`).slice(0, 300) }
    }
    const text = openAiText(j)
    if (!text) return { ok: false, text: '', error: 'empty-response' }

    const sid = opts?.resume ?? `oa-${randomUUID()}`
    const next = [...input, { role: 'assistant', content: [{ type: 'output_text', text }] }]
    openAiSessions.set(sid, next.slice(-OPENAI_MAX_MESSAGES))
    return { ok: true, text, sessionId: sid }
  } catch (e) {
    const aborted = ctrl.signal.aborted
    return { ok: false, text: '', error: aborted ? 'timeout' : String(e).slice(0, 300) }
  } finally {
    clearTimeout(timer)
  }
}

// ---------- codex(ChatGPT 구독) 경로 ----------
// `codex exec --json`은 JSONL 이벤트를 뱉는다. 문서 기준 스키마(2026-07-29):
//   {"type":"thread.started","thread_id":"..."} — 세션 id (우리의 resume 키)
//   item 이벤트 중 item.type === 'agent_message' 의 text — 최종 답변
//   {"type":"turn.completed","usage":{...}} / {"type":"turn.failed",...}
// 이어가기는 `codex exec resume <SESSION_ID> --json "..."`.
//
// ⚠️ **실행 미검증** — 이 기기에 codex가 설치돼 있지 않고 ChatGPT 구독도 없어 로컬에서 돌려볼 수
// 없었다. 그래서 파서를 관대하게(이벤트 모양이 조금 달라도 agent_message를 찾도록) 쓰고,
// 실패하면 stderr를 그대로 올린다 — 추측이 틀렸을 때 조용히 빈 답이 나오는 것보다 낫다.
// 모델은 지정하지 않는다: `--model` 플래그가 문서에서 확인되지 않았고, 구독 모델 id는
// API 모델 목록(gpt-5.4-*)과 다르다. 검증 못 한 플래그를 넣어 전체를 깨뜨릴 이유가 없다.
interface CodexEvent {
  type?: string
  thread_id?: string
  text?: string
  item?: { type?: string; text?: string }
  usage?: { input_tokens?: number; cached_input_tokens?: number; output_tokens?: number }
  error?: unknown
}

async function chatCodex(
  prompt: string,
  feature: AiFeature,
  opts?: { resume?: string; images?: { mediaType: string; data: string }[] }
): Promise<AiChatResult> {
  const info = cliInfo('codex')
  if (!info.available || !info.bin) return { ok: false, text: '', error: 'codex-cli-missing' }
  // 이미지 입력은 codex exec에 문서화된 방법이 없다. 조용히 버리면 "AI가 화면을 못 봤다"는
  // 사실이 감춰지므로 명시적으로 거절한다.
  if (opts?.images?.length) return { ok: false, text: '', error: 'codex-images-unsupported' }

  const startedAt = Date.now()
  const args = opts?.resume
    ? ['exec', 'resume', opts.resume, '--json', prompt]
    : ['exec', '--json', prompt]

  return await new Promise<AiChatResult>((resolve) => {
    const child = spawn(info.bin as string, args, { cwd: app.getPath('userData') })
    let out = ''
    let err = ''
    let done = false
    const finish = (r: AiChatResult): void => {
      if (done) return
      done = true
      resolve(r)
    }
    const timer = setTimeout(() => {
      child.kill()
      finish({ ok: false, text: '', error: 'timeout' })
    }, 180_000)
    child.stdout.on('data', (d) => (out += d))
    child.stderr.on('data', (d) => (err += d))
    child.on('error', (e) => {
      clearTimeout(timer)
      finish({ ok: false, text: '', error: String(e).slice(0, 300) })
    })
    child.on('close', () => {
      clearTimeout(timer)
      let text = ''
      let sessionId: string | undefined
      let failed = false
      let usage: CodexEvent['usage']
      for (const line of out.split('\n')) {
        const s = line.trim()
        if (!s.startsWith('{')) continue
        let e: CodexEvent
        try {
          e = JSON.parse(s) as CodexEvent
        } catch {
          continue // 부분 라인 무시
        }
        if (e.thread_id) sessionId = e.thread_id
        // agent_message가 item 안에 오든 평평하게 오든 둘 다 받는다
        const msg = e.item?.type === 'agent_message' ? e.item.text : undefined
        const flat = e.type === 'agent_message' ? e.text : undefined
        const t = msg ?? flat
        if (t) text = t // 마지막 것이 최종 답변
        if (e.type === 'turn.completed' && e.usage) usage = e.usage
        if (e.type === 'turn.failed') failed = true
      }
      const ok = !failed && !!text
      appendAiUsage({
        at: new Date().toISOString(),
        provider: 'chatgpt',
        mode: 'subscription',
        model: 'codex',
        feature,
        inputTokens: usage?.input_tokens ?? 0,
        outputTokens: usage?.output_tokens ?? 0,
        cacheReadTokens: usage?.cached_input_tokens ?? 0,
        cacheWriteTokens: 0,
        costUsd: 0, // 구독 — codex는 환산가를 주지 않는다
        billed: false,
        durationMs: Date.now() - startedAt,
        ok
      })
      if (ok) return finish({ ok: true, text, sessionId })
      // 실패 원인을 그대로 노출 — 파서 추측이 틀렸는지, 인증 문제인지 구분돼야 한다
      finish({
        ok: false,
        text: '',
        error: (err.trim() || (text ? 'turn-failed' : 'no-agent-message')).slice(0, 300)
      })
    })
  })
}

function aiStatus(fresh = false): AiStatus {
  const cfg = readAiConfig()
  const keys = readAiKeys()
  const claude = cliInfo('claude', fresh)
  const codex = cliInfo('codex', fresh)
  const providers: AiProviderStatus[] = [
    {
      id: 'claude',
      supportsSubscription: true,
      subscriptionAvailable: claude.available,
      subscriptionVersion: claude.version,
      hasKey: !!keys.claude,
      mode: cfg.modes.claude
    },
    {
      id: 'chatgpt',
      supportsSubscription: true,
      subscriptionAvailable: codex.available,
      subscriptionVersion: codex.version,
      hasKey: !!keys.chatgpt,
      mode: cfg.modes.chatgpt
    },
    {
      id: 'gemini',
      supportsSubscription: false,
      subscriptionAvailable: false,
      subscriptionVersion: '',
      hasKey: !!keys.gemini,
      mode: 'apikey'
    }
  ]
  // 쓸 수 있는 provider만 — 구독 방식이면 CLI 감지, API 키 방식이면 키 저장이 조건.
  const usable = (p: AiProviderStatus): boolean =>
    p.mode === 'subscription' ? p.subscriptionAvailable : p.hasKey
  const providerModels: Partial<Record<AiProviderId, AiModel[]>> = {}
  for (const p of providers) {
    const list = modelsFor(cfg, p.id)
    if (usable(p) && list.length > 0) providerModels[p.id] = list
  }
  return {
    active: cfg.active,
    model: modelFor(cfg, cfg.active),
    models: modelsFor(cfg, cfg.active),
    providerModels,
    providers
  }
}

// ---------- 스토어 자산 로컬 캐시 ----------
// 렌더러가 googleusercontent로 직접 <img> 요청을 보내면 일부만 뜬다(6개 중 1~2개, 2026-07-30 실측).
// URL은 살아 있고(curl 200×27) CSP도 허용하므로 원인은 요청 조건 — 렌더러는 임베드 브라우저와
// **기본 세션을 공유**해서 구글 로그인 쿠키가 함께 나간다. main의 fetch에는 그 쿠키가 없다.
// 그래서 여기서 받아 파일로 두고 file://로 렌더한다. 쿠키·스로틀·만료·오프라인 전부 무관해진다.
const ASSET_DIR = (): string => join(app.getPath('userData'), 'assets')
const EXT_BY_TYPE: Record<string, string> = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/webp': '.webp'
}

async function cacheAssets(urls: string[]): Promise<string[]> {
  const dir = ASSET_DIR()
  try {
    mkdirSync(dir, { recursive: true })
  } catch {
    /* 있으면 무시 */
  }
  const out: string[] = []
  // 4개씩 — 한 번에 다 던지면 CDN이 일부를 흘린다(원인 중 하나로 의심되던 지점)
  for (let i = 0; i < urls.length; i += 4) {
    const batch = urls.slice(i, i + 4)
    const done = await Promise.all(
      batch.map(async (url) => {
        const key = createHash('sha1').update(url).digest('hex')
        const hit = ['.png', '.jpg', '.webp'].map((e) => join(dir, key + e)).find(existsSync)
        if (hit) return `zto-asset://${basename(hit)}`
        try {
          const r = await fetch(url)
          if (!r.ok) return url // 실패하면 원격 URL 그대로 — 최소한 될 수도 있다
          const ext = EXT_BY_TYPE[(r.headers.get('content-type') ?? '').split(';')[0]] ?? '.png'
          const file = join(dir, key + ext)
          writeFileSync(file, Buffer.from(await r.arrayBuffer()))
          return `zto-asset://${basename(file)}`
        } catch {
          return url
        }
      })
    )
    out.push(...done)
  }
  return out
}

// ---------- 스토어 실황 조회 헬퍼 ----------
// 토큰 캐시 — 조회마다 스크립트 스폰(각 ~1초+)을 피한다. 실제 만료(Google 60분·ASC 20분)보다 짧게 잡는다.
const tokenCache = new Map<string, { tok: string; exp: number }>()

async function googleTokenFor(saPath: string): Promise<string | null> {
  const hit = tokenCache.get('g:' + saPath)
  if (hit && Date.now() < hit.exp) return hit.tok
  const tokenScript = join(app.getAppPath(), 'launch', 'scripts', 'google', 'token.js')
  return await new Promise((resolve) => {
    execFile(
      process.execPath,
      [tokenScript, '--sa', saPath],
      { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, timeout: 30_000 },
      (_err, stdout) => {
        try {
          const j = JSON.parse(stdout)
          if (j.ok) tokenCache.set('g:' + saPath, { tok: j.access_token, exp: Date.now() + 45 * 60_000 })
          resolve(j.ok ? j.access_token : null)
        } catch {
          resolve(null)
        }
      }
    )
  })
}

async function ascTokenFor(asc: { keyPath: string; keyId: string; issuerId: string }): Promise<string | null> {
  const hit = tokenCache.get('a:' + asc.keyId)
  if (hit && Date.now() < hit.exp) return hit.tok
  const script = join(app.getAppPath(), 'launch', 'scripts', 'apple', 'asc-token.js')
  return await new Promise((resolve) => {
    execFile(
      process.execPath,
      [script, '--key', asc.keyPath, '--kid', asc.keyId, '--iss', asc.issuerId],
      { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, timeout: 30_000 },
      (_err, stdout) => {
        try {
          const j = JSON.parse(stdout)
          if (j.ok) tokenCache.set('a:' + asc.keyId, { tok: j.token, exp: Date.now() + 15 * 60_000 })
          resolve(j.ok ? j.token : null)
        } catch {
          resolve(null)
        }
      }
    )
  })
}

// 200인데 빈 본문을 주는 스토어 API 대응 (예: one-time product 없는 앱의 oneTimeProducts, 없는 이미지 타입)
async function jsonOrEmpty(r: Response): Promise<Record<string, unknown>> {
  const t = await r.text()
  if (!t) return {}
  try {
    return JSON.parse(t)
  } catch {
    return {}
  }
}

// ---------- §4.5 앱 대시보드 pull (P1 읽기 전용) ----------

// Play — 트랙·릴리스·국가별 메타는 edit 트랜잭션 안에서만 읽힌다: 생성→읽기→삭제 패턴
async function pullGoogleDashboard(sheet: {
  app: { packageName: string }
  credentials?: { googleSa?: string }
}): Promise<{ data: DashGoogle | null; error?: string }> {
  const saPath = resolveGoogleSa(sheet)
  if (!saPath) return { data: null, error: 'no-key' }
  const tok = await googleTokenFor(saPath)
  if (!tok) return { data: null, error: 'token' }
  const base = `https://androidpublisher.googleapis.com/androidpublisher/v3/applications/${encodeURIComponent(sheet.app.packageName)}`
  const headers = { Authorization: 'Bearer ' + tok, 'Content-Type': 'application/json' }

  const editR = await fetch(`${base}/edits`, { method: 'POST', headers, body: '{}' })
  if (!editR.ok) return { data: null, error: `HTTP ${editR.status}` }
  const editId = ((await editR.json()) as { id?: string }).id
  if (!editId) return { data: null, error: 'edit' }

  const releases: PlayReleaseRow[] = []
  let listings: MetaListing[] = []
  let details = { defaultLanguage: '', contactEmail: '', contactWebsite: '' }
  let closedStarted = false
  const images: { type: string; urls: string[] }[] = []
  let imageLocale = '' // 자산을 읽어온 대표 로케일 — 편집이 이 로케일에만 적용된다
  try {
    const [tracksR, listingsR, detailsR] = await Promise.all([
      fetch(`${base}/edits/${editId}/tracks`, { headers }),
      fetch(`${base}/edits/${editId}/listings`, { headers }),
      fetch(`${base}/edits/${editId}/details`, { headers })
    ])
    if (tracksR.ok) {
      interface GRelease {
        status?: string
        name?: string
        versionCodes?: string[]
        releaseNotes?: { language?: string; text?: string }[]
      }
      const tracksJ = (await jsonOrEmpty(tracksR)) as {
        tracks?: { track?: string; releases?: GRelease[] }[]
      }
      for (const t of tracksJ.tracks ?? []) {
        const track = t.track ?? ''
        for (const r of t.releases ?? []) {
          releases.push({
            track,
            status: r.status ?? '',
            name: r.name ?? '',
            versionCodes: r.versionCodes ?? [],
            notes: (r.releaseNotes ?? [])
              .map((x) => ({ locale: x.language ?? '', text: x.text ?? '' }))
              .filter((x) => x.locale)
          })
        }
        // 클로즈드 테스트 "시작" = closed 계열 트랙(internal·beta·production이 아닌 전부)에 릴리스 존재 (SPEC §4.5 ⑨)
        if (!['internal', 'beta', 'production'].includes(track) && (t.releases ?? []).length > 0) {
          closedStarted = true
        }
      }
    }
    if (listingsR.ok) {
      const lJ = (await jsonOrEmpty(listingsR)) as {
        listings?: {
          language?: string
          title?: string
          shortDescription?: string
          fullDescription?: string
        }[]
      }
      listings = (lJ.listings ?? [])
        .map((l) => ({
          locale: l.language ?? '',
          title: l.title ?? '',
          short: l.shortDescription ?? '',
          full: l.fullDescription ?? '',
          promo: '',
          keywords: ''
        }))
        .filter((l) => l.locale)
    }
    if (detailsR.ok) {
      const dJ = (await jsonOrEmpty(detailsR)) as {
        defaultLanguage?: string
        contactEmail?: string
        contactWebsite?: string
      }
      details = {
        defaultLanguage: dJ.defaultLanguage ?? '',
        contactEmail: dJ.contactEmail ?? '',
        contactWebsite: dJ.contactWebsite ?? ''
      }
    }
    // 자산(아이콘·피처그래픽·스크린샷) — 대표 로케일 1개만, edit 트랜잭션 안에서만 읽힌다
    const lang = (listings.find((l) => l.locale.startsWith('ko')) ?? listings[0])?.locale
    imageLocale = lang ?? ''
    if (lang) {
      const types = ['icon', 'featureGraphic', 'phoneScreenshots']
      const imgRs = await Promise.all(
        types.map((t) => fetch(`${base}/edits/${editId}/listings/${lang}/${t}`, { headers }))
      )
      for (let i = 0; i < types.length; i++) {
        if (!imgRs[i].ok) continue
        const j = (await jsonOrEmpty(imgRs[i])) as { images?: { url?: string }[] }
        const urls = (j.images ?? []).map((im) => im.url ?? '').filter(Boolean)
        if (urls.length > 0) images.push({ type: types[i], urls: await cacheAssets(urls) })
      }
    }
  } finally {
    fetch(`${base}/edits/${editId}`, { method: 'DELETE', headers }).catch(() => {})
  }

  const iap: LiveIapProduct[] = []
  const iapR = await fetch(`${base}/oneTimeProducts`, { headers })
  if (iapR.ok) {
    interface GConfig {
      regionCode?: string
      price?: { units?: string; currencyCode?: string }
    }
    interface GProduct {
      productId?: string
      listings?: { title?: string }[]
      purchaseOptions?: { state?: string; regionalPricingAndAvailabilityConfigs?: GConfig[] }[]
    }
    const j = (await jsonOrEmpty(iapR)) as { oneTimeProducts?: GProduct[] }
    for (const p of j.oneTimeProducts ?? []) {
      const opt = p.purchaseOptions?.[0]
      const cfgs = opt?.regionalPricingAndAvailabilityConfigs ?? []
      const cfg = cfgs.find((c) => c.regionCode === 'KR') ?? cfgs[0]
      iap.push({
        id: p.productId ?? '',
        title: p.listings?.[0]?.title ?? '',
        state: opt?.state ?? '',
        priceLabel: cfg?.price?.units
          ? `${cfg.price.units} ${cfg.price.currencyCode ?? ''} · ${cfg.regionCode ?? ''}`
          : undefined
      })
    }
  }
  return { data: { releases, listings, details, images, imageLocale, iap, closedStarted } }
}

// ASC — 버전 이력·릴리스 노트·로케일·카테고리·등급·IAP
async function pullAppleDashboard(sheet: {
  app: { bundleId: string }
  credentials?: { asc?: { keyPath?: string; keyId?: string; issuerId?: string } }
}): Promise<{ data: DashApple | null; error?: string }> {
  const asc = resolveAsc(sheet)
  if (!asc) return { data: null, error: 'no-key' }
  const tok = await ascTokenFor(asc)
  if (!tok) return { data: null, error: 'token' }
  const A = 'https://api.appstoreconnect.apple.com/v1'
  const headers = { Authorization: 'Bearer ' + tok }

  const appsR = await fetch(
    `${A}/apps?filter%5BbundleId%5D=${encodeURIComponent(sheet.app.bundleId)}`,
    { headers }
  )
  if (!appsR.ok) return { data: null, error: `HTTP ${appsR.status}` }
  const appId = ((await appsR.json()) as { data?: { id: string }[] }).data?.[0]?.id
  if (!appId) return { data: null, error: 'app-not-found' }

  const [versR, infoR, iapR] = await Promise.all([
    fetch(
      `${A}/apps/${appId}/appStoreVersions?limit=10&fields%5BappStoreVersions%5D=versionString,appStoreState,createdDate`,
      { headers }
    ),
    fetch(`${A}/apps/${appId}/appInfos?include=primaryCategory`, { headers }),
    fetch(`${A}/apps/${appId}/inAppPurchasesV2?limit=50`, { headers })
  ])

  const versions: AscVersionRow[] = []
  const screenshots: { type: string; urls: string[] }[] = []
  // 최신 버전의 로케일별 설명·프로모션·키워드·릴리스 노트 (메타 병합용)
  const verLocs: { locale: string; whatsNew: string; full: string; promo: string; keywords: string }[] = []
  if (versR.ok) {
    const vJ = (await versR.json()) as {
      data?: {
        id: string
        attributes?: { versionString?: string; appStoreState?: string; createdDate?: string }
      }[]
    }
    const rows = (vJ.data ?? []).map((d) => ({
      id: d.id,
      version: d.attributes?.versionString ?? '',
      state: d.attributes?.appStoreState ?? '',
      createdAt: d.attributes?.createdDate ?? ''
    }))
    rows.sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    // 릴리스 노트·로케일은 최근 3개 버전만 조회 (요청 수 절약) — 최신 버전만 설명·키워드까지
    const withNotes = await Promise.all(
      rows.slice(0, 3).map(async (row, i) => {
        const fields =
          i === 0 ? 'locale,whatsNew,description,promotionalText,keywords' : 'locale,whatsNew'
        const locR = await fetch(
          `${A}/appStoreVersions/${row.id}/appStoreVersionLocalizations?fields%5BappStoreVersionLocalizations%5D=${fields}`,
          { headers }
        )
        if (!locR.ok) return { ...row, note: '', repLocId: '' }
        const locJ = (await locR.json()) as {
          data?: {
            id: string
            attributes?: {
              locale?: string
              whatsNew?: string
              description?: string
              promotionalText?: string
              keywords?: string
            }
          }[]
        }
        const items = locJ.data ?? []
        if (i === 0) {
          for (const l of items) {
            if (l.attributes?.locale) {
              verLocs.push({
                locale: l.attributes.locale,
                whatsNew: l.attributes.whatsNew ?? '',
                full: l.attributes.description ?? '',
                promo: l.attributes.promotionalText ?? '',
                keywords: l.attributes.keywords ?? ''
              })
            }
          }
        }
        const rep = items.find((l) => l.attributes?.locale?.startsWith('ko')) ?? items[0]
        return { ...row, note: rep?.attributes?.whatsNew ?? '', repLocId: rep?.id ?? '' }
      })
    )
    // 스크린샷 — 최신 버전의 대표 로케일에 올라간 세트(디스플레이 타입별)
    const repLocId = withNotes[0]?.repLocId
    if (repLocId) {
      const setsR = await fetch(
        `${A}/appStoreVersionLocalizations/${repLocId}/appScreenshotSets?include=appScreenshots`,
        { headers }
      )
      if (setsR.ok) {
        interface ShotAsset {
          templateUrl?: string
          width?: number
          height?: number
        }
        const setsJ = (await setsR.json()) as {
          data?: {
            attributes?: { screenshotDisplayType?: string }
            relationships?: { appScreenshots?: { data?: { id: string }[] } }
          }[]
          included?: { id: string; attributes?: { imageAsset?: ShotAsset } }[]
        }
        const assetById = new Map(
          (setsJ.included ?? []).map((inc) => [inc.id, inc.attributes?.imageAsset])
        )
        const thumbUrl = (asset?: ShotAsset): string => {
          if (!asset?.templateUrl || !asset.width || !asset.height) return ''
          const h = 400
          const w = Math.round((asset.width * h) / asset.height)
          return asset.templateUrl
            .replace('{w}', String(w))
            .replace('{h}', String(h))
            .replace('{f}', 'png')
        }
        for (const set of setsJ.data ?? []) {
          const urls = (set.relationships?.appScreenshots?.data ?? [])
            .map((s) => thumbUrl(assetById.get(s.id)))
            .filter(Boolean)
          if (urls.length > 0) {
            screenshots.push({ type: set.attributes?.screenshotDisplayType ?? '', urls })
          }
        }
      }
    }
    for (const r of withNotes) {
      versions.push({ version: r.version, state: r.state, createdAt: r.createdAt, note: r.note })
    }
    for (const r of rows.slice(3)) {
      versions.push({ version: r.version, state: r.state, createdAt: r.createdAt, note: '' })
    }
  }

  let category = ''
  let ageRating = ''
  const meta: MetaListing[] = []
  if (infoR.ok) {
    const iJ = (await infoR.json()) as {
      data?: {
        id: string
        attributes?: { appStoreAgeRating?: string }
        relationships?: { primaryCategory?: { data?: { id?: string } } }
      }[]
    }
    const infos = iJ.data ?? []
    const info = infos.find((d) => d.relationships?.primaryCategory?.data?.id) ?? infos[0]
    category = info?.relationships?.primaryCategory?.data?.id ?? ''
    ageRating = info?.attributes?.appStoreAgeRating ?? ''
    // 앱 이름·부제 — appInfoLocalizations (로케일별)
    if (info?.id) {
      const metaR = await fetch(
        `${A}/appInfos/${info.id}/appInfoLocalizations?fields%5BappInfoLocalizations%5D=locale,name,subtitle`,
        { headers }
      )
      if (metaR.ok) {
        const mJ = (await metaR.json()) as {
          data?: { attributes?: { locale?: string; name?: string; subtitle?: string } }[]
        }
        for (const d of mJ.data ?? []) {
          if (d.attributes?.locale) {
            meta.push({
              locale: d.attributes.locale,
              title: d.attributes.name ?? '',
              short: d.attributes.subtitle ?? '',
              full: '',
              promo: '',
              keywords: ''
            })
          }
        }
      }
    }
  }

  const iap: LiveIapProduct[] = []
  if (iapR.ok) {
    const j = (await iapR.json()) as {
      data?: { attributes?: { productId?: string; name?: string; state?: string } }[]
    }
    for (const d of j.data ?? []) {
      iap.push({
        id: d.attributes?.productId ?? '',
        title: d.attributes?.name ?? '',
        state: d.attributes?.state ?? ''
      })
    }
  }
  // 최신 버전 로컬라이제이션(설명·프로모션·키워드)을 로케일별로 병합
  for (const v of verLocs) {
    const row = meta.find((l) => l.locale === v.locale)
    if (row) {
      row.full = v.full
      row.promo = v.promo
      row.keywords = v.keywords
    } else {
      meta.push({
        locale: v.locale,
        title: '',
        short: '',
        full: v.full,
        promo: v.promo,
        keywords: v.keywords
      })
    }
  }
  const releaseNotes = verLocs
    .map((v) => ({ locale: v.locale, text: v.whatsNew }))
    .filter((v) => v.text)

  return { data: { appId, versions, meta, releaseNotes, category, ageRating, screenshots, iap } }
}

// ---------- §4.5 P2 편집 적용 (실제 스토어 write) ----------
// Play는 한 edit 트랜잭션에 리스팅 변경을 모아 :commit(원자적) / ASC는 리소스별 PATCH(부분 성공 가능)

// Play 스토어 리스팅 메타(title·short·full)를 한 edit에 모아 원자적으로 반영.
// 릴리스 노트는 라이브 트랙 릴리스를 수정해야 해(심사·롤아웃 위험) 이번 단계 제외 — 콘솔 안내.
async function applyPlayEdits(
  sheet: { app: { packageName: string }; credentials?: { googleSa?: string } },
  edits: PendingEdit[]
): Promise<ApplyResult[]> {
  const ko = appLocale === 'ko'
  const applied = (list: PendingEdit[]): ApplyResult[] =>
    list.map((e) => ({ id: e.id, ok: true, message: ko ? '반영됨' : 'Applied' }))
  const errored = (list: PendingEdit[], msg: string): ApplyResult[] =>
    list.map((e) => ({ id: e.id, ok: false, message: msg }))

  // 릴리스 노트는 라이브 트랙을 건드리므로 보류 (iOS는 초안 버전만 편집해 안전 — 비대칭 의도됨)
  const noteResults: ApplyResult[] = errored(
    edits.filter((e) => e.section === 'releaseNotes'),
    ko ? '릴리스 노트는 콘솔에서 (트랙 릴리스 편집)' : 'Release notes: use console (track release)'
  )
  const metaEdits = edits.filter((e) => e.section === 'meta')
  // 자산은 메타와 **같은 edit 안에서** 처리한다 — commit 하나로 같이 원자적으로 반영된다.
  // (id = `android:assets:{locale}:{imageType}`, newValue = 파일 경로들을 개행으로 이은 것)
  const assetEdits = edits.filter((e) => e.section === 'assets')
  if (metaEdits.length === 0 && assetEdits.length === 0) return noteResults
  const writeEdits = [...metaEdits, ...assetEdits]

  const saPath = resolveGoogleSa(sheet)
  if (!saPath) return [...noteResults, ...errored(writeEdits, ko ? '구글 인증 키 없음' : 'No Google key')]
  const tok = await googleTokenFor(saPath)
  if (!tok) return [...noteResults, ...errored(writeEdits, ko ? '토큰 발급 실패' : 'Token failed')]
  const base = `https://androidpublisher.googleapis.com/androidpublisher/v3/applications/${encodeURIComponent(sheet.app.packageName)}`
  const headers = { Authorization: 'Bearer ' + tok, 'Content-Type': 'application/json' }

  const editR = await fetch(`${base}/edits`, { method: 'POST', headers, body: '{}' })
  if (!editR.ok) return [...noteResults, ...errored(writeEdits, `HTTP ${editR.status}`)]
  const editId = ((await editR.json()) as { id?: string }).id
  if (!editId) return [...noteResults, ...errored(writeEdits, ko ? 'edit 생성 실패' : 'edit create failed')]

  // 로케일별로 현재 리스팅을 읽어 변경 필드만 병합 후 전체 PUT — 다른 필드 유실 방지
  const byLocale = new Map<string, PendingEdit[]>()
  for (const e of metaEdits) {
    const arr = byLocale.get(e.locale) ?? []
    arr.push(e)
    byLocale.set(e.locale, arr)
  }
  const writeErr = new Map<string, string>() // id → 실패 사유 (없으면 성공)
  try {
    for (const [locale, group] of byLocale) {
      const curR = await fetch(`${base}/edits/${editId}/listings/${locale}`, { headers })
      const cur = curR.ok ? await jsonOrEmpty(curR) : {}
      const body: Record<string, unknown> = {
        language: locale,
        title: (cur.title as string) ?? '',
        shortDescription: (cur.shortDescription as string) ?? '',
        fullDescription: (cur.fullDescription as string) ?? ''
      }
      if (cur.video) body.video = cur.video
      for (const e of group) {
        if (e.field === 'title') body.title = e.newValue
        else if (e.field === 'short') body.shortDescription = e.newValue
        else if (e.field === 'full') body.fullDescription = e.newValue
      }
      const putR = await fetch(`${base}/edits/${editId}/listings/${locale}`, {
        method: 'PUT',
        headers,
        body: JSON.stringify(body)
      })
      if (!putR.ok) for (const e of group) writeErr.set(e.id, `HTTP ${putR.status}`)
    }

    // 자산 — (로케일 × 이미지 종류)마다 통째 교체. 실패는 던져지므로 아래 catch가 edit을 폐기한다
    for (const e of assetEdits) {
      const files = e.newValue.split('\n').map((x) => x.trim()).filter(Boolean)
      if (files.length === 0) {
        writeErr.set(e.id, ko ? '올릴 파일이 없음' : 'No files to upload')
        continue
      }
      try {
        await replacePlayImages(base, editId, tok, e.locale, e.field, files)
      } catch (err) {
        writeErr.set(e.id, String(err).replace(/^Error:\s*/, '').slice(0, 140))
      }
    }

    if (writeErr.size > 0) {
      // 원자적 — 하나라도 실패하면 edit 폐기(전체 롤백)
      await fetch(`${base}/edits/${editId}`, { method: 'DELETE', headers }).catch(() => {})
      return [
        ...noteResults,
        ...writeEdits.map((e) => ({
          id: e.id,
          ok: false,
          message: writeErr.get(e.id) ?? (ko ? '다른 항목 실패로 함께 롤백됨' : 'Rolled back (atomic)')
        }))
      ]
    }
    const commitR = await fetch(`${base}/edits/${editId}:commit`, { method: 'POST', headers })
    if (!commitR.ok) {
      return [...noteResults, ...errored(writeEdits, (ko ? '커밋 실패 HTTP ' : 'Commit failed HTTP ') + commitR.status)]
    }
    return [...noteResults, ...applied(writeEdits)]
  } catch (err) {
    await fetch(`${base}/edits/${editId}`, { method: 'DELETE', headers }).catch(() => {})
    return [...noteResults, ...errored(writeEdits, String(err).slice(0, 120))]
  }
}

// ASC 에러 본문(JSON:API)에서 사람이 읽을 사유 뽑기
async function ascErrorMsg(r: Response): Promise<string> {
  try {
    const j = (await r.json()) as { errors?: { detail?: string; title?: string }[] }
    const first = j.errors?.[0]
    if (first?.detail) return `${r.status}: ${first.detail}`.slice(0, 160)
    if (first?.title) return `${r.status}: ${first.title}`.slice(0, 160)
  } catch {
    /* 본문 없음 */
  }
  return `HTTP ${r.status}`
}

// ASC 버전을 편집할 수 있는 상태(라이브 READY_FOR_SALE 등은 제외)
const ASC_EDITABLE_VERSION_STATES = [
  'PREPARE_FOR_SUBMISSION',
  'DEVELOPER_REJECTED',
  'REJECTED',
  'METADATA_REJECTED',
  'INVALID_BINARY'
]

// ASC 메타를 리소스별 PATCH(부분 성공 가능). name·subtitle → appInfoLocalizations,
// description·promotionalText·keywords·whatsNew → 편집 가능한 최신 버전의 appStoreVersionLocalizations.
// 라이브 버전은 건드리지 않는다(편집 가능한 상태의 버전만 대상).
async function applyAscEdits(
  sheet: {
    app: { bundleId: string }
    credentials?: { asc?: { keyPath?: string; keyId?: string; issuerId?: string } }
  },
  edits: PendingEdit[]
): Promise<ApplyResult[]> {
  const ko = appLocale === 'ko'
  const fail = (msg: string): ApplyResult[] => edits.map((e) => ({ id: e.id, ok: false, message: msg }))
  const asc = resolveAsc(sheet)
  if (!asc) return fail(ko ? 'ASC 인증 키 없음' : 'No ASC key')
  const tok = await ascTokenFor(asc)
  if (!tok) return fail(ko ? '토큰 발급 실패' : 'Token failed')
  const A = 'https://api.appstoreconnect.apple.com/v1'
  const headers = { Authorization: 'Bearer ' + tok }
  const jsonHeaders = { Authorization: 'Bearer ' + tok, 'Content-Type': 'application/json' }

  const appsR = await fetch(
    `${A}/apps?filter%5BbundleId%5D=${encodeURIComponent(sheet.app.bundleId)}`,
    { headers }
  )
  if (!appsR.ok) return fail(`HTTP ${appsR.status}`)
  const appId = ((await appsR.json()) as { data?: { id: string }[] }).data?.[0]?.id
  if (!appId) return fail(ko ? '앱 없음' : 'App not found')

  const APP_INFO_FIELDS: Record<string, string> = { name: 'name', subtitle: 'subtitle' }
  const VERSION_FIELDS: Record<string, string> = {
    description: 'description',
    promotionalText: 'promotionalText',
    keywords: 'keywords',
    whatsNew: 'whatsNew'
  }
  const results: ApplyResult[] = []
  const appInfoEdits = edits.filter((e) => e.field in APP_INFO_FIELDS)
  const versionEdits = edits.filter((e) => e.field in VERSION_FIELDS)
  for (const e of edits) {
    if (!(e.field in APP_INFO_FIELDS) && !(e.field in VERSION_FIELDS)) {
      results.push({ id: e.id, ok: false, message: ko ? '지원하지 않는 필드' : 'Unsupported field' })
    }
  }

  // 로케일별 리소스 id로 묶어 한 로케일당 PATCH 한 번(같은 로케일 여러 필드 병합)
  const applyLocalized = async (
    group: PendingEdit[],
    localeToId: Map<string, string>,
    resourceType: string,
    fieldMap: Record<string, string>,
    missingMsg: string
  ): Promise<void> => {
    const byLocale = new Map<string, PendingEdit[]>()
    for (const e of group) {
      const arr = byLocale.get(e.locale) ?? []
      arr.push(e)
      byLocale.set(e.locale, arr)
    }
    for (const [locale, es] of byLocale) {
      const id = localeToId.get(locale)
      if (!id) {
        for (const e of es) results.push({ id: e.id, ok: false, message: missingMsg })
        continue
      }
      const attributes: Record<string, string> = {}
      for (const e of es) attributes[fieldMap[e.field]] = e.newValue
      const r = await fetch(`${A}/${resourceType}/${id}`, {
        method: 'PATCH',
        headers: jsonHeaders,
        body: JSON.stringify({ data: { type: resourceType, id, attributes } })
      })
      const message = r.ok ? (ko ? '반영됨' : 'Applied') : await ascErrorMsg(r)
      for (const e of es) results.push({ id: e.id, ok: r.ok, message })
    }
  }

  // ---- appInfo 레벨 (name·subtitle) ----
  if (appInfoEdits.length) {
    const infoR = await fetch(
      `${A}/apps/${appId}/appInfos?fields%5BappInfos%5D=appStoreState,state`,
      { headers }
    )
    if (!infoR.ok) {
      for (const e of appInfoEdits) results.push({ id: e.id, ok: false, message: `HTTP ${infoR.status}` })
    } else {
      const iJ = (await infoR.json()) as {
        data?: { id: string; attributes?: { appStoreState?: string; state?: string } }[]
      }
      const infos = iJ.data ?? []
      // 편집 가능한 appInfo — 라이브(READY_FOR_SALE)가 아닌 것 우선, 없으면 첫 항목
      const editable =
        infos.find((d) => {
          const s = d.attributes?.state ?? d.attributes?.appStoreState ?? ''
          return s && s !== 'READY_FOR_SALE'
        }) ?? infos[0]
      if (!editable) {
        for (const e of appInfoEdits)
          results.push({ id: e.id, ok: false, message: ko ? '편집 가능한 앱 정보 없음' : 'No editable app info' })
      } else {
        const locMap = new Map<string, string>()
        const locR = await fetch(
          `${A}/appInfos/${editable.id}/appInfoLocalizations?fields%5BappInfoLocalizations%5D=locale&limit=50`,
          { headers }
        )
        if (locR.ok) {
          const lJ = (await locR.json()) as { data?: { id: string; attributes?: { locale?: string } }[] }
          for (const d of lJ.data ?? []) if (d.attributes?.locale) locMap.set(d.attributes.locale, d.id)
        }
        await applyLocalized(
          appInfoEdits,
          locMap,
          'appInfoLocalizations',
          APP_INFO_FIELDS,
          ko ? '해당 로케일 없음' : 'No such locale'
        )
      }
    }
  }

  // ---- version 레벨 (description·promotionalText·keywords·whatsNew) ----
  if (versionEdits.length) {
    const versR = await fetch(
      `${A}/apps/${appId}/appStoreVersions?limit=10&fields%5BappStoreVersions%5D=versionString,appStoreState,createdDate`,
      { headers }
    )
    if (!versR.ok) {
      for (const e of versionEdits) results.push({ id: e.id, ok: false, message: `HTTP ${versR.status}` })
    } else {
      const vJ = (await versR.json()) as {
        data?: { id: string; attributes?: { appStoreState?: string; createdDate?: string } }[]
      }
      const rows = (vJ.data ?? []).map((d) => ({
        id: d.id,
        state: d.attributes?.appStoreState ?? '',
        createdAt: d.attributes?.createdDate ?? ''
      }))
      rows.sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      const editable = rows.find((r) => ASC_EDITABLE_VERSION_STATES.includes(r.state))
      if (!editable) {
        for (const e of versionEdits)
          results.push({
            id: e.id,
            ok: false,
            message: ko ? '편집 가능한 버전 없음 (콘솔에서 새 버전 준비)' : 'No editable version (prepare one in console)'
          })
      } else {
        const locMap = new Map<string, string>()
        const locR = await fetch(
          `${A}/appStoreVersions/${editable.id}/appStoreVersionLocalizations?fields%5BappStoreVersionLocalizations%5D=locale&limit=50`,
          { headers }
        )
        if (locR.ok) {
          const lJ = (await locR.json()) as { data?: { id: string; attributes?: { locale?: string } }[] }
          for (const d of lJ.data ?? []) if (d.attributes?.locale) locMap.set(d.attributes.locale, d.id)
        }
        await applyLocalized(
          versionEdits,
          locMap,
          'appStoreVersionLocalizations',
          VERSION_FIELDS,
          ko ? '해당 로케일 없음' : 'No such locale'
        )
      }
    }
  }

  return results
}

// 대시보드 결과 캐시 — 진입 즉시 마지막 실황을 보여주고 백그라운드로 갱신한다
const dashCacheFile = (): string => join(app.getPath('userData'), 'zto-dashboard-cache.json')

function readDashCache(): Record<string, DashboardData> {
  try {
    return JSON.parse(readFileSync(dashCacheFile(), 'utf8'))
  } catch {
    return {}
  }
}

// 스토어 스냅샷 히스토리 — 메타·자산·IAP 전 섹션. 내용이 같으면 confirmedAt만 갱신, 다르면 새 항목 (이력 생성)
const storeSnapshotsFile = (): string => join(app.getPath('userData'), 'zto-store-snapshots.json')

function readStoreSnapshots(): Record<string, StoreSnapshotEntry[]> {
  try {
    return JSON.parse(readFileSync(storeSnapshotsFile(), 'utf8'))
  } catch {
    return {}
  }
}

function recordStoreSnapshot(
  file: string,
  google: StoreSnapshotEntry['google'],
  apple: StoreSnapshotEntry['apple']
): IapSnapshotInfo | null {
  const all = readStoreSnapshots()
  const entries = all[file] ?? []
  const last = entries[entries.length - 1]
  if (!google && !apple) {
    // 양쪽 다 조회 실패 — 히스토리는 건드리지 않고 마지막 정보만 반환
    return last
      ? { count: entries.length, createdAt: last.createdAt, confirmedAt: last.confirmedAt, changed: false }
      : null
  }
  const sortIap = (iap: LiveIapProduct[]): LiveIapProduct[] =>
    [...iap].sort((a, b) => a.id.localeCompare(b.id))
  const sortMeta = (meta: MetaListing[]): MetaListing[] =>
    [...meta].sort((a, b) => a.locale.localeCompare(b.locale))
  const data = {
    google: google && {
      listings: sortMeta(google.listings),
      images: google.images,
      iap: sortIap(google.iap)
    },
    apple: apple && {
      meta: sortMeta(apple.meta),
      screenshots: apple.screenshots,
      iap: sortIap(apple.iap)
    }
  }
  const now = new Date().toISOString()
  let changed = false
  if (last && JSON.stringify({ google: last.google, apple: last.apple }) === JSON.stringify(data)) {
    last.confirmedAt = now
  } else {
    changed = !!last
    entries.push({ createdAt: now, confirmedAt: now, ...data })
  }
  all[file] = entries.slice(-100)
  writeFileSync(storeSnapshotsFile(), JSON.stringify(all, null, 2))
  const cur = entries[entries.length - 1]
  return { count: entries.length, createdAt: cur.createdAt, confirmedAt: cur.confirmedAt, changed }
}

function firstAscCreds(): { keyPath: string; keyId: string; issuerId: string } | null {
  if (!existsSync(ANSWERS_DIR)) return null
  for (const f of readdirSync(ANSWERS_DIR).filter((x) => x.endsWith('.json') && !x.startsWith('_'))) {
    try {
      const sheet = JSON.parse(readFileSync(join(ANSWERS_DIR, f), 'utf8'))
      const asc = sheet.credentials?.asc
      if (asc?.keyPath && existsSync(asc.keyPath) && asc.keyId && asc.issuerId) return asc
    } catch {
      /* skip */
    }
  }
  return null
}

// 자격증명은 앱이 아니라 브랜드/계정 단위로 하나 — 마지막 사용 SA, 없으면 시트에서 첫 유효 SA
function firstGoogleSa(): string | null {
  const last = readState().lastGoogleSa as string
  if (last && existsSync(last)) return last
  if (!existsSync(ANSWERS_DIR)) return null
  for (const f of readdirSync(ANSWERS_DIR).filter((x) => x.endsWith('.json') && !x.startsWith('_'))) {
    try {
      const sheet = JSON.parse(readFileSync(join(ANSWERS_DIR, f), 'utf8'))
      const sa = sheet.credentials?.googleSa
      if (sa && existsSync(sa)) return sa
    } catch {
      /* skip */
    }
  }
  return null
}

// 자격증명은 앱이 아니라 계정(브랜드) 단위 하나 — 시트에 자기 것이 있으면 우선, 없으면 계정의 것을 쓴다.
// (Play SA·ASC 키의 접근 범위가 어떤 앱을 볼 수 있는지 결정한다. 예: ASC로 가져온 앱은 그 ASC 키로 조회)
function resolveGoogleSa(sheet: { credentials?: { googleSa?: string } }): string | null {
  const own = sheet.credentials?.googleSa
  if (own && existsSync(own)) return own
  return firstGoogleSa()
}
function resolveAsc(sheet: {
  credentials?: { asc?: { keyPath?: string; keyId?: string; issuerId?: string } }
}): { keyPath: string; keyId: string; issuerId: string } | null {
  const a = sheet.credentials?.asc
  if (a?.keyPath && existsSync(a.keyPath) && a.keyId && a.issuerId)
    return { keyPath: a.keyPath, keyId: a.keyId, issuerId: a.issuerId }
  return firstAscCreds()
}

interface SheetSummary {
  file: string
  appName: string
  packageName: string
  iapCount: number
  icon?: string
}

// 출시된 앱의 아이콘 — Apple 공개 조회(iTunes Lookup) → Play 스토어 페이지 순으로 시도, 로컬 캐시
const iconsDir = (): string => join(app.getPath('userData'), 'app-icons')
const iconPathFor = (file: string): string => join(iconsDir(), file.replace(/\.json$/, '') + '.png')

function iconDataUri(file: string): string | undefined {
  const p = iconPathFor(file)
  if (!existsSync(p)) return undefined
  return 'data:image/png;base64,' + readFileSync(p).toString('base64')
}

async function fetchAppIcon(file: string): Promise<boolean> {
  const sheet = JSON.parse(readFileSync(join(ANSWERS_DIR, file), 'utf8'))
  mkdirSync(iconsDir(), { recursive: true })
  if (existsSync(iconPathFor(file))) return true
  let url: string | null = null
  try {
    const r = await fetch(
      `https://itunes.apple.com/lookup?bundleId=${encodeURIComponent(sheet.app.bundleId)}&country=KR`
    )
    const j = (await r.json()) as { results?: { artworkUrl512?: string; artworkUrl100?: string }[] }
    url = j.results?.[0]?.artworkUrl512 ?? j.results?.[0]?.artworkUrl100 ?? null
  } catch {
    /* 다음 소스로 */
  }
  if (!url) {
    try {
      const r = await fetch(
        `https://play.google.com/store/apps/details?id=${encodeURIComponent(sheet.app.packageName)}&hl=ko`
      )
      if (r.ok) {
        const html = await r.text()
        const mch =
          html.match(/property="og:image"\s+content="([^"]+)"/) ??
          html.match(/content="([^"]+)"\s+property="og:image"/)
        url = mch?.[1] ?? null
      }
    } catch {
      /* 없으면 포기 */
    }
  }
  if (!url) return false
  const imgR = await fetch(url)
  if (!imgR.ok) return false
  writeFileSync(iconPathFor(file), Buffer.from(await imgR.arrayBuffer()))
  return true
}

function listSheets(): SheetSummary[] {
  if (!existsSync(ANSWERS_DIR)) return []
  return readdirSync(ANSWERS_DIR)
    .filter((f) => f.endsWith('.json') && !f.startsWith('_'))
    .map((file) => {
      try {
        const sheet = JSON.parse(readFileSync(join(ANSWERS_DIR, file), 'utf8'))
        return {
          file,
          appName: sheet.app?.name ?? file,
          packageName: sheet.app?.packageName ?? '',
          iapCount: Array.isArray(sheet.iap) ? sheet.iap.length : 0,
          icon: iconDataUri(file)
        }
      } catch {
        return { file, appName: `${file} (${mainMsg('parseFail')})`, packageName: '', iapCount: 0 }
      }
    })
}

// 자격증명 보유 점검 — 시트에 적힌 경로의 파일 존재 여부만 본다 (내용은 읽지 않음)
function checkCredentials(file: string): {
  googleSa: { path: string; ok: boolean }
  asc: { keyPath: string; keyId: string; issuerId: string; ok: boolean }
} {
  const sheet = JSON.parse(readFileSync(join(ANSWERS_DIR, file), 'utf8'))
  const saPath: string = sheet.credentials?.googleSa ?? ''
  const asc = sheet.credentials?.asc ?? {}
  const keyPath: string = asc.keyPath ?? ''
  return {
    googleSa: { path: saPath, ok: !!saPath && existsSync(saPath) },
    asc: {
      keyPath,
      keyId: asc.keyId ?? '',
      issuerId: asc.issuerId ?? '',
      ok: !!keyPath && existsSync(keyPath) && !!asc.keyId && !!asc.issuerId
    }
  }
}

// (계정, 앱)별 비밀번호 — SPEC §7.3 "기기에서만" 모델.
// 암호화 키는 OS 키체인(safeStorage), 여기 파일에는 암호문만. 계정 파일(zto-accounts.json)과 분리.
const secretsFile = (): string => join(app.getPath('userData'), 'zto-secrets.json')
const secretKey = (email: string, appId: string): string => `${email}::${appId}`

interface SecretRecord {
  v: string // safeStorage 암호문 (base64)
  updatedAt: string
}

// 구 포맷(값이 문자열) 마이그레이션 포함
function readSecrets(): Record<string, SecretRecord> {
  try {
    const raw = JSON.parse(readFileSync(secretsFile(), 'utf8')) as Record<
      string,
      string | SecretRecord
    >
    return Object.fromEntries(
      Object.entries(raw).map(([k, val]) => [
        k,
        typeof val === 'string' ? { v: val, updatedAt: '' } : val
      ])
    )
  } catch {
    return {}
  }
}

function writeSecrets(secrets: Record<string, SecretRecord>): void {
  writeFileSync(secretsFile(), JSON.stringify(secrets, null, 2))
}

// 생체인증 관문 — 2FA 필수 정책 (2026-07-22 Dan): Touch ID 불가 기기에서는 조회 자체를 거부.
// 승인 시 30분 잠금 해제 세션. 화면 잠금·잠자기 시 즉시 무효화 (powerMonitor).
const UNLOCK_TTL_MS = 30 * 60_000
let unlockedUntil = 0

// renderer가 동기화해주는 로케일 — main이 만드는 사용자 노출 문구(Touch ID 프롬프트 등)용
let appLocale: 'ko' | 'en' = 'ko'
const MAIN_MSG = {
  ko: { reveal: '비밀번호 보기', copy: '비밀번호 복사', update: '비밀번호 변경', delete: '비밀번호 삭제', deleteAccount: '계정 삭제', parseFail: '파싱 실패' },
  en: { reveal: 'reveal password', copy: 'copy password', update: 'change password', delete: 'delete password', deleteAccount: 'delete account', parseFail: 'parse failed' }
} as const
const mainMsg = (k: keyof (typeof MAIN_MSG)['ko']): string => MAIN_MSG[appLocale][k]

export function lockSecrets(): void {
  unlockedUntil = 0
}

async function biometricGate(reason: string): Promise<void> {
  if (Date.now() < unlockedUntil) return
  await biometricGateStrict(reason)
}

// "보기"(평문 표시)용 — 잠금 해제 세션을 무시하고 항상 재인증 (화면 노출은 위험도가 다름)
async function biometricGateStrict(reason: string): Promise<void> {
  if (process.platform !== 'darwin' || !systemPreferences.canPromptTouchID()) {
    throw new Error('biometric-unavailable')
  }
  await systemPreferences.promptTouchID(reason) // 실패/취소 시 throw
  unlockedUntil = Date.now() + UNLOCK_TTL_MS
}

// 접근 로그 (로컬 전용, 최근 500건 유지)
const accessLogFile = (): string => join(app.getPath('userData'), 'zto-access-log.json')

function logAccess(entry: Omit<AccessLogEntry, 'ts'>): void {
  let log: AccessLogEntry[] = []
  try {
    log = JSON.parse(readFileSync(accessLogFile(), 'utf8'))
  } catch {
    /* 첫 기록 */
  }
  log.push({ ts: new Date().toISOString(), ...entry })
  writeFileSync(accessLogFile(), JSON.stringify(log.slice(-500), null, 2))
}

function decryptSecret(email: string, appId: string): string | null {
  const record = readSecrets()[secretKey(email, appId)]
  if (!record) return null
  return safeStorage.decryptString(Buffer.from(record.v, 'base64'))
}

// ZTO 브라우저(WebContentsView)를 붙일 호스트 창 — IPC 핸들러가 참조 (모듈 스코프)
let browserHostWindow: BrowserWindow | null = null

function createWindow(): void {
  // 지난 실행의 창 크기·위치 복원
  const saved = readState().windowBounds as
    | { width: number; height: number; x?: number; y?: number }
    | undefined
  const mainWindow = new BrowserWindow({
    width: saved?.width ?? 1200,
    height: saved?.height ?? 800,
    x: saved?.x,
    y: saved?.y,
    minWidth: 960,
    minHeight: 640,
    show: false,
    autoHideMenuBar: true,
    title: 'ZTO',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false
    }
  })

  browserHostWindow = mainWindow
  mainWindow.on('closed', () => {
    browserHostWindow = null
  })

  mainWindow.on('ready-to-show', () => {
    // dev에서는 **포커스를 뺏지 않고** 띄운다. `src/main` 변경마다 dev 서버를 재시작하는데,
    // 그때마다 show()가 앞으로 튀어나와 다른 앱에서 하던 작업의 포커스를 가져간다(Dan 2026-07-30).
    // 하루에 몇 번씩 겪으면 개발 자체가 방해가 된다.
    // 실사용(패키징) 때는 사용자가 직접 실행한 것이므로 앞으로 나오는 게 맞다.
    if (app.isPackaged) mainWindow.show()
    else mainWindow.showInactive()
  })

  const saveBounds = (): void => {
    if (!mainWindow.isDestroyed() && !mainWindow.isFullScreen()) {
      writeState({ ...readState(), windowBounds: mainWindow.getBounds() })
    }
  }
  mainWindow.on('resized', saveBounds)
  mainWindow.on('moved', saveBounds)
  mainWindow.on('close', saveBounds)

  mainWindow.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url)
    return { action: 'deny' }
  })

  if (!app.isPackaged && process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

// 자산은 커스텀 스킴으로 낸다. `file://`은 CSP를 허용해도 **렌더러 오리진이 http일 때
// Chromium이 스킴 규칙으로 막는다**(dev 서버가 http://localhost:5173) — CSP 문제가 아니라
// 오리진↔스킴 문제라 img-src에 file:을 넣어도 안 뜬다(2026-07-30 실측: 타일이 통째로 빈칸).
// 커스텀 스킴은 오리진과 무관하게 로드되고, 경로도 우리가 통제한다.
protocol.registerSchemesAsPrivileged([
  { scheme: 'zto-asset', privileges: { standard: true, secure: true, supportFetchAPI: true } }
])

app.whenReady().then(() => {
  // userData/assets 안의 파일만 낸다 — 파일명만 받고 경로 조작은 차단한다
  protocol.handle('zto-asset', (req) => {
    const name = basename(decodeURIComponent(req.url.replace(/^zto-asset:\/\//, '').split('?')[0]))
    const file = join(ASSET_DIR(), name)
    if (!name || !existsSync(file)) return new Response('not found', { status: 404 })
    return net.fetch(pathToFileURL(file).toString())
  })
  // 기기가 손을 떠나는 순간 비밀번호 세션 종료
  powerMonitor.on('lock-screen', lockSecrets)
  powerMonitor.on('suspend', lockSecrets)

  ipcMain.handle('ping', () => 'pong')
  // #4 ZTO 자체 브라우저 — WebContentsView 임베드·네비게이트·eval/CDP 제어 (browser.ts)
  registerBrowserIpc(() => browserHostWindow)
  ipcMain.handle('app:setLocale', (_e, locale: 'ko' | 'en'): void => {
    appLocale = locale
    writeState({ ...readState(), locale })
  })
  ipcMain.handle('app:getLocale', (): 'ko' | 'en' => (readState().locale as 'ko' | 'en') ?? 'ko')
  // AI provider — 구독(CLI 감지)/API키(키체인) 상태 + active·mode·model 설정
  ipcMain.handle('ai:status', (_e, fresh?: boolean): AiStatus => aiStatus(fresh))
  // 모델은 active provider 것으로 저장 — 렌더러는 목록을 그대로 받아 쓰므로 provider를 몰라도 된다.
  ipcMain.handle('ai:setModel', (_e, model: string): void => {
    const cfg = readAiConfig()
    if (modelsFor(cfg, cfg.active).some((m) => m.id === model)) {
      writeAiConfig({ models: { ...cfg.models, [cfg.active]: model } })
    }
  })
  ipcMain.handle('ai:setActive', (_e, provider: AiProviderId): void => {
    writeAiConfig({ active: provider })
  })
  ipcMain.handle('ai:setMode', (_e, provider: AiProviderId, mode: AiMode): void => {
    if (provider === 'gemini') return // gemini는 API키 전용
    writeAiConfig({ modes: { ...readAiConfig().modes, [provider]: mode } })
  })
  // 키 저장/삭제 — 첫 저장 무인증(등록 마찰↓), 값 비우면 삭제. 화면 표시는 없음(저장 여부만)
  ipcMain.handle('ai:setKey', (_e, provider: AiProviderId, key: string): boolean =>
    setAiKey(provider, key)
  )
  // 사용량 — 집계는 렌더러가 한다(필터·기간이 화면 상태라). 여기선 원본 기록만 넘긴다.
  ipcMain.handle('ai:usage', (): AiUsageEntry[] => readAiUsage())
  ipcMain.handle('ai:usageClear', (): boolean => {
    try {
      writeFileSync(aiUsageFile(), '[]')
      return true
    } catch {
      return false
    }
  })
  // AI 한 턴 — active provider·mode로 실행. 구독(claude CLI spawn) 우선 구현, resume로 대화 이어감.
  // 이미지가 있으면 stream-json 입력으로 멀티모달(실증 확인) — 없으면 가벼운 --output-format json.
  ipcMain.handle(
    'ai:chat',
    async (
      _e,
      prompt: string,
      opts?: {
        resume?: string
        images?: { mediaType: string; data: string }[]
        feature?: AiFeature
      }
    ): Promise<AiChatResult> => {
      const cfg = readAiConfig()
      const provider = cfg.active
      const mode = cfg.modes[provider]
      const model = modelFor(cfg, provider)
      const feature: AiFeature = opts?.feature ?? 'other'
      const startedAt = Date.now()
      if (provider === 'chatgpt') {
        return mode === 'apikey'
          ? await chatOpenAi(prompt, model, { ...opts, feature })
          : await chatCodex(prompt, feature, opts)
      }
      if (mode === 'subscription' && provider === 'claude') {
        const info = cliInfo('claude')
        if (!info.available || !info.bin) return { ok: false, text: '', error: 'claude-cli-missing' }
        const bin = info.bin
        const images = opts?.images ?? []

        // 텍스트만 — 검증된 가벼운 경로
        if (images.length === 0) {
          const args = ['-p', prompt, '--output-format', 'json', '--model', model]
          if (opts?.resume) args.push('--resume', opts.resume)
          return await new Promise<AiChatResult>((resolve) => {
            execFile(
              bin,
              args,
              { cwd: app.getPath('userData'), timeout: 120_000, maxBuffer: 16 * 1024 * 1024 },
              (err, stdout) => {
                try {
                  const j = JSON.parse(stdout) as {
                    result?: string
                    session_id?: string
                    is_error?: boolean
                  } & ClaudeCliUsage
                  recordClaudeUsage(j, model, feature, startedAt, !j.is_error)
                  resolve({ ok: !j.is_error, text: j.result ?? '', sessionId: j.session_id })
                } catch {
                  resolve({ ok: false, text: '', error: err ? String(err).slice(0, 300) : 'parse' })
                }
              }
            )
          })
        }

        // 멀티모달 — stream-json 입력으로 이미지 content 블록을 stdin에 넣는다 (--verbose 필수)
        const content = [
          { type: 'text', text: prompt },
          ...images.map((im) => ({
            type: 'image',
            source: { type: 'base64', media_type: im.mediaType, data: im.data }
          }))
        ]
        const msg = JSON.stringify({ type: 'user', message: { role: 'user', content } })
        const args = [
          '-p',
          '--input-format',
          'stream-json',
          '--output-format',
          'stream-json',
          '--verbose',
          '--model',
          model
        ]
        if (opts?.resume) args.push('--resume', opts.resume)
        return await new Promise<AiChatResult>((resolve) => {
          const child = spawn(bin, args, { cwd: app.getPath('userData') })
          let out = ''
          let done = false
          const finish = (r: AiChatResult): void => {
            if (done) return
            done = true
            resolve(r)
          }
          const timer = setTimeout(() => {
            child.kill()
            finish({ ok: false, text: '', error: 'timeout' })
          }, 180_000)
          child.stdout.on('data', (d) => (out += d))
          child.on('error', (e) => {
            clearTimeout(timer)
            finish({ ok: false, text: '', error: String(e).slice(0, 300) })
          })
          child.on('close', () => {
            clearTimeout(timer)
            let text = ''
            let sessionId: string | undefined
            let isErr = false
            let found = false
            for (const line of out.split('\n')) {
              const s = line.trim()
              if (!s.startsWith('{')) continue
              try {
                const e = JSON.parse(s) as {
                  type?: string
                  result?: string
                  session_id?: string
                  is_error?: boolean
                } & ClaudeCliUsage
                if (e.type === 'result') {
                  text = e.result ?? ''
                  sessionId = e.session_id
                  isErr = !!e.is_error
                  found = true
                  recordClaudeUsage(e, model, feature, startedAt, !isErr)
                }
              } catch {
                /* 부분 라인 무시 */
              }
            }
            finish(found ? { ok: !isErr, text, sessionId } : { ok: false, text: '', error: 'parse' })
          })
          child.stdin.write(msg + '\n')
          child.stdin.end()
        })
      }
      // codex 구독·API 키 경로는 다음 슬라이스
      return { ok: false, text: '', error: `${provider}:${mode}:not-wired` }
    }
  )
  // 데이터 안전 — 콘솔에서 CSV로 가져오기(ROADMAP #4). 사용자는 버튼 하나만 누른다:
  // 로그인 확인 → 앱 찾기 → 폼 이동 → Export 클릭 → 파싱까지 ZTO가 대신한다.
  // 진행 단계는 렌더러로 흘려보낸다 — 20초간 조용하면 고장으로 보인다.
  ipcMain.handle('console:pullDataSafety', async (e, file: string, askLogin?: string, askChooseDev?: string, askExport?: string) => {
    let packageName = ''
    try {
      const sheet = JSON.parse(readFileSync(join(ANSWERS_DIR, file), 'utf8'))
      packageName = sheet.app?.packageName ?? ''
    } catch {
      return { ok: false, step: 'failed', error: 'sheet-unreadable' }
    }
    const result = await pullDataSafety(
      packageName,
      (step, detail) => {
        console.log('[pullDataSafety]', step, detail ?? '')
        if (!e.sender.isDestroyed()) e.sender.send('console:progress', { step, detail })
      },
      { login: askLogin ?? '', chooseDev: askChooseDev ?? '', export: askExport ?? '' }
    )
    // 화면만 보고 추측하지 않도록 결과를 main 로그에 남긴다 (dev 서버 출력에서 그대로 읽힌다)
    console.log('[pullDataSafety] result', JSON.stringify({ ...result, doc: undefined }))
    return result
  })
  // 앱 콘텐츠 선언 정찰 — 콘텐츠 등급(IARC)·타깃 연령 등은 CSV가 없어 DOM 경로다.
  // 코드를 쓰기 전에 폼이 실제로 어떻게 생겼는지 회수한다(결과는 userData/zto-app-content-*.json).
  ipcMain.handle(
    'console:probeAppContent',
    async (e, file: string, askLogin?: string, askChooseDev?: string) => {
      let packageName = ''
      try {
        const sheet = JSON.parse(readFileSync(join(ANSWERS_DIR, file), 'utf8'))
        packageName = sheet.app?.packageName ?? ''
      } catch {
        return { ok: false, step: 'failed', error: 'sheet-unreadable' }
      }
      const result = await probeAppContent(
        packageName,
        (step, detail) => {
          console.log('[probeAppContent]', step, detail ?? '')
          if (!e.sender.isDestroyed()) e.sender.send('console:progress', { step, detail })
        },
        { login: askLogin ?? '', chooseDev: askChooseDev ?? '' }
      )
      console.log(
        '[probeAppContent] result',
        JSON.stringify({
          ...result,
          doc: result.doc
            ? result.doc.forms.map((f) => `${f.slug}:${f.controls.length}`).join(' ')
            : undefined
        })
      )
      return result
    }
  )
  // 가져온 데이터 안전 결과 — 성공 여부를 사용자가 화면에서 판단할 수 있어야 한다.
  // (로그·파일로만 확인되면 그건 개발자만 아는 성공이다)
  ipcMain.handle('console:dataSafetyDoc', (_e, file: string) => {
    try {
      const sheet = JSON.parse(readFileSync(join(ANSWERS_DIR, file), 'utf8'))
      const pkg = sheet.app?.packageName ?? ''
      if (!pkg) return null
      const path = join(app.getPath('userData'), `zto-data-safety-${pkg}.json`)
      if (!existsSync(path)) return null
      return JSON.parse(readFileSync(path, 'utf8'))
    } catch {
      return null
    }
  })
  // 자산 고르기 — 파일 선택 → **업로드 전에** 규격 검증. 콘솔은 거부 사유를 뭉뚱그려 주므로
  // 여기서 "512×512여야 하는데 1024×1024"까지 말해준다(문서 §8).
  // 미리보기는 파일을 userData/assets에 복사해 zto-asset:// 로 낸다 — 이미 있는 안전한 통로를
  // 재사용한다(경로 조작은 basename으로 막혀 있고, 렌더러에 8MB 바이트를 실어 보내지 않아도 된다).
  ipcMain.handle('launch:pickAssets', async (_e, imageType: string) => {
    const ko = appLocale === 'ko'
    const spec = PLAY_IMAGE_SPECS[imageType]
    if (!spec) return { ok: false, error: `unknown-type:${imageType}`, files: [] }
    const picked = await dialog.showOpenDialog({
      title: spec.label,
      properties: spec.multiple ? ['openFile', 'multiSelections'] : ['openFile'],
      filters: [{ name: 'Images', extensions: spec.mimes.includes('image/jpeg') ? ['png', 'jpg', 'jpeg'] : ['png'] }]
    })
    if (picked.canceled || picked.filePaths.length === 0) return { ok: false, canceled: true, files: [] }

    const dir = ASSET_DIR()
    try {
      mkdirSync(dir, { recursive: true })
    } catch {
      /* 있으면 무시 */
    }
    const files: { path: string; name: string; width: number; height: number; preview: string }[] = []
    for (const f of picked.filePaths) {
      const info = imageInfo(f)
      if (!info) {
        return { ok: false, error: ko ? `${basename(f)}: PNG·JPEG만 읽을 수 있어요` : `${basename(f)}: only PNG/JPEG`, files: [] }
      }
      const bad = validatePlayImage(imageType, info, ko)
      if (bad) return { ok: false, error: bad, files: [] }
      // 미리보기 사본 — 원본은 건드리지 않는다
      const key = createHash('sha1').update(f + info.bytes).digest('hex')
      const copy = join(dir, `pick-${key}${info.mime === 'image/png' ? '.png' : '.jpg'}`)
      try {
        writeFileSync(copy, readFileSync(f))
      } catch {
        /* 미리보기 실패가 업로드를 막지는 않는다 */
      }
      files.push({
        path: f,
        name: info.name,
        width: info.width,
        height: info.height,
        preview: existsSync(copy) ? `zto-asset://${basename(copy)}` : ''
      })
    }
    return { ok: true, files }
  })
  ipcMain.handle('launch:listSheets', () => listSheets())
  ipcMain.handle('launch:checkCredentials', (_e, file: string) => checkCredentials(file))
  // GUI에서 답안 시트 생성 — 2단계가 파일 작업 없이 앱 안에서 완결되도록
  ipcMain.handle(
    'launch:createSheet',
    (
      _e,
      name: string,
      packageName: string,
      bundleId: string
    ): { ok: boolean; file?: string; error?: string } => {
      const slug = (packageName.split('.').pop() || name)
        .toLowerCase()
        .replace(/[^a-z0-9-]+/g, '-')
        .replace(/^-+|-+$/g, '')
      if (!slug) return { ok: false, error: 'invalid-name' }
      const file = `${slug}.json`
      const path = join(ANSWERS_DIR, file)
      if (existsSync(path)) return { ok: false, error: 'exists' }
      const sheet = {
        app: { name, packageName, bundleId: bundleId || packageName },
        iap: [],
        credentials: { googleSa: '', asc: { keyPath: '', keyId: '', issuerId: '' } },
        console_answers: { data_safety: {}, content_rating: {}, app_access: '', review_notes: '' }
      }
      writeFileSync(path, JSON.stringify(sheet, null, 2))
      return { ok: true, file }
    }
  )
  // 기존 앱 가져오기 — 패키지명 실존·접근 검증(SA 제공 시) 후 시트 생성
  ipcMain.handle(
    'launch:importApp',
    async (
      _e,
      name: string,
      packageName: string,
      saPath: string
    ): Promise<{ ok: boolean; file?: string; verified?: boolean; error?: string; detail?: string }> => {
      const slug = (packageName.split('.').pop() || name)
        .toLowerCase()
        .replace(/[^a-z0-9-]+/g, '-')
        .replace(/^-+|-+$/g, '')
      if (!slug || !packageName) return { ok: false, error: 'invalid-name' }
      const file = `${slug}.json`
      const path = join(ANSWERS_DIR, file)
      if (existsSync(path)) return { ok: false, error: 'exists' }

      let verified = false
      if (saPath) {
        if (!existsSync(saPath)) return { ok: false, error: 'verify-failed', detail: 'SA file not found' }
        const tokenScript = join(app.getAppPath(), 'launch', 'scripts', 'google', 'token.js')
        const tok = await new Promise<{ ok?: boolean; access_token?: string } | null>((resolve) => {
          execFile(
            process.execPath,
            [tokenScript, '--sa', saPath],
            { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, timeout: 30_000 },
            (_err, stdout) => {
              try {
                resolve(JSON.parse(stdout))
              } catch {
                resolve(null)
              }
            }
          )
        })
        if (!tok?.ok || !tok.access_token) {
          return { ok: false, error: 'verify-failed', detail: 'token' }
        }
        const r = await fetch(
          `https://androidpublisher.googleapis.com/androidpublisher/v3/applications/${encodeURIComponent(packageName)}/oneTimeProducts`,
          { headers: { Authorization: 'Bearer ' + tok.access_token } }
        )
        if (!r.ok) return { ok: false, error: 'verify-failed', detail: `HTTP ${r.status}` }
        verified = true
        writeState({ ...readState(), lastGoogleSa: saPath })
      }

      const sheet = {
        app: { name: name || slug, packageName, bundleId: packageName },
        iap: [],
        credentials: { googleSa: saPath || '', asc: { keyPath: '', keyId: '', issuerId: '' } },
        console_answers: { data_safety: {}, content_rating: {}, app_access: '', review_notes: '' }
      }
      writeFileSync(path, JSON.stringify(sheet, null, 2))
      return { ok: true, file, verified }
    }
  )
  // §4.5 앱 대시보드 — 양대 스토어 실황 pull + IAP 스냅샷 이력 축적 (읽기 전용)
  ipcMain.handle('launch:dashboard', async (_e, file: string): Promise<DashboardData> => {
    const sheet = JSON.parse(readFileSync(join(ANSWERS_DIR, file), 'utf8'))
    // pull이 던져도 loading이 영원히 안 풀리지 않게 — 예외를 에러 결과로 전환
    const [g, a] = await Promise.all([
      pullGoogleDashboard(sheet).catch((e) => ({ data: null, error: `err:${String(e).slice(0, 80)}` })),
      pullAppleDashboard(sheet).catch((e) => ({ data: null, error: `err:${String(e).slice(0, 80)}` }))
    ])
    const snapshot = recordStoreSnapshot(
      file,
      g.data ? { listings: g.data.listings, images: g.data.images, iap: g.data.iap } : null,
      a.data ? { meta: a.data.meta, screenshots: a.data.screenshots, iap: a.data.iap } : null
    )
    const result: DashboardData = {
      pulledAt: new Date().toISOString(),
      google: g.data,
      googleError: g.error,
      apple: a.data,
      appleError: a.error,
      snapshot
    }
    // 마지막 결과를 저장 — 다음 진입 시 즉시 표시(백그라운드 갱신)용
    const cache = readDashCache()
    cache[file] = result
    writeFileSync(dashCacheFile(), JSON.stringify(cache, null, 2))
    // 앱 아이콘 캐시 — 공개 스토어 페이지 조회가 실패하는 미출시 앱은 Play 리스팅 아이콘으로 채운다
    if (!existsSync(iconPathFor(file))) {
      const iconUrl = g.data?.images.find((im) => im.type === 'icon')?.urls[0]
      if (iconUrl) {
        try {
          const r = await fetch(iconUrl)
          if (r.ok) {
            mkdirSync(iconsDir(), { recursive: true })
            writeFileSync(iconPathFor(file), Buffer.from(await r.arrayBuffer()))
          }
        } catch {
          /* 아이콘 없어도 앱은 동작 */
        }
      }
    }
    return result
  })
  // 전역 API 연결 상태 — 자격증명은 앱이 아니라 계정 단위(플랫폼당 하나). 타이틀 우측 config용
  ipcMain.handle('launch:apiStatus', async (): Promise<ApiStatus> => {
    const saPath = firstGoogleSa()
    let play: ApiStatus['play'] = { connected: false, detail: '' }
    if (saPath) {
      const tok = await googleTokenFor(saPath)
      play = { connected: !!tok, detail: saPath.split('/').pop() ?? '' }
    }
    const asc = firstAscCreds()
    let apple: ApiStatus['apple'] = { connected: false, detail: '' }
    if (asc) {
      const tok = await ascTokenFor(asc)
      apple = { connected: !!tok, detail: `Key ${asc.keyId}` }
    }
    return { play, apple }
  })
  ipcMain.handle('launch:dashboardCached', (_e, file: string): DashboardData | null => {
    const d = readDashCache()[file]
    if (!d) return null
    // 구버전 캐시(스키마 다름)는 무시 — 새 pull로 채운다
    if (d.google && (!Array.isArray(d.google.listings) || !d.google.details)) return null
    if (d.google?.listings[0] && d.google.listings[0].full === undefined) return null
    if (d.apple && (!Array.isArray(d.apple.meta) || !Array.isArray(d.apple.releaseNotes)))
      return null
    return d
  })
  // 스냅샷 이력 — 노드별 "기록 보기"용 (최신순)
  ipcMain.handle('launch:snapshots', (_e, file: string): StoreSnapshotEntry[] => {
    return (readStoreSnapshots()[file] ?? []).slice(-50).reverse()
  })
  // 앱 콘텐츠 설문 — 질문 세트(버전 관리 JSON) 로드 + 답 저장(시트 console_answers)
  ipcMain.handle('launch:questionnaire', (_e, id: string): Questionnaire | null => {
    try {
      const safe = id.replace(/[^a-z0-9-]/g, '')
      const p = join(app.getAppPath(), 'launch', 'questionnaires', `${safe}.json`)
      return JSON.parse(readFileSync(p, 'utf8'))
    } catch {
      return null
    }
  })
  // 설문 목록 — 설정 노드가 플랫폼별로 여러 설문 버튼을 라벨과 함께 그리도록 (질문은 안 실음)
  ipcMain.handle('launch:questionnaireList', (): QuestionnaireMeta[] => {
    const dir = join(app.getAppPath(), 'launch', 'questionnaires')
    if (!existsSync(dir)) return []
    const out: QuestionnaireMeta[] = []
    for (const f of readdirSync(dir).filter((x) => x.endsWith('.json'))) {
      try {
        const q = JSON.parse(readFileSync(join(dir, f), 'utf8')) as Questionnaire
        if (q.id && q.platform) {
          out.push({ id: q.id, platform: q.platform, title: q.title, titleEn: q.titleEn ?? q.title })
        }
      } catch {
        /* 깨진 파일 건너뜀 */
      }
    }
    return out
  })
  ipcMain.handle('launch:getConsoleAnswers', (_e, file: string, id: string): ConsoleAnswers | null => {
    try {
      const sheet = JSON.parse(readFileSync(join(ANSWERS_DIR, file), 'utf8'))
      return sheet.console_answers?.[id] ?? null
    } catch {
      return null
    }
  })
  ipcMain.handle(
    'launch:setConsoleAnswers',
    (_e, file: string, id: string, data: ConsoleAnswers): void => {
      const path = join(ANSWERS_DIR, file)
      const sheet = JSON.parse(readFileSync(path, 'utf8'))
      sheet.console_answers = { ...(sheet.console_answers ?? {}), [id]: data }
      writeFileSync(path, JSON.stringify(sheet, null, 2))
    }
  )
  // iOS 연령 등급은 스토어에서 읽힌다(ageRatingDeclaration) → 기존 앱 설문 프리필용.
  // Play(콘텐츠 등급·데이터 안전·타깃 연령)는 read API 자체가 없어 프리필 불가 — 콘솔 확인만.
  ipcMain.handle(
    'launch:ageRatingDeclaration',
    async (_e, file: string): Promise<Record<string, string> | null> => {
      const sheet = JSON.parse(readFileSync(join(ANSWERS_DIR, file), 'utf8'))
      const asc = resolveAsc(sheet)
      if (!asc) return null
      const tok = await ascTokenFor(asc)
      if (!tok) return null
      const A = 'https://api.appstoreconnect.apple.com/v1'
      const headers = { Authorization: 'Bearer ' + tok }
      const appsR = await fetch(
        `${A}/apps?filter%5BbundleId%5D=${encodeURIComponent(sheet.app.bundleId)}`,
        { headers }
      )
      if (!appsR.ok) return null
      const appId = ((await appsR.json()) as { data?: { id: string }[] }).data?.[0]?.id
      if (!appId) return null
      const r = await fetch(`${A}/apps/${appId}/appInfos?include=ageRatingDeclaration`, { headers })
      if (!r.ok) return null
      const j = (await r.json()) as {
        included?: { type: string; attributes?: Record<string, unknown> }[]
      }
      const decl = (j.included ?? []).find((x) => x.type === 'ageRatingDeclarations')?.attributes
      if (!decl) return null
      const LV = ['NONE', 'INFREQUENT_OR_MILD', 'FREQUENT_OR_INTENSE']
      const out: Record<string, string> = {}
      for (const [k, v] of Object.entries(decl)) {
        if (typeof v === 'boolean') out[k] = v ? 'YES' : 'NO'
        else if (typeof v === 'string' && LV.includes(v)) out[k] = v
      }
      return out
    }
  )
  // P2 편집 적용 — 대기 diff를 스토어에 반영. Play(android)는 한 edit에 묶어 commit(원자적),
  // ASC(ios)는 리소스별 PATCH(부분 실패 가능). 성공분은 렌더러가 재-pull로 확인.
  ipcMain.handle(
    'launch:applyEdits',
    async (_e, file: string, edits: PendingEdit[]): Promise<ApplyResult[]> => {
      let sheet: {
        app: { packageName: string; bundleId: string }
        credentials?: {
          googleSa?: string
          asc?: { keyPath?: string; keyId?: string; issuerId?: string }
        }
      }
      try {
        sheet = JSON.parse(readFileSync(join(ANSWERS_DIR, file), 'utf8'))
      } catch {
        return edits.map((e) => ({
          id: e.id,
          ok: false,
          message: appLocale === 'ko' ? '시트를 읽을 수 없음' : 'Cannot read sheet'
        }))
      }
      const android = edits.filter((e) => e.platform === 'android')
      const ios = edits.filter((e) => e.platform === 'ios')
      const [aRes, iRes] = await Promise.all([
        android.length ? applyPlayEdits(sheet, android) : Promise.resolve([]),
        ios.length ? applyAscEdits(sheet, ios) : Promise.resolve([])
      ])
      return [...aRes, ...iRes]
    }
  )
  // iOS 새 버전 생성 — 이름 등 '버전 종속 메타'는 라이브 버전에 못 대고 편집 가능한 버전이 있어야 한다.
  // 버전 번호는 라이브보다 높아야 애플이 받는다. 생성 후 그 버전이 편집 가능해져 메타 반영이 열린다.
  // (제출·심사는 빌드 업로드 후 사람이 — 비가역이라 자동 안 함, SPEC §3)
  ipcMain.handle(
    'launch:createIosVersion',
    async (
      _e,
      file: string,
      versionString: string
    ): Promise<{ ok: boolean; error?: string; versionId?: string }> => {
      const ko = appLocale === 'ko'
      let sheet: {
        app: { bundleId: string }
        credentials?: { asc?: { keyPath?: string; keyId?: string; issuerId?: string } }
      }
      try {
        sheet = JSON.parse(readFileSync(join(ANSWERS_DIR, file), 'utf8'))
      } catch {
        return { ok: false, error: ko ? '시트를 읽을 수 없음' : 'Cannot read sheet' }
      }
      const asc = resolveAsc(sheet)
      if (!asc) return { ok: false, error: ko ? 'ASC 인증 키 없음' : 'No ASC key' }
      const tok = await ascTokenFor(asc)
      if (!tok) return { ok: false, error: ko ? '토큰 발급 실패' : 'Token failed' }
      const A = 'https://api.appstoreconnect.apple.com/v1'
      const headers = { Authorization: 'Bearer ' + tok, 'Content-Type': 'application/json' }
      const appsR = await fetch(
        `${A}/apps?filter%5BbundleId%5D=${encodeURIComponent(sheet.app.bundleId)}`,
        { headers: { Authorization: 'Bearer ' + tok } }
      )
      if (!appsR.ok) return { ok: false, error: `HTTP ${appsR.status}` }
      const appId = ((await appsR.json()) as { data?: { id: string }[] }).data?.[0]?.id
      if (!appId) return { ok: false, error: ko ? '앱 없음' : 'App not found' }
      const r = await fetch(`${A}/appStoreVersions`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          data: {
            type: 'appStoreVersions',
            attributes: { platform: 'IOS', versionString },
            relationships: { app: { data: { type: 'apps', id: appId } } }
          }
        })
      })
      if (!r.ok) return { ok: false, error: await ascErrorMsg(r) }
      const j = (await r.json()) as { data?: { id?: string } }
      return { ok: true, versionId: j.data?.id }
    }
  )
  // Apple 계정의 앱 목록 — 가져오기에서 클릭 선택용 (Play는 목록 API가 없음)
  ipcMain.handle(
    'launch:listAscApps',
    async (): Promise<{ name: string; bundleId: string }[]> => {
      const asc = firstAscCreds()
      if (!asc) return []
      const tok = await ascTokenFor(asc)
      if (!tok) return []
      const r = await fetch('https://api.appstoreconnect.apple.com/v1/apps?limit=50', {
        headers: { Authorization: 'Bearer ' + tok }
      })
      if (!r.ok) return []
      const j = (await r.json()) as {
        data?: { attributes?: { name?: string; bundleId?: string } }[]
      }
      return (j.data ?? []).map((d) => ({
        name: d.attributes?.name ?? '',
        bundleId: d.attributes?.bundleId ?? ''
      }))
    }
  )
  ipcMain.handle('launch:fetchIcon', async (_e, file: string): Promise<boolean> => {
    return await fetchAppIcon(file)
  })
  ipcMain.handle('launch:lastSa', (): string => (readState().lastGoogleSa as string) ?? '')
  // 앱별 출시 여정 진행 상태 — 시트에 저장 (며칠 걸리는 여정의 이어하기)
  ipcMain.handle('launch:getJourney', (_e, file: string): { registered: boolean } => {
    try {
      const sheet = JSON.parse(readFileSync(join(ANSWERS_DIR, file), 'utf8'))
      return { registered: !!sheet.journey?.registered }
    } catch {
      return { registered: false }
    }
  })
  ipcMain.handle(
    'launch:setJourney',
    (_e, file: string, registered: boolean): { registered: boolean } => {
      const path = join(ANSWERS_DIR, file)
      const sheet = JSON.parse(readFileSync(path, 'utf8'))
      sheet.journey = { ...(sheet.journey ?? {}), registered }
      writeFileSync(path, JSON.stringify(sheet, null, 2))
      return { registered }
    }
  )
  ipcMain.handle('launch:sheetIap', (_e, file: string): SheetIapInfo => {
    const sheet = JSON.parse(readFileSync(join(ANSWERS_DIR, file), 'utf8'))
    interface RawIap {
      productId?: string
      listings?: Record<string, { title?: string }>
      price?: Record<string, string>
      currency?: Record<string, string>
    }
    const products = ((sheet.iap ?? []) as RawIap[]).map((p) => {
      const firstListing = Object.values(p.listings ?? {})[0]
      const [region, units] = Object.entries(p.price ?? {})[0] ?? []
      return {
        productId: p.productId ?? '',
        title: firstListing?.title ?? '',
        priceLabel: region ? `${units} ${p.currency?.[region] ?? region}` : ''
      }
    })
    return { packageName: sheet.app?.packageName ?? '', products }
  })
  // 검증된 CLI 실행 — 스크립트는 화이트리스트 고정, 인자는 시트에서 main이 직접 구성
  ipcMain.handle(
    'launch:runIap',
    async (_e, file: string, action: 'upsert' | 'activate'): Promise<RunResult> => {
      const sheet = JSON.parse(readFileSync(join(ANSWERS_DIR, file), 'utf8'))
      const saPath = resolveGoogleSa(sheet)
      if (!saPath) return { ok: false, output: 'google-sa-missing' }
      const script = join(
        app.getAppPath(),
        'launch',
        'scripts',
        'google',
        action === 'upsert' ? 'otp-upsert.js' : 'otp-activate.js'
      )
      const answersPath = join(ANSWERS_DIR, file)
      return await new Promise<RunResult>((resolve) => {
        execFile(
          process.execPath,
          [script, '--sa', saPath, '--answers', answersPath],
          { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, timeout: 60_000 },
          (err, stdout, stderr) => {
            let parsed: unknown = null
            try {
              parsed = JSON.parse(stdout)
            } catch {
              /* 원문 유지 */
            }
            const okFlag =
              parsed !== null && typeof parsed === 'object' && 'ok' in (parsed as object)
                ? Boolean((parsed as { ok: unknown }).ok)
                : !err
            resolve({
              ok: !err && okFlag,
              output: parsed ?? stdout.slice(0, 4000),
              stderr: stderr ? stderr.slice(0, 2000) : undefined
            })
          }
        )
      })
    }
  )
  ipcMain.handle('launch:getDevAccounts', (): DevAccounts => {
    return (readState().devAccounts as DevAccounts) ?? {}
  })
  ipcMain.handle(
    'launch:setDevAccount',
    (_e, store: StoreKind, info: DevAccountState): DevAccounts => {
      const state = readState()
      const storeApp = store === 'play' ? 'play-console' : 'app-store-connect'
      const prev = ((state.devAccounts as DevAccounts) ?? {})[store]
      // 이메일이 바뀌거나 제거되면 이전 계정의 연결을 정리 (오타 계정 잔존 방지)
      if (prev?.email && prev.email !== info.email) {
        unlinkStoreFromAccount(prev.email, storeApp)
      }
      const devAccounts = { ...((state.devAccounts as DevAccounts) ?? {}), [store]: info }
      writeState({ ...state, devAccounts })
      // "있음" + 이메일 입력 시 계정 인벤토리에 자동 등록·연동 (모듈 1 → 모듈 2)
      if (info.status === 'yes' && info.email) {
        upsertAccount(info.email, { apps: [storeApp] })
      }
      return devAccounts
    }
  )
  ipcMain.handle('accounts:list', (): Account[] => readAccounts())
  ipcMain.handle('accounts:add', (_e, email: string, memo: string, apps: string[]): Account[] => {
    return upsertAccount(email, { memo, apps })
  })
  // 계정 삭제 — 저장된 비밀번호가 있으면 인증 필요(파괴적), 해당 이메일의 암호문도 함께 정리
  ipcMain.handle('accounts:delete', async (_e, id: string): Promise<Account[]> => {
    const accounts = readAccounts()
    const account = accounts.find((a) => a.id === id)
    if (!account) return accounts
    const secrets = readSecrets()
    const keys = Object.keys(secrets).filter((k) => k.startsWith(account.email + '::'))
    if (keys.length > 0) {
      await biometricGate(`${account.email} ${mainMsg('deleteAccount')}`)
      keys.forEach((k) => delete secrets[k])
      writeSecrets(secrets)
    }
    const remaining = accounts.filter((a) => a.id !== id)
    writeAccounts(remaining)
    return remaining
  })
  ipcMain.handle('accounts:setMemo', (_e, id: string, memo: string): Account[] => {
    const accounts = readAccounts()
    const account = accounts.find((a) => a.id === id)
    if (account) {
      account.memo = memo
      account.updatedAt = new Date().toISOString()
      writeAccounts(accounts)
    }
    return accounts
  })
  ipcMain.handle('accounts:setApps', (_e, id: string, apps: string[]): Account[] => {
    const accounts = readAccounts()
    const account = accounts.find((a) => a.id === id)
    if (account) {
      account.apps = apps
      account.updatedAt = new Date().toISOString()
      writeAccounts(accounts)
    }
    return accounts
  })

  // 비밀번호 저장/조회 — 전부 로컬, 네트워크 없음
  ipcMain.handle('secrets:list', (_e, email: string): string[] => {
    const prefix = email + '::'
    return Object.keys(readSecrets())
      .filter((k) => k.startsWith(prefix))
      .map((k) => k.slice(prefix.length))
  })
  ipcMain.handle(
    'secrets:set',
    async (_e, email: string, appId: string, password: string): Promise<boolean> => {
      if (!safeStorage.isEncryptionAvailable()) return false
      const secrets = readSecrets()
      const exists = secretKey(email, appId) in secrets
      // 첫 저장은 무인증(기존 비밀을 건드리지 않음), 변경은 파괴적이므로 인증 필요
      if (exists) {
        try {
          await biometricGate(`${email} · ${appId} ${mainMsg('update')}`)
        } catch (e) {
          logAccess({ email, appId, action: 'update', ok: false })
          throw e
        }
      }
      secrets[secretKey(email, appId)] = {
        v: safeStorage.encryptString(password).toString('base64'),
        updatedAt: new Date().toISOString()
      }
      writeSecrets(secrets)
      logAccess({ email, appId, action: exists ? 'update' : 'save', ok: true })
      return true
    }
  )
  ipcMain.handle('secrets:reveal', async (_e, email: string, appId: string): Promise<string | null> => {
    try {
      // 평문 표시는 세션 무시, 항상 재인증
      await biometricGateStrict(`${email} · ${appId} ${mainMsg('reveal')}`)
    } catch (e) {
      logAccess({ email, appId, action: 'reveal', ok: false })
      throw e
    }
    logAccess({ email, appId, action: 'reveal', ok: true })
    return decryptSecret(email, appId)
  })
  ipcMain.handle('secrets:copy', async (_e, email: string, appId: string): Promise<boolean> => {
    try {
      await biometricGate(`${email} · ${appId} ${mainMsg('copy')}`)
    } catch (e) {
      logAccess({ email, appId, action: 'copy', ok: false })
      throw e
    }
    const value = decryptSecret(email, appId)
    if (value === null) return false
    logAccess({ email, appId, action: 'copy', ok: true })
    clipboard.writeText(value)
    setTimeout(() => {
      if (clipboard.readText() === value) clipboard.clear()
    }, 30_000)
    return true
  })
  ipcMain.handle('secrets:lockState', (): LockState => {
    const remainingMs = Math.max(0, unlockedUntil - Date.now())
    return { unlocked: remainingMs > 0, remainingMs }
  })
  ipcMain.handle('secrets:lock', (): void => lockSecrets())
  ipcMain.handle('secrets:accessLog', (_e, email?: string, appId?: string): AccessLogEntry[] => {
    try {
      let log = JSON.parse(readFileSync(accessLogFile(), 'utf8')) as AccessLogEntry[]
      if (email) log = log.filter((x) => x.email === email)
      if (appId) log = log.filter((x) => x.appId === appId)
      return log.slice(-30).reverse()
    } catch {
      return []
    }
  })
  ipcMain.handle('secrets:updatedAt', (_e, email: string, appId: string): string | null => {
    return readSecrets()[secretKey(email, appId)]?.updatedAt || null
  })
  ipcMain.handle(
    'secrets:securityStatus',
    (): { biometry: boolean; secretCount: number; secretsPath: string } => ({
      biometry: process.platform === 'darwin' && systemPreferences.canPromptTouchID(),
      secretCount: Object.keys(readSecrets()).length,
      secretsPath: secretsFile()
    })
  )
  // 기기의 비밀번호 관리자로 안내 — 검색어(도메인)를 클립보드에 복사하고 해당 창을 연다.
  // Chrome/암호 앱 모두 검색어 주입 딥링크가 없어서 "복사 + 열기"가 최선 (2026-07-22 실기기 검증).
  ipcMain.handle(
    'secrets:locate',
    (_e, appId: string, target: 'chrome' | 'keychain'): string => {
      const term = PLATFORM_DOMAINS[appId] ?? appId
      clipboard.writeText(term)
      if (target === 'chrome') {
        execFile('open', ['-a', 'Google Chrome', 'chrome://password-manager/passwords'])
      } else {
        execFile('open', ['-a', 'Passwords'], (err) => {
          if (err) execFile('open', ['x-apple.systempreferences:com.apple.Passwords-Settings.extension'])
        })
      }
      return term
    }
  )
  ipcMain.handle('secrets:delete', async (_e, email: string, appId: string): Promise<boolean> => {
    try {
      await biometricGate(`${email} · ${appId} ${mainMsg('delete')}`)
    } catch (e) {
      logAccess({ email, appId, action: 'delete', ok: false })
      throw e
    }
    const secrets = readSecrets()
    delete secrets[secretKey(email, appId)]
    writeSecrets(secrets)
    logAccess({ email, appId, action: 'delete', ok: true })
    return true
  })
  ipcMain.handle('launch:openExternal', (_e, url: string) => {
    if (url.startsWith('https://')) shell.openExternal(url)
  })

  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
