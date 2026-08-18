// main ↔ preload ↔ renderer가 공유하는 모듈 1 타입
export interface SheetSummary {
  file: string
  appName: string
  packageName: string
  iapCount: number
  icon?: string // data URI (로컬 캐시된 스토어 아이콘)
}

export interface SheetIapInfo {
  packageName: string
  products: { productId: string; title: string; priceLabel: string }[]
}

export interface RunResult {
  ok: boolean
  output: unknown
  stderr?: string
}

export interface CredentialStatus {
  googleSa: { path: string; ok: boolean }
  asc: { keyPath: string; keyId: string; issuerId: string; ok: boolean }
}

// 스토어 개발자 계정 보유 상태 — 앱이 아닌 사용자/브랜드 소유라 답안 시트가 아닌 전역 상태
export type StoreKind = 'play' | 'apple'

export interface DevAccountState {
  status: 'yes' | 'no'
  email?: string
}

export interface DevAccounts {
  play?: DevAccountState
  apple?: DevAccountState
}

// ---------- §4.5 앱 대시보드 (P1 읽기 전용) — 스토어 실황 pull 결과 ----------

// 일회성 상품과 구독은 양대 스토어 모두 **다른 리소스**다(Play: oneTimeProducts↔subscriptions,
// ASC: inAppPurchasesV2↔subscriptionGroups). 한쪽만 부르면 화면이 "등록된 IAP 없음"이라고
// 단언하면서 실제로는 구독을 가진 앱을 만난다(2026-07-31 실사례).
// `kind`·`period`는 나중에 생긴 선택 필드다 — 옛 캐시·스냅샷에는 없으므로 없을 때도 그려져야 한다.
export interface LiveIapProduct {
  id: string
  title: string
  state: string
  priceLabel?: string
  kind?: 'onetime' | 'subscription'
  period?: string // 구독 주기 (P1M·ONE_MONTH 같은 스토어 원문을 사람 말로 바꿔 담는다)
  productId?: string // 편집용 원본 상품 id (구독은 표시 id에 요금제가 붙어 있어 따로 필요하다)
  // 로케일별 이름·설명. **편집하려면 전부 읽어야 한다** — Play는 listings 배열을 통째로
  // 덮어쓰므로 일부만 갖고 쓰면 나머지 언어가 지워진다(읽기의 생략이 쓰기의 사고가 되는 자리)
  listings?: { locale: string; title: string; description: string }[]
}

// `PendingEdit.field`는 문자열 하나뿐인데, 어떤 섹션은 대상이 둘로 갈린다
// (IAP = 상품 × 필드, 릴리스 노트 = 트랙 × 필드). 그래서 대상을 필드 키에 같이 싣는다.
// 렌더러가 만들고 main이 푸는 규칙이라 **양쪽이 보는 한 곳**에 둔다.
export const FIELD_SEP = '::'
/** @deprecated 이름만 남긴 별칭 — 새 코드는 FIELD_SEP을 쓴다 */
export const IAP_FIELD_SEP = FIELD_SEP

// 릴리스 노트는 **어느 트랙의 릴리스인가**가 위험도를 가른다 → 트랙을 필드에 싣는다
export const noteFieldKey = (track: string): string => `${track}${FIELD_SEP}whatsNew`
export const parseNoteFieldKey = (key: string): { track: string } | null => {
  const at = key.lastIndexOf(FIELD_SEP)
  if (at < 0 || key.slice(at + FIELD_SEP.length) !== 'whatsNew') return null
  return { track: key.slice(0, at) }
}
// 프로덕션 릴리스 노트 수정은 라이브 사용자에게 바로 나가고 롤아웃 중이면 위험하다 →
// 테스트 트랙(internal·closed·open)만 연다. 판정을 렌더러·main이 공유해야 화면과 결과가 안 어긋난다.
export const isEditableNoteTrack = (track: string): boolean => track !== 'production'

export const iapFieldKey = (productId: string, field: 'title' | 'description'): string =>
  `${productId}${FIELD_SEP}${field}`
export const parseIapFieldKey = (
  key: string
): { productId: string; field: 'title' | 'description' } | null => {
  const at = key.lastIndexOf(FIELD_SEP)
  if (at < 0) return null
  const field = key.slice(at + FIELD_SEP.length)
  if (field !== 'title' && field !== 'description') return null
  return { productId: key.slice(0, at), field }
}

// Play 트랙별 현재 릴리스 — 트랙 안에 살아있는 릴리스만 온다 (과거 버전 이력 API는 없음)
export interface PlayReleaseRow {
  track: string
  status: string
  name: string
  versionCodes: string[]
  notes: { locale: string; text: string }[] // 로케일별 릴리스 노트
}

// 스토어에 올라가 있는 이미지 자산 묶음 (타입별 URL 목록 — 스토어 CDN 직링크)
export interface DashImageSet {
  type: string // Play: icon·featureGraphic·phoneScreenshots / ASC: screenshotDisplayType
  urls: string[]
}

// 로케일별 스토어 메타 — Play: title/short/full, ASC: name/subtitle + 버전 로컬라이제이션의 desc/promo/keywords
export interface MetaListing {
  locale: string
  title: string
  short: string
  full: string
  promo: string // iOS 전용 (promotionalText)
  keywords: string // iOS 전용
}

export interface DashGoogle {
  releases: PlayReleaseRow[]
  listings: MetaListing[]
  details: { defaultLanguage: string; contactEmail: string; contactWebsite: string }
  images: DashImageSet[]
  // 자산은 **대표 로케일 하나**만 읽는다 → 어느 로케일이었는지 반드시 같이 보낸다.
  // 이걸 안 실어 보내면 편집이 엉뚱한 로케일에 덮어쓴다(라이브 스토어가 바뀌는 사고).
  imageLocale: string
  iap: LiveIapProduct[]
  closedStarted: boolean // closed 계열 트랙(alpha·커스텀)에 릴리스 존재 여부로 유추
}

export interface AscVersionRow {
  version: string
  state: string
  createdAt: string
  note: string
}

export interface DashApple {
  appId: string // 콘솔 딥링크용
  versions: AscVersionRow[]
  meta: MetaListing[] // appInfoLocalizations(name·subtitle) + 최신 버전 로컬라이제이션(desc·promo·keywords) 병합
  releaseNotes: { locale: string; text: string }[] // 최신 버전 whatsNew (로케일별)
  category: string
  ageRating: string
  screenshots: DashImageSet[]
  // 스크린샷도 Play 자산과 같은 이유로 **대표 로케일 하나**만 읽는다 → 어디에 쓰는지 같이 보낸다.
  // 나중에 생긴 선택 필드라 옛 캐시엔 없다(렌더러가 되짚는다).
  shotLocale?: string
  iap: LiveIapProduct[]
}

// 스토어 스냅샷 — 스토어에 이력 API가 없어서 ZTO가 pull마다 저장해 이력을 만든다 (SPEC §4.5 ⑧)
// 메타·자산·IAP 전 섹션을 덮는다. 내용이 같으면 confirmedAt만 갱신, 다르면 새 항목.
export interface StoreSnapshotEntry {
  createdAt: string
  confirmedAt: string
  google: { listings: MetaListing[]; images: DashImageSet[]; iap: LiveIapProduct[] } | null
  apple: { meta: MetaListing[]; screenshots: DashImageSet[]; iap: LiveIapProduct[] } | null
}

export interface IapSnapshotInfo {
  count: number
  createdAt: string // 마지막 스냅샷이 처음 기록된 시각
  confirmedAt: string // 같은 내용이 마지막으로 확인된 시각
  changed: boolean // 이번 pull에서 직전 스냅샷과 달라졌는지
}

export interface DashboardData {
  pulledAt: string
  google: DashGoogle | null
  googleError?: string
  apple: DashApple | null
  appleError?: string
  snapshot: IapSnapshotInfo | null
}

// AI provider — BYO 2방식: 구독(로컬 CLI spawn: claude/codex) 또는 API 키(키체인 저장). ROADMAP #1.
export interface AiModel {
  id: string
  label: string
}

export type AiProviderId = 'claude' | 'chatgpt' | 'gemini' | 'hosted'
export type AiMode = 'subscription' | 'apikey'

export interface AiProviderStatus {
  id: AiProviderId
  supportsSubscription: boolean // gemini는 CLI 구독 개념 없음 → API 키 전용
  subscriptionAvailable: boolean // 로컬 CLI 감지됨 (claude/codex)
  subscriptionVersion: string
  hasKey: boolean // API 키가 키체인에 저장됨
  mode: AiMode // 사용자가 고른 연결 방식
}

export interface AiStatus {
  active: AiProviderId // 두뇌로 쓸 provider
  model: string // active provider가 지금 쓰는 모델 id (provider별로 따로 기억됨)
  models: AiModel[] // active provider가 제공하는 모델 — 목록 자체가 provider별로 갈린다
  // 쓸 수 있는(구독 감지됨 or 키 저장됨) provider의 모델 전부. AI 패널이 한 드롭다운에서
  // provider까지 바꾸려면 active 것만으론 부족해서 같이 내려준다.
  providerModels: Partial<Record<AiProviderId, AiModel[]>>
  providers: AiProviderStatus[]
}

// AI 한 턴 실행 결과 — 구독(CLI spawn)/키(API) 공통. session_id로 대화 이어가기.
export interface AiChatResult {
  ok: boolean
  text: string
  sessionId?: string
  error?: string
}

// AI를 부른 자리 — 대시보드에서 "어디에 썼나"를 가른다.
// console = 콘솔 코파일럿(진짜 폼 옆에서 거드는 대화). 사용량 대시보드에서 소셜과 갈려 보인다 —
// 자동 질문이 도는 모드라 비용 성격이 다르고, 합치면 어디서 새는지 못 본다.
export type AiFeature = 'social' | 'survey' | 'console' | 'other'

// 호출 1건 기록 (userData/zto-ai-usage.json). 설정의 사용량 대시보드가 이걸 집계한다.
// billed=false(구독)는 실지출이 아니라 API 환산가다 — 합계를 절대 섞지 않는다.
export interface AiUsageEntry {
  at: string // ISO
  provider: AiProviderId
  mode: AiMode
  model: string
  feature: AiFeature
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  costUsd: number // 구독이면 CLI가 준 환산가, API 키면 가격표로 계산한 실지출
  billed: boolean // true = 실제로 청구되는 지출(API 키 경로)
  durationMs: number
  ok: boolean
}

// ---------- 앱 콘텐츠 설문 (ROADMAP #2) — 콘솔 전용 설정을 결정형 위저드로 ----------
// 질문 세트는 버전 관리 JSON(launch/questionnaires/). 콘솔이 개정되면 그 파일만 갱신.
export type QuestionType = 'level' | 'bool'

export interface QuestionDef {
  id: string
  type: QuestionType
  label: string
  labelEn?: string
  help?: string
}

export interface Questionnaire {
  id: string
  platform: EditPlatform
  version: string
  title: string
  titleEn?: string
  questions: QuestionDef[]
}

// 설문 목록 항목 — 설정 노드가 플랫폼별로 여러 설문 버튼을 그릴 때 (질문 세트는 빼고 라벨만)
export interface QuestionnaireMeta {
  id: string
  platform: EditPlatform
  title: string
  titleEn: string
}

// 답: level → NONE|INFREQUENT_OR_MILD|FREQUENT_OR_INTENSE, bool → YES|NO
export interface ConsoleAnswers {
  version: string
  answers: Record<string, string>
  completedAt: string // '' = 미완료
}

// 전역 API 연결 상태 — 자격증명은 앱이 아니라 브랜드/계정 단위(플랫폼당 하나)
export interface ApiStatus {
  play: { connected: boolean; detail: string }
  apple: { connected: boolean; detail: string }
}

// ---------- P2 편집 프레임 — 대기 중 수정(로컬 diff) → "수정 적용하기"로 배치 발사 ----------
export type EditPlatform = 'android' | 'ios'
export type EditSection = 'meta' | 'releaseNotes' | 'iap' | 'assets'

// 한 건의 대기 수정. id = `${platform}:${section}:${locale}:${field}` (같은 필드 재수정은 덮어씀)
export interface PendingEdit {
  id: string
  platform: EditPlatform
  section: EditSection
  field: string // meta: title·short·full·promo·keywords / releaseNotes: whatsNew ...
  locale: string
  label: string // 사람이 읽는 라벨 (적용 바·결과 패널용)
  oldValue: string
  newValue: string
}

// 적용 결과 — 항목별 (ASC는 부분 실패 가능, Play는 원자적)
// 코파일럿에 넘기는 **목적**. 브라우저를 열어주는 것과 이끄는 것은 다르다 —
// 목적 없이 화면만 띄우면 AI는 "무엇을 도와드릴까요"부터 시작하고, 우리가 이미 아는 것
// (어느 앱인지·무엇을 하러 왔는지)을 사용자에게 되묻는다(2026-07-31 실제로 그랬다).
// ASC에서 **편집이 되는 버전 상태**. 라이브(READY_FOR_SALE)엔 메타·스크린샷을 못 쓴다.
// main(적용)과 화면(편집 범위 표)이 같은 규칙을 봐야 "된다고 해놓고 실패"가 안 생긴다.
export const ASC_EDITABLE_VERSION_STATES = [
  'PREPARE_FOR_SUBMISSION',
  'DEVELOPER_REJECTED',
  'REJECTED',
  'METADATA_REJECTED',
  'INVALID_BINARY'
]
export const isAscEditableVersion = (state: string): boolean =>
  ASC_EDITABLE_VERSION_STATES.includes(state)

// 편집이 막혔을 때 **왜 막혔는지**가 처방을 가른다 (2026-07-31 실측에서 드러남):
//  - 라이브뿐 → 새 버전을 만들면 풀린다
//  - **심사 중 → 새 버전을 만들 수 없다.** 심사에서 빼거나 결과를 기다려야 한다
// 둘을 뭉뚱그려 "새 버전 만들기"를 제안하면, 심사 대기 중인 앱에 **되지도 않는 처방**을 준다.
const ASC_IN_REVIEW_STATES = [
  'READY_FOR_REVIEW',
  'WAITING_FOR_REVIEW',
  'IN_REVIEW',
  'PENDING_APPLE_RELEASE',
  'PENDING_DEVELOPER_RELEASE',
  'PROCESSING_FOR_APP_STORE',
  'WAITING_FOR_EXPORT_COMPLIANCE',
  'ACCEPTED'
]
export const isAscInReview = (state: string): boolean => ASC_IN_REVIEW_STATES.includes(state)

export interface CopilotTask {
  goal: string // 사용자가 하러 온 일 — 화면에 쓰인 라벨 그대로
  app?: string // "MyApp (com.example.app)" — 알면 반드시 넘긴다. 되묻게 하지 않는다
  platform?: 'android' | 'ios'
  why?: string // 왜 여기서(콘솔에서) 해야 하는지 — AI가 "ZTO에서 하세요"라고 되돌려보내지 않도록
  exact?: boolean // 목적지 화면까지 데려갔는지. false면 AI가 먼저 길찾기를 도와야 한다
}

export interface ApplyResult {
  id: string
  ok: boolean
  message: string
  // 화면이 실패에 **반응**해야 할 때 쓰는 기계 판독 코드. 메시지 문구로 판정하면
  // 로케일이 바뀌는 순간 조용히 안 맞는다(한국어 UI에서 잠금 해제 바가 안 뜨던 실제 버그).
  // 'version-locked' = iOS 라이브 버전이라 편집 불가 → "새 버전 만들어 반영" 제안
  //  version-locked = 라이브뿐이라 잠김 → 새 버전을 만들면 풀린다
  //  in-review      = 심사 중이라 잠김 → **새 버전으로 못 푼다**. 심사에서 빼야 한다
  code?: 'version-locked' | 'in-review'
}

// 모듈 2 — 계정 인벤토리 항목 (메타데이터만. 비밀번호 필드는 설계상 존재하지 않는다 — SPEC §7.3)
export interface Account {
  id: string
  email: string
  memo: string
  apps: string[] // 연결된 앱 — PLATFORMS의 id
  createdAt: string
  updatedAt: string
}

// 비밀번호 접근 기록 (로컬 전용) — "내가 연 게 맞나"를 확인하는 유일한 수단
export interface AccessLogEntry {
  ts: string
  email: string
  appId: string
  action: 'reveal' | 'copy' | 'save' | 'update' | 'delete' | 'reveal-prev'
  ok: boolean
}

// 교체된 옛 비밀번호 한 건 — 값은 안 싣는다(목록은 무인증, 값은 생체 관문 뒤).
// at = 이 값이 **교체된** 시각 = 다음 값의 수정일. 그래서 현재 값의 '수정일'과 한 줄로 이어진다.
export interface SecretVersion {
  at: string
}

export interface LockState {
  unlocked: boolean
  remainingMs: number
}

// 연결 가능한 앱 카탈로그 — 개발자 콘솔 2종 + 메일 + 소셜(Postiz 지원 플랫폼) + 솔로파운더 SaaS
export type PlatformCategory = 'console' | 'mail' | 'social' | 'saas'

export interface PlatformDef {
  id: string
  name: string
  category: PlatformCategory
}

export const PLATFORMS: PlatformDef[] = [
  { id: 'play-console', name: 'Play Console', category: 'console' },
  { id: 'app-store-connect', name: 'App Store Connect', category: 'console' },
  { id: 'gmail', name: 'Gmail', category: 'mail' },
  { id: 'naver', name: 'Naver Mail', category: 'mail' },
  { id: 'icloud', name: 'iCloud Mail', category: 'mail' },
  { id: 'outlook', name: 'Outlook', category: 'mail' },
  { id: 'yahoo', name: 'Yahoo Mail', category: 'mail' },
  { id: 'protonmail', name: 'Proton Mail', category: 'mail' },
  { id: 'daum', name: 'Daum Mail', category: 'mail' },
  { id: 'kakao', name: 'Kakao', category: 'mail' },
  { id: 'x', name: 'X', category: 'social' },
  { id: 'threads', name: 'Threads', category: 'social' },
  { id: 'instagram', name: 'Instagram', category: 'social' },
  { id: 'facebook', name: 'Facebook', category: 'social' },
  { id: 'youtube', name: 'YouTube', category: 'social' },
  { id: 'tiktok', name: 'TikTok', category: 'social' },
  { id: 'linkedin', name: 'LinkedIn', category: 'social' },
  { id: 'reddit', name: 'Reddit', category: 'social' },
  { id: 'bluesky', name: 'Bluesky', category: 'social' },
  { id: 'mastodon', name: 'Mastodon', category: 'social' },
  { id: 'pinterest', name: 'Pinterest', category: 'social' },
  { id: 'dribbble', name: 'Dribbble', category: 'social' },
  { id: 'discord', name: 'Discord', category: 'social' },
  { id: 'slack', name: 'Slack', category: 'social' },
  { id: 'telegram', name: 'Telegram', category: 'social' },
  { id: 'warpcast', name: 'Warpcast', category: 'social' },
  { id: 'lemmy', name: 'Lemmy', category: 'social' },
  { id: 'nostr', name: 'Nostr', category: 'social' },
  { id: 'vk', name: 'VK', category: 'social' },
  { id: 'kick', name: 'Kick', category: 'social' },
  // SaaS — 솔로파운더가 계정을 흩뿌리게 되는 서비스들 (2026-08-02 Dan 요청)
  { id: 'lemonsqueezy', name: 'Lemon Squeezy', category: 'saas' },
  { id: 'stripe', name: 'Stripe', category: 'saas' },
  { id: 'paypal', name: 'PayPal', category: 'saas' },
  { id: 'vercel', name: 'Vercel', category: 'saas' },
  { id: 'supabase', name: 'Supabase', category: 'saas' },
  { id: 'firebase', name: 'Firebase', category: 'saas' },
  { id: 'cloudflare', name: 'Cloudflare', category: 'saas' },
  { id: 'aws', name: 'AWS', category: 'saas' },
  { id: 'googlecloud', name: 'Google Cloud', category: 'saas' },
  { id: 'github', name: 'GitHub', category: 'saas' },
  { id: 'openai', name: 'OpenAI', category: 'saas' },
  { id: 'anthropic', name: 'Anthropic', category: 'saas' },
  { id: 'notion', name: 'Notion', category: 'saas' },
  { id: 'figma', name: 'Figma', category: 'saas' }
]

// 이메일 도메인 → 메일 서비스 앱. ID가 이메일이면 이 앱이 유저 설정 없이 강제 연결되고 항상 맨 앞.
const EMAIL_DOMAIN_APP: Record<string, string> = {
  'gmail.com': 'gmail',
  'googlemail.com': 'gmail',
  'naver.com': 'naver',
  'icloud.com': 'icloud',
  'me.com': 'icloud',
  'mac.com': 'icloud',
  'outlook.com': 'outlook',
  'hotmail.com': 'outlook',
  'live.com': 'outlook',
  'msn.com': 'outlook',
  'yahoo.com': 'yahoo',
  'yahoo.co.kr': 'yahoo',
  'proton.me': 'protonmail',
  'protonmail.com': 'protonmail',
  'pm.me': 'protonmail',
  'daum.net': 'daum',
  'hanmail.net': 'daum',
  'kakao.com': 'kakao'
}

// 앱 → 비밀번호 관리자 검색어(대표 도메인). 딥링크에 검색어 주입은 공식적으로 불가 → 클립보드 복사용
export const PLATFORM_DOMAINS: Record<string, string> = {
  'play-console': 'play.google.com',
  'app-store-connect': 'appstoreconnect.apple.com',
  gmail: 'google.com',
  naver: 'naver.com',
  icloud: 'apple.com',
  outlook: 'live.com',
  yahoo: 'yahoo.com',
  protonmail: 'proton.me',
  daum: 'daum.net',
  kakao: 'kakao.com',
  x: 'x.com',
  threads: 'threads.net',
  instagram: 'instagram.com',
  facebook: 'facebook.com',
  youtube: 'google.com',
  tiktok: 'tiktok.com',
  linkedin: 'linkedin.com',
  reddit: 'reddit.com',
  bluesky: 'bsky.app',
  mastodon: 'mastodon.social',
  pinterest: 'pinterest.com',
  dribbble: 'dribbble.com',
  discord: 'discord.com',
  slack: 'slack.com',
  telegram: 'telegram.org',
  warpcast: 'warpcast.com',
  lemmy: 'lemmy.world',
  nostr: 'nostr.com',
  vk: 'vk.com',
  kick: 'kick.com'
}

export function mailAppForEmail(email: string): string | null {
  const domain = email.split('@')[1]?.toLowerCase()
  return domain ? (EMAIL_DOMAIN_APP[domain] ?? null) : null
}

export const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

// 편집거리 1 이내 판정 (오타 추정용)
function within1Edit(a: string, b: string): boolean {
  if (a === b) return false
  if (Math.abs(a.length - b.length) > 1) return false
  let i = 0
  let j = 0
  let edits = 0
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      i++
      j++
      continue
    }
    if (++edits > 1) return false
    if (a.length > b.length) i++
    else if (b.length > a.length) j++
    else {
      i++
      j++
    }
  }
  return edits + (a.length - i) + (b.length - j) <= 1
}

// "gmail.cpm" 같은 도메인 오타 → 알려진 도메인으로 교정 제안
export function suggestEmailDomain(email: string): string | null {
  const [local, domain] = email.split('@')
  if (!local || !domain) return null
  const d = domain.toLowerCase()
  if (EMAIL_DOMAIN_APP[d]) return null
  for (const known of Object.keys(EMAIL_DOMAIN_APP)) {
    if (within1Edit(d, known)) return `${local}@${known}`
  }
  return null
}

// 신규 앱 여정 ② — 콘텐츠(스토어 리스팅) 초안. 시트에 저장했다가 스토어 레코드가 생기면 반영한다.
// 양대 스토어가 같은 정보를 다른 규격으로 받으므로 플랫폼별로 든다. iOS 아이콘이 없는 이유:
// App Store 아이콘은 빌드(Asset Catalog) 소속이라 여기서 못 넣는다 — 핸드오프로 넘긴다.
export interface SheetListing {
  locale: string
  android: { title: string; short: string; full: string; icon: string }
  ios: { name: string; subtitle: string; keywords: string; full: string }
}

// 콘텐츠 기본 언어 후보 — 양대 스토어가 **같은 언어를 다른 코드로** 받는다(Play=BCP-47,
// ASC=자체 코드: ko-KR↔ko, zh-CN↔zh-Hans). value는 Play 형으로 저장하고 ASC 반영 시 변환한다.
// 자유 입력이면 이 변환이 불가능해 한쪽 반영이 조용히 깨진다 — 그래서 드롭다운이다.
export const LISTING_LOCALES: { value: string; asc: string; label: string }[] = [
  { value: 'en-US', asc: 'en-US', label: 'English (US)' },
  { value: 'ko-KR', asc: 'ko', label: '한국어' },
  { value: 'ja-JP', asc: 'ja', label: '日本語' },
  { value: 'zh-CN', asc: 'zh-Hans', label: '中文(简体)' },
  { value: 'zh-TW', asc: 'zh-Hant', label: '中文(繁體)' },
  { value: 'de-DE', asc: 'de-DE', label: 'Deutsch' },
  { value: 'fr-FR', asc: 'fr-FR', label: 'Français' },
  { value: 'es-ES', asc: 'es-ES', label: 'Español' },
  { value: 'pt-BR', asc: 'pt-BR', label: 'Português (BR)' },
  { value: 'it-IT', asc: 'it', label: 'Italiano' },
  { value: 'nl-NL', asc: 'nl-NL', label: 'Nederlands' },
  { value: 'id', asc: 'id', label: 'Bahasa Indonesia' },
  { value: 'th', asc: 'th', label: 'ไทย' },
  { value: 'vi', asc: 'vi', label: 'Tiếng Việt' },
  { value: 'ru-RU', asc: 'ru', label: 'Русский' },
  { value: 'tr-TR', asc: 'tr', label: 'Türkçe' }
]
export const ascLocaleOf = (v: string): string =>
  LISTING_LOCALES.find((l) => l.value === v)?.asc ?? v
