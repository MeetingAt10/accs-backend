import type { S3Client } from '@aws-sdk/client-s3'
import request from 'supertest'
import { describe, expect, it } from 'vitest'

import { createApp } from '../src/app.js'
import { AuthStoreConflict, createMemoryAuthStore, createS3AuthStore } from '../src/auth.js'
import { createMemoryRepository } from '../src/store.js'
import { seedPassword } from './helpers.js'

const failure = (status: number) => Object.assign(new Error(`HTTP ${status}`), { $metadata: { httpStatusCode: status } })

/** A bucket with one object and real ETag rules: a conditional GET answers 304, and a write needs the current ETag. */
function fakeBucket() {
  let body: string | undefined
  let version = 0
  const etag = () => `"v${version}"`
  const puts: string[] = []
  let gets = 0
  // While set, another writer always gets in first, so every write is refused.
  let contended = false
  const client = {
    async send(command: { constructor: { name: string }; input: Record<string, any> }) {
      const { input } = command
      if (command.constructor.name === 'GetObjectCommand') {
        gets++
        if (body === undefined) throw failure(404)
        if (input.IfNoneMatch === etag()) throw failure(304)
        return { ETag: etag(), Body: { transformToString: async () => body! } }
      }
      puts.push(input.IfMatch ?? input.IfNoneMatch)
      if (contended) throw failure(412)
      if (input.IfMatch ? input.IfMatch !== etag() : body !== undefined) throw failure(412)
      body = input.Body
      version++
      return { ETag: etag() }
    },
  }
  return { client: client as unknown as S3Client, puts, gets: () => gets, contend: () => { contended = true }, read: () => JSON.parse(body ?? '{}'), overwrite: (next: object) => { body = JSON.stringify(next); version++ } }
}

describe('S3 auth store', () => {
  it('starts empty, with no adviser assignments', async () => {
    const { client } = fakeBucket()
    expect(await createS3AuthStore('bucket', 'key', client).load()).toEqual({ users: [], credentials: {}, advisorAssignments: {} })
    expect(await createMemoryAuthStore().load()).toEqual({ users: [], credentials: {}, advisorAssignments: {} })
  })

  it('reads an object written before adviser assignments existed', async () => {
    const bucket = fakeBucket()
    bucket.overwrite({ users: [], credentials: { a: 'hash' }, resets: { old: 1 } })
    expect(await createS3AuthStore('bucket', 'key', bucket.client).load()).toEqual({ users: [], credentials: { a: 'hash' }, advisorAssignments: {} })
  })

  it('runs the change again on the version the other instance wrote when two instances write together', async () => {
    const bucket = fakeBucket()
    const [first, second] = [createS3AuthStore('bucket', 'key', bucket.client), createS3AuthStore('bucket', 'key', bucket.client)]
    await first.update((data) => { data.credentials.base = 'x' })
    let runs = 0
    await Promise.all([
      first.update((data) => { runs++; data.credentials.first = 'a' }),
      second.update((data) => { runs++; data.credentials.second = 'b' }),
    ])
    expect(bucket.read().credentials).toEqual({ base: 'x', first: 'a', second: 'b' })
    expect(runs).toBeGreaterThan(2)
  })

  it('keeps trying through several lost races before it gives up', async () => {
    const bucket = fakeBucket()
    const store = createS3AuthStore('bucket', 'key', bucket.client)
    await store.update((data) => { data.credentials.base = 'x' })
    // Another writer gets in ahead of each of the next three attempts.
    let rival = 0
    const runs: number[] = []
    await store.update((data) => {
      runs.push(runs.length)
      if (rival++ < 3) bucket.overwrite({ ...bucket.read(), credentials: { ...bucket.read().credentials, [`rival${rival}`]: 'r' } })
      data.credentials.mine = 'm'
    })
    expect(runs).toHaveLength(4)
    expect(Object.keys(bucket.read().credentials).sort()).toEqual(['base', 'mine', 'rival1', 'rival2', 'rival3'])
  })

  it('stops after five attempts and saves nothing from the last one', async () => {
    const bucket = fakeBucket()
    const store = createS3AuthStore('bucket', 'key', bucket.client)
    await store.update((data) => { data.credentials.base = 'x' })
    let runs = 0
    await expect(store.update((data) => {
      runs++
      bucket.overwrite({ ...bucket.read(), credentials: { ...bucket.read().credentials, [`rival${runs}`]: 'r' } })
      data.credentials.mine = 'm'
    })).rejects.toSatisfy((error) => error instanceof AuthStoreConflict && (error.cause as { $metadata: { httpStatusCode: number } }).$metadata.httpStatusCode === 412)
    expect(runs).toBe(5)
    expect(bucket.read().credentials.mine).toBeUndefined()
  })

  it('saves nothing when the change throws, and does not retry other failures', async () => {
    const bucket = fakeBucket()
    const store = createS3AuthStore('bucket', 'key', bucket.client)
    await store.update((data) => { data.credentials.base = 'x' })
    await expect(store.update((data) => { data.credentials.lost = 'y'; throw new Error('refused') })).rejects.toThrow('refused')
    expect(bucket.read().credentials).toEqual({ base: 'x' })
    expect(bucket.puts).toHaveLength(1)
  })

  it('lands every write when four instances write at once', async () => {
    const bucket = fakeBucket()
    const stores = Array.from({ length: 4 }, () => createS3AuthStore('bucket', 'key', bucket.client))
    await stores[0]!.update((data) => { data.credentials.base = 'x' })
    // Each lost race means another writer saved, so with four writers no one loses more than three times.
    await Promise.all(stores.map((store, i) => store.update((data) => { data.credentials[`w${i}`] = String(i) })))
    expect(bucket.read().credentials).toEqual({ base: 'x', w0: '0', w1: '1', w2: '2', w3: '3' })
  })

  it('sends one GET for loads that arrive together, then serves the cached copy', async () => {
    const bucket = fakeBucket()
    bucket.overwrite({ users: [], credentials: { a: 'hash' } })
    const store = createS3AuthStore('bucket', 'key', bucket.client)
    const loaded = await Promise.all(Array.from({ length: 10 }, () => store.load()))
    expect(bucket.gets()).toBe(1)
    expect(new Set(loaded).size).toBe(1)
    expect(loaded[0]!.credentials).toEqual({ a: 'hash' })
    await store.load()
    expect(bucket.gets()).toBe(1)
  })

  it('lets the next load retry after a failed GET instead of reusing the failure', async () => {
    const bucket = fakeBucket()
    let fail = true
    const client = { send: (command: never) => (fail ? Promise.reject(failure(500)) : bucket.client.send(command)) } as unknown as S3Client
    const store = createS3AuthStore('bucket', 'key', client)
    await expect(Promise.all([store.load(), store.load()])).rejects.toMatchObject({ $metadata: { httpStatusCode: 500 } })
    fail = false
    expect(await store.load()).toEqual({ users: [], credentials: {}, advisorAssignments: {} })
  })

  it('keeps its own newer save when a GET that started earlier finishes after it', async () => {
    const bucket = fakeBucket()
    bucket.overwrite({ users: [], credentials: { a: 'old' } })
    // Hold the first GET's answer until after the save below has landed.
    let release!: () => void
    const held = new Promise<void>((resolve) => { release = resolve })
    let calls = 0
    const client = {
      async send(command: { constructor: { name: string } }) {
        if (command.constructor.name !== 'GetObjectCommand' || calls++ > 0) return bucket.client.send(command as never)
        // Read the body now, as S3 would have sent it, and deliver it late.
        const answer = await bucket.client.send(command as never) as { ETag: string; Body: { transformToString(): Promise<string> } }
        const text = await answer.Body.transformToString()
        await held
        return { ETag: answer.ETag, Body: { transformToString: async () => text } }
      },
    } as unknown as S3Client
    const store = createS3AuthStore('bucket', 'key', client)
    const slowLoad = store.load()
    await store.update((data) => { data.credentials.a = 'new' })
    release()
    await slowLoad
    expect((await store.load()).credentials).toEqual({ a: 'new' })
  })
})

describe('auth store conflicts through the API', () => {
  it('answers 409, not 500, when every write loses the race, and keeps the old password', async () => {
    const bucket = fakeBucket()
    const app = createApp(createMemoryRepository(), { authStore: createS3AuthStore('bucket', 'key', bucket.client) })
    const agent = request.agent(app)
    expect((await agent.post('/api/auth/sign-in').send({ emailOrId: 'QCU-STU-IT-A', password: seedPassword })).status).toBe(200)

    bucket.contend()
    const changed = await agent.post('/api/auth/change-password').send({ currentPassword: seedPassword, password: 'N3w!Passw0rdXyz' })
    expect(changed.status).toBe(409)
    expect(changed.body).toEqual({ error: 'Someone else changed this at the same time. Try again.', code: 'CONFLICT' })
    expect(bucket.read().credentials?.['QCU-STU-IT-A']).toBeUndefined()
    expect((await request(app).post('/api/auth/sign-in').send({ emailOrId: 'QCU-STU-IT-A', password: seedPassword })).status).toBe(200)
  })
})
