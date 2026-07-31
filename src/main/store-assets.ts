// ---------- 스토어 자산 편집 (ROADMAP #3) ----------
// 지금까지 자산은 '보기'만 됐다. 스크린샷·아이콘은 업데이트마다 만지는 것이라 값이 바로 난다.
//
// Play는 이미지 조작이 **메타와 같은 edit 안에서** 일어나고 `:commit` 하나로 원자적으로 반영된다
// → 이미 있는 `applyPlayEdits` 인프라에 그대로 얹힌다(ASC는 3단계 업로드라 별개, 후속).
//
// ⚠️ 경로 주의: 이미지 API는 이름이 `edits.images`인데 **URL은 `listings/{lang}/{type}` 아래**다.
// `edits/{id}/images/...`로 부르면 404다(2026-07-22 실측, 읽기에서 이미 겪음).
import { createHash } from 'crypto'
import { readFileSync } from 'fs'
import { basename, extname } from 'path'

export interface ImageInfo {
  width: number
  height: number
  bytes: number
  mime: string
  name: string
  hasAlpha: boolean // ASC 전용 관문 — 애플은 알파 있는 스크린샷을 거부한다
}

// PNG·JPEG 헤더에서 크기를 읽는다. 라이브러리를 안 쓰는 이유: 우리가 필요한 건 폭·높이뿐이고,
// **업로드 전에 여기서 걸러야** 사용자가 콘솔의 불친절한 거부 사유 대신 정확한 문장을 본다.
export function imageInfo(path: string): ImageInfo | null {
  let buf: Buffer
  try {
    buf = readFileSync(path)
  } catch {
    return null
  }
  const name = basename(path)
  const bytes = buf.length

  // PNG: 8바이트 시그니처 + 4(len) + 4('IHDR') 다음에 width·height가 빅엔디언 4바이트씩.
  // 이어서 bitDepth(24)·colorType(25) — colorType 4(회색+알파)·6(RGBA)면 알파가 있다.
  if (buf.length > 25 && buf.readUInt32BE(0) === 0x89504e47) {
    const colorType = buf[25]
    return {
      width: buf.readUInt32BE(16),
      height: buf.readUInt32BE(20),
      bytes,
      mime: 'image/png',
      name,
      hasAlpha: colorType === 4 || colorType === 6
    }
  }

  // JPEG: SOF 마커(0xFFC0~0xFFCF, 단 C4/C8/CC 제외)를 찾아 그 안에서 높이·폭을 읽는다
  if (buf.length > 4 && buf[0] === 0xff && buf[1] === 0xd8) {
    let i = 2
    while (i + 9 < buf.length) {
      if (buf[i] !== 0xff) {
        i++
        continue
      }
      const marker = buf[i + 1]
      const isSof = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc
      const len = buf.readUInt16BE(i + 2)
      if (isSof) {
        return {
          height: buf.readUInt16BE(i + 5),
          width: buf.readUInt16BE(i + 7),
          bytes,
          mime: 'image/jpeg',
          name,
          hasAlpha: false // JPEG엔 알파가 없다
        }
      }
      i += 2 + len
    }
  }
  return null
}

// Play 스토어 등록정보 이미지 규격. 콘솔이 거부하면 사유가 뭉뚱그려 오므로 **여기서 먼저 막는다**
// (문서 §8 — 진단은 한 단계 아래 사실을 실어야 한다. "업로드 실패"보다 "512×512여야 하는데 1024×1024"가 낫다).
export interface ImageSpec {
  label: string
  exact?: { w: number; h: number } // 정확히 이 크기여야 함
  min?: number // 짧은 변 최소
  max?: number // 긴 변 최대
  maxRatio?: number // 긴 변 / 짧은 변
  maxBytes: number
  mimes: string[]
  multiple: boolean // 여러 장을 세트로 올리나
}

export const PLAY_IMAGE_SPECS: Record<string, ImageSpec> = {
  icon: {
    label: 'Icon',
    exact: { w: 512, h: 512 },
    maxBytes: 1024 * 1024,
    mimes: ['image/png'],
    multiple: false
  },
  featureGraphic: {
    label: 'Feature graphic',
    exact: { w: 1024, h: 500 },
    maxBytes: 15 * 1024 * 1024,
    mimes: ['image/png', 'image/jpeg'],
    multiple: false
  },
  phoneScreenshots: {
    label: 'Phone screenshots',
    min: 320,
    max: 3840,
    maxRatio: 2,
    maxBytes: 8 * 1024 * 1024,
    mimes: ['image/png', 'image/jpeg'],
    multiple: true
  }
}

// 통과하면 null, 아니면 사람이 읽는 사유. 문구는 값과 기대치를 **둘 다** 담는다.
export function validatePlayImage(type: string, info: ImageInfo, ko: boolean): string | null {
  const spec = PLAY_IMAGE_SPECS[type]
  if (!spec) return ko ? `지원하지 않는 자산 종류: ${type}` : `Unsupported asset type: ${type}`
  if (!spec.mimes.includes(info.mime)) {
    const want = spec.mimes.map((s) => s.replace('image/', '').toUpperCase()).join('/')
    return ko
      ? `${info.name}: ${want} 형식이어야 해요 (지금 ${info.mime.replace('image/', '').toUpperCase()})`
      : `${info.name}: must be ${want} (got ${info.mime.replace('image/', '').toUpperCase()})`
  }
  if (spec.exact && (info.width !== spec.exact.w || info.height !== spec.exact.h)) {
    return ko
      ? `${info.name}: ${spec.exact.w}×${spec.exact.h}이어야 해요 (지금 ${info.width}×${info.height})`
      : `${info.name}: must be ${spec.exact.w}×${spec.exact.h} (got ${info.width}×${info.height})`
  }
  const shortSide = Math.min(info.width, info.height)
  const longSide = Math.max(info.width, info.height)
  if (spec.min && shortSide < spec.min) {
    return ko
      ? `${info.name}: 짧은 변이 ${spec.min}px 이상이어야 해요 (지금 ${shortSide}px)`
      : `${info.name}: short side must be ≥ ${spec.min}px (got ${shortSide}px)`
  }
  if (spec.max && longSide > spec.max) {
    return ko
      ? `${info.name}: 긴 변이 ${spec.max}px 이하여야 해요 (지금 ${longSide}px)`
      : `${info.name}: long side must be ≤ ${spec.max}px (got ${longSide}px)`
  }
  if (spec.maxRatio && longSide / shortSide > spec.maxRatio) {
    const r = (longSide / shortSide).toFixed(2)
    return ko
      ? `${info.name}: 가로세로 비가 ${spec.maxRatio}:1 이하여야 해요 (지금 ${r}:1)`
      : `${info.name}: aspect ratio must be ≤ ${spec.maxRatio}:1 (got ${r}:1)`
  }
  if (info.bytes > spec.maxBytes) {
    const mb = (n: number): string => (n / 1024 / 1024).toFixed(1)
    return ko
      ? `${info.name}: ${mb(spec.maxBytes)}MB 이하여야 해요 (지금 ${mb(info.bytes)}MB)`
      : `${info.name}: must be ≤ ${mb(spec.maxBytes)}MB (got ${mb(info.bytes)}MB)`
  }
  return null
}

// ---------- ASC(iOS) 스크린샷 ----------
// Play와 달리 **기기(디스플레이 타입)별로 세트가 따로**고 크기가 정확히 맞아야 한다.
// 세로 규격만 적고 가로는 전치(w↔h)를 허용한다 — 애플이 둘 다 받는다.
//
// ⚠️ 모르는 타입은 크기 검사를 **건너뛴다**. 애플이 기기를 추가하면 이 표가 먼저 낡는데,
// 낡은 표로 "규격 아님"이라 막으면 우리가 올릴 수 있는 것도 못 올리게 된다.
// 표에 없다고 거짓으로 단정하느니 스토어의 판정에 맡긴다(형식·알파 검사는 그대로 건다).
export const ASC_SHOT_SIZES: Record<string, { w: number; h: number }[]> = {
  APP_IPHONE_67: [
    { w: 1290, h: 2796 },
    { w: 1320, h: 2868 }
  ],
  APP_IPHONE_65: [
    { w: 1284, h: 2778 },
    { w: 1242, h: 2688 }
  ],
  APP_IPHONE_61: [
    { w: 1179, h: 2556 },
    { w: 1206, h: 2622 }
  ],
  APP_IPHONE_58: [
    { w: 1125, h: 2436 },
    { w: 1080, h: 2340 }
  ],
  APP_IPHONE_55: [{ w: 1242, h: 2208 }],
  APP_IPHONE_47: [{ w: 750, h: 1334 }],
  APP_IPAD_PRO_3GEN_129: [{ w: 2048, h: 2732 }],
  APP_IPAD_PRO_129: [{ w: 2048, h: 2732 }],
  APP_IPAD_PRO_3GEN_11: [{ w: 1668, h: 2388 }],
  APP_IPAD_105: [{ w: 1668, h: 2224 }],
  APP_IPAD_97: [{ w: 1536, h: 2048 }]
}

const ASC_MAX_BYTES = 500 * 1024 * 1024 // 애플 업로드 상한은 매우 크다 — 사실상 크기 검사가 관문

export function validateAscScreenshot(
  displayType: string,
  info: ImageInfo,
  ko: boolean
): string | null {
  if (info.mime !== 'image/png' && info.mime !== 'image/jpeg') {
    return ko ? `${info.name}: PNG·JPEG만 돼요` : `${info.name}: PNG/JPEG only`
  }
  // 알파는 애플이 거부한다. 거부 사유가 "이미지가 유효하지 않음" 수준으로만 와서 **여기서 잡는다**
  if (info.hasAlpha) {
    return ko
      ? `${info.name}: 알파 채널(투명도)이 있으면 애플이 거부해요 — 배경을 채워 다시 저장하세요`
      : `${info.name}: Apple rejects screenshots with an alpha channel — flatten it and re-save`
  }
  const sizes = ASC_SHOT_SIZES[displayType]
  if (!sizes) return null // 모르는 기기 — 스토어 판정에 맡긴다
  const fits = sizes.some(
    (s) =>
      (info.width === s.w && info.height === s.h) || (info.width === s.h && info.height === s.w)
  )
  if (!fits) {
    const want = sizes.map((s) => `${s.w}×${s.h}`).join(ko ? ' 또는 ' : ' or ')
    return ko
      ? `${info.name}: ${want}여야 해요 (지금 ${info.width}×${info.height})`
      : `${info.name}: must be ${want} (got ${info.width}×${info.height})`
  }
  if (info.bytes > ASC_MAX_BYTES) {
    return ko ? `${info.name}: 파일이 너무 커요` : `${info.name}: file too large`
  }
  return null
}

// 한 스크린샷 세트(= 기기 하나)를 통째로 교체한다. Play와 같은 '세트 교체' 원칙이되,
// ASC는 업로드가 **3단계**다: ① 예약(POST로 자리를 잡고 업로드 지시를 받음) →
// ② 지시받은 URL에 바이트 전송 → ③ `uploaded:true` + 체크섬으로 확정.
// 예약만 하고 확정을 안 하면 **깨진 자산이 콘솔에 남는다**(애플이 지우지 않는다).
export async function replaceAscScreenshots(
  A: string,
  token: string,
  setId: string,
  files: string[]
): Promise<void> {
  const auth = { Authorization: 'Bearer ' + token }
  const jsonAuth = { ...auth, 'Content-Type': 'application/json' }

  // 1) 기존 스크린샷 제거 — 세트를 비우고 새로 채운다
  const curR = await fetch(`${A}/appScreenshotSets/${setId}/appScreenshots?limit=50`, {
    headers: auth
  })
  if (curR.ok) {
    const cur = (await curR.json()) as { data?: { id: string }[] }
    for (const d of cur.data ?? []) {
      const delR = await fetch(`${A}/appScreenshots/${d.id}`, { method: 'DELETE', headers: auth })
      if (!delR.ok && delR.status !== 404) throw new Error(`delete ${d.id}: HTTP ${delR.status}`)
    }
  }

  // 2) 순서대로 예약 → 전송 → 확정
  const uploadedIds: string[] = []
  for (const f of files) {
    const body = readFileSync(f)
    const fileName = basename(f)
    const resR = await fetch(`${A}/appScreenshots`, {
      method: 'POST',
      headers: jsonAuth,
      body: JSON.stringify({
        data: {
          type: 'appScreenshots',
          attributes: { fileName, fileSize: body.length },
          relationships: { appScreenshotSet: { data: { type: 'appScreenshotSets', id: setId } } }
        }
      })
    })
    if (!resR.ok) throw new Error(`reserve ${fileName}: HTTP ${resR.status}`)
    const resJ = (await resR.json()) as {
      data?: {
        id?: string
        attributes?: {
          uploadOperations?: {
            method?: string
            url?: string
            offset?: number
            length?: number
            requestHeaders?: { name?: string; value?: string }[]
          }[]
        }
      }
    }
    const shotId = resJ.data?.id
    const ops = resJ.data?.attributes?.uploadOperations ?? []
    if (!shotId || ops.length === 0) throw new Error(`reserve ${fileName}: no upload operation`)

    // 애플이 파일을 여러 조각으로 나눠 받으라고 지시할 수 있다 — offset·length를 그대로 따른다
    for (const op of ops) {
      if (!op.url) throw new Error(`upload ${fileName}: missing url`)
      const chunk = body.subarray(op.offset ?? 0, (op.offset ?? 0) + (op.length ?? body.length))
      const opHeaders: Record<string, string> = {}
      for (const h of op.requestHeaders ?? []) if (h.name) opHeaders[h.name] = h.value ?? ''
      const upR = await fetch(op.url, {
        method: op.method ?? 'PUT',
        headers: opHeaders,
        body: chunk
      })
      if (!upR.ok) throw new Error(`upload ${fileName}: HTTP ${upR.status}`)
    }

    const md5 = createHash('md5').update(body).digest('hex')
    const okR = await fetch(`${A}/appScreenshots/${shotId}`, {
      method: 'PATCH',
      headers: jsonAuth,
      body: JSON.stringify({
        data: {
          type: 'appScreenshots',
          id: shotId,
          attributes: { uploaded: true, sourceFileChecksum: md5 }
        }
      })
    })
    // 확정 실패는 조용히 넘기면 안 된다 — 콘솔에 '처리 중'으로 굳은 자산이 남는다
    if (!okR.ok) throw new Error(`commit ${fileName}: HTTP ${okR.status}`)
    uploadedIds.push(shotId)
  }

  // 3) 진열 순서를 명시한다. 생성 순서를 따라간다고 가정하지 않는다 — 관계를 직접 지정하면
  //    "순서가 왜 다르지"를 나중에 디버깅할 필요가 없다
  if (uploadedIds.length > 1) {
    const ordR = await fetch(`${A}/appScreenshotSets/${setId}/relationships/appScreenshots`, {
      method: 'PATCH',
      headers: jsonAuth,
      body: JSON.stringify({ data: uploadedIds.map((id) => ({ type: 'appScreenshots', id })) })
    })
    if (!ordR.ok) throw new Error(`order: HTTP ${ordR.status}`)
  }
}

const mimeOf = (path: string): string =>
  extname(path).toLowerCase() === '.png' ? 'image/png' : 'image/jpeg'

// 한 (로케일 × 이미지 종류)를 **통째로 교체**한다: 기존 전부 삭제 → 새 파일들을 순서대로 업로드.
//
// 왜 개별 추가·삭제가 아니라 세트 교체인가:
//  ① Play는 스크린샷 **순서 = 업로드 순서**라, 세트 교체가 순서 변경까지 공짜로 해결한다
//  ② 개별 삭제는 imageId가 필요한데, 그걸 추적하려면 읽기·스냅샷 타입까지 번져 나간다
//  ③ 실제로도 스크린샷은 한 장씩 고치기보다 새 세트로 갈아끼운다
//
// 실패하면 던진다 — 호출부(applyPlayEdits)가 edit을 통째로 폐기해 롤백한다(원자성 유지).
export async function replacePlayImages(
  base: string,
  editId: string,
  token: string,
  locale: string,
  imageType: string,
  files: string[]
): Promise<void> {
  const auth = { Authorization: 'Bearer ' + token }
  const path = `${base}/edits/${editId}/listings/${encodeURIComponent(locale)}/${imageType}`

  // 1) 기존 전부 삭제 (deleteall). 없으면 그냥 통과한다
  const delR = await fetch(path, { method: 'DELETE', headers: auth })
  if (!delR.ok && delR.status !== 404) {
    throw new Error(`deleteall ${imageType}/${locale}: HTTP ${delR.status}`)
  }

  // 2) 순서대로 업로드. 업로드는 별도 호스트 경로(`/upload/...`)에 원시 바이트를 보낸다
  const upBase = base.replace(
    'https://androidpublisher.googleapis.com/androidpublisher',
    'https://androidpublisher.googleapis.com/upload/androidpublisher'
  )
  for (const f of files) {
    const body = readFileSync(f)
    const r = await fetch(
      `${upBase}/edits/${editId}/listings/${encodeURIComponent(locale)}/${imageType}?uploadType=media`,
      { method: 'POST', headers: { ...auth, 'Content-Type': mimeOf(f) }, body }
    )
    if (!r.ok) {
      // 어느 파일에서 죽었는지까지 올린다 — 5장 중 3번째가 문제인 걸 모르면 다시 다 뒤진다
      throw new Error(`upload ${basename(f)} → ${imageType}/${locale}: HTTP ${r.status}`)
    }
  }
}
