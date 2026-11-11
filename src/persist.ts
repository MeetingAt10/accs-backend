import type { DynamoDBClient } from '@aws-sdk/client-dynamodb'

import { ulid } from './ids.js'
import { renameAccountIds, renamedAccountIds } from './renames.js'
import type { DomainTable } from './env.js'
import { createDynamoRecordStore, RecordConflict, writeLimit, type RecordStore, type RecordWrite, type StoredRecord } from './records.js'
import { ApiError } from './services.js'
import { createMemoryRepository, seed, type Collection, type Database, type Repository } from './store.js'

/** The collections kept in the record store, and the domain table each lives in (accs-architecture adr/0004, DOC006). */
export const persisted: Record<Collection, DomainTable> = {
  reports: 'ccs_grievance',
  clusters: 'ccs_grievance',
  consultations: 'ccs_scheduling',
  slots: 'ccs_scheduling',
  events: 'ccs_scheduling',
  todos: 'ccs_scheduling',
  threads: 'ccs_messaging',
  notifications: 'ccs_notification',
  settings: 'ccs_notification',
  audit: 'ccs_audit',
  posts: 'ccs_community',
  moderation: 'ccs_moderation',
  cycles: 'ccs_evaluation',
  assignments: 'ccs_evaluation',
  followUps: 'ccs_evaluation',
  restrictions: 'ccs_discipline',
  referrals: 'ccs_discipline',
  strikes: 'ccs_discipline',
  strikeSettlements: 'ccs_discipline',
  goodMoral: 'ccs_discipline',
  // Report drafts hold concern narratives, so they stay out of the forum table.
  drafts: 'ccs_assistant',
  telemetry: 'ccs_assistant',
  permissionOverrides: 'ccs_identity',
}
const stored = Object.keys(persisted) as Collection[]
// A unit of work that loses a version race runs again on fresh data, up to this many times in all.
const attempts = 3

type Row = Record<string, unknown>

// The President's Office stage was removed on 2026-11-10. A report stored at that stage, or with it in its history or
// disclosures, is read as being with OSAS, now the last stage; it is written back that way only when it next changes.
function upgrade(name: Collection, stored: Row): Row {
  // Renamed accounts (QCU-DEAN is now CCS-DEAN): every field that holds the old ID is read with the new one.
  const row = renameAccountIds(stored)
  if (name !== 'reports') return row
  const stage = (value: unknown) => (value === 'executive' ? 'osas' : value)
  const history = Array.isArray(row.history) ? row.history.map((entry: Row) => ({ ...entry, stage: stage(entry.stage) })) : row.history
  const disclosedTo = Array.isArray(row.disclosedTo) ? [...new Set(row.disclosedTo.map(stage))] : row.disclosedTo
  return { ...row, stage: stage(row.stage), history, disclosedTo }
}
type Loaded = Partial<Record<Collection, StoredRecord[]>>
const addOnly = () => new Error('Audit entries are add-only.')

// Domain rules see these as objects. Each key is stored as its own record, wrapped so a value can be a plain boolean.
const objectCollections: ReadonlySet<Collection> = new Set(['drafts', 'settings', 'permissionOverrides'])
const toRows = (name: Collection, value: unknown): Row[] => (objectCollections.has(name) ? Object.entries(value as Row).map(([id, entry]) => ({ id, value: entry })) : (value as Row[]))
const fromRows = (name: Collection, rows: Row[]): unknown => (objectCollections.has(name) ? Object.fromEntries(rows.map((row) => [row.id, row.value])) : rows)
// Good Moral has one row per student and no ID of its own.
const keyOf = (name: Collection, row: Row) => String(name === 'goodMoral' ? row.studentId : row.id)

/**
 * A `Repository` for several instances that share a record store. The seed is the base: each stored record replaces the
 * seeded record with the same ID, a stored deletion hides it, and new records follow in ID order. Collections outside
 * `persisted` (`users`, `spaces`, `organizations`, `offenses`) stay per instance, as they are in memory.
 * Each unit of work runs on a private copy; `transact` then writes only the records it changed, each conditioned on the
 * version it read, in one DynamoDB transaction per `writeLimit` writes. Conflicting units run again.
 * ponytail: write-write conflicts only. A unit that reads a record and acts on it without changing it is not validated.
 */
export function createRecordRepository(store: RecordStore): Repository {
  const local = seed() // per-instance state; its persisted collections are only ever the seed
  const nextId = (prefix: string) => `${prefix}-${ulid()}`
  let queue: Promise<unknown> = Promise.resolve()
  // Transactions on one instance take turns, so the per-instance state is never changed from two stale copies.
  const exclusive = <T>(run: () => Promise<T>) => {
    const next = queue.then(run)
    queue = next.catch(() => undefined)
    return next
  }

  // ponytail: loads whole collections on every unit of work. Notifications, telemetry, and the audit trail grow without bound, so give
  // them a per-user key or a time window in the table once a page view slows down.
  const load = async (names: readonly Collection[]) => Object.fromEntries(await Promise.all(names.map(async (name) => [name, await store.list(persisted[name], name)]))) as Loaded

  // A working copy: the per-instance state with the stored records laid over the seed. Collections that were not loaded throw when read.
  function open(loaded: Loaded) {
    const db = structuredClone(local)
    const collections = db as unknown as Record<Collection, unknown>
    const baseline = new Map<Collection, Map<string, string>>()
    const versions = new Map<Collection, Map<string, number>>()
    for (const name of stored) {
      let records = loaded[name]
      if (!records) {
        Object.defineProperty(db, name, { enumerable: true, configurable: true, get: () => { throw new Error(`The ${name} collection was not loaded for this unit of work.`) } })
        continue
      }
      const ids = new Set(records.map((record) => record.id))
      records = records.filter((record) => !(record.id in renamedAccountIds && ids.has(renamedAccountIds[record.id]!)))
      const byId = new Map(records.map((record) => [renamedAccountIds[record.id] ?? record.id, record]))
      const seedRows = toRows(name, collections[name])
      const seeded = new Set(seedRows.map((row) => keyOf(name, row)))
      const merged: Row[] = []
      for (const row of seedRows) {
        const record = byId.get(keyOf(name, row))
        if (!record) merged.push(row)
        else if (record.data !== undefined) merged.push(upgrade(name, JSON.parse(record.data)))
      }
      for (const record of records) if (!seeded.has(renamedAccountIds[record.id] ?? record.id) && record.data !== undefined) merged.push(upgrade(name, JSON.parse(record.data)))
      collections[name] = fromRows(name, merged)
      baseline.set(name, new Map(merged.map((row) => [keyOf(name, row), JSON.stringify(row)])))
      versions.set(name, new Map(records.map((record) => [record.id, record.version])))
    }
    return { db, baseline, versions }
  }

  // Records that differ from what was loaded, version conditions first so a lost race shows in the first transaction.
  function changes({ db, baseline, versions }: ReturnType<typeof open>) {
    const collections = db as unknown as Record<Collection, unknown>
    const writes: RecordWrite[] = []
    for (const [name, before] of baseline) {
      const ids = new Set<string>()
      for (const row of toRows(name, collections[name])) {
        const id = keyOf(name, row)
        ids.add(id)
        const data = JSON.stringify(row)
        if (before.get(id) === data) continue
        if (name === 'audit' && before.has(id)) throw addOnly()
        writes.push({ table: persisted[name], collection: name, id, data, version: versions.get(name)!.get(id) })
      }
      for (const id of before.keys()) {
        if (ids.has(id)) continue
        if (name === 'audit') throw addOnly()
        writes.push({ table: persisted[name], collection: name, id, version: versions.get(name)!.get(id) })
      }
    }
    return writes.sort((a, b) => Number(a.version === undefined) - Number(b.version === undefined))
  }

  const conflict = () => new ApiError(409, 'Someone else changed this at the same time. Try again.', 'CONFLICT')

  return {
    async view(work, names = stored) {
      const { db } = open(await load(names))
      return work({ read: () => db, nextId: () => { throw new Error('A read-only view cannot allocate IDs.') } })
    },
    transact: (work, names = stored) => exclusive(async () => {
      for (let attempt = 1; ; attempt++) {
        const state = open(await load(names))
        const result = work({ read: () => state.db, nextId })
        const writes = changes(state)
        try {
          for (let from = 0; from < writes.length; from += writeLimit) {
            try {
              await store.write(writes.slice(from, from + writeLimit))
            } catch (error) {
              // Earlier transactions are already stored, and running the work again would repeat them.
              if (error instanceof RecordConflict && from > 0) throw conflict()
              throw error
            }
          }
        } catch (error) {
          if (!(error instanceof RecordConflict)) throw error
          if (attempt < attempts) continue
          throw conflict()
        }
        for (const key of Object.keys(local) as (keyof Database)[]) if (!stored.includes(key as Collection)) (local as Record<string, unknown>)[key] = state.db[key]
        return structuredClone(result)
      }
    }),
  }
}

/** Shared state in DynamoDB on a deployed stack (a table prefix is set); in memory for tests and local runs, unless a client is given. */
export function createRepository(options: { nodeEnv: string; tableName: (table: DomainTable) => string | undefined; client?: DynamoDBClient }): Repository {
  if (!options.tableName('ccs_audit') || (options.nodeEnv === 'test' && !options.client)) return createMemoryRepository()
  return createRecordRepository(createDynamoRecordStore((table) => options.tableName(table)!, options.client))
}
