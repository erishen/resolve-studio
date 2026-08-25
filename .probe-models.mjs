import 'dotenv/config'
const base = process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1'
const key = process.env.OPENAI_API_KEY
const r = await fetch(base + '/models', { headers: { Authorization: 'Bearer ' + key } })
const j = await r.json().catch(() => null)
console.log('status', r.status)
console.log('BASE', base)
if (Array.isArray(j?.data)) {
  console.log('MODELS:', j.data.map((m) => m.id).join(', '))
} else {
  console.log(JSON.stringify(j).slice(0, 600))
}
