import 'dotenv/config'
import { readFileSync } from 'node:fs'
const env = {}
try {
  for (const line of readFileSync(new URL('../../.env', import.meta.url), 'utf8').split('\n')) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/)
    if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, '')
  }
} catch {}
const base = env.OPENAI_BASE_URL || process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1'
const key = env.OPENAI_API_KEY || process.env.OPENAI_API_KEY
const r = await fetch(base + '/models', { headers: { Authorization: 'Bearer ' + key } })
const j = await r.json().catch(() => null)
console.log('status', r.status, 'BASE', base)
if (Array.isArray(j?.data)) console.log('MODELS:', j.data.map((m) => m.id).join(', '))
else console.log(JSON.stringify(j).slice(0, 600))
