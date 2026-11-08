import { ConditionalCheckFailedException, type DynamoDBClient } from '@aws-sdk/client-dynamodb'
import request from 'supertest'
import { describe, expect, it } from 'vitest'

import { createApp } from '../src/app.js'
import { createMemoryRepository } from '../src/store.js'
import { createDynamoThrottleStore, createMemoryThrottleStore, throttleKeyOf, throttlePolicy, type ThrottleStore } from '../src/throttle.js'
import { seedPassword } from './helpers.js'

const T0 = Date.parse('2026-11-01T02:00:00.000Z')
const minute = 60 * 1000

// Applies the store's condition expressions the way DynamoDB would. `beforePut` lets a test slip in a
// competing write between the failed update and the put, as a second Lambda instance could.
function fakeDynamo(beforePut?: (items: Map<string, Record<string, any>>, key: string) => void) {
  const items = new Map<string, Record<string, any>>()
  const keyOf = (k: Record<string, any>) => `${k.PK.S}|${k.SK.S}`
  const fail = (item?: Record<string, any>) => Object.assign(new ConditionalCheckFailedException({ message: 'condition', $metadata: {} }), item ? { Item: structuredClone(item) } : {})
  const commands: string[] = []
  const client = {
    async send(command: { constructor: { name: string }; input: Record<string, any> }) {
      const { input } = command
      const values = input.ExpressionAttributeValues ?? {}
      commands.push(command.constructor.name)
      switch (command.constructor.name) {
        case 'UpdateItemCommand': {
          expect(input.ConditionExpression).toBe('entity_type = :type AND window_start > :cutoff AND attempts < :max')
          const item = items.get(keyOf(input.Key))
          const live = !!item && item.entity_type.S === values[':type'].S && item.window_start.S > values[':cutoff'].S
          if (!live || Number(item!.attempts.N) >= Number(values[':max'].N)) throw fail(input.ReturnValuesOnConditionCheckFailure === 'ALL_OLD' ? item : undefined)
          item!.attempts = { N: String(Number(item!.attempts.N) + 1) }
          item!.updated_at = values[':nowIso']
          return {}
        }
        case 'PutItemCommand': {
          const key = keyOf(input.Item)
          beforePut?.(items, key)
          expect(input.ConditionExpression).toBe('attribute_not_exists(PK) OR window_start <= :cutoff')
          const existing = items.get(key)
          if (existing && !(existing.window_start.S <= values[':cutoff'].S)) throw fail()
          items.set(key, structuredClone(input.Item))
          return {}
        }
        case 'DeleteItemCommand':
          items.delete(keyOf(input.Key))
          return {}
      }
      throw new Error(`Unexpected command ${command.constructor.name}`)
    },
  }
  return { client: client as unknown as DynamoDBClient, items, commands }
}

const stores: [string, () => ThrottleStore][] = [
  ['memory', () => createMemoryThrottleStore()],
  ['DynamoDB', () => createDynamoThrottleStore('accs-dev-ccs_identity', fakeDynamo().client)],
]

describe.each(stores)('%s throttle store', (_name, make) => {
  it('allows the configured number of attempts per window, then refuses', async () => {
    const store = make()
    for (let n = 0; n < throttlePolicy.maxAttempts; n++) expect(await store.claim('k', T0 + n * 1000)).toBe(true)
    expect(await store.claim('k', T0 + 10 * 1000)).toBe(false)
    expect(await store.claim('k', T0 + throttlePolicy.windowMs - 1)).toBe(false)
  })

  it('starts a new window once the old one is over, even if the old counter is still stored', async () => {
    const store = make()
    for (let n = 0; n < throttlePolicy.maxAttempts; n++) await store.claim('k', T0)
    expect(await store.claim('k', T0 + throttlePolicy.windowMs)).toBe(true)
    for (let n = 1; n < throttlePolicy.maxAttempts; n++) expect(await store.claim('k', T0 + throttlePolicy.windowMs + n)).toBe(true)
    expect(await store.claim('k', T0 + throttlePolicy.windowMs + 10)).toBe(false)
  })

  it('keeps keys apart and forgets a key on clear', async () => {
    const store = make()
    for (let n = 0; n < throttlePolicy.maxAttempts; n++) await store.claim('a', T0)
    expect(await store.claim('b', T0)).toBe(true)
    await store.clear('a')
    expect(await store.claim('a', T0 + 1000)).toBe(true)
  })

  it('does not let parallel attempts exceed the limit', async () => {
    const store = make()
    const results = await Promise.all(Array.from({ length: 20 }, () => store.claim('k', T0)))
    expect(results.filter(Boolean)).toHaveLength(throttlePolicy.maxAttempts)
  })
})

describe('DynamoDB throttle item', () => {
  it('stores only a hash of the key, with a TTL at the end of the window', async () => {
    const { client, items } = fakeDynamo()
    const store = createDynamoThrottleStore('accs-dev-ccs_identity', client)
    await store.claim('203.0.113.7|qcu-stu-it-a', T0)
    expect([...items.keys()]).toEqual([`${throttleKeyOf('203.0.113.7|qcu-stu-it-a').PK.S}|THROTTLE`])
    const item = [...items.values()][0]
    expect(item.PK.S).toMatch(/^THROTTLE#[0-9a-f]{64}$/)
    expect(JSON.stringify(item)).not.toMatch(/203\.0\.113\.7|qcu-stu-it-a/)
    expect(item).toMatchObject({ entity_type: { S: 'THROTTLE' }, attempts: { N: '1' }, window_start: { S: '2026-11-01T02:00:00.000Z' } })
    expect(item.expires_epoch).toEqual({ N: String((T0 + throttlePolicy.windowMs) / 1000) })
  })

  it('does not overwrite a window another instance started a moment earlier', async () => {
    let raced = false
    const { client, items } = fakeDynamo((stored, key) => {
      if (raced) return
      raced = true
      // Another instance starts the window, with its own attempt, between this instance's update and put.
      stored.set(key, { ...throttleKeyOf('k'), entity_type: { S: 'THROTTLE' }, attempts: { N: '1' }, window_start: { S: new Date(T0).toISOString() } })
    })
    const store = createDynamoThrottleStore('accs-dev-ccs_identity', client)
    expect(await store.claim('k', T0)).toBe(true)
    // Both attempts are counted: the other instance's and this one, added on the retry.
    expect([...items.values()][0].attempts).toEqual({ N: '2' })
  })

  it('refuses without writing when the window has no attempts left', async () => {
    const { client, commands } = fakeDynamo()
    const store = createDynamoThrottleStore('accs-dev-ccs_identity', client)
    for (let n = 0; n < throttlePolicy.maxAttempts; n++) await store.claim('k', T0)
    commands.length = 0
    expect(await store.claim('k', T0 + minute)).toBe(false)
    expect(commands).toEqual(['UpdateItemCommand'])
  })
})

describe('limits across instances', () => {
  // Two Lambda instances: separate apps and repositories, one shared ccs_identity table.
  const instances = () => {
    const throttleStore = createDynamoThrottleStore('accs-dev-ccs_identity', fakeDynamo().client)
    return [createApp(createMemoryRepository(), { throttleStore }), createApp(createMemoryRepository(), { throttleStore })]
  }
  const attempt = (app: ReturnType<typeof createApp>, password: string) => request(app).post('/api/auth/sign-in').send({ emailOrId: 'QCU-STU-IT-A', password })

  it('counts failed sign-ins on every instance against one limit', async () => {
    const [first, second] = instances()
    for (let n = 0; n < throttlePolicy.maxAttempts; n++) expect((await attempt(n % 2 ? first : second, 'Wrong!Passw0rd')).status).toBe(401)
    expect((await attempt(first, seedPassword)).status).toBe(429)
    expect((await attempt(second, seedPassword)).status).toBe(429)
  })

  it('clears the count for every instance after a success', async () => {
    const [first, second] = instances()
    for (let n = 0; n < throttlePolicy.maxAttempts - 1; n++) expect((await attempt(first, 'Wrong!Passw0rd')).status).toBe(401)
    expect((await attempt(second, seedPassword)).status).toBe(200)
    for (let n = 0; n < throttlePolicy.maxAttempts; n++) expect((await attempt(first, 'Wrong!Passw0rd')).status).toBe(401)
    expect((await attempt(second, seedPassword)).status).toBe(429)
  })
})
