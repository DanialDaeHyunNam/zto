// One-time product 구매 옵션 활성화 — SPEC §2.1 (업서트 후 별도 호출 필요)
// 사용: node otp-activate.js --sa <sa.json> --answers <answers.json> [--product <productId>]
const fs = require('node:fs')
const { googleToken, parseArgs, out, fail } = require('../_lib/auth')

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const saPath = args.sa || process.env.ZTO_GOOGLE_SA_PATH
  if (!saPath || !args.answers) return fail('--sa, --answers 필요')
  const sheet = JSON.parse(fs.readFileSync(args.answers, 'utf8'))
  const pkg = sheet.app.packageName
  let products = sheet.iap || []
  if (args.product) products = products.filter((p) => p.productId === args.product)
  if (!products.length) return fail('활성화할 상품 없음')

  const token = await googleToken(JSON.parse(fs.readFileSync(saPath, 'utf8')))
  const results = []
  for (const p of products) {
    const url = `https://androidpublisher.googleapis.com/androidpublisher/v3/applications/${encodeURIComponent(pkg)}/oneTimeProducts/${encodeURIComponent(p.productId)}/purchaseOptions:batchUpdateStates`
    const r = await fetch(url, {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        requests: [
          {
            activatePurchaseOptionRequest: {
              packageName: pkg,
              productId: p.productId,
              purchaseOptionId: 'buy'
            }
          }
        ]
      })
    })
    const body = await r.json().catch(() => ({}))
    results.push({ productId: p.productId, status: r.status, ok: r.ok, response: body })
  }
  const allOk = results.every((x) => x.ok)
  out({ ok: allOk, results })
  if (!allOk) process.exit(1)
}

main().catch((e) => fail(String(e)))
