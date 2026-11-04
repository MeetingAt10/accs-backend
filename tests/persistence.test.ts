import { TransactionCanceledException, type DynamoDBClient } from '@aws-sdk/client-dynamodb'
import { describe, expect, it } from 'vitest'

import { createApp } from '../src/app.js'
import { createMemoryAuthStore } from '../src/auth.js'
import type { DomainTable } from '../src/env.js'
import { createRecordRepository, createRepository } from '../src/persist.js'
import { createDynamoRecordStore, createMemoryRecordStore, RecordConflict, writeLimit, type RecordStore, type RecordWrite } from '../src/records.js'
import { ApiError } from '../src/services.js'
import { createMemorySessionStore } from '../src/sessions.js'
import type { Database, Notification } from '../src/store.js'
import { signIn } from './helpers.js'

const tick = () => new Promise((resolve) => setImmediate(resolve))
const at = '2026-11-05T02:00:00.000Z'

type Sent = { name: string; input: Record<string, any> }
/** A stand-in for DynamoDB: pages of `pageSize` items per Query, and transactions that check every condition, then apply every write. */
function fakeDynamo(pageSize = 100) {
  const tables = new Map<string, Map<string, Record<string, any>>>()
  const sent: Sent[] = []
  const key = (item: Record<string, any>) => `${item.PK.S}|${item.SK.S}`
  const client = {
    async send(command: { constructor: { name: string }; input: Record<string, any> }) {
      const { input } = command
      const name = command.constructor.name
      sent.push({ name, input })
      if (name === 'QueryCommand') {
        const items = [...(tables.get(input.TableName)?.values() ?? [])].filter((item) => item.PK.S === input.ExpressionAttributeValues[':pk'].S).sort((a, b) => (a.SK.S < b.SK.S ? -1 : 1))
        const from = input.ExclusiveStartKey ? items.findIndex((item) => item.SK.S === input.ExclusiveStartKey.SK.S) + 1 : 0
        const page = items.slice(from, from + pageSize)
        return { Items: structuredClone(page), LastEvaluatedKey: from + pageSize < items.length ? { PK: page.at(-1)!.PK, SK: page.at(-1)!.SK } : undefined }
      }
      if (name === 'TransactWriteItemsCommand') {
        const writes = input.TransactItems as { Put: Record<string, any> }[]
        if (writes.length > writeLimit) throw new Error('ValidationException: Member must have length less than or equal to 100')
        const keys = writes.map(({ Put }) => `${Put.TableName}|${key(Put.Item)}`)
        if (new Set(keys).size !== keys.length) throw new Error('ValidationException: Transaction request cannot include multiple operations on one item')
        const reasons = writes.map(({ Put }) => {
          const existing = tables.get(Put.TableName)?.get(key(Put.Item))
          const holds = Put.ConditionExpression === 'attribute_not_exists(PK)' ? !existing : existing?.version.N === Put.ExpressionAttributeValues[':expected'].N
          return holds ? { Code: 'None' } : { Code: 'ConditionalCheckFailed' }
        })
        if (reasons.some((reason) => reason.Code !== 'None')) throw new TransactionCanceledException({ message: 'Transaction cancelled', $metadata: {}, CancellationReasons: reasons })
        for (const { Put } of writes) {
          if (!tables.has(Put.TableName)) tables.set(Put.TableName, new Map())
          tables.get(Put.TableName)!.set(key(Put.Item), structuredClone(Put.Item))
        }
        return {}
      }
      throw new Error(`Unexpected command ${name}`)
    },
  }
  return { client: client as unknown as DynamoDBClient, tables, sent }
}

const write = (id: string, data?: string, version?: number, collection = 'reports', table: DomainTable = 'ccs_grievance'): RecordWrite => ({ table, collection, id, data, version })

describe.each([
  ['the in-memory record store', () => createMemoryRecordStore()],
  ['the DynamoDB record store', () => createDynamoRecordStore((table) => `accs-test-${table}`, fakeDynamo(2).client)],
] as const)('%s', (_name, make) => {
  it('lists a collection in ID order with the version each record is at', async () => {
    const store = make()
    await store.write([write('B', '{"id":"B"}'), write('A', '{"id":"A"}'), write('S1', '{"id":"S1"}', undefined, 'slots', 'ccs_scheduling')])
    await store.write([write('A', '{"id":"A","n":2}', 1)])
    expect(await store.list('ccs_grievance', 'reports')).toEqual([{ id: 'A', version: 2, data: '{"id":"A","n":2}' }, { id: 'B', version: 1, data: '{"id":"B"}' }])
    expect(await store.list('ccs_scheduling', 'slots')).toHaveLength(1)
    expect(await store.list('ccs_scheduling', 'consultations')).toEqual([])
    expect(await store.list('ccs_grievance', 'slots')).toEqual([])
  })

  it('keeps a deleted record as a version without data', async () => {
    const store = make()
    await store.write([write('A', '{"id":"A"}')])
    await store.write([write('A', undefined, 1)])
    expect(await store.list('ccs_grievance', 'reports')).toEqual([{ id: 'A', version: 2, data: undefined }])
    await store.write([write('A', '{"id":"A","again":true}', 2)])
    expect((await store.list('ccs_grievance', 'reports'))[0]).toMatchObject({ version: 3, data: '{"id":"A","again":true}' })
  })

  it('applies none of a transaction when one record is not at the version its write names', async () => {
    const store = make()
    await store.write([write('A', '{"id":"A"}')])
    await expect(store.write([write('B', '{}'), write('A', '{"n":2}', 5)])).rejects.toBeInstanceOf(RecordConflict)
    await expect(store.write([write('C', '{}'), write('A', '{"n":3}')])).rejects.toBeInstanceOf(RecordConflict)
    await expect(store.write([write('C', '{}', 1)])).rejects.toBeInstanceOf(RecordConflict)
    expect(await store.list('ccs_grievance', 'reports')).toEqual([{ id: 'A', version: 1, data: '{"id":"A"}' }])
  })

  it('takes at most 100 writes in one transaction', async () => {
    const store = make()
    const many = (count: number) => Array.from({ length: count }, (_, n) => write(`R${String(n).padStart(3, '0')}`, '{}'))
    await expect(store.write(many(writeLimit + 1))).rejects.toThrow('at most 100')
    expect(await store.list('ccs_grievance', 'reports')).toEqual([])
    await store.write(many(writeLimit))
    expect(await store.list('ccs_grievance', 'reports')).toHaveLength(writeLimit)
  })
})

describe('DynamoDB record store', () => {
  it('writes one Put per record, in the table of the record, conditioned on its version', async () => {
    const { client, sent } = fakeDynamo()
    const store = createDynamoRecordStore((table) => `accs-dev-${table}`, client)
    await store.write([write('R1', '{"id":"R1"}'), write('SLOT-1', '{"id":"SLOT-1"}', undefined, 'slots', 'ccs_scheduling'), write('A1', '{"id":"A1"}', undefined, 'audit', 'ccs_audit')])
    await store.write([write('R1', '{"id":"R1","n":2}', 1), write('R2', undefined)])
    const [create, update] = sent.filter((command) => command.name === 'TransactWriteItemsCommand').map((command) => command.input.TransactItems as { Put: Record<string, any> }[])
    expect(create!.map(({ Put }) => [Put.TableName, Put.Item.PK.S, Put.Item.SK.S, Put.Item.version.N, Put.ConditionExpression])).toEqual([
      ['accs-dev-ccs_grievance', 'STATE#reports', 'R1', '1', 'attribute_not_exists(PK)'],
      ['accs-dev-ccs_scheduling', 'STATE#slots', 'SLOT-1', '1', 'attribute_not_exists(PK)'],
      ['accs-dev-ccs_audit', 'STATE#audit', 'A1', '1', 'attribute_not_exists(PK)'],
    ])
    expect(create![0]!.Put).toMatchObject({ Item: { entity_type: { S: 'STATE' }, data: { S: '{"id":"R1"}' } } })
    expect(create![0]!.Put.ExpressionAttributeValues).toBeUndefined()
    expect(update![0]!.Put).toMatchObject({ ConditionExpression: '#version = :expected', ExpressionAttributeNames: { '#version': 'version' }, ExpressionAttributeValues: { ':expected': { N: '1' } }, Item: { version: { N: '2' }, data: { S: '{"id":"R1","n":2}' } } })
    // A deleted record has a marker and no data.
    expect(update![1]!.Put.Item).toMatchObject({ SK: { S: 'R2' }, deleted: { BOOL: true } })
    expect(update![1]!.Put.Item.data).toBeUndefined()
    // Put only: the audit table allows nothing else.
    expect(new Set(sent.map((command) => command.name))).toEqual(new Set(['TransactWriteItemsCommand']))
  })

  it('reads strongly consistent and follows every page of a query', async () => {
    const { client, sent } = fakeDynamo(2)
    const store = createDynamoRecordStore((table) => `accs-dev-${table}`, client)
    await store.write(['A', 'B', 'C', 'D', 'E'].map((id) => write(id, `{"id":"${id}"}`)))
    expect((await store.list('ccs_grievance', 'reports')).map((record) => record.id)).toEqual(['A', 'B', 'C', 'D', 'E'])
    const queries = sent.filter((command) => command.name === 'QueryCommand')
    expect(queries).toHaveLength(3)
    for (const { input } of queries) expect(input).toMatchObject({ TableName: 'accs-dev-ccs_grievance', KeyConditionExpression: 'PK = :pk', ConsistentRead: true, ExpressionAttributeValues: { ':pk': { S: 'STATE#reports' } } })
  })

  it('turns a lost race into RecordConflict and leaves other failures alone', async () => {
    const fail = (error: unknown) => createDynamoRecordStore((table) => table, { send: async () => { throw error } } as unknown as DynamoDBClient)
    const cancelled = (...codes: string[]) => new TransactionCanceledException({ message: 'Transaction cancelled', $metadata: {}, CancellationReasons: codes.map((Code) => ({ Code })) })
    await expect(fail(cancelled('None', 'ConditionalCheckFailed')).write([write('A', '{}')])).rejects.toBeInstanceOf(RecordConflict)
    await expect(fail(cancelled('TransactionConflict', 'None')).write([write('A', '{}')])).rejects.toBeInstanceOf(RecordConflict)
    const other = cancelled('ValidationError')
    await expect(fail(other).write([write('A', '{}')])).rejects.toBe(other)
    const down = new Error('connection reset')
    await expect(fail(down).write([write('A', '{}')])).rejects.toBe(down)
  })
})

const notice = (unit: { nextId(prefix: string): string }, recipientId = 'QCU-STU-CS'): Notification => ({ id: unit.nextId('NOTIF'), recipientId, kind: 'announcement', title: 'New college announcement', body: 'Open the feed to read it.', priority: 'normal', pageId: 'P04', at, read: false })

describe('the record repository', () => {
  const fresh = () => {
    const store = createMemoryRecordStore()
    return { store, repo: createRecordRepository(store) }
  }
  // Counts the size of each transaction, and can fail chosen ones as a lost race.
  function watched(store: RecordStore, conflictOn: (call: number) => boolean = () => false) {
    const sizes: number[] = []
    const watching: RecordStore & { sizes: number[]; lists: string[] } = {
      sizes,
      lists: [],
      list: async (table, collection) => { watching.lists.push(`${table}/${collection}`); return store.list(table, collection) },
      write: async (writes) => {
        sizes.push(writes.length)
        if (conflictOn(sizes.length)) throw new RecordConflict()
        await store.write(writes)
      },
    }
    return watching
  }

  it('keeps what a transaction changes, returns a detached result, and leaves per-instance data on the instance', async () => {
    const { store, repo } = fresh()
    const entry = await repo.transact((unit) => {
      const added = { id: unit.nextId('AUDIT'), at, actorId: 'QCU-ADMIN', action: 'Checked', module: 'identity', reference: 'x', result: 'Recorded' }
      unit.read().audit.push(added)
      unit.read().todos.push({ id: 'MINE-1', ownerId: 'QCU-STU-CS', title: 'Stays on this instance', date: '2026-11-05', done: false })
      return added
    })
    entry.action = 'changed after the commit'
    expect((await repo.view((unit) => unit.read().audit.at(-1)))?.action).toBe('Checked')
    expect((await repo.view((unit) => unit.read().todos.at(-1)))?.title).toBe('Stays on this instance')
    const other = createRecordRepository(store)
    expect((await other.view((unit) => unit.read().audit.at(-1)))?.id).toBe(entry.id)
    expect(await other.view((unit) => unit.read().todos.some((todo) => todo.id === 'MINE-1'))).toBe(false)
  })

  it('rolls back every change when the work throws, and writes nothing', async () => {
    const { store, repo } = fresh()
    const before = await repo.view((unit) => structuredClone(unit.read()))
    await expect(repo.transact((unit) => {
      const db = unit.read()
      unit.nextId('TODO')
      db.todos.push({ id: 'MINE-1', ownerId: 'QCU-STU-CS', title: 'lost', date: '2026-11-05', done: false })
      db.users[0]!.name = 'Changed nested value'
      db.posts = []
      db.slots[0]!.state = 'unavailable'
      db.notifications.push(notice(unit))
      throw new Error('boom')
    })).rejects.toThrow('boom')
    expect(store.all()).toEqual([])
    expect(await repo.view((unit) => unit.read())).toEqual(before)
  })

  it('discards what a view changes and refuses to allocate IDs in one', async () => {
    const { store, repo } = fresh()
    const before = await repo.view((unit) => structuredClone(unit.read()))
    await repo.view((unit) => { unit.read().users[0]!.name = 'Changed in a view'; unit.read().posts = []; unit.read().slots = [] })
    expect(store.all()).toEqual([])
    expect(await repo.view((unit) => unit.read())).toEqual(before)
    await expect(repo.view((unit) => unit.nextId('TODO'))).rejects.toThrow('read-only')
    const user = await repo.view((unit) => unit.read().users[0]!)
    user.roles.push('administrator')
    expect((await repo.view((unit) => unit.read().users[0]!)).roles).not.toContain('administrator')
  })

  it('writes only the records a transaction changed, each at the next version', async () => {
    const { store, repo } = fresh()
    const slot = (db: Database) => db.slots.find((entry) => entry.id === 'SLOT-0104')!
    await repo.transact((unit) => { slot(unit.read()).state = 'unavailable' })
    expect(store.all().map((item) => [item.table, item.collection, item.id, item.version])).toEqual([['ccs_scheduling', 'slots', 'SLOT-0104', 1]])
    await repo.transact((unit) => unit.read().slots.map((entry) => entry.state))
    expect(store.all().map((item) => item.version)).toEqual([1])
    await repo.transact((unit) => { slot(unit.read()).state = 'open' })
    expect(store.all().map((item) => item.version)).toEqual([2])
    expect(await createRecordRepository(store).view((unit) => slot(unit.read()).state)).toBe('open')
  })

  it('puts each collection in its own domain table', async () => {
    const { store, repo } = fresh()
    await repo.transact((unit) => {
      const db = unit.read()
      db.reports[0]!.status = 'Reviewed'
      db.consultations[0]!.purpose = 'Changed'
      db.slots[0]!.state = 'unavailable'
      db.threads[0]!.title = 'Renamed'
      db.notifications[0]!.read = true
      db.audit.push({ id: unit.nextId('AUDIT'), at, actorId: 'QCU-ADMIN', action: 'Checked', module: 'identity', reference: 'x', result: 'Recorded' })
    })
    expect(store.all().map((item) => `${item.table}/${item.collection}`).sort()).toEqual([
      'ccs_audit/audit', 'ccs_grievance/reports', 'ccs_messaging/threads', 'ccs_notification/notifications', 'ccs_scheduling/consultations', 'ccs_scheduling/slots',
    ])
  })

  it('keeps a deleted seeded record deleted on every instance', async () => {
    const { store, repo } = fresh()
    await repo.transact((unit) => { unit.read().slots = unit.read().slots.filter((entry) => entry.id !== 'SLOT-0104') })
    expect(store.all()).toMatchObject([{ id: 'SLOT-0104', version: 1, data: undefined }])
    const slots = (r: ReturnType<typeof createRecordRepository>) => r.view((unit) => unit.read().slots.map((entry) => entry.id))
    expect(await slots(repo)).not.toContain('SLOT-0104')
    expect(await slots(createRecordRepository(store))).toEqual(['SLOT-0101', 'SLOT-0102', 'SLOT-0103', 'SLOT-0105', 'SLOT-0106'])
    await repo.transact((unit) => { unit.read().slots.push({ id: unit.nextId('SLOT'), facultyId: 'QCU-PROF-IT', date: '2026-11-06', start: '09:00', end: '09:30', state: 'open' }) })
    expect(store.all().filter((item) => item.id === 'SLOT-0104')).toHaveLength(1)
  })

  it('only adds audit entries: changing or removing one fails', async () => {
    const { store, repo } = fresh()
    await expect(repo.transact((unit) => { unit.read().audit[0]!.action = 'Edited' })).rejects.toThrow('add-only')
    await expect(repo.transact((unit) => { unit.read().audit = [] })).rejects.toThrow('add-only')
    expect(store.all()).toEqual([])
    const added = await repo.transact((unit) => { const entry = { id: unit.nextId('AUDIT'), at, actorId: 'QCU-ADMIN', action: 'Checked', module: 'identity', reference: 'x', result: 'Recorded' }; unit.read().audit.push(entry); return entry })
    await expect(repo.transact((unit) => { unit.read().audit.find((entry) => entry.id === added.id)!.result = 'Edited' })).rejects.toThrow('add-only')
    expect(store.all()).toMatchObject([{ id: added.id, version: 1 }])
  })

  it('splits a large change into transactions of 100', async () => {
    const { store, repo: _ } = fresh()
    const spy = watched(store)
    const repo = createRecordRepository(spy)
    const before = (await repo.view((unit) => unit.read().notifications)).length
    await repo.transact((unit) => { for (let n = 0; n < 250; n++) unit.read().notifications.push(notice(unit)) })
    expect(spy.sizes).toEqual([100, 100, 50])
    expect((await createRecordRepository(store).view((unit) => unit.read().notifications)).length).toBe(before + 250)
  })

  it('runs the work again on fresh data after a lost race, up to three times', async () => {
    const { store } = fresh()
    let runs = 0
    const work = (unit: { read(): Database }) => { runs++; unit.read().slots.find((entry) => entry.id === 'SLOT-0104')!.state = 'unavailable'; return 'saved' }
    const once = watched(store, (call) => call === 1)
    expect(await createRecordRepository(once).transact(work)).toBe('saved')
    expect([runs, once.sizes]).toEqual([2, [1, 1]])

    runs = 0
    const always = createRecordRepository(watched(createMemoryRecordStore(), () => true))
    const failure = await always.transact(work).catch((error) => error)
    expect(failure).toBeInstanceOf(ApiError)
    expect(failure).toMatchObject({ status: 409, code: 'CONFLICT' })
    expect(runs).toBe(3)
  })

  it('does not run the work again once part of a large change is stored', async () => {
    const { store } = fresh()
    let runs = 0
    const repo = createRecordRepository(watched(store, (call) => call === 2))
    const failure = await repo.transact((unit) => { runs++; for (let n = 0; n < 150; n++) unit.read().notifications.push(notice(unit)) }).catch((error) => error)
    expect(failure).toMatchObject({ status: 409, code: 'CONFLICT' })
    expect([runs, store.all().length]).toEqual([1, 100])
  })

  it('does not retry other store failures', async () => {
    let runs = 0
    const broken: RecordStore = { list: async () => [], write: async () => { throw new Error('table unavailable') } }
    await expect(createRecordRepository(broken).transact((unit) => { runs++; unit.read().slots[0]!.state = 'unavailable' })).rejects.toThrow('table unavailable')
    expect(runs).toBe(1)
  })

  it('loads only the collections the work names, and the work cannot read the others', async () => {
    const { store } = fresh()
    const spy = watched(store)
    const repo = createRecordRepository(spy)
    expect(await repo.view((unit) => unit.read().users.length, [])).toBeGreaterThan(0)
    expect(spy.lists).toEqual([])
    expect(await repo.view((unit) => unit.read().audit.length, ['audit'])).toBe(1)
    expect(spy.lists).toEqual(['ccs_audit/audit'])
    await expect(repo.view((unit) => unit.read().reports, ['audit'])).rejects.toThrow('reports collection was not loaded')
    await expect(repo.transact((unit) => unit.read().slots, [])).rejects.toThrow('slots collection was not loaded')
    await repo.view((unit) => unit.read().reports)
    expect(spy.lists.slice(-6).sort()).toEqual(['ccs_audit/audit', 'ccs_grievance/reports', 'ccs_messaging/threads', 'ccs_notification/notifications', 'ccs_scheduling/consultations', 'ccs_scheduling/slots'])
  })

  it('takes turns when transactions arrive together, so none of them is lost', async () => {
    const store = createMemoryRecordStore()
    const slow: RecordStore = { list: async (...args) => { await tick(); const records = await store.list(...args); await tick(); return records }, write: async (writes) => { await tick(); await store.write(writes) } }
    const repo = createRecordRepository(slow)
    await Promise.all([1, 2, 3, 4, 5].map((n) => repo.transact((unit) => { unit.read().todos.push({ id: `MINE-${n}`, ownerId: 'QCU-STU-CS', title: `To-do ${n}`, date: '2026-11-05', done: false }); unit.read().audit.push({ id: unit.nextId('AUDIT'), at, actorId: 'QCU-ADMIN', action: `Check ${n}`, module: 'identity', reference: 'x', result: 'Recorded' }) })))
    expect(await repo.view((unit) => unit.read().todos.filter((todo) => todo.id.startsWith('MINE-')).length)).toBe(5)
    expect(await repo.view((unit) => unit.read().audit.length)).toBe(1 + 5)
  })

  it('uses memory in tests and when no table prefix is set, and shared state on a deployed stack', () => {
    const tableName = (table: string) => `accs-dev-${table}`
    expect('read' in createRepository({ nodeEnv: 'test', tableName })).toBe(true)
    expect('read' in createRepository({ nodeEnv: 'development', tableName: () => undefined })).toBe(true)
    expect('read' in createRepository({ nodeEnv: 'production', tableName })).toBe(false)
  })

  it('uses a DynamoDB client it is given, even in tests', async () => {
    const { client, tables } = fakeDynamo()
    const repo = createRepository({ nodeEnv: 'test', tableName: (table) => `accs-test-${table}`, client })
    await repo.transact((unit) => { unit.read().slots.find((entry) => entry.id === 'SLOT-0104')!.state = 'unavailable' })
    expect([...tables.keys()]).toEqual(['accs-test-ccs_scheduling'])
    expect(await createRepository({ nodeEnv: 'test', tableName: (table) => `accs-test-${table}`, client }).view((unit) => unit.read().slots.find((entry) => entry.id === 'SLOT-0104')!.state)).toBe('unavailable')
  })
})

describe('two app instances sharing a record store', () => {
  function instances(wrap: (store: RecordStore) => RecordStore = (store) => store) {
    const store = createMemoryRecordStore()
    const shared = wrap(store)
    const authStore = createMemoryAuthStore()
    const sessionStore = createMemorySessionStore()
    return { store, instance: () => createApp(createRecordRepository(shared), { authStore, sessionStore }) }
  }
  // Holds the first two writes until both have arrived, so two instances that loaded the same data really do race.
  const racing = (store: RecordStore): RecordStore => {
    let waiting: (() => void)[] = []
    let met = false
    return {
      list: async (...args) => { await tick(); const records = await store.list(...args); await tick(); return records },
      write: async (writes) => {
        if (!met) {
          await new Promise<void>((resolve) => {
            waiting.push(resolve)
            if (waiting.length < 2) return
            met = true
            for (const release of waiting) release()
            waiting = []
          })
        }
        await store.write(writes)
      },
    }
  }
  const report = { narrative: 'The lab timetable changed without notice.', category: 'General concern', severity: 'low', identity: 'named' }

  it('shows data written by one to the other, and to an instance that starts cold', async () => {
    const { instance } = instances()
    const [first, second] = [instance(), instance()]
    const { agent: student } = await signIn(first, 'QCU-STU-CS')
    const filed = await student.post('/api/pages/P19/actions').send({ action: 'createReport', payload: report })
    expect(filed.status).toBe(200)
    const id = filed.body.record.id as string

    const { agent: adviser } = await signIn(second, 'QCU-PROF-CS')
    expect((await adviser.get(`/api/pages/P22?id=${id}`)).status).toBe(200)
    expect((await adviser.get('/api/pages/P40')).body.data.notifications.some((n: { kind: string; recordId?: string }) => n.kind === 'report' && n.recordId === id)).toBe(true)
    expect((await adviser.post('/api/pages/P22/actions').send({ action: 'sendReportMessage', recordId: id, payload: { body: 'We are looking into it.' } })).status).toBe(200)

    const { agent: back } = await signIn(instance(), 'QCU-STU-CS')
    const mine = (await back.get(`/api/pages/P20?id=${id}`)).body.data.record
    expect(mine.messages.map((message: { body: string }) => message.body)).toContain('We are looking into it.')
    expect((await back.get('/api/pages/P18')).body.data.reports.map((r: { id: string }) => r.id)).toContain(id)
  })

  it('lets only one of two instances reserve the same slot', async () => {
    const { store, instance } = instances(racing)
    const [first, second] = [instance(), instance()]
    const [{ agent: a }, { agent: b }] = await Promise.all([signIn(first, 'QCU-STU-IT-A'), signIn(second, 'QCU-STU-RESTRICTED')])
    const responses = await Promise.all([a, b].map((agent) => agent.post('/api/pages/P15/actions').send({ action: 'createConsultation', payload: { slotId: 'SLOT-0101', purpose: 'Academic question' } })))
    expect(responses.map((response) => response.status).sort()).toEqual([200, 409])
    expect(responses.find((response) => response.status === 409)!.body.error).toBe('That time was just taken. Pick another time.')
    expect(store.all().filter((item) => item.collection === 'consultations')).toHaveLength(1)
    expect(store.all().find((item) => item.id === 'SLOT-0101')).toMatchObject({ version: 1 })
  })

  it('keeps both updates when two instances change the same report together', async () => {
    const { instance } = instances(racing)
    const [first, second] = [instance(), instance()]
    const [{ agent: student }, { agent: adviser }] = await Promise.all([signIn(first, 'QCU-STU-IT-A'), signIn(second, 'QCU-PROF-IT')])
    const sent = await Promise.all([
      student.post('/api/pages/P20/actions').send({ action: 'sendReportMessage', recordId: 'RPT-0241', payload: { body: 'From the student' } }),
      adviser.post('/api/pages/P22/actions').send({ action: 'sendReportMessage', recordId: 'RPT-0241', payload: { body: 'From the adviser' } }),
    ])
    expect(sent.map((response) => response.status)).toEqual([200, 200])
    const bodies = (await student.get('/api/pages/P20?id=RPT-0241')).body.data.record.messages.map((message: { body: string }) => message.body)
    expect(bodies).toEqual(expect.arrayContaining(['From the student', 'From the adviser']))
  })

  it('commits the audit entry written while a student record is read', async () => {
    const { store, instance } = instances()
    const { agent: dean } = await signIn(instance(), 'QCU-DEAN')
    expect((await dean.get('/api/pages/P34?id=QCU-STU-RESTRICTED&purpose=Case%20handling')).status).toBe(200)
    expect(store.all().filter((item) => item.collection === 'audit').map((item) => JSON.parse(item.data!).action)).toEqual(['Record opened'])
  })

  it('keeps nothing from an action that fails partway', async () => {
    const store = createMemoryRecordStore()
    const repo = createRecordRepository(store)
    const app = createApp(repo, { authStore: createMemoryAuthStore() })
    const { agent: admin } = await signIn(app, 'QCU-ADMIN')
    // The flagged comment's post is gone, so the action fails after it has already changed the moderation item.
    await repo.transact((unit) => { unit.read().posts = unit.read().posts.filter((post) => post.id !== 'POST-0102') })
    const response = await admin.post('/api/pages/P50/actions').send({ action: 'moderate', recordId: 'MOD-0101', reason: 'Off topic', payload: { decision: 'remove', notifyAuthor: false } })
    expect(response.status).toBe(404)
    const item = await repo.view((unit) => unit.read().moderation.find((entry) => entry.id === 'MOD-0101')!)
    expect([item.status, item.history]).toEqual(['Pending', []])
    expect(store.all()).toEqual([])
  })

  it('reads, writes, and maps domain errors to their status', async () => {
    const { instance } = instances(racing)
    const app = instance()
    const { agent: student } = await signIn(app, 'QCU-STU-IT-A')
    expect((await student.get('/api/session')).body.user.id).toBe('QCU-STU-IT-A')
    expect((await student.get('/api/pages/P45')).status).toBe(403)
    expect((await student.get('/api/pages/P08?id=SPACE-IT-B')).status).toBe(404)
    const todo = await student.post('/api/pages/P13/actions').send({ action: 'createTodo', payload: { title: 'Through the store', date: '2026-11-05' } })
    expect(todo.status).toBe(200)
    expect((await student.get('/api/pages/P13')).body.data.todos.map((entry: { id: string }) => entry.id)).toContain(todo.body.record.id)
  })
})
