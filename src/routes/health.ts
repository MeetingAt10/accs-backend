import { Router } from 'express'
import { healthResponseSchema } from '../schemas.js'

export const health = Router()
health.get('/', (_req, res) => { res.json(healthResponseSchema.parse({ status: 'ok' })) })
