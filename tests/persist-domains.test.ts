import { describe, expect, it } from 'vitest'

import { createApp } from '../src/app.js'
import { createMemoryAuthStore } from '../src/auth.js'
import { createRecordRepository, persisted } from '../src/persist.js'
import { createMemoryRecordStore, type RecordStore } from '../src/records.js'
import { createMemorySessionStore } from '../src/sessions.js'
import { signIn } from './helpers.js'

const at = '2026-11-05T02:00:00.000Z'

/** Instances that share one record store, auth store, and session store, as Lambda instances do. */
function stack(wrap: (store: RecordStore) => RecordStore = (store) => store) {
  const store = createMemoryRecordStore()
  const authStore = createMemoryAuthStore()
  const sessionStore = createMemorySessionStore()
  return {
    store,
    authStore,
    sessionStore,
    cold: () => createRecordRepository(store),
    instance: () => createApp(createRecordRepository(wrap(store)), { authStore, sessionStore }),
  }
}

describe('where each collection is stored', () => {
  it('follows the DOC006 table mapping', () => {
    expect(persisted).toEqual({
      reports: 'ccs_grievance', clusters: 'ccs_grievance',
      consultations: 'ccs_scheduling', slots: 'ccs_scheduling', events: 'ccs_scheduling', todos: 'ccs_scheduling',
      threads: 'ccs_messaging',
      notifications: 'ccs_notification', settings: 'ccs_notification',
      audit: 'ccs_audit',
      posts: 'ccs_community',
      moderation: 'ccs_moderation',
      cycles: 'ccs_evaluation', assignments: 'ccs_evaluation', followUps: 'ccs_evaluation',
      restrictions: 'ccs_discipline', referrals: 'ccs_discipline', goodMoral: 'ccs_discipline',
      drafts: 'ccs_assistant', telemetry: 'ccs_assistant',
      permissionOverrides: 'ccs_identity',
    })
  })
})

describe('collections that are not plain rows', () => {
  it('stores an object collection per key, and keeps a false value', async () => {
    const { store, cold } = stack()
    await cold().transact((unit) => {
      const db = unit.read()
      db.permissionOverrides['staff:post.create'] = false
      db.permissionOverrides['staff:post.comment'] = true
      db.drafts['QCU-STU-CS'] = { narrative: 'Unfinished' }
      db.settings['QCU-STU-CS'] = { theme: 'dark', density: 'compact', priorities: {} }
    })
    expect(store.all().map((item) => [item.table, item.collection, item.id]).sort()).toEqual([
      ['ccs_assistant', 'drafts', 'QCU-STU-CS'],
      ['ccs_identity', 'permissionOverrides', 'staff:post.comment'],
      ['ccs_identity', 'permissionOverrides', 'staff:post.create'],
      ['ccs_notification', 'settings', 'QCU-STU-CS'],
    ])
    const db = await cold().view((unit) => unit.read())
    expect(db.permissionOverrides).toEqual({ 'staff:post.create': false, 'staff:post.comment': true })
    expect(db.drafts['QCU-STU-CS']).toEqual({ narrative: 'Unfinished' })
    expect(db.settings['QCU-STU-CS']?.theme).toBe('dark')
  })

  it('writes only the key that changed, at the next version', async () => {
    const { store, cold } = stack()
    await cold().transact((unit) => { unit.read().permissionOverrides.a = true; unit.read().permissionOverrides.b = true })
    await cold().transact((unit) => { unit.read().permissionOverrides.a = false })
    expect(store.all().map((item) => [item.id, item.version]).sort()).toEqual([['a', 2], ['b', 1]])
  })

  it('hides a key removed from an object collection on every instance', async () => {
    const { cold } = stack()
    await cold().transact((unit) => { unit.read().drafts.gone = { narrative: 'x' } })
    await cold().transact((unit) => { delete unit.read().drafts.gone })
    expect(await cold().view((unit) => unit.read().drafts)).toEqual({})
  })

  it('keeps one good moral row per student, replaced in place', async () => {
    const { store, cold } = stack()
    const review = (status: string) => ({ studentId: 'QCU-STU-CS', status, decisionSource: 'Office', notes: '', actorId: 'QCU-GUIDANCE', at })
    await cold().transact((unit) => { unit.read().goodMoral.push(review('Pending QCU review')) })
    await cold().transact((unit) => { const db = unit.read(); db.goodMoral = db.goodMoral.filter((row) => row.studentId !== 'QCU-STU-CS'); db.goodMoral.push(review('Prerequisites reviewed')) })
    expect(store.all().map((item) => [item.table, item.id, item.version])).toEqual([['ccs_discipline', 'QCU-STU-CS', 2]])
    expect((await cold().view((unit) => unit.read().goodMoral)).map((row) => row.status)).toEqual(['Prerequisites reviewed'])
  })
})

describe('the session check', () => {
  it('reads only restrictions from the record store', async () => {
    const lists: string[] = []
    const { instance } = stack((store) => ({ list: async (table, collection) => { lists.push(`${table}/${collection}`); return store.list(table, collection) }, write: (writes) => store.write(writes) }))
    const { agent } = await signIn(instance(), 'QCU-STU-CS')
    lists.length = 0
    expect((await agent.get('/api/session')).status).toBe(200)
    expect(lists).toEqual(['ccs_discipline/restrictions'])
  })
})
