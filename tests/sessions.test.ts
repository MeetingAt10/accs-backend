import { ConditionalCheckFailedException, type DynamoDBClient } from '@aws-sdk/client-dynamodb'
import { describe, expect, it } from 'vitest'

import { createDynamoSessionStore, sessionPolicy, sessionState, type Session } from '../src/sessions.js'

type Sent = { name: string; input: Record<string, any> }

// Minimal stand-in for the DynamoDB client: records each command and answers from a plain map.
function fakeClient() {
  const items = new Map<string, Record<string, any>>()
  const sent: Sent[] = []
  const key = (k: Record<string, any>) => `${k.PK.S}|${k.SK.S}`
  const client = {
    async send(command: { constructor: { name: string }; input: Record<string, any> }) {
      const name = command.constructor.name
      const input = command.input
      sent.push({ name, input })
      if (name === 'PutItemCommand') {
        if (items.has(key(input.Item))) throw new ConditionalCheckFailedException({ message: 'exists', $metadata: {} })
        items.set(key(input.Item), structuredClone(input.Item))
        return {}
      }
      if (name === 'GetItemCommand') return { Item: items.get(key(input.Key)) }
      if (name === 'UpdateItemCommand') {
        const item = items.get(key(input.Key))
        if (!item) throw new ConditionalCheckFailedException({ message: 'missing', $metadata: {} })
        if (input.ConditionExpression === '#status = :active' && item.status.S !== 'active') throw new ConditionalCheckFailedException({ message: 'inactive', $metadata: {} })
        if (input.ExpressionAttributeValues[':revoked']) item.status = input.ExpressionAttributeValues[':revoked']
        if (input.ExpressionAttributeValues[':at']) item.last_seen_at = input.ExpressionAttributeValues[':at']
        return {}
      }
      if (name === 'QueryCommand') {
        const value = input.ExpressionAttributeValues[':user'].S
        const prefix = input.ExpressionAttributeValues[':prefix'].S
        return { Items: [...items.values()].filter(item => item.GSI2PK?.S === value && item.GSI2SK?.S.startsWith(prefix)).map(item => ({ PK: item.PK, SK: item.SK })) }
      }
      throw new Error(`Unexpected command ${name}`)
    },
  }
  return { client: client as unknown as DynamoDBClient, items, sent }
}

const session = (id: string, userId = 'QCU-STU-IT-A'): Session => {
  const issued = new Date('2026-11-01T02:00:00.000Z')
  return { sessionId: id, userId, activeRoleId: 'student', issuedAt: issued.toISOString(), expiresAt: new Date(issued.getTime() + sessionPolicy.normal.absoluteMs).toISOString(), lastSeenAt: issued.toISOString(), remember: false, ipAddress: '127.0.0.1', userAgent: 'test', status: 'active' }
}

describe('DynamoDB session store', () => {
  it('writes the DOC006 SESSION item with a numeric TTL and a per-user index key', async () => {
    const { client, items } = fakeClient()
    const store = createDynamoSessionStore('accs-dev-ccs_identity', client)
    await store.create(session('abc'))
    const item = items.get('SESSION#abc|META')!
    expect(item).toMatchObject({ entity_type: { S: 'SESSION' }, session_id: { S: 'abc' }, user_id: { S: 'QCU-STU-IT-A' }, GSI2PK: { S: 'USER#QCU-STU-IT-A' }, GSI2SK: { S: 'SESSION#2026-11-01T02:00:00.000Z' }, status: { S: 'active' }, expires_at: { S: '2026-11-01T14:00:00.000Z' } })
    expect(item.expires_epoch).toEqual({ N: String(Date.parse('2026-11-01T14:00:00.000Z') / 1000) })
    expect(Object.keys(item).filter(k => /[A-Z]/.test(k) && !/^(PK|SK|GSI\dPK|GSI\dSK)$/.test(k))).toEqual([])
    expect(await store.get('abc')).toEqual(session('abc'))
    await expect(store.create(session('abc'))).rejects.toThrow()
  })

  it('reads strongly consistent and ignores other item types', async () => {
    const { client, items, sent } = fakeClient()
    const store = createDynamoSessionStore('accs-dev-ccs_identity', client)
    items.set('SESSION#other|META', { PK: { S: 'SESSION#other' }, SK: { S: 'META' }, entity_type: { S: 'USER' } })
    expect(await store.get('other')).toBeUndefined()
    expect(sent.at(-1)!.input.ConsistentRead).toBe(true)
  })

  it('revokes one session, all of a user, and skips touching revoked ones', async () => {
    const { client, items } = fakeClient()
    const store = createDynamoSessionStore('accs-dev-ccs_identity', client)
    for (const id of ['a', 'b', 'c']) await store.create(session(id))
    await store.create(session('z', 'ACCS-ADMIN'))
    // A role-holder entry under the same user key on GSI2 must not be touched.
    items.set('ROLE#x|META', { PK: { S: 'ROLE#x' }, SK: { S: 'META' }, GSI2PK: { S: 'USER#QCU-STU-IT-A' }, GSI2SK: { S: 'ROLE#x' } })
    await store.revoke('a')
    expect((await store.get('a'))!.status).toBe('revoked')
    await store.revokeUser('QCU-STU-IT-A', 'b')
    expect((await store.get('b'))!.status).toBe('active')
    expect((await store.get('c'))!.status).toBe('revoked')
    expect((await store.get('z'))!.status).toBe('active')
    await store.touch('c', '2026-11-01T03:00:00.000Z')
    expect((await store.get('c'))!.lastSeenAt).toBe('2026-11-01T02:00:00.000Z')
    await store.revoke('missing')
  })

  it('treats revoked, idle, and past-expiry sessions as not live', () => {
    const base = session('x')
    const start = Date.parse(base.issuedAt)
    expect(sessionState(base, start + 1000)).toBe('live')
    expect(sessionState({ ...base, status: 'revoked' }, start + 1000)).toBe('revoked')
    expect(sessionState(base, start + sessionPolicy.normal.idleMs)).toBe('expired')
    expect(sessionState({ ...base, lastSeenAt: new Date(start + 11.9 * 60 * 60 * 1000).toISOString() }, start + sessionPolicy.normal.absoluteMs)).toBe('expired')
  })
})
