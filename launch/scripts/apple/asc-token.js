// App Store Connect API JWT 발급 (관리용 — IAP CRUD·메타데이터·스크린샷)
// App Manager 역할 키 필요 (SPEC §2.2). 2026-07-22 실키 프로브 통과.
//    Server API(영수증 검증)용 In-App Purchase 키와 혼동 금지 — 그 키로는 여기 못 쓴다.
// 사용: node asc-token.js --key <AuthKey_XXXX.p8> --kid <Key ID> --iss <Issuer ID>
const fs = require('node:fs')
const { ascToken, parseArgs, out, fail } = require('../_lib/auth')

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const keyPath = args.key || process.env.ZTO_ASC_KEY_PATH
  const keyId = args.kid || process.env.ZTO_ASC_KEY_ID
  const issuerId = args.iss || process.env.ZTO_ASC_ISSUER_ID
  if (!keyPath || !keyId || !issuerId) return fail('--key, --kid, --iss (또는 ZTO_ASC_* env) 필요')
  if (!fs.existsSync(keyPath)) return fail('p8 키 파일 없음: ' + keyPath)

  const token = ascToken({ issuerId, keyId, privateKey: fs.readFileSync(keyPath, 'utf8') })

  // 발급 확인을 겸해 앱 목록 1건 조회 (읽기 전용)
  const r = await fetch('https://api.appstoreconnect.apple.com/v1/apps?limit=1', {
    headers: { Authorization: 'Bearer ' + token }
  })
  const body = await r.json().catch(() => ({}))
  if (!r.ok) return fail('ASC API ' + r.status + ' — 키 역할(App Manager) 확인 필요', { response: body })
  out({ ok: true, token, probe: { firstApp: body.data?.[0]?.attributes?.name ?? null } })
}

main().catch((e) => fail(String(e)))
