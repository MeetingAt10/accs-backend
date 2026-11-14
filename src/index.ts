import { app } from './app.js'
import { env } from './env.js'
import { flushTelemetry, telemetryEnabled } from './telemetry.js'

app.listen(env.PORT, () => {
  console.log(`API listening on :${env.PORT}`)
})

if (telemetryEnabled()) setInterval(flushTelemetry, 5000).unref()
