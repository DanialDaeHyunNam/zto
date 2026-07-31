import {
  app,
  shell,
  BrowserWindow,
  clipboard,
  dialog,
  ipcMain,
  nativeImage,
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
import {
  imageInfo,
  PLAY_IMAGE_SPECS,
  replaceAscScreenshots,
  replacePlayImages,
  validateAscScreenshot,
  validatePlayImage
} from './store-assets'
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
  ASC_EDITABLE_VERSION_STATES,
  isEditableNoteTrack,
  parseIapFieldKey,
  parseNoteFieldKey,
  type LockState,
  type MetaListing,
  type PendingEdit,
  type PlayReleaseRow,
  type RunResult,
  type SheetIapInfo,
  type StoreKind,
  type StoreSnapshotEntry
} from '../shared/launch-types'

// ---------- 패키징 경로 ----------
// 개발과 배포에서 파일이 사는 곳이 다르다. 이걸 안 나누면 패키징한 앱이 **조용히** 망가진다:
//  ① 스크립트·설문은 asar 안으로 들어가는데, 스크립트는 별도 프로세스로 실행되므로
//     asar 밖(extraResources)에 있어야 한다 → `resourceDir()`
//  ② 답안 시트는 **쓰기** 대상이다. 앱 번들 안은 서명이 걸려 있어 macOS가 쓰기를 막으므로
//     반드시 userData로 간다 → `ANSWERS_DIR`
const resourceDir = (): string =>
  app.isPackaged ? join(process.resourcesPath, 'launch') : join(app.getAppPath(), 'launch')
const launchScript = (...seg: string[]): string => join(resourceDir(), 'scripts', ...seg)

const ANSWERS_DIR = app.isPackaged
  ? join(app.getPath('userData'), 'answers')
  : join(app.getAppPath(), 'launch', 'answers')

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
  // **2026-07-31 재검토 — 앞선 판단(Luna 제외)이 뒤집혔다.**
  // 7/29엔 Luna가 $1/$6이라 mini($0.75/$4.50)보다 비쌌고, 그래서 뺐다. 그런데 7/30 OpenAI가
  // Luna를 80% 인하($0.20/$1.20)해 **mini보다 3.75배 싸졌다**. 세대도 5.6으로 위다.
  // 가격이 근거였던 결정은 가격이 바뀌면 다시 봐야 한다 — 결정을 적어둔 덕에 무엇이 무효인지 알 수 있었다.
  //
  // Luna 기본: mini보다 싸고 새롭다. nano는 **제거** — Luna가 입력 동가($0.20)에 출력이 더 싸고
  // (nano $1.25 vs Luna $1.20) 세대가 위라, nano를 고를 이유가 남지 않는다.
  // Terra 추가: 소셜 카피라이팅처럼 문장 품질이 결과를 가르는 자리용. 실측상 이걸 써도
  // 월 원가가 몇 달러 수준이라(사용량 대시보드 데이터 기준) 품질을 아낄 이유가 없다.
  chatgpt: [
    { id: 'gpt-5.6-luna', label: 'GPT-5.6 Luna' },
    { id: 'gpt-5.6-terra', label: 'GPT-5.6 Terra (고품질)' },
    { id: 'gpt-5.4-mini', label: 'GPT-5.4 mini' }
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
// $/1M 토큰. 2026-07-30 인하 반영(Luna·Terra 80%↓). 옛 사용 기록은 저장 시점의 costUsd를
// 그대로 쓰므로 이 표를 고쳐도 과거 금액이 바뀌지 않는다 — 지난 달 청구서가 소급 변경되면 안 된다.
const OPENAI_PRICE: Record<string, { in: number; out: number }> = {
  'gpt-5.6-luna': { in: 0.2, out: 1.2 },
  'gpt-5.6-terra': { in: 2.0, out: 12.0 },
  'gpt-5.6-sol': { in: 5.0, out: 30.0 },
  // 목록에서 뺐어도 표에는 남긴다 — 예전에 이 모델로 부른 기록의 환산가를 계속 계산해야 한다
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
// 이미지는 보내기 전에 이 크기로 줄인다 — 콘솔·소셜 화면을 읽는 데 원본 해상도가 필요 없다
const IMAGE_MAX_EDGE = 1024
// 이미지가 붙었을 때 피할 고단가 모델 → 대신 쓸 모델
const IMAGE_HEAVY_MODELS = ['gpt-5.6-terra', 'gpt-5.6-sol']
const IMAGE_FALLBACK_MODEL = 'gpt-5.6-luna'

const openAiSessions = new Map<string, unknown[]>()
const OPENAI_MAX_MESSAGES = 24 // 이력 폭주 방지 — 오래된 턴부터 버린다

interface OpenAiPart {
  type: string
  text?: string
}
// 이력용 — input_image 파트를 자리표시자 텍스트로 바꾼다(다음 턴에 재전송되지 않게)
function stripImages(msg: unknown): unknown {
  const m = msg as { role?: string; content?: { type?: string }[] }
  if (!Array.isArray(m?.content)) return msg
  if (!m.content.some((c) => c?.type === 'input_image')) return msg
  return {
    ...m,
    content: m.content.map((c) =>
      c?.type === 'input_image' ? { type: 'input_text', text: '[이 턴에 화면 이미지 첨부됨]' } : c
    )
  }
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
    // **이력에는 이미지를 남기지 않는다.** Responses API는 무상태라 매 턴 이력을 통째로 다시
    // 보내는데, 이미지가 남아 있으면 한 장이 창(24메시지) 동안 계속 재청구된다 — 붙인 장수가
    // 아니라 이 곱셈이 비용을 지배한다. 자리표시자를 남겨 "그때 화면을 봤다"는 사실은 유지한다.
    openAiSessions.set(sid, next.slice(-OPENAI_MAX_MESSAGES).map(stripImages))
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
  const tokenScript = launchScript('google', 'token.js')
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
  const script = launchScript('apple', 'asc-token.js')
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

// 구독 주기를 ISO 8601 기간 토큰으로 모은다. Play는 이미 ISO(`P1M`)를 주고, ASC는 열거형
// (`ONE_MONTH`)을 준다. 렌더러 사전이 이 토큰을 사람 말로 바꾼다.
const ASC_PERIOD: Record<string, string> = {
  ONE_WEEK: 'P1W',
  ONE_MONTH: 'P1M',
  TWO_MONTHS: 'P2M',
  THREE_MONTHS: 'P3M',
  SIX_MONTHS: 'P6M',
  ONE_YEAR: 'P1Y'
}
function normalizePeriod(raw?: string): string | undefined {
  if (!raw) return undefined
  return ASC_PERIOD[raw] ?? raw
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

  // 구독 주기 표기가 스토어마다 다르다: Play는 ISO 8601 기간(`P1M`), ASC는 열거형(`ONE_MONTH`).
  // 여기서 **ISO 토큰 하나로 모으고**, 사람이 읽는 말로 바꾸는 건 렌더러 사전에 맡긴다
  // (i18n 원칙 — 화면 문자열은 컴포넌트·main이 아니라 사전에서 나온다).
  // 모르는 값은 원문 그대로 흘려보낸다: 못 알아본 걸 감추기보다 보여주는 쪽이 진단이 된다.
  // IAP는 **두 리소스를 다 불러야** 한다 — Play는 2023년 상품 모델을 쪼개면서 일회성과 구독이
  // 서로 다른 엔드포인트가 됐고, 한쪽만 부르면 구독만 파는 앱이 "IAP 없음"으로 보인다.
  const iap: LiveIapProduct[] = []
  const [iapR, subR] = await Promise.all([
    fetch(`${base}/oneTimeProducts`, { headers }),
    fetch(`${base}/subscriptions?pageSize=100`, { headers })
  ])
  if (iapR.ok) {
    interface GConfig {
      regionCode?: string
      price?: { units?: string; currencyCode?: string }
    }
    interface GProduct {
      productId?: string
      listings?: { languageCode?: string; title?: string; description?: string }[]
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
          : undefined,
        kind: 'onetime',
        productId: p.productId ?? '',
        // 편집이 listings 배열을 통째로 덮어쓰므로 **전 로케일**을 읽어둔다
        listings: (p.listings ?? [])
          .filter((l) => l.languageCode)
          .map((l) => ({
            locale: l.languageCode ?? '',
            title: l.title ?? '',
            description: l.description ?? ''
          }))
      })
    }
  }
  // 구독 — 상품 하나가 기본 요금제(basePlan) 여럿을 가질 수 있다(월·연). 요금제마다 상태·가격·주기가
  // 따로 놀아서 **요금제를 행으로 편다** — 상품만 보여주면 "월간은 살아있고 연간은 초안"이 사라진다.
  if (subR.ok) {
    interface SubRegional {
      regionCode?: string
      price?: { units?: string; nanos?: number; currencyCode?: string }
    }
    interface SubBasePlan {
      basePlanId?: string
      state?: string
      regionalConfigs?: SubRegional[]
      autoRenewingBasePlanType?: { billingPeriodDuration?: string }
      prepaidBasePlanType?: { billingPeriodDuration?: string }
    }
    interface SubProduct {
      productId?: string
      basePlans?: SubBasePlan[]
      listings?: { languageCode?: string; title?: string }[]
      archived?: boolean
    }
    const j = (await jsonOrEmpty(subR)) as { subscriptions?: SubProduct[] }
    for (const s of j.subscriptions ?? []) {
      const ls = s.listings ?? []
      const title = (ls.find((l) => l.languageCode?.startsWith('ko')) ?? ls[0])?.title ?? ''
      const plans = s.basePlans ?? []
      // 요금제가 없는 상품(초안)도 존재를 알려야 한다 — 빈 배열이면 상품 한 줄로 낸다
      if (plans.length === 0) {
        iap.push({
          id: s.productId ?? '',
          title,
          state: s.archived ? 'ARCHIVED' : 'DRAFT',
          kind: 'subscription'
        })
        continue
      }
      for (const bp of plans) {
        const cfgs = bp.regionalConfigs ?? []
        const cfg = cfgs.find((c) => c.regionCode === 'KR') ?? cfgs[0]
        iap.push({
          id: bp.basePlanId ? `${s.productId ?? ''} · ${bp.basePlanId}` : (s.productId ?? ''),
          title,
          state: s.archived ? 'ARCHIVED' : (bp.state ?? ''),
          priceLabel: cfg?.price?.units
            ? `${cfg.price.units} ${cfg.price.currencyCode ?? ''} · ${cfg.regionCode ?? ''}`
            : undefined,
          kind: 'subscription',
          period: normalizePeriod(
            bp.autoRenewingBasePlanType?.billingPeriodDuration ??
              bp.prepaidBasePlanType?.billingPeriodDuration
          )
        })
      }
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

  // 구독(subR)은 앱 바로 밑이 아니라 **구독 그룹 아래**에 있다 — `inAppPurchasesV2`에는 절대
  // 안 섞이므로 따로 부른다. `include=subscriptions`로 그룹·구독을 한 번에 받는다.
  const [versR, infoR, iapR, subR] = await Promise.all([
    fetch(
      `${A}/apps/${appId}/appStoreVersions?limit=10&fields%5BappStoreVersions%5D=versionString,appStoreState,createdDate`,
      { headers }
    ),
    fetch(`${A}/apps/${appId}/appInfos?include=primaryCategory`, { headers }),
    fetch(`${A}/apps/${appId}/inAppPurchasesV2?limit=50`, { headers }),
    fetch(`${A}/apps/${appId}/subscriptionGroups?include=subscriptions&limit=50`, { headers })
  ])

  const versions: AscVersionRow[] = []
  const screenshots: { type: string; urls: string[] }[] = []
  let shotLocale = '' // 스크린샷을 읽어온 대표 로케일 — 편집이 이 로케일에만 적용된다
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
        if (!locR.ok) return { ...row, note: '', repLocId: '', repLocale: '' }
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
        return {
          ...row,
          note: rep?.attributes?.whatsNew ?? '',
          repLocId: rep?.id ?? '',
          repLocale: rep?.attributes?.locale ?? ''
        }
      })
    )
    // 스크린샷 — 최신 버전의 대표 로케일에 올라간 세트(디스플레이 타입별).
    // 편집이 이 로케일에만 적용되므로 어느 로케일이었는지 화면까지 실어 보낸다(Play `imageLocale`과 같은 이유)
    const repLocId = withNotes[0]?.repLocId
    shotLocale = withNotes[0]?.repLocale ?? ''
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
      data?: { id: string; attributes?: { productId?: string; name?: string; state?: string } }[]
    }
    const rows = (j.data ?? []).filter((d) => d.attributes?.productId)
    // 로케일별 이름·설명은 별도 리소스다. ⚠️ 경로가 **`/v2/inAppPurchases/{id}/...`** — v1로
    // 부르면 "relationship does not exist" 404다(2026-07-31 실측). `include=`도 안 먹혔다.
    const locs = await Promise.all(
      rows.map((d) =>
        fetch(`${A.replace('/v1', '/v2')}/inAppPurchases/${d.id}/inAppPurchaseLocalizations`, {
          headers
        })
          .then((r) => (r.ok ? r.json() : null))
          .catch(() => null)
      )
    )
    for (let i = 0; i < rows.length; i++) {
      const d = rows[i]
      const lJ = locs[i] as {
        data?: { attributes?: { locale?: string; name?: string; description?: string } }[]
      } | null
      iap.push({
        id: d.attributes?.productId ?? '',
        title: d.attributes?.name ?? '',
        state: d.attributes?.state ?? '',
        kind: 'onetime',
        productId: d.attributes?.productId ?? '',
        listings: (lJ?.data ?? [])
          .filter((l) => l.attributes?.locale)
          .map((l) => ({
            locale: l.attributes?.locale ?? '',
            title: l.attributes?.name ?? '',
            description: l.attributes?.description ?? ''
          }))
      })
    }
  }
  // 구독 — 그룹 응답의 `included`에 구독이 실려 온다. 가격은 또 별도 리소스(subscriptionPrices)라
  // 여기선 주기까지만 낸다: 있는 것을 못 보여주는 문제부터 없애고, 가격은 필요해지면 붙인다.
  if (subR.ok) {
    const j = (await subR.json()) as {
      included?: {
        type?: string
        attributes?: { productId?: string; name?: string; state?: string; subscriptionPeriod?: string }
      }[]
    }
    for (const inc of j.included ?? []) {
      if (inc.type !== 'subscriptions') continue
      iap.push({
        id: inc.attributes?.productId ?? '',
        title: inc.attributes?.name ?? '',
        state: inc.attributes?.state ?? '',
        kind: 'subscription',
        period: normalizePeriod(inc.attributes?.subscriptionPeriod)
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

  return {
    data: { appId, versions, meta, releaseNotes, category, ageRating, screenshots, shotLocale, iap }
  }
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

  // 릴리스 노트는 **트랙에 따라** 갈린다: 테스트 트랙은 여기서 쓰고, 프로덕션은 콘솔로 보낸다
  // (라이브 사용자에게 바로 나가고 롤아웃 중이면 위험하다). 판정 규칙은 shared에 있어
  // 화면이 "편집 가능"이라고 보여준 것과 여기서 실제로 되는 것이 어긋나지 않는다.
  const allNoteEdits = edits.filter((e) => e.section === 'releaseNotes')
  const noteEdits = allNoteEdits.filter((e) => {
    const t = parseNoteFieldKey(e.field)
    return t && isEditableNoteTrack(t.track)
  })
  const noteResults: ApplyResult[] = errored(
    allNoteEdits.filter((e) => !noteEdits.includes(e)),
    ko ? '프로덕션 릴리스 노트는 콘솔에서' : 'Production release notes: use the console'
  )
  // IAP는 edit 트랜잭션 밖이다 — 상품 API(`oneTimeProducts`)는 리스팅 edit과 무관하게 즉시 반영된다.
  // 그래서 메타·자산의 원자적 커밋에 섞지 않고 **따로** 처리한다(섞으면 롤백 범위가 거짓말이 된다).
  const iapResults = await applyPlayIapEdits(
    sheet,
    edits.filter((e) => e.section === 'iap')
  )
  const metaEdits = edits.filter((e) => e.section === 'meta')
  // 자산은 메타와 **같은 edit 안에서** 처리한다 — commit 하나로 같이 원자적으로 반영된다.
  // (id = `android:assets:{locale}:{imageType}`, newValue = 파일 경로들을 개행으로 이은 것)
  const assetEdits = edits.filter((e) => e.section === 'assets')
  if (metaEdits.length === 0 && assetEdits.length === 0 && noteEdits.length === 0)
    return [...noteResults, ...iapResults]
  // 셋 다 같은 edit 트랜잭션 안에서 처리된다 → 커밋 하나로 원자적, 실패 시 함께 롤백
  const writeEdits = [...metaEdits, ...assetEdits, ...noteEdits]

  const saPath = resolveGoogleSa(sheet)
  if (!saPath) return [...noteResults, ...iapResults, ...errored(writeEdits, ko ? '구글 인증 키 없음' : 'No Google key')]
  const tok = await googleTokenFor(saPath)
  if (!tok) return [...noteResults, ...iapResults, ...errored(writeEdits, ko ? '토큰 발급 실패' : 'Token failed')]
  const base = `https://androidpublisher.googleapis.com/androidpublisher/v3/applications/${encodeURIComponent(sheet.app.packageName)}`
  const headers = { Authorization: 'Bearer ' + tok, 'Content-Type': 'application/json' }

  const editR = await fetch(`${base}/edits`, { method: 'POST', headers, body: '{}' })
  if (!editR.ok) return [...noteResults, ...iapResults, ...errored(writeEdits, `HTTP ${editR.status}`)]
  const editId = ((await editR.json()) as { id?: string }).id
  if (!editId) return [...noteResults, ...iapResults, ...errored(writeEdits, ko ? 'edit 생성 실패' : 'edit create failed')]

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

    // 릴리스 노트 — 트랙별로 현재 릴리스를 읽어 해당 로케일만 갈아끼우고 트랙을 다시 PUT한다.
    // versionCodes·status·userFraction을 그대로 다시 실어 보내는 게 핵심이다: 일부만 보내면
    // 롤아웃 비율이나 버전 목록이 날아간다(트랙 PUT은 병합이 아니라 교체다).
    const byTrack = new Map<string, PendingEdit[]>()
    for (const e of noteEdits) {
      const t = parseNoteFieldKey(e.field)
      if (!t) {
        writeErr.set(e.id, ko ? '트랙을 알 수 없음' : 'Unknown track')
        continue
      }
      const arr = byTrack.get(t.track) ?? []
      arr.push(e)
      byTrack.set(t.track, arr)
    }
    for (const [track, group] of byTrack) {
      const tR = await fetch(`${base}/edits/${editId}/tracks/${encodeURIComponent(track)}`, {
        headers
      })
      if (!tR.ok) {
        for (const e of group) writeErr.set(e.id, `track ${track}: HTTP ${tR.status}`)
        continue
      }
      const tJ = (await jsonOrEmpty(tR)) as {
        releases?: {
          status?: string
          releaseNotes?: { language?: string; text?: string }[]
          [k: string]: unknown
        }[]
      }
      const releases = tJ.releases ?? []
      // 롤아웃 중이면 릴리스가 둘일 수 있다 — 어느 쪽인지 우리가 고르면 틀릴 수 있으므로 넘긴다
      if (releases.length !== 1) {
        for (const e of group) {
          writeErr.set(
            e.id,
            releases.length === 0
              ? ko
                ? `${track} 트랙에 릴리스가 없음`
                : `No release in ${track}`
              : ko
                ? `${track} 트랙에 릴리스가 여러 개 — 콘솔에서 수정하세요`
                : `Multiple releases in ${track} — edit in the console`
          )
        }
        continue
      }
      const rel = releases[0]
      const notes = [...(rel.releaseNotes ?? [])]
      for (const e of group) {
        const row = notes.find((n) => n.language === e.locale)
        if (row) row.text = e.newValue
        else notes.push({ language: e.locale, text: e.newValue })
      }
      const putR = await fetch(`${base}/edits/${editId}/tracks/${encodeURIComponent(track)}`, {
        method: 'PUT',
        headers,
        body: JSON.stringify({ track, releases: [{ ...rel, releaseNotes: notes }] })
      })
      if (!putR.ok) for (const e of group) writeErr.set(e.id, `track ${track}: HTTP ${putR.status}`)
    }

    if (writeErr.size > 0) {
      // 원자적 — 하나라도 실패하면 edit 폐기(전체 롤백)
      await fetch(`${base}/edits/${editId}`, { method: 'DELETE', headers }).catch(() => {})
      return [
        ...noteResults,
        ...iapResults,
        ...writeEdits.map((e) => ({
          id: e.id,
          ok: false,
          message: writeErr.get(e.id) ?? (ko ? '다른 항목 실패로 함께 롤백됨' : 'Rolled back (atomic)')
        }))
      ]
    }
    const commitR = await fetch(`${base}/edits/${editId}:commit`, { method: 'POST', headers })
    if (!commitR.ok) {
      return [...noteResults, ...iapResults, ...errored(writeEdits, (ko ? '커밋 실패 HTTP ' : 'Commit failed HTTP ') + commitR.status)]
    }
    return [...noteResults, ...iapResults, ...applied(writeEdits)]
  } catch (err) {
    await fetch(`${base}/edits/${editId}`, { method: 'DELETE', headers }).catch(() => {})
    return [...noteResults, ...iapResults, ...errored(writeEdits, String(err).slice(0, 120))]
  }
}

// Play 상품 API가 요구하는 지역 목록 버전. `launch/scripts/google/otp-upsert.js`와 같은 값을
// 쓴다 — 구글이 지역을 추가하면 이 값을 올려야 하고, 두 곳이 어긋나면 한쪽만 실패한다
const PLAY_REGIONS_VERSION = '2025/01'

// ---------- Play IAP 편집 (일회성 상품의 로케일별 제목·설명) ----------
// 가격·상태·구독은 **여기서 다루지 않는다**: 가격은 지역 173개를 통째로 실어 보내야 하는데
// 우리는 대표 지역 하나만 읽고, 구독 가격은 기존 구독자에게 영향이 가 동의 절차가 따로다.
// 읽은 것보다 넓게 쓰지 않는다 — 그게 이 화면이 지킬 수 있는 약속의 경계다.
async function applyPlayIapEdits(
  sheet: { app: { packageName: string }; credentials?: { googleSa?: string } },
  edits: PendingEdit[]
): Promise<ApplyResult[]> {
  if (edits.length === 0) return []
  const ko = appLocale === 'ko'
  const errored = (msg: string): ApplyResult[] =>
    edits.map((e) => ({ id: e.id, ok: false, message: msg }))

  const saPath = resolveGoogleSa(sheet)
  if (!saPath) return errored(ko ? '구글 인증 키 없음' : 'No Google key')
  const tok = await googleTokenFor(saPath)
  if (!tok) return errored(ko ? '토큰 발급 실패' : 'Token failed')
  const pkg = sheet.app.packageName
  const base = `https://androidpublisher.googleapis.com/androidpublisher/v3/applications/${encodeURIComponent(pkg)}`
  const headers = { Authorization: 'Bearer ' + tok, 'Content-Type': 'application/json' }

  // 현재 상품을 먼저 읽는다 — listings는 **배열 통째 교체**라 안 건드릴 로케일까지 다시 실어야 한다
  const curR = await fetch(`${base}/oneTimeProducts`, { headers })
  if (!curR.ok) return errored(`HTTP ${curR.status}`)
  const curJ = (await jsonOrEmpty(curR)) as {
    oneTimeProducts?: {
      productId?: string
      listings?: { languageCode?: string; title?: string; description?: string }[]
    }[]
  }
  const byId = new Map((curJ.oneTimeProducts ?? []).map((p) => [p.productId ?? '', p]))

  // (상품 × 로케일 × 필드) 편집을 상품 단위로 모은다 — batchUpdate가 상품 하나를 한 요청으로 받는다
  const results: ApplyResult[] = []
  const byProduct = new Map<string, PendingEdit[]>()
  for (const e of edits) {
    const parsed = parseIapFieldKey(e.field)
    if (!parsed) {
      results.push({ id: e.id, ok: false, message: ko ? '지원하지 않는 필드' : 'Unsupported field' })
      continue
    }
    const arr = byProduct.get(parsed.productId) ?? []
    arr.push(e)
    byProduct.set(parsed.productId, arr)
  }

  for (const [productId, group] of byProduct) {
    const cur = byId.get(productId)
    if (!cur) {
      for (const e of group)
        results.push({ id: e.id, ok: false, message: ko ? '상품을 찾을 수 없음' : 'Product not found' })
      continue
    }
    const listings = (cur.listings ?? []).map((l) => ({
      languageCode: l.languageCode ?? '',
      title: l.title ?? '',
      description: l.description ?? ''
    }))
    for (const e of group) {
      const parsed = parseIapFieldKey(e.field)
      if (!parsed) continue
      let row = listings.find((l) => l.languageCode === e.locale)
      if (!row) {
        // 그 로케일 리스팅이 아직 없으면 만든다 — 새 언어를 추가하는 경우다
        row = { languageCode: e.locale, title: '', description: '' }
        listings.push(row)
      }
      if (parsed.field === 'title') row.title = e.newValue
      else row.description = e.newValue
    }
    // updateMask를 `listings`로 좁혀 **가격·가용성(purchaseOptions)은 손대지 않는다**.
    // allowMissing은 false — 상품 id가 틀렸을 때 유령 상품이 생기는 대신 실패해야 한다.
    const r = await fetch(`${base}/oneTimeProducts:batchUpdate`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        requests: [
          {
            oneTimeProduct: { packageName: pkg, productId, listings },
            updateMask: 'listings',
            allowMissing: false,
            regionsVersion: { version: PLAY_REGIONS_VERSION }
          }
        ]
      })
    })
    if (r.ok) {
      for (const e of group) results.push({ id: e.id, ok: true, message: ko ? '반영됨' : 'Applied' })
    } else {
      const body = (await jsonOrEmpty(r)) as { error?: { message?: string } }
      const msg = (body.error?.message ?? `HTTP ${r.status}`).slice(0, 160)
      for (const e of group) results.push({ id: e.id, ok: false, message: msg })
    }
  }
  return results
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
  // 자산·IAP는 필드명 표로 못 가른다(자산=기기 타입, IAP=상품id::필드) — 섹션으로 먼저 가른다
  const assetEdits = edits.filter((e) => e.section === 'assets')
  const iapEdits = edits.filter((e) => e.section === 'iap')
  const plain = edits.filter((e) => e.section !== 'assets' && e.section !== 'iap')
  const appInfoEdits = plain.filter((e) => e.field in APP_INFO_FIELDS)
  const versionEdits = plain.filter((e) => e.field in VERSION_FIELDS)
  for (const e of plain) {
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
      // 라이브 버전이라 거부당한 경우(ASC가 "current state"로 알려준다) → 잠금 해제 제안 대상
      const code = !r.ok && /current state/i.test(message) ? ('version-locked' as const) : undefined
      for (const e of es) results.push({ id: e.id, ok: r.ok, message, code })
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

  // ---- 편집 가능한 버전 찾기 ----
  // 버전 종속 메타(description 등)와 스크린샷이 **같은 관문**을 지난다: 라이브(READY_FOR_SALE)
  // 버전에는 둘 다 못 쓴다. 판정이 두 벌이면 언젠가 어긋나므로 한 곳에 두고, 결과를 캐시해
  // 메타·자산을 함께 적용할 때 같은 조회를 두 번 하지 않는다.
  type VerLookup =
    | { ok: true; id: string }
    | { ok: false; message: string; code?: 'version-locked' }
  let verCache: VerLookup | null = null
  const editableVersion = async (): Promise<VerLookup> => {
    if (verCache) return verCache
    const versR = await fetch(
      `${A}/apps/${appId}/appStoreVersions?limit=10&fields%5BappStoreVersions%5D=versionString,appStoreState,createdDate`,
      { headers }
    )
    if (!versR.ok) return (verCache = { ok: false, message: `HTTP ${versR.status}` })
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
      // 편집 가능한 버전이 아예 없다 = 라이브뿐이다 → 화면이 "새 버전 만들어 반영"을 제안한다
      return (verCache = {
        ok: false,
        message: ko
          ? '편집 가능한 버전 없음 (새 버전이 필요해요)'
          : 'No editable version (a new version is needed)',
        code: 'version-locked'
      })
    }
    return (verCache = { ok: true, id: editable.id })
  }
  // 버전 로컬라이제이션 id (로케일 → id). 메타·자산이 같이 쓰므로 한 번만 조회한다
  let locCache: Map<string, string> | null = null
  const versionLocales = async (verId: string): Promise<Map<string, string>> => {
    if (locCache) return locCache
    const map = new Map<string, string>()
    const locR = await fetch(
      `${A}/appStoreVersions/${verId}/appStoreVersionLocalizations?fields%5BappStoreVersionLocalizations%5D=locale&limit=50`,
      { headers }
    )
    if (locR.ok) {
      const lJ = (await locR.json()) as { data?: { id: string; attributes?: { locale?: string } }[] }
      for (const d of lJ.data ?? []) if (d.attributes?.locale) map.set(d.attributes.locale, d.id)
    }
    return (locCache = map)
  }

  // ---- version 레벨 (description·promotionalText·keywords·whatsNew) ----
  if (versionEdits.length) {
    const v = await editableVersion()
    if (!v.ok) {
      for (const e of versionEdits)
        results.push({ id: e.id, ok: false, message: v.message, code: v.code })
    } else {
      await applyLocalized(
        versionEdits,
        await versionLocales(v.id),
        'appStoreVersionLocalizations',
        VERSION_FIELDS,
        ko ? '해당 로케일 없음' : 'No such locale'
      )
    }
  }

  // ---- IAP (로케일별 이름·설명) ----
  // 상품은 버전에 매달리지 않는다(라이브 앱이어도 IAP는 따로 심사) → 버전 관문을 안 지난다.
  // 가격·상태는 다루지 않는다(Play와 같은 이유 — 읽은 것보다 넓게 쓰지 않는다).
  if (iapEdits.length) {
    const listR = await fetch(`${A}/apps/${appId}/inAppPurchasesV2?limit=200`, { headers })
    if (!listR.ok) {
      for (const e of iapEdits) results.push({ id: e.id, ok: false, message: `HTTP ${listR.status}` })
    } else {
      const lJ = (await listR.json()) as {
        data?: { id: string; attributes?: { productId?: string } }[]
      }
      const idOfProduct = new Map(
        (lJ.data ?? []).map((d) => [d.attributes?.productId ?? '', d.id])
      )
      // 로케일 리소스 id는 상품마다 한 번만 조회해 재사용한다
      const locCacheByProduct = new Map<string, Map<string, string>>()
      const localesOf = async (iapId: string): Promise<Map<string, string>> => {
        const hit = locCacheByProduct.get(iapId)
        if (hit) return hit
        const map = new Map<string, string>()
        // ⚠️ v2 경로다 — v1로 부르면 relationship 없음 404 (2026-07-31 실측)
        const r = await fetch(
          `${A.replace('/v1', '/v2')}/inAppPurchases/${iapId}/inAppPurchaseLocalizations`,
          { headers }
        )
        if (r.ok) {
          const j = (await r.json()) as {
            data?: { id: string; attributes?: { locale?: string } }[]
          }
          for (const d of j.data ?? []) if (d.attributes?.locale) map.set(d.attributes.locale, d.id)
        }
        locCacheByProduct.set(iapId, map)
        return map
      }

      // 같은 (상품·로케일)의 이름·설명은 PATCH 한 번으로 묶는다 (메타와 같은 방식)
      const grouped = new Map<string, PendingEdit[]>()
      for (const e of iapEdits) {
        const parsed = parseIapFieldKey(e.field)
        if (!parsed) {
          results.push({ id: e.id, ok: false, message: ko ? '지원하지 않는 필드' : 'Unsupported field' })
          continue
        }
        const key = `${parsed.productId} ${e.locale}`
        const arr = grouped.get(key) ?? []
        arr.push(e)
        grouped.set(key, arr)
      }
      for (const [key, group] of grouped) {
        const [productId, locale] = key.split(' ')
        const iapId = idOfProduct.get(productId)
        if (!iapId) {
          for (const e of group)
            results.push({ id: e.id, ok: false, message: ko ? '상품을 찾을 수 없음' : 'Product not found' })
          continue
        }
        const locId = (await localesOf(iapId)).get(locale)
        if (!locId) {
          for (const e of group)
            results.push({ id: e.id, ok: false, message: ko ? '해당 로케일 없음' : 'No such locale' })
          continue
        }
        const attributes: Record<string, string> = {}
        for (const e of group) {
          const parsed = parseIapFieldKey(e.field)
          if (!parsed) continue
          // ASC는 제목을 `name`으로 부른다 — 화면·Play와 말을 맞추려고 우리 쪽에서 title로 쓴다
          attributes[parsed.field === 'title' ? 'name' : 'description'] = e.newValue
        }
        const r = await fetch(`${A}/inAppPurchaseLocalizations/${locId}`, {
          method: 'PATCH',
          headers: jsonHeaders,
          body: JSON.stringify({
            data: { type: 'inAppPurchaseLocalizations', id: locId, attributes }
          })
        })
        const message = r.ok ? (ko ? '반영됨' : 'Applied') : await ascErrorMsg(r)
        for (const e of group) results.push({ id: e.id, ok: r.ok, message })
      }
    }
  }

  // ---- 자산 (기기별 스크린샷 세트) ----
  // Play와 달리 원자성이 없다 — 기기 하나가 실패해도 다른 기기는 이미 올라간 뒤다.
  // 그래서 결과를 **항목별로** 낸다(ASC 다른 섹션과 같은 부분 성공 모델).
  if (assetEdits.length) {
    const v = await editableVersion()
    if (!v.ok) {
      for (const e of assetEdits)
        results.push({ id: e.id, ok: false, message: v.message, code: v.code })
    } else {
      const locMap = await versionLocales(v.id)
      for (const e of assetEdits) {
        const files = e.newValue.split('\n').map((x) => x.trim()).filter(Boolean)
        if (files.length === 0) {
          results.push({ id: e.id, ok: false, message: ko ? '올릴 파일이 없음' : 'No files to upload' })
          continue
        }
        const locId = locMap.get(e.locale)
        if (!locId) {
          results.push({ id: e.id, ok: false, message: ko ? '해당 로케일 없음' : 'No such locale' })
          continue
        }
        try {
          // 이 기기의 세트를 찾는다. 없으면 만든다 — 스크린샷이 아직 없는 기기에 처음 올리는 경우다
          const setsR = await fetch(
            `${A}/appStoreVersionLocalizations/${locId}/appScreenshotSets`,
            { headers }
          )
          if (!setsR.ok) throw new Error(`sets: HTTP ${setsR.status}`)
          const setsJ = (await setsR.json()) as {
            data?: { id: string; attributes?: { screenshotDisplayType?: string } }[]
          }
          let setId = (setsJ.data ?? []).find(
            (s) => s.attributes?.screenshotDisplayType === e.field
          )?.id
          if (!setId) {
            const mkR = await fetch(`${A}/appScreenshotSets`, {
              method: 'POST',
              headers: jsonHeaders,
              body: JSON.stringify({
                data: {
                  type: 'appScreenshotSets',
                  attributes: { screenshotDisplayType: e.field },
                  relationships: {
                    appStoreVersionLocalization: {
                      data: { type: 'appStoreVersionLocalizations', id: locId }
                    }
                  }
                }
              })
            })
            if (!mkR.ok) throw new Error(await ascErrorMsg(mkR))
            setId = ((await mkR.json()) as { data?: { id?: string } }).data?.id
          }
          if (!setId) throw new Error(ko ? '세트를 만들지 못함' : 'Could not create set')
          await replaceAscScreenshots(A, tok, setId, files)
          results.push({ id: e.id, ok: true, message: ko ? '반영됨' : 'Applied' })
        } catch (err) {
          const message = String(err).replace(/^Error:\s*/, '').slice(0, 160)
          // 세트 생성이 라이브 버전에서 막히면 ASC가 "current state"로 답한다 — 같은 잠금 해제 대상
          results.push({
            id: e.id,
            ok: false,
            message,
            code: /current state/i.test(message) ? 'version-locked' : undefined
          })
        }
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
  // 전역 상태에 등록된 것이 우선 — 자격증명은 앱이 아니라 브랜드 단위 하나다.
  // 이게 없던 동안 사용자는 ASC 키를 **답안 시트 JSON에 손으로** 적어야 했다
  const saved = readState().ascCreds as { keyPath?: string; keyId?: string; issuerId?: string } | undefined
  if (saved?.keyPath && existsSync(saved.keyPath) && saved.keyId && saved.issuerId) {
    return { keyPath: saved.keyPath, keyId: saved.keyId, issuerId: saved.issuerId }
  }
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
  // 패키징 앱의 답안 시트는 userData에 산다(번들 안은 서명 때문에 쓰기 불가) — 없으면 만든다
  try {
    mkdirSync(ANSWERS_DIR, { recursive: true })
  } catch {
    /* 있으면 무시 */
  }
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
  // ---------- 멀티모달 비용 제어 ----------
  // 캡처는 원본 해상도(레티나면 3000px대)로 오는데, 콘솔 화면을 읽는 데 그만한 화질이 필요 없다.
  // 긴 변 1024px로 줄이면 이미지 토큰이 1/2~1/3이 되고 전송·응답도 빨라진다.
  // ⚠️ 이건 **요금 문제만이 아니다** — 큰 이미지는 매 턴 이력으로 재전송되며 곱해진다(아래 참조).
  const shrinkImage = (im: {
    mediaType: string
    data: string
  }): { mediaType: string; data: string } => {
    try {
      const img = nativeImage.createFromDataURL(`data:${im.mediaType};base64,${im.data}`)
      const { width } = img.getSize()
      if (!width || width <= IMAGE_MAX_EDGE) return im
      const small = img.resize({ width: IMAGE_MAX_EDGE, quality: 'good' })
      return { mediaType: 'image/png', data: small.toPNG().toString('base64') }
    } catch {
      return im // 줄이기에 실패해도 원본으로 보낸다 — 기능이 막히는 것보단 낫다
    }
  }

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
      let model = modelFor(cfg, provider)
      const feature: AiFeature = opts?.feature ?? 'other'
      const startedAt = Date.now()
      // 보내기 전에 줄인다 — 모든 provider 경로의 공통 입구가 여기다
      const images = opts?.images?.map(shrinkImage)
      // 이미지가 붙으면 **비싼 모델로 보내지 않는다**. 고급 모델의 값어치는 문장을 짓는 데 있지
      // 화면을 읽는 데 있지 않은데, 이미지는 입력 토큰을 수십 배로 부풀린다(Terra는 Luna의 10배 단가).
      if (images?.length && IMAGE_HEAVY_MODELS.includes(model)) model = IMAGE_FALLBACK_MODEL
      opts = opts ? { ...opts, images } : opts
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
  // 정찰 때 **눌러서 도착한** 콘솔 URL을 그대로 돌려준다(브라우저를 다시 돌리지 않는 순수 읽기).
  // 이 값이 있어야 "콘솔에서 하세요" 대신 "이 화면입니다"까지 갈 수 있다.
  // ⚠️ URL을 조립해서 만들지 않는다 — 없으면 없는 대로 null을 준다(BROWSER-AUTOMATION §1:
  // `app-content`는 존재하지 않고 실제 경로는 `app-content/overview`였다. 추측은 4연속 실패했다).
  ipcMain.handle('console:appContentLinks', (_e, file: string) => {
    try {
      const sheet = JSON.parse(readFileSync(join(ANSWERS_DIR, file), 'utf8'))
      const pkg = sheet.app?.packageName ?? ''
      if (!pkg) return null
      const path = join(app.getPath('userData'), `zto-app-content-${pkg}.json`)
      if (!existsSync(path)) return null
      const doc = JSON.parse(readFileSync(path, 'utf8')) as {
        consoleBase?: string
        forms?: { slug?: string; label?: string; url?: string; reached?: boolean }[]
      }
      return {
        consoleBase: doc.consoleBase ?? '',
        // 도달하지 못한 폼의 URL은 내보내지 않는다 — 열어봤자 홈으로 튕기고, 그건 조용한 실패다
        forms: (doc.forms ?? [])
          .filter((f) => f.slug && f.url && f.reached)
          .map((f) => ({ slug: f.slug ?? '', label: f.label ?? '', url: f.url ?? '' }))
      }
    } catch {
      return null
    }
  })
  // 자산 고르기 — 파일 선택 → **업로드 전에** 규격 검증. 콘솔은 거부 사유를 뭉뚱그려 주므로
  // 여기서 "512×512여야 하는데 1024×1024"까지 말해준다(문서 §8).
  // 미리보기는 파일을 userData/assets에 복사해 zto-asset:// 로 낸다 — 이미 있는 안전한 통로를
  // 재사용한다(경로 조작은 basename으로 막혀 있고, 렌더러에 8MB 바이트를 실어 보내지 않아도 된다).
  // platform으로 갈린다: Play는 종류별 규격표(PLAY_IMAGE_SPECS), iOS는 **기기별 스크린샷**이라
  // imageType이 곧 디스플레이 타입(APP_IPHONE_67 등)이다. 검증기가 다르므로 여기서 나눈다.
  ipcMain.handle('launch:pickAssets', async (_e, imageType: string, platform?: string) => {
    const ko = appLocale === 'ko'
    const ios = platform === 'ios'
    const spec = ios ? undefined : PLAY_IMAGE_SPECS[imageType]
    if (!ios && !spec) return { ok: false, error: `unknown-type:${imageType}`, files: [] }
    const picked = await dialog.showOpenDialog({
      title: spec?.label ?? imageType,
      // iOS 스크린샷은 언제나 세트(여러 장)다
      properties: ios || spec?.multiple ? ['openFile', 'multiSelections'] : ['openFile'],
      filters: [
        {
          name: 'Images',
          extensions: !spec || spec.mimes.includes('image/jpeg') ? ['png', 'jpg', 'jpeg'] : ['png']
        }
      ]
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
      const bad = ios
        ? validateAscScreenshot(imageType, info, ko)
        : validatePlayImage(imageType, info, ko)
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
        const tokenScript = launchScript('google', 'token.js')
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
  // 자격증명 등록 — 파일을 고르고 **토큰이 실제로 발급되는지 확인한 뒤에만** 저장한다.
  // 검증 없이 저장하면 "연결됨"이라고 표시해놓고 첫 pull에서 터진다(화면이 거짓말한다).
  ipcMain.handle('launch:pickCredential', async (_e, store: StoreKind) => {
    const picked = await dialog.showOpenDialog({
      properties: ['openFile'],
      filters:
        store === 'play'
          ? [{ name: 'Service account JSON', extensions: ['json'] }]
          : [{ name: 'App Store Connect key', extensions: ['p8'] }]
    })
    if (picked.canceled || !picked.filePaths[0]) return { path: '' }
    return { path: picked.filePaths[0] }
  })

  ipcMain.handle(
    'launch:saveCredential',
    async (
      _e,
      store: StoreKind,
      creds: { path: string; keyId?: string; issuerId?: string }
    ): Promise<{ ok: boolean; error?: string }> => {
      const ko = appLocale === 'ko'
      if (!creds.path || !existsSync(creds.path)) {
        return { ok: false, error: ko ? '파일을 찾을 수 없어요' : 'File not found' }
      }
      if (store === 'play') {
        const tok = await googleTokenFor(creds.path)
        if (!tok) {
          return {
            ok: false,
            error: ko
              ? '이 키로 토큰을 못 받았어요 — 서비스 계정 JSON이 맞는지, Play Console에서 권한을 줬는지 확인하세요'
              : 'Could not get a token — check it is a service account JSON and has Play Console access'
          }
        }
        writeState({ ...readState(), lastGoogleSa: creds.path })
        return { ok: true }
      }
      if (!creds.keyId || !creds.issuerId) {
        return { ok: false, error: ko ? 'Key ID와 Issuer ID를 입력하세요' : 'Enter Key ID and Issuer ID' }
      }
      const asc = { keyPath: creds.path, keyId: creds.keyId.trim(), issuerId: creds.issuerId.trim() }
      const tok = await ascTokenFor(asc)
      if (!tok) {
        return {
          ok: false,
          error: ko
            ? '이 키로 토큰을 못 받았어요 — .p8 파일과 Key ID·Issuer ID가 서로 맞는지 확인하세요'
            : 'Could not get a token — check the .p8 file matches the Key ID and Issuer ID'
        }
      }
      writeState({ ...readState(), ascCreds: asc })
      return { ok: true }
    }
  )
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
      const p = join(resourceDir(), 'questionnaires', `${safe}.json`)
      return JSON.parse(readFileSync(p, 'utf8'))
    } catch {
      return null
    }
  })
  // 설문 목록 — 설정 노드가 플랫폼별로 여러 설문 버튼을 라벨과 함께 그리도록 (질문은 안 실음)
  ipcMain.handle('launch:questionnaireList', (): QuestionnaireMeta[] => {
    const dir = join(resourceDir(), 'questionnaires')
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
      const script = launchScript(
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
  // 계정 식별자(이메일/ID) 변경. **비밀번호 키와 접근 로그가 이 값을 물고 있다** —
  // 계정 파일만 고치면 저장된 비밀번호가 고아가 되고(옛 이메일 키로 남아 영영 못 꺼냄)
  // 접근 로그도 다른 사람 기록처럼 갈린다. 그래서 셋을 **한 번에** 옮긴다.
  //
  // 비밀번호가 있는 계정의 개명은 파괴적 변경이라 생체 관문을 지난다(저장·삭제와 같은 규칙).
  ipcMain.handle(
    'accounts:rename',
    async (_e, id: string, email: string): Promise<{ ok: boolean; error?: string; accounts: Account[] }> => {
      const accounts = readAccounts()
      const account = accounts.find((a) => a.id === id)
      const next = email.trim()
      if (!account) return { ok: false, error: 'not-found', accounts }
      if (!next) return { ok: false, error: 'empty', accounts }
      if (next === account.email) return { ok: true, accounts }
      // 같은 식별자가 이미 있으면 막는다 — 합치면 어느 쪽 비밀번호가 남는지 우리가 정하게 된다
      if (accounts.some((a) => a.id !== id && a.email === next)) {
        return { ok: false, error: 'duplicate', accounts }
      }

      const prefix = account.email + '::'
      const secrets = readSecrets()
      const keys = Object.keys(secrets).filter((k) => k.startsWith(prefix))
      if (keys.length > 0) {
        try {
          await biometricGate(`${account.email} → ${next}`)
        } catch {
          logAccess({ email: account.email, appId: '', action: 'update', ok: false })
          return { ok: false, error: 'auth', accounts }
        }
        for (const k of keys) {
          secrets[next + '::' + k.slice(prefix.length)] = secrets[k]
          delete secrets[k]
        }
        writeSecrets(secrets)
      }

      // 접근 로그도 따라 옮긴다 — 안 옮기면 "내가 연 게 맞나"를 확인할 수 없게 된다
      try {
        const log = JSON.parse(readFileSync(accessLogFile(), 'utf8')) as AccessLogEntry[]
        let touched = false
        for (const e of log) {
          if (e.email === account.email) {
            e.email = next
            touched = true
          }
        }
        if (touched) writeFileSync(accessLogFile(), JSON.stringify(log, null, 2))
      } catch {
        /* 로그가 없으면 옮길 것도 없다 */
      }

      account.email = next
      account.updatedAt = new Date().toISOString()
      writeAccounts(accounts)
      if (keys.length > 0) logAccess({ email: next, appId: '', action: 'update', ok: true })
      return { ok: true, accounts }
    }
  )
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
