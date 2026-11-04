import { DynamoDBClient, QueryCommand, TransactWriteItemsCommand, type AttributeValue } from '@aws-sdk/client-dynamodb'

import type { DomainTable } from './env.js'

// Shared domain state: one item per record in the record's domain table (accs-architecture adr/0004).
// PK STATE#<collection>, SK the record ID, the record as JSON text in `data`, a numeric `version` that every write
// must match, and `entity_type` STATE. A deleted record keeps its item with `deleted` set and no `data`, so a record
// that also exists in the seed stays hidden.

export type StoredRecord = { id: string; version: number; /** JSON text; undefined once the record is deleted. */ data?: string }
/** Replaces one record. `version` is the version being replaced; undefined means the record must not exist yet. */
export type RecordWrite = { table: DomainTable; collection: string; id: string; data?: string; version?: number }

/** DynamoDB allows 100 actions in one transaction. */
export const writeLimit = 100

export class RecordConflict extends Error {
  constructor() {
    super('A record changed since it was read.')
  }
}

export interface RecordStore {
  /** Every record of a collection, in ID order. Reads are strongly consistent, so a write by any instance shows at once. */
  list(table: DomainTable, collection: string): Promise<StoredRecord[]>
  /** All or nothing, at most `writeLimit` writes. Throws `RecordConflict` if any record is not at the version its write names. */
  write(writes: RecordWrite[]): Promise<void>
}

const s = (value: string): AttributeValue => ({ S: value })
const n = (value: number): AttributeValue => ({ N: String(value) })
const conflictCodes = new Set(['ConditionalCheckFailed', 'TransactionConflict'])
const isConflict = (error: unknown) => {
  const { name, CancellationReasons } = error as { name?: string; CancellationReasons?: { Code?: string }[] }
  return name === 'TransactionCanceledException' && !!CancellationReasons?.some((reason) => conflictCodes.has(reason.Code ?? ''))
}

export function createDynamoRecordStore(tableOf: (table: DomainTable) => string, client = new DynamoDBClient({})): RecordStore {
  return {
    async list(table, collection) {
      const records: StoredRecord[] = []
      let ExclusiveStartKey: Record<string, AttributeValue> | undefined
      do {
        const page = await client.send(new QueryCommand({
          TableName: tableOf(table),
          KeyConditionExpression: 'PK = :pk',
          ExpressionAttributeValues: { ':pk': s(`STATE#${collection}`) },
          ConsistentRead: true,
          ExclusiveStartKey,
        }))
        for (const item of page.Items ?? []) {
          records.push({ id: item.SK?.S ?? '', version: Number(item.version?.N ?? 0), data: item.deleted?.BOOL ? undefined : item.data?.S })
        }
        ExclusiveStartKey = page.LastEvaluatedKey
      } while (ExclusiveStartKey)
      return records
    },
    async write(writes) {
      if (writes.length > writeLimit) throw new Error(`A transaction holds at most ${writeLimit} writes.`)
      const now = new Date().toISOString()
      try {
        await client.send(new TransactWriteItemsCommand({
          TransactItems: writes.map((write) => ({
            // Put only, for updates too: the audit table allows nothing else, and the condition decides who wins.
            Put: {
              TableName: tableOf(write.table),
              Item: {
                PK: s(`STATE#${write.collection}`),
                SK: s(write.id),
                entity_type: s('STATE'),
                version: n((write.version ?? 0) + 1),
                updated_at: s(now),
                ...(write.data === undefined ? { deleted: { BOOL: true } } : { data: s(write.data) }),
              },
              ...(write.version === undefined
                ? { ConditionExpression: 'attribute_not_exists(PK)' }
                : { ConditionExpression: '#version = :expected', ExpressionAttributeNames: { '#version': 'version' }, ExpressionAttributeValues: { ':expected': n(write.version) } }),
            },
          })),
        }))
      } catch (error) {
        if (isConflict(error)) throw new RecordConflict()
        throw error
      }
    },
  }
}

/** In memory, with the same rules as DynamoDB: the transaction limit, one write per record, and version conditions. For tests. */
export function createMemoryRecordStore() {
  const items = new Map<string, StoredRecord & { table: DomainTable; collection: string }>()
  const keyOf = (write: { table: DomainTable; collection: string; id: string }) => `${write.table}|${write.collection}|${write.id}`
  return {
    /** Every stored item, for tests that check where records landed. */
    all: () => [...items.values()].map((item) => ({ ...item })),
    async list(table: DomainTable, collection: string): Promise<StoredRecord[]> {
      return [...items.values()]
        .filter((item) => item.table === table && item.collection === collection)
        .sort((a, b) => (a.id < b.id ? -1 : 1))
        .map(({ id, version, data }) => ({ id, version, data }))
    },
    async write(writes: RecordWrite[]) {
      if (writes.length > writeLimit) throw new Error(`A transaction holds at most ${writeLimit} writes.`)
      const keys = writes.map(keyOf)
      if (new Set(keys).size !== keys.length) throw new Error('A transaction cannot write the same record twice.')
      if (writes.some((write, index) => items.get(keys[index]!)?.version !== write.version)) throw new RecordConflict()
      writes.forEach((write, index) => items.set(keys[index]!, { table: write.table, collection: write.collection, id: write.id, version: (write.version ?? 0) + 1, data: write.data }))
    },
  } satisfies RecordStore & { all(): unknown[] }
}
