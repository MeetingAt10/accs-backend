import { AsyncLocalStorage } from 'node:async_hooks'
import { randomBytes } from 'node:crypto'
import { format } from 'node:util'
import type { NextFunction, Request, Response } from 'express'

/**
 * Traces and logs to Grafana Cloud over OTLP/HTTP JSON, with Node's global fetch and no SDK. Everything here is a
 * no-op while OTEL_EXPORTER_OTLP_ENDPOINT is unset. The two settings are read through these exact expressions
 * because the deploy build replaces them with esbuild --define (the Lambda has no way to set them at runtime).
 * Only the method, route, path (without query string), and status of a request are recorded: never the query, body, headers, or cookies.
 */
const endpoint = () => process.env.OTEL_EXPORTER_OTLP_ENDPOINT?.replace(/\/+$/, '')
const headers = () => Object.fromEntries((process.env.OTEL_EXPORTER_OTLP_HEADERS ?? '').split(',').flatMap(pair => {
  // Split on the first "=" only: the Basic credential ends in "=" padding.
  const i = pair.indexOf('=');return i > 0 ? [[pair.slice(0, i).trim(), pair.slice(i + 1).trim()]] : []
}))
export const telemetryEnabled = () => Boolean(endpoint())

type Attrs = Record<string, string | number>
type Span = { traceId: string; spanId: string; parentSpanId?: string; name: string; kind: number; startTimeUnixNano: string; endTimeUnixNano: string; attributes: unknown[]; status: { code: number } }
type LogRecord = { timeUnixNano: string; severityNumber: number; severityText: string; body: { stringValue: string }; attributes: unknown[]; traceId?: string; spanId?: string }
type Context = { traceId: string; spanId: string; exception?: Attrs }

const MAX_BUFFER = 1000
const spans: Span[] = []
const logs: LogRecord[] = []
const context = new AsyncLocalStorage<Context>()
const push = <T>(buffer: T[], item: T) => { buffer.push(item); if (buffer.length > MAX_BUFFER) buffer.shift() }
const nano = (ms: number) => String(BigInt(Math.round(ms * 1000)) * 1000n)
const attrs = (a: Attrs) => Object.entries(a).map(([key, v]) => ({ key, value: typeof v === 'number' ? { intValue: String(v) } : { stringValue: v } }))
const severity = (level: string) => {
  const l = level.toLowerCase()
  return l === 'error' || l === 'fatal' ? { n: 17, text: 'ERROR' } : l === 'warn' || l === 'warning' ? { n: 13, text: 'WARN' } : { n: 9, text: 'INFO' }
}
const addLog = (level: string, body: string, a: Attrs = {}, ctx = context.getStore()) => {
  const s = severity(level)
  push(logs, { timeUnixNano: nano(Date.now()), severityNumber: s.n, severityText: s.text, body: { stringValue: body }, attributes: attrs(a), ...(ctx && { traceId: ctx.traceId, spanId: ctx.spanId }) })
}

const original = { log: console.log, info: console.info, warn: console.warn, error: console.error }
let initialized = false, capturing = false
/** Wraps console.* so each call still prints as before and is also queued as an OTLP log record. */
export function initTelemetry() {
  if (initialized || !telemetryEnabled()) return
  initialized = true
  for (const method of ['log', 'info', 'warn', 'error'] as const) {
    console[method] = (...args: unknown[]) => {
      original[method](...args)
      if (capturing) return
      capturing = true
      try {
        const body = format(...args);let level = method === 'log' ? 'info' : method
        // A structured line such as logUnexpected writes keeps its own level; the string stays the body.
        if (args.length === 1 && typeof args[0] === 'string') try { const parsed = JSON.parse(args[0]); if (typeof parsed?.level === 'string') level = parsed.level } catch { /* plain text */ }
        addLog(level, body)
      } finally { capturing = false }
    }
  }
}
initTelemetry()

/** Marks the current request's span with the error, for the unexpected-error path in app.ts. */
export function recordException(error: unknown) {
  const ctx = context.getStore();if (!ctx) return
  const err = error instanceof Error ? error : new Error(String(error))
  ctx.exception = { 'exception.type': err.name, 'exception.message': err.message, 'exception.stacktrace': err.stack ?? '' }
}

const traceparent = /^00-([0-9a-f]{32})-([0-9a-f]{16})-[0-9a-f]{2}$/
export function requestTelemetry(req: Request, res: Response, next: NextFunction) {
  if (!telemetryEnabled()) return next()
  initTelemetry()
  const incoming = traceparent.exec(String(req.headers.traceparent ?? ''))
  const ctx: Context = { traceId: incoming?.[1] ?? randomBytes(16).toString('hex'), spanId: randomBytes(8).toString('hex') }
  const startMs = Date.now(), t0 = performance.now()
  res.on('finish', () => {
    const duration = performance.now() - t0, status = res.statusCode
    // The route pattern (/api/pages/:pageId), never the raw path, keeps span names low-cardinality.
    const route = req.route ? `${req.baseUrl}${String(req.route.path)}` : undefined
    const name = route ? `${req.method} ${route}` : req.method
    push(spans, {
      traceId: ctx.traceId, spanId: ctx.spanId, ...(incoming && { parentSpanId: incoming[2] }), name, kind: 2,
      startTimeUnixNano: nano(startMs), endTimeUnixNano: nano(startMs + duration),
      attributes: attrs({ 'http.request.method': req.method, ...(route && { 'http.route': route }), 'url.path': req.originalUrl.split('?')[0], 'http.response.status_code': status, ...ctx.exception }),
      status: { code: status >= 500 ? 2 : 0 },
    })
    const ms = Math.round(duration)
    addLog(status >= 500 ? 'error' : status >= 400 ? 'warn' : 'info', `${name} ${status} ${ms}ms`, { method: req.method, ...(route && { route }), status, duration_ms: ms }, ctx)
  })
  context.run(ctx, next)
}

/** Sends and clears both buffers. Never throws: a failed send is dropped with one stderr line. */
export async function flushTelemetry() {
  const base = endpoint();if (!base) return
  const sent = { spans: spans.splice(0), logs: logs.splice(0) }
  const prefix = process.env.TABLE_PREFIX ?? ''
  const resource = { attributes: attrs({
    'service.name': 'accs-backend', 'service.namespace': 'accs',
    'deployment.environment.name': prefix.startsWith('accs-dev-') ? 'dev' : prefix.startsWith('accs-prod-') ? 'prod' : process.env.NODE_ENV ?? 'development',
    ...(process.env.AWS_LAMBDA_FUNCTION_VERSION && { 'service.version': process.env.AWS_LAMBDA_FUNCTION_VERSION }),
  }) }
  const scope = { name: 'accs-backend' }
  const post = async (path: string, body: unknown) => {
    try {
      const res = await fetch(`${base}${path}`, { method: 'POST', headers: { ...headers(), 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(2000) })
      if (!res.ok) original.error(`telemetry: ${path} answered ${res.status}`)
    } catch (error) { original.error(`telemetry: ${path} not sent (${error instanceof Error ? error.name : 'Unknown'})`) }
  }
  await Promise.all([
    sent.spans.length && post('/v1/traces', { resourceSpans: [{ resource, scopeSpans: [{ scope, spans: sent.spans }] }] }),
    sent.logs.length && post('/v1/logs', { resourceLogs: [{ resource, scopeLogs: [{ scope, logRecords: sent.logs }] }] }),
  ])
}
