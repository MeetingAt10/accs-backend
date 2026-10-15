import cors from 'cors'
import express from 'express'
import helmet from 'helmet'

import { env } from './env.js'
import { health } from './routes/health.js'

export const app = express()

app.use(helmet())
app.use(cors({ origin: env.CORS_ORIGIN }))
app.use(express.json())

app.use('/api/health', health)
