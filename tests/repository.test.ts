import request from 'supertest'
import { beforeEach, describe, expect, it } from 'vitest'

import { createApp } from '../src/app.js'
import { createMemoryAuthStore, hashPassword } from '../src/auth.js'
import type { User } from '../src/schemas.js'
import { createMemoryRepository, type MemoryRepository, type Repository } from '../src/store.js'

const password = 'Accs@Qcu2026!'
const tick = () => new Promise(resolve => setImmediate(resolve))

/** Yields to the event loop around every unit of work, as a networked backend would. */
function withLatency(inner: Repository): Repository {
  const slow = (run: Repository['view']): Repository['view'] => async work => {
    await tick()
    const result = await run(work)
    await tick()
    return result
  }
  return { view: slow(work => inner.view(work)), transact: slow(work => inner.transact(work)) }
}

describe('memory repository contract', () => {
  let repo: MemoryRepository
  beforeEach(() => { repo = createMemoryRepository() })

  it('keeps what a transaction changes and returns a detached result', async () => {
    const created = await repo.transact(unit => {
      const todo = { id: unit.nextId('TODO'), ownerId: 'QCU-STU-CS', title: 'kept', date: '2026-11-04', done: false }
      unit.read().todos.push(todo)
      return todo
    })
    expect(repo.read().todos.at(-1)).toEqual(created)
    created.title = 'changed after the commit'
    expect(repo.read().todos.at(-1)?.title).toBe('kept')
  })

  it('rolls back every change when the work throws', async () => {
    const before = structuredClone(repo.read())
    await expect(repo.transact(unit => {
      const db = unit.read()
      unit.nextId('TODO')
      db.todos.push({ id: 'TODO-X', ownerId: 'QCU-STU-CS', title: 'lost', date: '2026-11-04', done: false })
      db.users[0]!.name = 'Changed nested value'
      db.posts = []
      throw new Error('boom')
    })).rejects.toThrow('boom')
    expect(repo.read()).toEqual(before)
  })

  it('discards changes made in a view and refuses to allocate IDs there', async () => {
    const before = structuredClone(repo.read())
    await repo.view(unit => { unit.read().users[0]!.name = 'Changed in a view'; unit.read().posts = [] })
    expect(repo.read()).toEqual(before)
    await expect(repo.view(unit => unit.nextId('TODO'))).rejects.toThrow('read-only')
  })

  it('returns view results that cannot reach the stored state', async () => {
    const user = await repo.view(unit => unit.read().users[0]!)
    user.roles.push('administrator')
    expect(repo.read().users[0]!.roles).not.toContain('administrator')
  })
})

describe('API over the repository boundary', () => {
  let repo: MemoryRepository
  const signIn = async (app: ReturnType<typeof createApp>, id: string) => {
    const agent = request.agent(app)
    expect((await agent.post('/api/auth/sign-in').send({ emailOrId: id, password })).status).toBe(200)
    return agent
  }
  beforeEach(() => { repo = createMemoryRepository() })

  it('keeps nothing from an action that fails partway', async () => {
    const app = createApp(repo, { authStore: createMemoryAuthStore() })
    const admin = await signIn(app, 'ACCS-ADMIN')
    // The flagged comment's post is gone, so the action fails after it has already changed the moderation item.
    repo.read().posts = repo.read().posts.filter(post => post.id !== 'POST-0102')
    const response = await admin.post('/api/pages/P50/actions').send({ action: 'moderate', recordId: 'MOD-0101', reason: 'Off topic', payload: { decision: 'remove', notifyAuthor: false } })
    expect(response.status).toBe(404)
    const item = repo.read().moderation.find(entry => entry.id === 'MOD-0101')!
    expect(item.status).toBe('Pending')
    expect(item.history).toEqual([])
  })

  it('commits the audit entry written while a student record is read', async () => {
    const app = createApp(repo, { authStore: createMemoryAuthStore() })
    const dean = await signIn(app, 'QCU-FAC-PAULA-DELACRUZ')
    const response = await dean.get('/api/pages/P34?id=QCU-STU-RESTRICTED&purpose=Case%20handling')
    expect(response.status).toBe(200)
    expect(repo.read().audit.filter(entry => entry.action === 'Record opened' && entry.purpose === 'Case handling')).toHaveLength(1)
  })

  it('does not change state when a page is read', async () => {
    const app = createApp(repo, { authStore: createMemoryAuthStore() })
    const student = await signIn(app, 'QCU-STU-IT-A')
    const before = structuredClone(repo.read())
    for (const page of ['P03', 'P04', 'P13', 'P18', 'P26', 'P40']) expect((await student.get(`/api/pages/${page}`)).status).toBe(200)
    expect(repo.read()).toEqual(before)
  })

  describe('with a backend that yields between steps', () => {
    let app: ReturnType<typeof createApp>
    beforeEach(() => { app = createApp(withLatency(repo), { authStore: createMemoryAuthStore() }) })

    it('reads, writes, and maps domain errors to their status', async () => {
      const student = await signIn(app, 'QCU-STU-IT-A')
      expect((await student.get('/api/session')).body.user.id).toBe('QCU-STU-IT-A')
      expect((await student.get('/api/pages/P45')).status).toBe(403)
      expect((await student.get('/api/pages/P08?id=SPACE-IT-B')).status).toBe(404)
      const todo = await student.post('/api/pages/P13/actions').send({ action: 'createTodo', payload: { title: 'Through the boundary', date: '2026-11-05' } })
      expect(todo.status).toBe(200)
      expect((await student.get('/api/pages/P13')).body.data.todos.map((entry: { id: string }) => entry.id)).toContain(todo.body.record.id)
    })

    it('still allows only one reservation of a slot under concurrent requests', async () => {
      const [first, second] = await Promise.all([signIn(app, 'QCU-STU-IT-A'), signIn(app, 'QCU-STU-RESTRICTED')])
      const responses = await Promise.all([first, second].map(agent => agent.post('/api/pages/P15/actions').send({ action: 'createConsultation', payload: { slotId: 'SLOT-0101', purpose: 'Academic question' } })))
      expect(responses.map(response => response.status).sort()).toEqual([200, 409])
      expect(repo.read().consultations.filter(consultation => consultation.slotId === 'SLOT-0101')).toHaveLength(1)
    })

    it('merges an auth-store user once when requests arrive together', async () => {
      const authStore = createMemoryAuthStore()
      const body = { email: 'new.student@qcu.edu.ph', password: 'N3w!Passw0rdXyz' }
      const added: User = { id: 'USR-NEW', name: 'New Student', email: body.email, roles: ['student'], program: 'BSIT', section: 'A', year: 3, studentId: '26-0999', restrictions: [], title: '', bio: '', education: '', officeHours: '', spaceIds: ['SPACE-IT-A'], organizationIds: [], active: true }
      await authStore.update(data => { data.users.push(added); data.credentials[added.id] = hashPassword(body.password) })
      // A second instance has never seen this user, so concurrent requests race to merge them.
      const fresh = createMemoryRepository()
      const other = createApp(withLatency(fresh), { authStore })
      const signIns = await Promise.all(Array.from({ length: 5 }, () => request(other).post('/api/auth/sign-in').send({ emailOrId: body.email, password: body.password })))
      expect(signIns.map(response => response.status)).toEqual([200, 200, 200, 200, 200])
      expect(fresh.read().users.filter(user => user.email === body.email)).toHaveLength(1)
      const space = fresh.read().spaces.find(entry => entry.id === 'SPACE-IT-A')!
      expect(space.studentIds.filter(id => id === added.id)).toHaveLength(1)
    })
  })
})
