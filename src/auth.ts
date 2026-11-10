import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3'

import { env, onLambda } from './env.js'
import type { User } from './schemas.js'

// Password hashing: scrypt, stored as `scrypt$<salt b64>$<hash b64>`.
const scryptOptions = { N: 16384, r: 8, p: 1 }

export function hashPassword(password: string) {
  const salt = randomBytes(16)
  return `scrypt$${salt.toString('base64')}$${scryptSync(password, salt, 64, scryptOptions).toString('base64')}`
}

export function verifyPassword(password: string, stored: string) {
  const [scheme, salt, hash] = stored.split('$')
  if (scheme !== 'scrypt' || !salt || !hash) return false
  const expected = Buffer.from(hash, 'base64')
  const actual = scryptSync(password, Buffer.from(salt, 'base64'), expected.length, scryptOptions)
  return actual.length === expected.length && timingSafeEqual(actual, expected)
}

/** Returns a message when the password is too weak, otherwise undefined. */
export function passwordProblem(password: string) {
  if (password.length < 10) return 'Use at least 10 characters.'
  if (!/[a-z]/.test(password)) return 'Add a lowercase letter.'
  if (!/[A-Z]/.test(password)) return 'Add an uppercase letter.'
  if (!/\d/.test(password)) return 'Add a number.'
  if (!/[^A-Za-z0-9]/.test(password)) return 'Add a symbol.'
  return undefined
}

// Every seeded active user signs in with this until they set their own password.
// Deployed stacks set SEED_PASSWORD. Production without it gets an unguessable random value, which disables seeded
// sign-in (an empty SeedPassword stack parameter). The built-in value is public, so it is used only for local runs and
// tests; a deployed stack whose NODE_ENV is not production fails at startup instead of falling back to it.
export function resolveSeedPassword(options: { seedPassword?: string; nodeEnv: string; onLambda: boolean }) {
  if (options.seedPassword) return options.seedPassword
  if (options.nodeEnv === 'production') return randomBytes(32).toString('base64url')
  if (options.onLambda)
    throw new Error(`SEED_PASSWORD is not set and NODE_ENV is "${options.nodeEnv}" on Lambda. Set NODE_ENV=production (an empty SEED_PASSWORD then disables seeded sign-in) or set SEED_PASSWORD; the built-in password is for local runs and tests only.`)
  return 'Accs@Qcu2026!'
}
export const defaultPassword = resolveSeedPassword({ seedPassword: env.SEED_PASSWORD, nodeEnv: env.NODE_ENV, onLambda })
let cachedDefaultHash: string | undefined
export const defaultHash = () => (cachedDefaultHash ??= hashPassword(defaultPassword))

export type AuthData = {
  /** Accounts created after the seed, and changes to seeded ones: a record here replaces the seeded user with the same ID. */
  users: User[]
  credentials: Record<string, string>
  /** Faculty IDs who advise each year level ("1" to "4"). A student's adviser follows from their year and program. */
  advisorAssignments: Record<string, string[]>
}

/** `update` runs `mutate` on a fresh copy and persists it; if `mutate` throws, nothing is saved. */
export interface AuthStore {
  load(): Promise<AuthData>
  update(mutate: (data: AuthData) => void): Promise<void>
}

const empty = (): AuthData => ({ users: [], credentials: {}, advisorAssignments: {} })
// Reset codes moved to ccs_identity; a leftover `resets` key in an old object is dropped on the next write.
const parse = (text: string): AuthData => {
  const { users, credentials, advisorAssignments } = { ...empty(), ...JSON.parse(text) } as AuthData
  return { users, credentials, advisorAssignments }
}

function simpleStore(read: () => AuthData, write: (data: AuthData) => void): AuthStore {
  return {
    async load() {
      return read()
    },
    async update(mutate) {
      const next = structuredClone(read())
      mutate(next)
      write(next)
    },
  }
}

export function createMemoryAuthStore(): AuthStore {
  let data = empty()
  return simpleStore(() => data, (next) => { data = next })
}

export function createFileAuthStore(file: string): AuthStore {
  return simpleStore(
    () => {
      try {
        return parse(readFileSync(file, 'utf8'))
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return empty()
        throw error
      }
    },
    (next) => {
      mkdirSync(dirname(file), { recursive: true })
      const tmp = `${file}.${process.pid}.tmp`
      writeFileSync(tmp, JSON.stringify(next), { mode: 0o600 })
      renameSync(tmp, file)
    },
  )
}

const statusOf = (error: unknown) => (error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode

// A write that loses the ETag race reloads and runs `mutate` again, up to this many times in all.
const writeAttempts = 5

/** Every write attempt lost the race to other writers. The app answers 409 so the client can try again. */
export class AuthStoreConflict extends Error {
  constructor(options?: ErrorOptions) {
    super('Someone else changed this at the same time. Try again.', options)
    this.name = 'AuthStoreConflict'
  }
}

export function createS3AuthStore(bucket: string, key: string, s3 = new S3Client({})): AuthStore {
  let cache = { etag: undefined as string | undefined, data: empty(), checkedAt: 0 }
  // Requests that arrive while the cached copy is being refreshed wait for that one GET instead of sending their own.
  let refreshing: Promise<typeof cache> | undefined
  // Counts this instance's own saves. A GET that was already under way when one landed carries an older copy, so it is dropped.
  let saves = 0

  function fetch(force: boolean) {
    if (force) return refresh()
    if (Date.now() - cache.checkedAt < 2000) return Promise.resolve(cache)
    return (refreshing ??= refresh().finally(() => { refreshing = undefined }))
  }

  // Conditional GET: a 304 keeps the cached copy; a missing object is an empty store.
  async function refresh() {
    const savesBefore = saves
    try {
      const response = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key, IfNoneMatch: cache.etag }))
      const data = parse(await response.Body!.transformToString())
      if (saves === savesBefore) cache = { etag: response.ETag, data, checkedAt: Date.now() }
    } catch (error) {
      const status = statusOf(error)
      if (saves !== savesBefore && (status === 304 || status === 404)) return cache
      if (status === 304) cache = { ...cache, checkedAt: Date.now() }
      else if (status === 404) cache = { etag: undefined, data: empty(), checkedAt: Date.now() }
      else throw error
    }
    return cache
  }

  return {
    async load() {
      return (await fetch(false)).data
    },
    async update(mutate) {
      for (let attempt = 0; ; attempt++) {
        const { etag, data } = await fetch(true)
        const next = structuredClone(data)
        mutate(next)
        try {
          const response = await s3.send(new PutObjectCommand({
            Bucket: bucket,
            Key: key,
            Body: JSON.stringify(next),
            ContentType: 'application/json',
            ...(etag ? { IfMatch: etag } : { IfNoneMatch: '*' }),
          }))
          saves++
          cache = { etag: response.ETag, data: next, checkedAt: Date.now() }
          return
        } catch (error) {
          // Someone else wrote first: reload and run `mutate` on their version, after a short random pause.
          const lostRace = statusOf(error) === 412 || statusOf(error) === 409
          if (lostRace && attempt + 1 < writeAttempts) {
            await new Promise((resolve) => setTimeout(resolve, 20 * (attempt + 1) + Math.random() * 60))
            continue
          }
          if (lostRace) throw new AuthStoreConflict({ cause: error })
          throw error
        }
      }
    },
  }
}

export function createAuthStore(): AuthStore {
  if (env.NODE_ENV === 'test') return createMemoryAuthStore()
  if (env.AUTH_STORE_BUCKET) return createS3AuthStore(env.AUTH_STORE_BUCKET, env.AUTH_STORE_KEY)
  return createFileAuthStore(env.AUTH_STORE_FILE)
}
