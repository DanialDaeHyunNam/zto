// One-time product 업서트 (생성 겸 수정) — SPEC §2.1, 2026-07-18 실런칭에서 검증된 신 API
// ⚠️ 구 inappproducts.insert는 신규 앱에서 403 — oneTimeProducts:batchUpdate를 쓴다.
// ⚠️ newRegionsConfig는 넣지 말 것 (enum 불일치로 400 — 생략하면 통과).
// 사용: node otp-upsert.js --sa <sa.json> --answers <answers.json> [--product <productId>]
//   answers 시트의 iap[] 전체(또는 --product 하나)를 업서트한다.
const fs = require('node:fs')
const { googleToken, parseArgs, out, fail } = require('../_lib/auth')

function toRequest(pkg, p) {
  return {
    oneTimeProduct: {
      packageName: pkg,
      productId: p.productId,
      listings: Object.entries(p.listings).map(([languageCode, l]) => ({
        languageCode,
        title: l.title,
        description: l.description
      })),
      purchaseOptions: [
        {
          purchaseOptionId: 'buy',
          buyOption: {},
          regionalPricingAndAvailabilityConfigs: Object.entries(p.price).map(
            ([regionCode, units]) => ({
              regionCode,
              price: { currencyCode: p.currency[regionCode], units: String(units) },
              availability: 'AVAILABLE'
            })
          )
        }
      ]
    },
    updateMask: 'listings,purchaseOptions',
    allowMissing: true,
    regionsVersion: { version: '2025/01' }
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const saPath = args.sa || process.env.ZTO_GOOGLE_SA_PATH
  if (!saPath || !args.answers) return fail('--sa, --answers 필요')
  const sheet = JSON.parse(fs.readFileSync(args.answers, 'utf8'))
  const pkg = sheet.app.packageName
  let products = sheet.iap || []
  if (args.product) products = products.filter((p) => p.productId === args.product)
  if (!products.length) return fail('업서트할 상품 없음 (answers.iap 또는 --product 확인)')

  const token = await googleToken(JSON.parse(fs.readFileSync(saPath, 'utf8')))
  const url = `https://androidpublisher.googleapis.com/androidpublisher/v3/applications/${encodeURIComponent(pkg)}/oneTimeProducts:batchUpdate`
  const r = await fetch(url, {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
    body: JSON.stringify({ requests: products.map((p) => toRequest(pkg, p)) })
  })
  const body = await r.json().catch(() => ({}))
  if (!r.ok) return fail('batchUpdate ' + r.status, { response: body })
  out({ ok: true, upserted: products.map((p) => p.productId), response: body })
}

main().catch((e) => fail(String(e)))
