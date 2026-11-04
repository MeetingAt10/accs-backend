import type { Response } from 'express'
import type { z } from 'zod'

/** Sends a response only if it matches its schema, which also drops fields the schema does not name. */
export function send<T>(res: Response, schema: z.ZodType<T>, value: unknown, status = 200) {
  const parsed = schema.safeParse(value)
  if (!parsed.success) throw new Error('API response did not match its schema')
  res.status(status).json(parsed.data)
}
