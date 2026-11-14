import serverless from 'serverless-http'

import { app } from './app.js'
import { flushTelemetry } from './telemetry.js'

const inner = serverless(app)

// Lambda freezes once the handler returns, so queued traces and logs are sent before that.
export const handler: typeof inner = async (event, context) => {
  try { return await inner(event, context) } finally { await flushTelemetry() }
}
