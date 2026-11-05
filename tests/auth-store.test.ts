import type { S3Client } from '@aws-sdk/client-s3'
import { describe, expect, it } from 'vitest'

import { createMemoryAuthStore, createS3AuthStore } from '../src/auth.js'

const failure = (status: number) => Object.assign(new Error(`HTTP ${status}`), { $metadata: { httpStatusCode: status } })

/** A bucket with one object and real ETag rules: a conditional GET answers 304, and a write needs the current ETag. */
function fakeBucket() {
  let body: string | undefined
  let version = 0
  const etag = () => `"v${version}"`
  const puts: string[] = []
  const client = {
    async send(command: { constructor: { name: string }; input: Record<string, any> }) {
      const { input } = command
      if (command.constructor.name === 'GetObjectCommand') {
        if (body === undefined) throw failure(404)
        if (input.IfNoneMatch === etag()) throw failure(304)
        return { ETag: etag(), Body: { transformToString: async () => body! } }
      }
      puts.push(input.IfMatch ?? input.IfNoneMatch)
      if (input.IfMatch ? input.IfMatch !== etag() : body !== undefined) throw failure(412)
      body = input.Body
      version++
      return { ETag: etag() }
    },
  }
  return { client: client as unknown as S3Client, puts, read: () => JSON.parse(body ?? '{}'), overwrite: (next: object) => { body = JSON.stringify(next); version++ } }
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
    })).rejects.toMatchObject({ $metadata: { httpStatusCode: 412 } })
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
})
