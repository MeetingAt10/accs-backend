import { ConditionalCheckFailedException, type DynamoDBClient } from '@aws-sdk/client-dynamodb'
import { describe, expect, it } from 'vitest'

import { createDynamoResetStore, createMemoryResetStore, nextReset, resetPolicy, type ResetStore } from '../src/resets.js'

const T0 = Date.parse('2026-11-01T02:00:00.000Z')
const minute = 60 * 1000

describe('reset issuing rule', () => {
  it('enforces the cooldown and the hourly cap for self-service, not for an administrator', () => {
    let previous = nextReset(undefined, { userId: 'u', codeHash: 'h', now: T0 })
    if (typeof previous === 'string') throw new Error('first code must issue')
    expect(nextReset(previous, { userId: 'u', codeHash: 'h', now: T0 + 30 * 1000 })).toBe('cooldown')
    for (let n = 2; n <= resetPolicy.maxPerWindow; n++) {
      const next = nextReset(previous, { userId: 'u', codeHash: 'h', now: T0 + n * 2 * minute })
      if (typeof next === 'string') throw new Error(`code ${n} must issue`)
      expect(next.issuedCount).toBe(n)
      previous = next
    }
    expect(nextReset(previous, { userId: 'u', codeHash: 'h', now: T0 + 30 * minute })).toBe('limit')
    const admin = nextReset(previous, { userId: 'u', codeHash: 'h', now: T0 + 30 * minute, issuedBy: 'ACCS-ADMIN' })
    expect(admin).toMatchObject({ attempts: 0, issuedBy: 'ACCS-ADMIN' })
    // A new window starts the count again.
    expect(nextReset(previous, { userId: 'u', codeHash: 'h', now: T0 + 61 * minute })).toMatchObject({ issuedCount: 1, windowStart: T0 + 61 * minute })
  })
})

// The same behavior must hold for both stores.
function fakeDynamo() {
  const items = new Map<string, Record<string, any>>()
  const key = (k: Record<string, any>) => `${k.PK.S}|${k.SK.S}`
  const fail = () => new ConditionalCheckFailedException({ message: 'condition', $metadata: {} })
  const client = {
    async send(command: { constructor: { name: string }; input: Record<string, any> }) {
      const { input } = command
      const values = input.ExpressionAttributeValues ?? {}
      switch (command.constructor.name) {
        case 'GetItemCommand':
          return { Item: items.get(key(input.Key)) }
        case 'PutItemCommand': {
          const existing = items.get(key(input.Item))
          if (input.ConditionExpression === 'attribute_not_exists(PK)' && existing) throw fail()
          if (input.ConditionExpression === 'created_at = :previous' && existing?.created_at.S !== values[':previous'].S) throw fail()
          items.set(key(input.Item), structuredClone(input.Item))
          return {}
        }
        case 'UpdateItemCommand': {
          const item = items.get(key(input.Key))
          if (!item || item.entity_type.S !== values[':type'].S || Number(item.attempts.N) >= Number(values[':max'].N) || item.code_expires_at.S <= values[':nowIso'].S) throw fail()
          item.attempts = { N: String(Number(item.attempts.N) + 1) }
          return { Attributes: structuredClone(item) }
        }
        case 'DeleteItemCommand': {
          const item = items.get(key(input.Key))
          if (!item || item.code_hash.S !== values[':hash'].S) throw fail()
          items.delete(key(input.Key))
          return {}
        }
      }
      throw new Error(`Unexpected command ${command.constructor.name}`)
    },
  }
  return { client: client as unknown as DynamoDBClient, items }
}

const stores: [string, () => ResetStore][] = [
  ['memory', () => createMemoryResetStore()],
  ['DynamoDB', () => createDynamoResetStore('accs-dev-ccs_identity', fakeDynamo().client)],
]

describe.each(stores)('%s reset store', (_name, make) => {
  it('allows only the configured number of guesses per code', async () => {
    const store = make()
    expect(await store.issue({ userId: 'u', codeHash: 'h1', now: T0 })).toBe('issued')
    for (let n = 1; n <= resetPolicy.maxAttempts; n++) expect((await store.claimAttempt('u', T0 + 1000))?.attempts).toBe(n)
    expect(await store.claimAttempt('u', T0 + 1000)).toBeUndefined()
  })

  it('expires the code and makes it single use', async () => {
    const store = make()
    await store.issue({ userId: 'u', codeHash: 'h1', now: T0 })
    expect(await store.claimAttempt('u', T0 + resetPolicy.codeTtlMs)).toBeUndefined()
    expect(await store.consume('u', 'h1')).toBe(true)
    expect(await store.consume('u', 'h1')).toBe(false)
    expect(await store.claimAttempt('u', T0 + 1000)).toBeUndefined()
  })

  it('refuses to consume a replaced code', async () => {
    const store = make()
    await store.issue({ userId: 'u', codeHash: 'h1', now: T0 })
    await store.issue({ userId: 'u', codeHash: 'h2', now: T0 + 2 * minute })
    expect(await store.consume('u', 'h1')).toBe(false)
    expect(await store.consume('u', 'h2')).toBe(true)
  })

  it('applies the cooldown and keeps the hourly count across new codes', async () => {
    const store = make()
    expect(await store.issue({ userId: 'u', codeHash: 'h', now: T0 })).toBe('issued')
    expect(await store.issue({ userId: 'u', codeHash: 'h', now: T0 + 1000 })).toBe('cooldown')
    for (let n = 2; n <= resetPolicy.maxPerWindow; n++) expect(await store.issue({ userId: 'u', codeHash: 'h', now: T0 + n * 2 * minute })).toBe('issued')
    expect(await store.issue({ userId: 'u', codeHash: 'h', now: T0 + 30 * minute })).toBe('limit')
    expect(await store.issue({ userId: 'u', codeHash: 'h', now: T0 + 30 * minute, issuedBy: 'ACCS-ADMIN' })).toBe('issued')
  })
})

describe('DynamoDB reset item', () => {
  it('uses the RESET key in ccs_identity and keeps the TTL until the hourly window ends', async () => {
    const { client, items } = fakeDynamo()
    const store = createDynamoResetStore('accs-dev-ccs_identity', client)
    await store.issue({ userId: 'QCU-STU-IT-A', codeHash: 'h', now: T0 })
    const item = items.get('USER#QCU-STU-IT-A|RESET')!
    expect(item).toMatchObject({ entity_type: { S: 'RESET' }, user_id: { S: 'QCU-STU-IT-A' }, code_hash: { S: 'h' }, attempts: { N: '0' }, issued_count: { N: '1' }, window_start: { S: '2026-11-01T02:00:00.000Z' } })
    expect(item.code_expires_at).toEqual({ S: new Date(T0 + resetPolicy.codeTtlMs).toISOString() })
    expect(item.expires_epoch).toEqual({ N: String((T0 + resetPolicy.windowMs) / 1000) })
  })
})
