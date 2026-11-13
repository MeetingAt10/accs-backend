import request from 'supertest'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { createApp } from '../src/app.js'
import { createMemoryAuthStore } from '../src/auth.js'
import { devToolboxEnabled, isDevToolboxCall, type Stack } from '../src/dev.js'
import { createRecordRepository } from '../src/persist.js'
import { createMemoryRecordStore } from '../src/records.js'
import { createMemorySessionStore } from '../src/sessions.js'
import { createMemoryRepository, seed, type MemoryRepository } from '../src/store.js'
import { activateSecretary, secretaryPassword, seedPassword, secretarySession, signIn } from './helpers.js'

type Body = Record<string, any>

// As deployed: the Lambda runs with NODE_ENV=production on both stacks and tells them apart by the table prefix.
const dev: Stack = { tablePrefix: 'accs-dev-', nodeEnv: 'production' }
const prod: Stack = { tablePrefix: 'accs-prod-', nodeEnv: 'production' }
const cookieOf = (response: request.Response) => String(response.headers['set-cookie'][0]).split(';')[0]!
const student = { name: 'Ben Student', email: 'ben.student@gmail.com', studentId: '26-1001', program: 'BSIT', year: 3, section: 'A' }

function setup(stack: Stack, repository: MemoryRepository = createMemoryRepository()) {
  const authStore = createMemoryAuthStore()
  const sessionStore = createMemorySessionStore()
  return { repository, authStore, sessionStore, app: createApp(repository, { authStore, sessionStore, stack }) }
}

beforeEach(() => { vi.spyOn(console, 'log').mockImplementation(() => {}) })
afterEach(() => vi.restoreAllMocks())

describe('where the account switcher exists', () => {
  it.each<[Stack, boolean]>([
    [{ tablePrefix: 'accs-dev-', nodeEnv: 'production' }, true],
    [{ tablePrefix: 'accs-dev-', nodeEnv: 'development' }, true],
    [{ tablePrefix: undefined, nodeEnv: 'development' }, true],
    [{ tablePrefix: undefined, nodeEnv: 'test' }, true],
    [{ tablePrefix: 'accs-prod-', nodeEnv: 'production' }, false],
    // A deployed table set that is not the development one never gets the routes, whatever NODE_ENV says.
    [{ tablePrefix: 'accs-prod-', nodeEnv: 'development' }, false],
    [{ tablePrefix: 'accs-prod-', nodeEnv: 'test' }, false],
    [{ tablePrefix: 'accs-devops-', nodeEnv: 'development' }, false],
    [{ tablePrefix: undefined, nodeEnv: 'production' }, false],
  ])('%j: %s', (stack, mounted) => {
    expect(devToolboxEnabled(stack)).toBe(mounted)
  })

  it('names only the two calls the toolbox makes', () => {
    expect([['GET', '/dev/users'], ['POST', '/dev/switch-user']].every(([method, path]) => isDevToolboxCall(method!, path!))).toBe(true)
    for (const [method, path] of [['POST', '/dev/users'], ['GET', '/dev/switch-user'], ['GET', '/session'], ['GET', '/dev/other'], ['DELETE', '/dev/users']]) expect(isDevToolboxCall(method!, path!)).toBe(false)
  })
})

describe.each<[string, Stack]>([
  ['the production stack', prod],
  ['a deployed stack that is not the development one, run with NODE_ENV=development', { tablePrefix: 'accs-prod-', nodeEnv: 'development' }],
  ['production without a table prefix', { nodeEnv: 'production' }],
])('on %s', (_name, stack) => {
  it('has no such routes: 404 for a signed-in Dean, 401 for nobody, and no one is switched', async () => {
    const { app, repository } = setup(stack)
    const { agent: dean } = await signIn(app, 'CCS-DEAN')
    const missing = { error: 'This API resource is not available.', code: 'NOT_FOUND' }
    for (const response of [await dean.get('/api/dev/users'), await dean.post('/api/dev/switch-user').send({ userId: 'QCU-STU-IT-A' }), await dean.post('/api/dev/switch-user').send({})]) {
      expect(response.status).toBe(404)
      expect(response.body).toEqual(missing)
    }
    expect((await dean.get('/api/session')).body.user.id).toBe('CCS-DEAN')
    expect(repository.read().audit.some((entry) => entry.action === 'Account switched')).toBe(false)
    // The shared session check runs first, as it does for any unknown API path.
    expect((await request(app).get('/api/dev/users')).status).toBe(401)
    expect((await request(app).post('/api/dev/switch-user').send({ userId: 'QCU-STU-IT-A' })).status).toBe(401)
  })

  it('keeps the first-sign-in gate on every route, the toolbox paths included', async () => {
    const { app } = setup(stack)
    const credentials = await activateSecretary(app)
    const { agent } = await signIn(app, credentials.username, credentials.temporaryPassword)
    for (const response of [await agent.get('/api/dev/users'), await agent.post('/api/dev/switch-user').send({ userId: 'CCS-DEAN' })]) {
      expect([response.status, response.body.code]).toEqual([403, 'CREDENTIALS_CHANGE_REQUIRED'])
    }
  })
})

describe('on the development stack', () => {
  it('needs a session', async () => {
    const { app } = setup(dev)
    expect((await request(app).get('/api/dev/users')).status).toBe(401)
    expect((await request(app).post('/api/dev/switch-user').send({ userId: 'QCU-STU-IT-A' })).status).toBe(401)
  })

  it('lists every account, the inactive ones and the ones from the auth store included', async () => {
    const context = setup(dev)
    const { agent: dean } = await signIn(context.app, 'CCS-DEAN')
    const first = await dean.get('/api/dev/users')
    expect(first.status).toBe(200)
    const seeded = seed().users
    expect(first.body.users).toHaveLength(seeded.length)
    // The secretary has not been activated yet and has no username.
    expect(first.body.users.find((user: Body) => user.id === 'QCU-SECRETARY')).toEqual({ id: 'QCU-SECRETARY', name: 'CCS Secretary', roles: ['secretary'], active: false })
    expect(first.body.users.find((user: Body) => user.id === 'CCS-DEAN')).toEqual({ id: 'CCS-DEAN', name: 'Dr. Sage Linden', roles: ['dean'], active: true })

    const secretary = await secretarySession(context.app)
    const [made] = (await secretary.post('/api/accounts/students').send({ students: [student] })).body.record.results as Body[]
    expect((await secretary.post('/api/accounts/QCU-PROF-OTHER/active').send({ active: false })).status).toBe(200)
    // A cold instance over the same auth store lists them too, and so does a signed-in student.
    const cold = createApp(createMemoryRepository(), { authStore: context.authStore, sessionStore: context.sessionStore, stack: dev })
    const { agent: viaCold } = await signIn(cold, 'QCU-STU-IT-A')
    for (const agent of [dean, viaCold]) {
      const listing = await agent.get('/api/dev/users')
      const users = listing.body.users as Body[]
      expect(users.map((user) => user.name)).toEqual([...users.map((user) => user.name)].sort((a, b) => a.localeCompare(b)))
      expect(users).toHaveLength(seeded.length + 1)
      expect(users.find((user) => user.id === made!.account.id)).toEqual({ id: made!.account.id, name: 'Ben Student', roles: ['student'], active: true, username: made!.credentials.username })
      expect(users.find((user) => user.id === 'QCU-PROF-OTHER')).toMatchObject({ active: false })
      expect(users.find((user) => user.id === 'QCU-SECRETARY')).toMatchObject({ active: true, username: 'ccs.secretary' })
      // Names, roles, and the sign-in name only: no email, student ID, hash, or password.
      for (const user of users) expect(Object.keys(user).every((key) => ['id', 'name', 'roles', 'active', 'username'].includes(key))).toBe(true)
      expect(JSON.stringify(listing.body)).not.toMatch(/scrypt|@|26-1001|Passw/)
    }
  })

  it('ends the current session, starts one for the target, and answers as sign-in does', async () => {
    const { app, repository } = setup(dev)
    const signedIn = await request(app).post('/api/auth/sign-in').send({ emailOrId: 'CCS-DEAN', password: seedPassword })
    const oldCookie = cookieOf(signedIn)
    const switched = await request(app).post('/api/dev/switch-user').set('Cookie', oldCookie).send({ userId: 'QCU-STU-IT-A' })
    expect(switched.status).toBe(200)
    const direct = await request(app).post('/api/auth/sign-in').send({ emailOrId: 'QCU-STU-IT-A', password: seedPassword })
    expect(switched.body).toEqual(direct.body)
    expect(switched.body.user.roles).toEqual(['student'])
    expect(Object.keys(switched.body).sort()).toEqual(['allowedPages', 'permissions', 'roleLabels', 'user'])

    // The old token is dead, the new one belongs to the student and is not the same.
    const newCookie = cookieOf(switched)
    expect(newCookie).not.toBe(oldCookie)
    for (const call of [request(app).get('/api/session'), request(app).get('/api/pages/P03'), request(app).get('/api/dev/users')]) expect((await call.set('Cookie', oldCookie)).status).toBe(401)
    expect((await request(app).get('/api/session').set('Cookie', newCookie)).body.user.id).toBe('QCU-STU-IT-A')
    expect((await request(app).get('/api/pages/P45').set('Cookie', newCookie)).status).toBe(403)
    expect(String(switched.headers['set-cookie'][0])).toMatch(/HttpOnly/)

    // One entry: who switched, to whom, and what. Nothing else.
    const entries = repository.read().audit.filter((entry) => entry.action === 'Account switched')
    expect(entries).toHaveLength(1)
    expect(entries[0]).toMatchObject({ actorId: 'CCS-DEAN', reference: 'QCU-STU-IT-A', module: 'identity', result: 'Recorded' })
    expect(Object.keys(entries[0]!).sort()).toEqual(['action', 'actorId', 'at', 'id', 'module', 'reference', 'result'])
    expect(JSON.stringify(entries)).not.toContain(oldCookie.split('=')[1]!)
    expect(JSON.stringify(entries)).not.toContain(newCookie.split('=')[1]!)
    // The administrator reads it in the audit trail.
    const { agent: admin } = await signIn(app, 'ACCS-ADMIN')
    expect((await admin.get('/api/pages/P51')).body.data.audit.some((entry: Body) => entry.action === 'Account switched' && entry.reference === 'QCU-STU-IT-A' && entry.actor.name === 'Dr. Sage Linden')).toBe(true)
  })

  it('answers with the whole session, and the secretary it switches to can open Home', async () => {
    const { app } = setup(dev)
    // The Dean activates the secretary, who replaces the temporary details at the first sign-in.
    await secretarySession(app)
    const { agent: tester } = await signIn(app, 'CCS-DEAN')
    const switched = await tester.post('/api/dev/switch-user').send({ userId: 'QCU-SECRETARY' })
    expect(switched.status).toBe(200)
    expect(switched.body.user).toMatchObject({ id: 'QCU-SECRETARY', roles: ['secretary'], username: 'ccs.secretary', mustChangeCredentials: false })
    // The same body as signing in as the secretary: the user, the permissions, the allowed pages, and the role labels.
    const direct = await signIn(app, 'ccs.secretary', secretaryPassword)
    expect(switched.body).toEqual(direct.response.body)
    expect(switched.body.allowedPages).toContain('P03')
    expect(switched.body.permissions).toEqual(expect.arrayContaining(['account.provision', 'self.manage']))
    expect(switched.body.roleLabels.secretary).toBe('CCS Secretary')
    // The tester's cookie is now the secretary's: Home opens, and so do the secretary's account pages.
    const home = await tester.get('/api/pages/P03')
    expect([home.status, home.body.pageId, home.body.title]).toEqual([200, 'P03', 'Home'])
    expect(Array.isArray(home.body.data.stats)).toBe(true)
    expect((await tester.get('/api/accounts/types')).status).toBe(200)
  })

  it('switches again and again, and back, each time recorded', async () => {
    const { app, repository } = setup(dev)
    const { agent } = await signIn(app, 'QCU-STU-IT-A')
    for (const id of ['QCU-PROF-IT', 'QCU-CHAIR-IT', 'ACCS-ADMIN', 'QCU-STU-IT-A', 'QCU-STU-IT-A']) {
      expect((await agent.post('/api/dev/switch-user').send({ userId: id })).status).toBe(200)
      expect((await agent.get('/api/session')).body.user.id).toBe(id)
    }
    expect(repository.read().audit.filter((entry) => entry.action === 'Account switched').map((entry) => [entry.actorId, entry.reference])).toEqual([
      ['QCU-STU-IT-A', 'QCU-PROF-IT'], ['QCU-PROF-IT', 'QCU-CHAIR-IT'], ['QCU-CHAIR-IT', 'ACCS-ADMIN'], ['ACCS-ADMIN', 'QCU-STU-IT-A'], ['QCU-STU-IT-A', 'QCU-STU-IT-A'],
    ])
  })

  it('refuses only an account that is not active, and an account that does not exist', async () => {
    const { app, repository } = setup(dev)
    const { agent } = await signIn(app, 'CCS-DEAN')
    const inactive = await agent.post('/api/dev/switch-user').send({ userId: 'QCU-SECRETARY' })
    expect([inactive.status, inactive.body.code]).toEqual([409, 'CONFLICT'])
    expect((await agent.post('/api/dev/switch-user').send({ userId: 'NOBODY' })).status).toBe(404)
    for (const bad of [{}, { userId: '' }, { userId: 7 }, { userId: 'CCS-DEAN', extra: true }, { userId: 'x'.repeat(65) }]) expect([JSON.stringify(bad), (await agent.post('/api/dev/switch-user').send(bad)).status]).toEqual([JSON.stringify(bad), 400])
    // Still the Dean, and nothing was recorded.
    expect((await agent.get('/api/session')).body.user.id).toBe('CCS-DEAN')
    expect(repository.read().audit.some((entry) => entry.action === 'Account switched')).toBe(false)
  })

  it('stays open to an account that still holds temporary details, in both directions', async () => {
    const { app } = setup(dev)
    const credentials = await activateSecretary(app)
    const { agent } = await signIn(app, credentials.username, credentials.temporaryPassword)
    // Every other call is held until the details are replaced; the two toolbox calls are not.
    expect([(await agent.get('/api/pages/P03')).status, (await agent.get('/api/pages/P03')).body.code]).toEqual([403, 'CREDENTIALS_CHANGE_REQUIRED'])
    expect((await agent.get('/api/dev/users')).status).toBe(200)
    expect((await agent.post('/api/dev/switch-user').send({ userId: 'QCU-STU-IT-A' })).status).toBe(200)
    expect((await agent.get('/api/pages/P03')).status).toBe(200)
    // Switching into the account that is still on temporary details lands on the gate, and the toolbox still gets the tester out.
    const into = await agent.post('/api/dev/switch-user').send({ userId: 'QCU-SECRETARY' })
    expect([into.status, into.body.user.mustChangeCredentials]).toEqual([200, true])
    expect((await agent.get('/api/pages/P03')).body.code).toBe('CREDENTIALS_CHANGE_REQUIRED')
    expect((await agent.post('/api/dev/switch-user').send({ userId: 'CCS-DEAN' })).status).toBe(200)
    expect((await agent.get('/api/session')).body.user.id).toBe('CCS-DEAN')
  })

  it('does not switch when the switch cannot be recorded', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const { app, repository } = setup(dev)
    const { agent } = await signIn(app, 'CCS-DEAN')
    const transact = repository.transact.bind(repository)
    vi.spyOn(repository, 'transact').mockImplementation(((work: Parameters<typeof transact>[0], collections?: Parameters<typeof transact>[1]) => {
      if (collections?.includes('audit')) return Promise.reject(new Error('audit table unavailable'))
      return transact(work, collections)
    }) as typeof repository.transact)
    const refused = await agent.post('/api/dev/switch-user').send({ userId: 'QCU-STU-IT-A' })
    expect([refused.status, refused.body.code]).toEqual([500, 'INTERNAL_ERROR'])
    expect(error).toHaveBeenCalledTimes(1)
    expect((await agent.get('/api/session')).body.user.id).toBe('CCS-DEAN')
  })

  it('records the switch in the audit table of a shared record store, and nothing else', async () => {
    const store = createMemoryRecordStore()
    const authStore = createMemoryAuthStore()
    const sessionStore = createMemorySessionStore()
    const app = createApp(createRecordRepository(store), { authStore, sessionStore, stack: dev })
    const { agent } = await signIn(app, 'CCS-DEAN')
    expect(store.all()).toEqual([])
    expect((await agent.post('/api/dev/switch-user').send({ userId: 'QCU-PROF-IT' })).status).toBe(200)
    expect(store.all().map((item) => [item.table, item.collection])).toEqual([['ccs_audit', 'audit']])
    expect(JSON.parse(store.all()[0]!.data!)).toMatchObject({ actorId: 'CCS-DEAN', action: 'Account switched', reference: 'QCU-PROF-IT' })
    // Another instance sees the new session and the entry.
    const other = createApp(createRecordRepository(store), { authStore, sessionStore, stack: dev })
    expect((await agent.get('/api/session')).body.user.id).toBe('QCU-PROF-IT')
    const { agent: admin } = await signIn(other, 'ACCS-ADMIN')
    expect((await admin.get('/api/pages/P51')).body.data.audit.some((entry: Body) => entry.action === 'Account switched')).toBe(true)
  })
})
