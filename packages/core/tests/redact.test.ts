import { test } from 'node:test'
import assert from 'node:assert/strict'
import { redactSecrets } from '../src/util/redact.js'

// NOTE: sample values below are deliberately plain placeholders (not real key
// shapes) so the gitleaks pre-commit scan does not flag them as leaked secrets.

test('redacts Bearer tokens in an Authorization header', () => {
  const out = redactSecrets('Authorization: Bearer demo-bearer-value tail')
  assert.match(out, /Authorization: \[REDACTED\]/)
  assert.doesNotMatch(out, /demo-bearer-value/)
})

test('redacts a bare Bearer token without an Authorization header', () => {
  const out = redactSecrets('call with Bearer demo-bearer-value here')
  assert.match(out, /Bearer \[REDACTED\]/)
  assert.doesNotMatch(out, /demo-bearer-value/)
})

test('redacts non-Bearer Authorization headers', () => {
  const out = redactSecrets('Authorization: Basic demo-credential')
  assert.match(out, /Authorization: \[REDACTED\]/)
  assert.doesNotMatch(out, /demo-credential/)
})

test('redacts Cookie / Set-Cookie headers', () => {
  const out = redactSecrets(
    'Cookie: PHPSESSID=demo-sess; token=xyz\nSet-Cookie: sid=demo-sid; HttpOnly',
  )
  assert.match(out, /Cookie: \[REDACTED\]/)
  assert.match(out, /Set-Cookie: \[REDACTED\]/)
  assert.doesNotMatch(out, /demo-sess|demo-sid/)
})

test('redacts bare OpenAI-style sk- keys', () => {
  // sk-your-key-here is an allowlisted placeholder in .gitleaks.toml.
  const out = redactSecrets('using key sk-your-key-here now')
  assert.match(out, /sk-\[REDACTED\]/)
  assert.doesNotMatch(out, /your-key-here/)
})

test('redacts key=value / key: value credential pairs', () => {
  const cases = [
    'OPENAI_API_KEY=demo-openai-key',
    'api_key: demo-api-key',
    'secret=demo-secret-value',
    'password=demo-password',
    'access_token=demo-access-token',
    'APP_SECRET=demo-app-secret',
  ]
  for (const c of cases) {
    const out = redactSecrets(c)
    assert.match(out, /\[REDACTED\]/, `expected redaction in: ${c}`)
    // the trailing secret value must not survive
    assert.doesNotMatch(
      out,
      /demo-openai-key|demo-api-key|demo-secret-value|demo-password|demo-access-token|demo-app-secret/,
    )
  }
})

test('keeps plain prose that merely mentions a credential word', () => {
  const prose = 'The planner finished; each step emits a progress token for the UI panel.'
  assert.equal(redactSecrets(prose), prose)
})

test('leaves empty/undefined-like input untouched', () => {
  assert.equal(redactSecrets(''), '')
})
