import express from 'express'
import request from 'supertest'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { flushTelemetry, requestTelemetry } from '../src/telemetry.js'

const tiny = () => {
  const app = express()
  app.use(requestTelemetry)
  app.get('/x/:id', (_req, res) => { res.json({ ok: true }) })
  return app
}
const trace = 'a'.repeat(32)
let fetchMock: ReturnType<typeof vi.fn>

beforeEach(() => { fetchMock = vi.fn(async () => new Response('{}')); vi.stubGlobal('fetch', fetchMock) })
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs() })

describe('telemetry', () => {
  it('posts spans and logs with the auth header', async () => {
    vi.stubEnv('OTEL_EXPORTER_OTLP_ENDPOINT', 'https://otlp.example/otlp')
    vi.stubEnv('OTEL_EXPORTER_OTLP_HEADERS', 'Authorization=Basic abc==')
    await request(tiny()).get('/x/42?secret=1').set('traceparent', `00-${trace}-${'b'.repeat(16)}-01`)
    await flushTelemetry()
    const calls = fetchMock.mock.calls as [string, RequestInit][]
    expect(calls.map(c => c[0]).sort()).toEqual(['https://otlp.example/otlp/v1/logs', 'https://otlp.example/otlp/v1/traces'])
    for (const [, init] of calls) {
      expect((init.headers as Record<string, string>).Authorization).toBe('Basic abc==')
      expect(init.body as string).not.toContain('secret')
      expect(init.body as string).toContain(trace)
    }
    const span = JSON.parse(calls.find(c => c[0].endsWith('/v1/traces'))![1].body as string).resourceSpans[0].scopeSpans[0].spans[0]
    expect(span.name).toBe('GET /x/:id')
    expect(span.parentSpanId).toBe('b'.repeat(16))
    expect(span.attributes).toContainEqual({ key: 'http.response.status_code', value: { intValue: '200' } })
  })

  it('sends nothing when the endpoint is unset', async () => {
    vi.stubEnv('OTEL_EXPORTER_OTLP_ENDPOINT', '')
    await request(tiny()).get('/x/1')
    await flushTelemetry()
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
