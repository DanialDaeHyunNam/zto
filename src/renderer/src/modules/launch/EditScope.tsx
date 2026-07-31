import { useEffect, useState } from 'react'
import { useI18n } from '../../i18n'
import { useBrowserOverlay } from '../../browser-overlay'

// ---------- "무엇을 어디서 바꾸나" 표 ----------
// 이 지식이 사람 머릿속(또는 대화 로그)에만 있으면 화면은 매번 "왜 여긴 편집이 안 되지"를
// 겪게 한다. 그래서 앱 안에 둔다.
//
// **상태는 두 개뿐이다: ZTO에서 / 콘솔에서.** 처음엔 '읽기만'을 따로 뒀다가 걷어냈다(Dan) —
// 그건 만드는 쪽 분류지 쓰는 쪽 분류가 아니다. 쓰는 사람에게는 "여기서 되나, 안 되면 어디로
// 가나" 두 질문뿐이고 안 되는 건 전부 콘솔로 간다. **왜 콘솔인지는 사유 열로 내린다** —
// 스토어가 길을 안 열어준 것과 우리가 일부러 안 연 것은 다르고, 후자는 언제든 열 수 있다.
type Where = 'zto' | 'console'

interface CapRow {
  key: string
  where: Where
  // 정찰이 수확해 둔 앱 콘텐츠 폼 슬러그. 있으면 **그 화면까지** 데려간다.
  // 없으면 콘솔 홈으로 보내고 안내 문구가 무엇을 찾아야 하는지 말한다 —
  // URL을 지어내지 않는다(BROWSER-AUTOMATION §1)
  slug?: string
  // iOS는 ASC 경로가 앱 id 기준이라 조립이 아니라 알려진 상대 경로를 붙인다(스토어가 문서화한 것)
  ascPath?: string
  // iOS 전용 — 버전과의 관계. **iOS 행은 전부 값을 가진다**: 빈칸이면 "버전 무관"으로
  // 읽히는데(Dan 2026-07-31), 아이콘처럼 실제로는 새 빌드가 필요한 것도 콘솔행이라는
  // 이유로 빈칸이었다. 모른다는 것과 필요 없다는 것은 화면에서 같은 모양이면 안 된다.
  //  bound = 버전 종속(라이브엔 못 씀) / free = 버전 무관 / build = 새 빌드가 필요
  // Android엔 대응 개념이 없어 값을 두지 않는다(트랙 릴리스는 릴리스 노트 행에서 따로 말한다)
  ver?: 'bound' | 'free' | 'build'
}

// key는 사전(capItems)의 항목 이름이다. 플랫폼끼리 겹치지 않게 a/i 접두어를 쓴다.
const CAPS: Record<'android' | 'ios', CapRow[]> = {
  android: [
    { key: 'aMeta', where: 'zto' },
    { key: 'aAssets', where: 'zto' },
    { key: 'aIapText', where: 'zto' },
    { key: 'aIapAdd', where: 'zto' },
    { key: 'aNotesTest', where: 'zto' },
    { key: 'aNotesProd', where: 'console' },
    { key: 'aIapPrice', where: 'console' },
    { key: 'aSubs', where: 'console' },
    { key: 'aAssetLocale', where: 'console' },
    { key: 'aTabletShots', where: 'console' },
    { key: 'aDetails', where: 'console' },
    { key: 'aRating', where: 'console', slug: 'content-rating-overview' },
    { key: 'aAudience', where: 'console', slug: 'target-audience-content' },
    { key: 'aDataSafety', where: 'console', slug: 'data-privacy-security' },
    { key: 'aDeclarations', where: 'console', slug: 'ads-declaration' },
    { key: 'aRollout', where: 'console' },
    { key: 'aCreate', where: 'console' }
  ],
  ios: [
    { key: 'iMetaName', where: 'zto', ver: 'bound' },
    { key: 'iMetaVersion', where: 'zto', ver: 'bound' },
    { key: 'iPromo', where: 'zto', ver: 'bound' },
    { key: 'iNotes', where: 'zto', ver: 'bound' },
    { key: 'iShots', where: 'zto', ver: 'bound' },
    { key: 'iShotDevice', where: 'zto', ver: 'bound' },
    // IAP는 앱 버전이 아니라 **자체 심사 주기**를 탄다 — 앱을 다시 올리지 않아도 바뀐다
    { key: 'iIapText', where: 'zto', ver: 'free' },
    { key: 'iNewVersion', where: 'zto' },
    // 아이콘은 빌드 안에 있다 → 메타 수정이 아니라 새 빌드가 필요하다
    { key: 'iIcon', where: 'console', ver: 'build' },
    { key: 'iIapAdd', where: 'console', ver: 'free' },
    { key: 'iIapPrice', where: 'console', ver: 'free' },
    // 카테고리·연령 등급은 앱 이름·부제와 **같은 appInfo 리소스**다(우리 읽기 코드가 그 증거 —
    // `appInfos?include=primaryCategory`, `attributes.appStoreAgeRating`) → 같은 관문을 지난다
    { key: 'iCategory', where: 'console', ascPath: 'distribution/info', ver: 'bound' },
    { key: 'iPrivacy', where: 'console', ascPath: 'distribution/appprivacy', ver: 'free' },
    { key: 'iAgeRating', where: 'console', ascPath: 'distribution/info', ver: 'bound' },
    { key: 'iPricing', where: 'console', ascPath: 'pricing', ver: 'free' },
    { key: 'iSubmit', where: 'console', ver: 'build' }
  ]
}

const CONSOLE_URL: Record<'android' | 'ios', string> = {
  android: 'https://play.google.com/console',
  ios: 'https://appstoreconnect.apple.com/apps'
}

export default function EditScope({
  platform,
  file,
  ascAppId,
  appLabel,
  iosEditableVersion,
  onClose
}: {
  platform: 'android' | 'ios'
  file: string | null // 선택된 앱 시트 — 수확된 콘솔 링크를 찾는 열쇠
  ascAppId?: string
  appLabel?: string // "실측 앱 (com.example.app)" — AI가 되묻지 않게 같이 넘긴다
  // 지금 편집할 수 있는 iOS 버전 번호(없으면 라이브뿐이라는 뜻). 표가 **일반론이 아니라
  // 이 앱의 지금**을 말하게 하는 값이다 — "새 버전이 필요합니다"와 "1.2.0에 반영됩니다"는 다르다
  iosEditableVersion?: string
  onClose: () => void
}): React.JSX.Element {
  const { m } = useI18n()
  const overlay = useBrowserOverlay()
  // 정찰이 수확해 둔 링크(있으면). 없으면 홈으로 보내되 안내가 무엇을 찾을지 말해준다
  const [links, setLinks] = useState<Record<string, string>>({})
  // 표를 연 시점의 플랫폼으로 시작하되, 여기서 바꿔 볼 수 있다 — 두 스토어를 비교하는 게
  // 이 표의 쓰임 절반이다(“iOS는 되는데 Android는 왜 안 되지”)
  const [plat, setPlat] = useState<'android' | 'ios'>(platform)

  useEffect(() => {
    if (!file) return
    let live = true
    window.zto.console.appContentLinks(file).then((r) => {
      if (!live || !r) return
      setLinks(Object.fromEntries(r.forms.map((f) => [f.slug, f.url])))
    })
    return () => {
      live = false
    }
  }, [file])

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const rows = CAPS[plat]
  const items = m.launch.capItems
  const ztoCount = rows.filter((r) => r.where === 'zto').length

  // 행이 갈 곳. 수확된 URL > ASC 문서 경로 > 콘솔 홈 순. **지어내지 않는다**
  const urlOf = (r: CapRow): string => {
    if (plat === 'android') return (r.slug && links[r.slug]) || CONSOLE_URL.android
    if (r.ascPath && ascAppId) return `https://appstoreconnect.apple.com/apps/${ascAppId}/${r.ascPath}`
    return CONSOLE_URL.ios
  }
  // 정확한 화면까지 데려갔는지 여부는 **안내 문구가 달라져야 한다** — 홈에 떨궈놓고
  // "여기입니다"라고 하면 사용자는 없는 걸 찾는다
  const exact = (r: CapRow): boolean =>
    plat === 'android' ? !!(r.slug && links[r.slug]) : !!(r.ascPath && ascAppId)

  // 표에서 바로 콘솔로 — 읽고 나서 "그럼 어디로"를 다시 찾게 하지 않는다(모드 B)
  const openConsole = (): void => {
    onClose()
    overlay.open(CONSOLE_URL[plat], { copilot: true })
    overlay.setGuide({ text: m.launch.capGuide, tone: 'ask' })
  }

  const openRow = (r: CapRow): void => {
    const label = items[r.key]?.t ?? r.key
    onClose()
    // 화면만 열지 않는다 — **무엇을 하러 왔는지**를 AI에게 같이 넘긴다.
    // 사유(why)까지 주는 건 AI가 "그건 ZTO에서 하세요"라고 되돌려보내지 않게 하기 위해서다
    overlay.open(urlOf(r), {
      copilot: true,
      task: {
        goal: label,
        app: appLabel,
        platform: plat,
        why: items[r.key]?.w,
        exact: exact(r)
      }
    })
    overlay.setGuide({
      text: (exact(r) ? m.launch.capGuideExact : m.launch.capGuideHome).replace('{n}', label),
      tone: 'ask'
    })
  }

  return (
    <div className="lightbox" onClick={onClose}>
      <div className="meta-modal" onClick={(e) => e.stopPropagation()}>
        <div className="meta-modal-head">
          <strong>{m.launch.capTitle}</strong>
          <div className="seg small">
            <button
              className={plat === 'android' ? 'active' : ''}
              onClick={() => setPlat('android')}
            >
              {m.launch.dashAndroid}
            </button>
            <button className={plat === 'ios' ? 'active' : ''} onClick={() => setPlat('ios')}>
              {m.launch.dashIos}
            </button>
          </div>
          <button className="modal-close" onClick={onClose}>
            ✕
          </button>
        </div>
        <div className="cap-body">
          <p className="cap-intro">
            {m.launch.capIntro.replace('{n}', String(ztoCount)).replace('{t}', String(rows.length))}
          </p>
          {plat === 'ios' && <p className="cap-intro">{m.launch.capVerLegend}</p>}
          <div className="cap-table">
            {rows.map((r) => (
              <div key={r.key} className={`cap-row ${r.where}`}>
                <span className="cap-what">{items[r.key]?.t ?? r.key}</span>
                <span className={`cap-where ${r.where}`}>
                  {r.where === 'zto' ? m.launch.capHere : m.launch.capConsole}
                </span>
                <span className="cap-why">
                  {items[r.key]?.w ?? ''}
                  {/* 버전 종속 표시는 **이 앱의 지금 상태**로 말한다. 편집 가능한 버전이 있으면
                      어디에 반영되는지를, 없으면 새 버전이 먼저 필요하다는 것을 */}
                  {r.ver === 'free' && <span className="cap-ver ok">{m.launch.capVerFree}</span>}
                  {r.ver === 'build' && (
                    <span className="cap-ver need">{m.launch.capVerBuild}</span>
                  )}
                  {r.ver === 'bound' && (
                    <span className={`cap-ver ${iosEditableVersion ? 'ok' : 'need'}`}>
                      {iosEditableVersion
                        ? m.launch.capVerInto.replace('{v}', iosEditableVersion)
                        : m.launch.capVerNeed}
                    </span>
                  )}
                </span>
                {/* 콘솔행은 반드시 목적지를 갖는다 — "여기선 안 돼요"로 끝나면 막다른 길이다 */}
                {r.where === 'console' ? (
                  <button
                    className="dash-go"
                    onClick={() => openRow(r)}
                    title={exact(r) ? m.launch.capGoExact : m.launch.capGoHome}
                  >
                    ↗
                  </button>
                ) : (
                  <span />
                )}
              </div>
            ))}
          </div>
          <div className="cap-foot">
            <span className="asset-note">{m.launch.capFoot}</span>
            <button className="ghost-btn mini" onClick={openConsole}>
              {m.launch.capOpenConsole}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
