// ---------- 스토어 자산 편집 (ROADMAP #3) ----------
// 지금까지 자산은 '보기'만 됐다. 스크린샷·아이콘은 업데이트마다 만지는 것이라 값이 바로 난다.
//
// Play는 이미지 조작이 **메타와 같은 edit 안에서** 일어나고 `:commit` 하나로 원자적으로 반영된다
// → 이미 있는 `applyPlayEdits` 인프라에 그대로 얹힌다(ASC는 3단계 업로드라 별개, 후속).
//
// ⚠️ 경로 주의: 이미지 API는 이름이 `edits.images`인데 **URL은 `listings/{lang}/{type}` 아래**다.
// `edits/{id}/images/...`로 부르면 404다(2026-07-22 실측, 읽기에서 이미 겪음).
import { readFileSync } from 'fs'
import { basename, extname } from 'path'

export interface ImageInfo {
  width: number
  height: number
  bytes: number
  mime: string
  name: string
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

  // PNG: 8바이트 시그니처 + 4(len) + 4('IHDR') 다음에 width·height가 빅엔디언 4바이트씩
  if (buf.length > 24 && buf.readUInt32BE(0) === 0x89504e47) {
    return {
      width: buf.readUInt32BE(16),
      height: buf.readUInt32BE(20),
      bytes,
      mime: 'image/png',
      name
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
          name
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
