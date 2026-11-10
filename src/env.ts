import { z } from 'zod'

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().default(3000),
  // DynamoDB tables are <TABLE_PREFIX><DOC006 table>, e.g. accs-dev-ccs_identity (accs-architecture adr/0004).
  // The Lambda sets it; required there.
  TABLE_PREFIX: z.string().min(1).optional(),
  // Registered users and credentials: an S3 object when the bucket is set, otherwise a JSON file.
  AUTH_STORE_FILE: z.string().default('/tmp/accs-auth-store.json'),
  AUTH_STORE_BUCKET: z.string().optional(),
  AUTH_STORE_KEY: z.string().default('auth-store.json'),
  // Shared sign-in password of the seeded accounts. Deployed stacks set it (stack parameter SeedPassword);
  // without it, production disables seeded sign-in, local runs and tests use the built-in default in auth.ts, and
  // Lambda with any other NODE_ENV fails at startup.
  SEED_PASSWORD: z.string().min(10).optional(),
  // Sender of password reset emails, a verified Amazon SES identity. Without it, local runs log the code and
  // production leaves resets to an administrator (src/mail.ts).
  MAIL_FROM: z.email().optional(),
  // Comma-separated list: every ACCS site (portal, forums, ...) calls the same API with credentials.
  CORS_ORIGIN: z
    .string()
    .default('http://localhost:5173')
    .transform((value) => value.split(',').map((origin) => origin.trim()).filter(Boolean)),
})

export const env = schema.parse(process.env)
export const onLambda = !!process.env.AWS_LAMBDA_FUNCTION_NAME

// The twelve DOC006 domain tables.
export type DomainTable = 'ccs_identity' | 'ccs_academic' | 'ccs_community' | 'ccs_messaging' | 'ccs_moderation' | 'ccs_scheduling' | 'ccs_grievance' | 'ccs_evaluation' | 'ccs_discipline' | 'ccs_notification' | 'ccs_assistant' | 'ccs_audit'
export const tableName = (table: DomainTable) => (env.TABLE_PREFIX ? `${env.TABLE_PREFIX}${table}` : undefined)
