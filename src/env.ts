import { z } from 'zod'

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().default(3000),
  SESSION_SECRET: z.string().min(32).optional(),
  CORS_ORIGIN: z.string().default('http://localhost:5173'),
})

export const env = schema.parse(process.env)
