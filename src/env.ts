import { z } from 'zod'

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().default(3000),
  SESSION_SECRET: z.string().min(32).optional(),
  // Registered users and credentials: an S3 object when the bucket is set, otherwise a JSON file.
  AUTH_STORE_FILE: z.string().default('/tmp/accs-auth-store.json'),
  AUTH_STORE_BUCKET: z.string().optional(),
  AUTH_STORE_KEY: z.string().default('auth-store.json'),
  // Comma-separated list: every ACCS site (portal, forums, ...) calls the same API with credentials.
  CORS_ORIGIN: z
    .string()
    .default('http://localhost:5173')
    .transform((value) => value.split(',').map((origin) => origin.trim()).filter(Boolean)),
})

// SESSION_SECRET is read explicitly so the Lambda build can inline it (esbuild --define).
export const env = schema.parse({ ...process.env, SESSION_SECRET: process.env.SESSION_SECRET })
