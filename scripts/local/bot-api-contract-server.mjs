// REHEARSAL / E2E ONLY: local server implementing the Telegram Bot API
// sendMessage and getMe contract. Used by the E2E suite and to rehearse the
// live-notification branch of the production smoke when api.telegram.org is
// unreachable. Not a substitute for a live check.
import { appendFileSync } from 'node:fs'
import { createServer } from 'node:http'
import process from 'node:process'
let id = 1000
createServer((req, res) => {
  let raw = ''
  req.on('data', (c) => (raw += c))
  req.on('end', () => {
    if (req.url === '/') return res.writeHead(200).end('ok')
    if (/^\/bot[^/]+\/getMe$/.test(req.url ?? '')) {
      return res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ ok: true, result: { id: 1, is_bot: true, username: 'detailflow_e2e_bot' } }))
    }
    const ok = /^\/bot[^/]+\/sendMessage$/.test(req.url ?? '')
    if (ok) appendFileSync(process.argv[2] ?? '.local/bot-api-received.jsonl', JSON.stringify({ at: new Date().toISOString(), ...JSON.parse(raw || '{}') }) + '\n')
    res.writeHead(ok ? 200 : 404, { 'content-type': 'application/json' }).end(JSON.stringify(ok ? { ok: true, result: { message_id: ++id } } : { ok: false, error_code: 404, description: 'Not Found' }))
  })
}).listen(54399, '127.0.0.1')
