import { z } from 'zod'

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().default(3000),
  // App table from accs-architecture (adr/0003); the Lambda sets it. Holds SESSION items; required on Lambda.
  TABLE_NAME: z.string().min(1).optional(),
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

export const env = schema.parse(process.env)
export const onLambda = !!process.env.AWS_LAMBDA_FUNCTION_NAME
