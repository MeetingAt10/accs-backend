import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3'

import { env } from './env.js'
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
export const defaultPassword = 'Accs@Qcu2026!'
let cachedDefaultHash: string | undefined
export const defaultHash = () => (cachedDefaultHash ??= hashPassword(defaultPassword))

export type AuthData = {
  users: User[]
  credentials: Record<string, string>
}

/** `update` runs `mutate` on a fresh copy and persists it; if `mutate` throws, nothing is saved. */
export interface AuthStore {
  load(): Promise<AuthData>
  update(mutate: (data: AuthData) => void): Promise<void>
}

const empty = (): AuthData => ({ users: [], credentials: {} })
// Reset codes moved to ccs_identity; a leftover `resets` key in an old object is dropped on the next write.
const parse = (text: string): AuthData => {
  const { users, credentials } = { ...empty(), ...JSON.parse(text) } as AuthData
  return { users, credentials }
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

export function createS3AuthStore(bucket: string, key: string): AuthStore {
  const s3 = new S3Client({})
  let cache = { etag: undefined as string | undefined, data: empty(), checkedAt: 0 }

  // Conditional GET: a 304 keeps the cached copy; a missing object is an empty store.
  async function fetch(force: boolean) {
    if (!force && Date.now() - cache.checkedAt < 2000) return cache
    try {
      const response = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key, IfNoneMatch: cache.etag }))
      cache = { etag: response.ETag, data: parse(await response.Body!.transformToString()), checkedAt: Date.now() }
    } catch (error) {
      const status = statusOf(error)
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
          cache = { etag: response.ETag, data: next, checkedAt: Date.now() }
          return
        } catch (error) {
          // Someone else wrote first: reload and retry once.
          if (attempt === 0 && (statusOf(error) === 412 || statusOf(error) === 409)) continue
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
