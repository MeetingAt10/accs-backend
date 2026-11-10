import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

import { createApp } from '../src/app.js'
import { createMemoryAuthStore } from '../src/auth.js'
import { createRecordRepository, persisted } from '../src/persist.js'
import { createMemoryRecordStore, type RecordStore } from '../src/records.js'
import { createMemorySessionStore } from '../src/sessions.js'
import { createMemoryRepository, type Database } from '../src/store.js'
import { secretaryPassword, secretarySession, signIn } from './helpers.js'

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
      restrictions: 'ccs_discipline', referrals: 'ccs_discipline', strikes: 'ccs_discipline', strikeSettlements: 'ccs_discipline', goodMoral: 'ccs_discipline',
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

type Step = { as: string; page: string; action: string; recordId?: string; reason?: string; payload: object }
const post = { title: 'Stored post', body: 'Stored body.', audience: 'college', label: 'Discussion', kind: 'discussion' }

/** One real action per collection: who does it, and what must then be stored, and where. */
const writes: { collection: string; table: string; step: Step }[] = [
  { collection: 'posts', table: 'ccs_community', step: { as: 'QCU-STU-IT-A', page: 'P05', action: 'createPost', payload: post } },
  { collection: 'moderation', table: 'ccs_moderation', step: { as: 'QCU-STU-IT-A', page: 'P06', action: 'flag', recordId: 'POST-0101', payload: { reason: 'Off topic' } } },
  { collection: 'todos', table: 'ccs_scheduling', step: { as: 'QCU-STU-IT-A', page: 'P13', action: 'createTodo', payload: { title: 'Stored', date: '2026-11-05' } } },
  { collection: 'cycles', table: 'ccs_evaluation', step: { as: 'QCU-DEAN', page: 'P30', action: 'createCycle', payload: { title: 'Stored cycle', term: 'Term', opens: '2027-01-01', closes: '2027-03-01' } } },
  { collection: 'followUps', table: 'ccs_evaluation', step: { as: 'QCU-CHAIR-IT', page: 'P29', action: 'saveFollowUp', recordId: 'QCU-PROF-IT', payload: { note: 'Discussed' } } },
  { collection: 'restrictions', table: 'ccs_discipline', step: { as: 'QCU-ADMIN', page: 'P35', action: 'applyRestriction', reason: 'Approved', payload: { studentId: 'QCU-STU-IT-A', features: ['post.create'], basis: 'Approved review', decisionReference: 'QCU-DEC-002', until: '2099-01-01' } } },
  { collection: 'referrals', table: 'ccs_discipline', step: { as: 'QCU-GUIDANCE', page: 'P35', action: 'referRestriction', reason: 'Review the status', payload: { studentId: 'QCU-STU-IT-A', change: 'Review' } } },
  { collection: 'goodMoral', table: 'ccs_discipline', step: { as: 'QCU-GUIDANCE', page: 'P34', action: 'reviewGoodMoral', recordId: 'QCU-STU-RESTRICTED', payload: { status: 'Prerequisites reviewed', decisionSource: 'Office' } } },
  { collection: 'clusters', table: 'ccs_grievance', step: { as: 'QCU-CHAIR-IT', page: 'P24', action: 'reviewCluster', recordId: 'CLUSTER-0101', reason: 'Reviewed', payload: { decision: 'confirmed' } } },
  { collection: 'settings', table: 'ccs_notification', step: { as: 'QCU-STU-IT-A', page: 'P43', action: 'saveSettings', payload: { theme: 'dark', density: 'compact' } } },
  { collection: 'drafts', table: 'ccs_assistant', step: { as: 'QCU-STU-IT-A', page: 'P19', action: 'saveDraft', payload: { narrative: 'Unfinished concern' } } },
  { collection: 'telemetry', table: 'ccs_assistant', step: { as: 'QCU-STU-IT-A', page: 'P41', action: 'assistantAsk', payload: { question: 'Show my schedule' } } },
  { collection: 'permissionOverrides', table: 'ccs_identity', step: { as: 'QCU-ADMIN', page: 'P48', action: 'updatePermission', reason: 'Proposal', payload: { role: 'staff', permission: 'post.create', allowed: false } } },
]

describe('a route writes through one instance', () => {
  it.each(writes)('$collection lands in $table and a cold instance sees it', async ({ collection, table, step }) => {
    const { store, cold, instance } = stack()
    const { agent } = await signIn(instance(), step.as)
    const { as: _as, page, ...body } = step
    const response = await agent.post(`/api/pages/${page}/actions`).send(body)
    expect(response.status, JSON.stringify(response.body)).toBe(200)
    const items = store.all().filter((item) => item.collection === collection)
    expect(items.length).toBeGreaterThan(0)
    expect(items.every((item) => item.table === table)).toBe(true)
    const seen: unknown = await cold().view((unit) => unit.read()[collection as keyof Database])
    const ids = Array.isArray(seen) ? seen.map((row: { id?: string; studentId?: string }) => String(row.id ?? row.studentId)) : Object.keys(seen as object)
    for (const item of items) expect(ids).toContain(item.id)
  })

  it('stores an announcement event in ccs_scheduling', async () => {
    const { store, cold, instance } = stack()
    const { agent } = await signIn(instance(), 'QCU-DEAN')
    const response = await agent.post('/api/pages/P05/actions').send({ action: 'createPost', payload: { title: 'Open house', body: 'Details.', audience: 'college', kind: 'announcement', eventDate: '2027-01-15', eventTime: '09:00', eventPlace: 'IC 301' } })
    expect(response.status, JSON.stringify(response.body)).toBe(200)
    expect(store.all().filter((item) => item.collection === 'events').map((item) => item.table)).toEqual(['ccs_scheduling'])
    expect((await cold().view((unit) => unit.read().events)).some((event) => event.postId === response.body.record.id)).toBe(true)
  })

  it('stores generated assignments in ccs_evaluation when a cycle moves to review', async () => {
    const { store, instance } = stack()
    const { agent: dean } = await signIn(instance(), 'QCU-DEAN')
    const dates = { opens: '2027-01-01', closes: '2027-03-01' }
    const created = await dean.post('/api/pages/P30/actions').send({ action: 'createCycle', payload: { title: 'Stored cycle', term: 'Term', ...dates } })
    const id = created.body.record.id as string
    const saved = await dean.post('/api/pages/P31/actions').send({ action: 'saveCycle', recordId: id, payload: { title: 'Stored cycle', instructions: 'Answer honestly.', ...dates, questions: [{ id: 'Q1', criterion: 'Teaching', text: 'Is the class clear?', type: 'rating', required: true }], forms: ['peer'] } })
    expect(saved.status, JSON.stringify(saved.body)).toBe(200)
    const moved = await dean.post('/api/pages/P31/actions').send({ action: 'cycleAction', recordId: id, payload: { status: 'In review' } })
    expect(moved.status, JSON.stringify(moved.body)).toBe(200)
    const assignments = store.all().filter((item) => item.collection === 'assignments')
    expect(assignments.length).toBeGreaterThan(0)
    expect(new Set(assignments.map((item) => item.table))).toEqual(new Set(['ccs_evaluation']))
  })

  it('keeps comments and reactions inside the post, for every instance', async () => {
    const { store, instance } = stack()
    const { agent: first } = await signIn(instance(), 'QCU-STU-CS')
    const comment = await first.post('/api/pages/P06/actions').send({ action: 'comment', recordId: 'POST-0101', payload: { body: 'Stored comment' } })
    expect(comment.status, JSON.stringify(comment.body)).toBe(200)
    expect((await first.post('/api/pages/P06/actions').send({ action: 'react', recordId: 'POST-0101', payload: {} })).status).toBe(200)
    expect(store.all().filter((item) => item.collection === 'posts').map((item) => [item.id, item.version])).toEqual([['POST-0101', 2]])
    const stored = JSON.parse(store.all().find((item) => item.collection === 'posts')!.data!)
    expect(stored.comments.map((entry: { body: string }) => entry.body)).toContain('Stored comment')
    expect(stored.reactions).toContain('QCU-STU-CS')
    const { agent: second } = await signIn(instance(), 'QCU-STU-IT-B')
    expect(JSON.stringify((await second.get('/api/pages/P06?id=POST-0101')).body)).toContain('Stored comment')
  })

  it('applies a restriction from one instance to a session open on another', async () => {
    const { instance } = stack()
    const [first, second] = [instance(), instance()]
    const { agent: student } = await signIn(second, 'QCU-STU-IT-A')
    expect((await student.get('/api/pages/P05')).status).toBe(200)
    const { agent: admin } = await signIn(first, 'QCU-ADMIN')
    const applied = await admin.post('/api/pages/P35/actions').send({ action: 'applyRestriction', reason: 'Approved', payload: { studentId: 'QCU-STU-IT-A', features: ['post.create'], basis: 'Approved review', decisionReference: 'QCU-DEC-002', until: '2099-01-01' } })
    expect(applied.status).toBe(200)
    expect((await student.get('/api/pages/P05')).status).toBe(403)
    expect((await admin.post('/api/pages/P35/actions').send({ action: 'liftRestriction', recordId: applied.body.record.id, reason: 'Done', payload: {} })).status).toBe(200)
    expect((await student.get('/api/pages/P05')).status).toBe(200)
  })
})

describe('accounts across a restart', () => {
  const profile = { title: 'Senior lecturer', bio: 'Updated bio.', education: 'MS CS', officeHours: 'Fridays' }

  it('keeps saved profile text on every instance and after a cold start', async () => {
    const { instance } = stack()
    const { agent: prof } = await signIn(instance(), 'QCU-PROF-IT')
    expect((await prof.post('/api/pages/P39/actions').send({ action: 'saveProfile', payload: profile })).status).toBe(200)
    const { agent: viewer } = await signIn(instance(), 'QCU-STU-CS')
    expect((await viewer.get('/api/pages/P38?id=QCU-PROF-IT')).body.data.record).toMatchObject(profile)
  })

  it('keeps the rest of the account when profile text is saved', async () => {
    const { authStore, instance } = stack()
    const { agent: prof } = await signIn(instance(), 'QCU-PROF-IT')
    await prof.post('/api/pages/P39/actions').send({ action: 'saveProfile', payload: profile })
    const stored = (await authStore.load()).users.find((user) => user.id === 'QCU-PROF-IT')!
    expect(stored).toMatchObject({ ...profile, active: true })
    expect(stored.roles).toContain('professor')
  })

  it('keeps P46/P47 role grants after a restart', async () => {
    const { instance } = stack()
    const { agent: admin } = await signIn(instance(), 'QCU-ADMIN')
    const granted = await admin.post('/api/pages/P47/actions').send({ action: 'updateRoles', recordId: 'QCU-STAFF', reason: 'New duties', payload: { roles: ['staff', 'guidance'] } })
    expect(granted.status, JSON.stringify(granted.body)).toBe(200)
    const { agent: restarted } = await signIn(instance(), 'QCU-STAFF')
    expect((await restarted.get('/api/session')).body.user.roles).toEqual(['staff', 'guidance'])
  })
})

describe('the record repository behaves like memory', () => {
  beforeAll(() => { vi.spyOn(console, 'log').mockImplementation(() => {}) })
  afterAll(() => vi.restoreAllMocks())

  const accounts = ['QCU-STU-IT-A', 'QCU-ORG', 'QCU-PROF-IT', 'QCU-STAFF', 'QCU-CHAIR-IT', 'QCU-DEAN', 'QCU-ADMIN', 'QCU-GUIDANCE', 'QCU-OSAS']
  const pageIds = Array.from({ length: 50 }, (_, n) => `P${String(n + 3).padStart(2, '0')}`)

  it.each(accounts)('%s gets the same status on every page', async (id) => {
    const { instance } = stack()
    const { agent: stored } = await signIn(instance(), id)
    const { agent: memory } = await signIn(createApp(createMemoryRepository(), { authStore: createMemoryAuthStore(), sessionStore: createMemorySessionStore() }), id)
    for (const page of pageIds) {
      const [a, b] = await Promise.all([stored.get(`/api/pages/${page}`), memory.get(`/api/pages/${page}`)])
      expect(a.status, `${id} ${page}: ${JSON.stringify(a.body).slice(0, 200)}`).toBe(b.status)
      expect(a.status).not.toBe(500)
    }
  })

  it('serves the routes that name their collections', async () => {
    const { instance } = stack()
    const app = instance()
    const secretary = await secretarySession(app)
    for (const path of ['/api/accounts/types', '/api/accounts', '/api/accounts/faculty', '/api/accounts/advisors']) {
      expect((await secretary.get(path)).status, path).toBe(200)
    }
    const created = await secretary.post('/api/accounts/students').send({ students: [{ name: 'New Student', email: 'new.student@qcu.edu.ph', studentId: '24-9999', program: 'BSIT', year: 2, section: 'A' }] })
    expect(created.status, JSON.stringify(created.body)).toBe(200)
    expect(created.body.record.created).toBe(1)
    expect((await secretary.post('/api/auth/change-password').send({ currentPassword: secretaryPassword, password: 'Sec#Passw0rd-2027' })).status).toBe(200)
    const { agent: admin } = await signIn(app, 'QCU-ADMIN')
    expect((await admin.post('/api/admin/accounts/QCU-STU-CS/reset-code').send({})).status).toBe(200)
    expect((await admin.post('/api/auth/sign-out').send({})).status).toBe(200)
    expect((await admin.get('/api/session')).status).toBe(401)
  })
})
