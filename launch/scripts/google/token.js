// Google Play 액세스 토큰 발급 (스모크 테스트 겸 다른 스크립트의 부품)
// 사용: node token.js --sa <service-account.json 경로>
const fs = require('node:fs')
const { googleToken, parseArgs, out, fail } = require('../_lib/auth')

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const saPath = args.sa || process.env.ZTO_GOOGLE_SA_PATH
  if (!saPath) return fail('--sa <경로> 또는 ZTO_GOOGLE_SA_PATH 필요')
  if (!fs.existsSync(saPath)) return fail('서비스 계정 파일 없음: ' + saPath)
  const sa = JSON.parse(fs.readFileSync(saPath, 'utf8'))
  const token = await googleToken(sa)
  out({ ok: true, access_token: token, client_email: sa.client_email })
}

main().catch((e) => fail(String(e)))
