// 모듈 1 공용 인증 — 실런칭(2026-07-18) 검증 코드 이관
const crypto = require('node:crypto')

const b64url = (s) =>
  Buffer.from(s).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')

// Google Play: 서비스 계정 JSON → RS256 JWT → androidpublisher 액세스 토큰
async function googleToken(sa) {
  const now = Math.floor(Date.now() / 1000)
  const head = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }))
  const claim = b64url(
    JSON.stringify({
      iss: sa.client_email,
      scope: 'https://www.googleapis.com/auth/androidpublisher',
      aud: 'https://oauth2.googleapis.com/token',
      iat: now,
      exp: now + 3600
    })
  )
  const sig = b64url(
    crypto.createSign('RSA-SHA256').update(head + '.' + claim).sign(sa.private_key)
  )
  const r = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body:
      'grant_type=' +
      encodeURIComponent('urn:ietf:params:oauth:grant-type:jwt-bearer') +
      '&assertion=' +
      head +
      '.' +
      claim +
      '.' +
      sig
  })
  if (!r.ok) throw new Error('google token ' + r.status + ' ' + (await r.text()))
  return (await r.json()).access_token
}

// App Store Connect API: App Manager 키 (ES256) → 관리용 JWT
// ⚠️ Server API(영수증 검증)용 키와 다르다 — App Manager 역할 키 필요 (SPEC §2.2)
function ascToken({ issuerId, keyId, privateKey }) {
  const now = Math.floor(Date.now() / 1000)
  const head = b64url(JSON.stringify({ alg: 'ES256', kid: keyId, typ: 'JWT' }))
  const claim = b64url(
    JSON.stringify({ iss: issuerId, iat: now, exp: now + 1200, aud: 'appstoreconnect-v1' })
  )
  const sig = b64url(
    crypto
      .createSign('SHA256')
      .update(head + '.' + claim)
      .sign({ key: privateKey, dsaEncoding: 'ieee-p1363' })
  )
  return head + '.' + claim + '.' + sig
}

// CLI 공통: --flag value 파싱
function parseArgs(argv) {
  const args = {}
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) {
      args[argv[i].slice(2)] = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true
    }
  }
  return args
}

// CLI 공통: 결과는 stdout에 JSON 한 덩어리 (Electron/Claude 양쪽에서 파싱)
function out(obj) {
  process.stdout.write(JSON.stringify(obj, null, 2) + '\n')
}

function fail(message, extra = {}) {
  process.stdout.write(JSON.stringify({ ok: false, error: message, ...extra }, null, 2) + '\n')
  process.exit(1)
}

module.exports = { googleToken, ascToken, parseArgs, out, fail }
