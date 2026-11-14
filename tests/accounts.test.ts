import { readFileSync } from 'node:fs'
import request from 'supertest'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { sendInvite, temporaryPassword, type Invite, type InviteMailer } from '../src/accounts.js'
import { createApp } from '../src/app.js'
import { createMemoryAuthStore, passwordProblem } from '../src/auth.js'
import { facultyRoster } from '../src/faculty-roster.js'
import { createRecordRepository } from '../src/persist.js'
import { createMemoryRecordStore } from '../src/records.js'
import { createMemorySessionStore } from '../src/sessions.js'
import { createMemoryRepository, type Database, type Repository } from '../src/store.js'
import { activateSecretary, concernChoices, secretaryPassword, secretarySession, seedPassword, signIn } from './helpers.js'

// The unsent-invite mailer logs once per account; the tests that look at the log spy on it again.
beforeEach(() => { vi.spyOn(console, 'log').mockImplementation(() => {}) })
afterEach(() => vi.restoreAllMocks())

// The same flows over both repositories: in memory, and over a record store that every instance of a test shares.
const backends: [string, () => () => Repository][] = [
  ['in memory', () => createMemoryRepository],
  ['over a shared record store', () => { const store = createMemoryRecordStore(); return () => createRecordRepository(store) }],
]
const peek = <T>(repository: Repository, read: (db: Database) => T) => repository.view((unit) => read(unit.read()))
type Agent = ReturnType<typeof request.agent>

const student = (n: number, extra: object = {}) => ({ name: `Student Number${n}`, email: `student.${n}@gmail.com`, studentId: `26-${String(1000 + n)}`, program: 'BSIT', year: 3, section: 'A', ...extra })
const faculty = (n: number, program = 'BSIT') => ({ name: `Prof. Faculty${n}`, email: `faculty.${n}@qcu.edu.ph`, program })
type Created = { index: number; status: string; code?: string; error?: string; account: { id: string; adviserId?: string; active: boolean }; credentials: { username: string; temporaryPassword: string }; invite: { sent: boolean; signInUrl: string } }

async function createFaculty(secretary: Agent, rows: object[]) {
  const response = await secretary.post('/api/accounts/faculty').send({ faculty: rows })
  expect(response.status).toBe(200)
  return response.body.record.results as Created[]
}
async function importStudents(secretary: Agent, rows: object[]) {
  const response = await secretary.post('/api/accounts/students').send({ students: rows })
  expect(response.status).toBe(200)
  return response.body.record.results as Created[]
}
const studentsById = async (secretary: Agent, q: string) => new Map<string, { adviserId?: string }>((await secretary.get('/api/accounts').query({ role: 'student', q })).body.accounts.map((a: { id: string }) => [a.id, a]))

describe.each(backends)('accounts, %s', (_name, backend) => {
  function setup(options: { mailer?: InviteMailer } = {}) {
    const newRepository = backend()
    const repository = newRepository()
    const authStore = createMemoryAuthStore()
    const sessionStore = createMemorySessionStore()
    return {
      repository,
      authStore,
      sessionStore,
      app: createApp(repository, { authStore, sessionStore, ...options }),
      // A cold instance: its own repository, over the same auth store, session store, and (if there is one) record store.
      another: () => createApp(newRepository(), { authStore, sessionStore }),
    }
  }

  describe('activating the secretary', () => {
    it('starts inactive, so the secretary cannot sign in until the Dean activates the account', async () => {
      const { app } = setup()
      expect((await signIn(app, 'QCU-SECRETARY')).response.status).toBe(401)
      const { agent: dean } = await signIn(app, 'CCS-DEAN')
      const types = await dean.get('/api/accounts/types')
      expect(types.status).toBe(200)
      expect(types.body.types.map((row: { type: string }) => row.type)).toEqual(['secretary', 'faculty', 'advisor', 'chair', 'student'])
      expect(types.body.types[0]).toMatchObject({ type: 'secretary', active: 1, inactive: 1, canManage: true })  // the real secretary from the roster is active, the QCU-SECRETARY placeholder is not
      // The Dean manages the secretary account only.
      expect(types.body.types.slice(1).every((row: { canManage: boolean }) => !row.canManage)).toBe(true)
      expect(types.body.secretary).toMatchObject({ id: 'QCU-SECRETARY', name: 'CCS Secretary', active: false })
    })

    it('returns temporary credentials once with an unsent invite, and stores only a hash', async () => {
      const log = vi.spyOn(console, 'log').mockImplementation(() => {})
      const { app, authStore } = setup()
      const { agent: dean } = await signIn(app, 'CCS-DEAN')
      const response = await dean.post('/api/accounts/secretary/activate').send({})
      const { credentials, invite, account } = response.body.record
      expect(response.status).toBe(200)
      expect(account).toMatchObject({ id: 'QCU-SECRETARY', active: true, mustChangeCredentials: true })
      expect(credentials.username).toMatch(/^ccs\.secretary\.[a-z0-9]{4}$/)
      expect(passwordProblem(credentials.temporaryPassword)).toBeUndefined()
      expect(invite).toEqual({ sent: false, signInUrl: 'http://localhost:5173/sign-in' })
      const stored = await authStore.load()
      expect(stored.credentials['QCU-SECRETARY']).toMatch(/^scrypt\$/)
      expect(JSON.stringify(stored)).not.toContain(credentials.temporaryPassword)
      // The mailer logs that nothing was sent, never what was in the invite.
      expect(log).toHaveBeenCalledTimes(1)
      expect(String(log.mock.calls[0]![0])).toContain('QCU-SECRETARY')
      for (const secret of [credentials.username, credentials.temporaryPassword]) expect(JSON.stringify(log.mock.calls)).not.toContain(secret)
    })

    it('hands the invite to the mailer and reports whether it was sent', async () => {
      const log = vi.spyOn(console, 'log').mockImplementation(() => {})
      const invites: Invite[] = []
      const { app } = setup({ mailer: { send: async (invite) => { invites.push(invite); return { sent: true } } } })
      const { agent: dean } = await signIn(app, 'CCS-DEAN')
      const response = await dean.post('/api/accounts/secretary/activate').set('Origin', 'http://localhost:5173').send({ name: 'Maria Santos', email: 'Maria.Santos@Gmail.com' })
      expect(response.body.record.invite).toEqual({ sent: true, signInUrl: 'http://localhost:5173/sign-in' })
      expect(response.body.record.account).toMatchObject({ name: 'Maria Santos', email: 'maria.santos@gmail.com' })
      const { username, temporaryPassword } = response.body.record.credentials
      expect(username).toMatch(/^maria\.santos\.[a-z0-9]{4}$/)
      expect(invites).toEqual([{ accountId: 'QCU-SECRETARY', to: 'maria.santos@gmail.com', name: 'Maria Santos', signInUrl: 'http://localhost:5173/sign-in', username, temporaryPassword }])
      // Only a site of ours may be linked.
      const other = await dean.post('/api/accounts/secretary/activate').set('Origin', 'https://evil.example').send({})
      expect(other.body.record.invite.signInUrl).toBe('http://localhost:5173/sign-in')
      // Without a mailer of ours, nothing is sent.
      expect(await sendInvite(invites[0]!)).toEqual({ sent: false })
      expect(log).toHaveBeenCalledTimes(1)
    })

    it('refuses an email that another account already uses', async () => {
      const { app } = setup()
      const { agent: dean } = await signIn(app, 'CCS-DEAN')
      const response = await dean.post('/api/accounts/secretary/activate').send({ email: 'dean@access-ccs.com' })
      expect(response.status).toBe(409)
      expect(response.body.code).toBe('CONFLICT')
    })

    it('lets the secretary sign in by username in any case, then holds every other call until the details are replaced', async () => {
      const { app } = setup()
      const credentials = await activateSecretary(app)
      const { agent, response } = await signIn(app, credentials.username.toUpperCase(), credentials.temporaryPassword)
      expect(response.status).toBe(200)
      expect(response.body.user).toMatchObject({ id: 'QCU-SECRETARY', username: credentials.username, mustChangeCredentials: true })
      const session = await agent.get('/api/session')
      expect(session.status).toBe(200)
      expect(session.body.user.mustChangeCredentials).toBe(true)
      const held = { error: 'Set your own username and password to continue.', code: 'CREDENTIALS_CHANGE_REQUIRED' }
      for (const [method, path] of [['get', '/api/pages/P03'], ['get', '/api/accounts/types'], ['get', '/api/accounts'], ['post', '/api/auth/change-password'], ['post', '/api/pages/P43/actions']] as const) {
        const blocked = await agent[method](path).send({})
        expect([path, blocked.status, blocked.body]).toEqual([path, 403, held])
      }
      expect((await agent.post('/api/auth/sign-out').send({})).status).toBe(200)
      expect((await agent.get('/api/session')).status).toBe(401)
    })

    it('checks the first-login fields before it replaces the temporary details', async () => {
      const { app } = setup()
      const credentials = await activateSecretary(app)
      const { agent } = await signIn(app, credentials.username, credentials.temporaryPassword)
      const change = (body: object) => agent.post('/api/auth/complete-first-login').send({ currentPassword: credentials.temporaryPassword, username: 'maria.santos', password: secretaryPassword, ...body })
      const wrong = await change({ currentPassword: 'Wrong!Passw0rd1' })
      expect([wrong.status, wrong.body.code]).toEqual([400, 'INVALID_CREDENTIALS'])
      const weak = await change({ password: 'weak' })
      expect([weak.status, weak.body.code]).toEqual([400, 'VALIDATION_ERROR'])
      expect(weak.body.fields.map((field: { path: string }) => field.path)).toEqual(['password'])
      for (const username of ['ab', 'has space', '-leading', 'x'.repeat(33)]) expect((await change({ username })).status, username).toBe(400)
      expect((await change({ password: credentials.temporaryPassword })).status).toBe(400)
      expect((await change({ username: credentials.username.toUpperCase() })).status).toBe(400)
      // The ID of another account is taken, whatever its case.
      const taken = await change({ username: 'QCU-Dean' })
      expect([taken.status, taken.body.code]).toEqual([409, 'CONFLICT'])
      expect((await agent.get('/api/session')).body.user.mustChangeCredentials).toBe(true)
    })

    it('sets both, keeps this session, ends the others, and retires the temporary details', async () => {
      const { app } = setup()
      const credentials = await activateSecretary(app)
      const { agent } = await signIn(app, credentials.username, credentials.temporaryPassword)
      const { agent: elsewhere } = await signIn(app, credentials.username, credentials.temporaryPassword)
      const done = await agent.post('/api/auth/complete-first-login').send({ currentPassword: credentials.temporaryPassword, username: 'Maria.Santos', password: secretaryPassword })
      expect(done.status).toBe(200)
      expect(done.body.user).toMatchObject({ username: 'maria.santos', mustChangeCredentials: false })
      expect((await agent.get('/api/pages/P03')).status).toBe(200)
      expect((await elsewhere.get('/api/session')).status).toBe(401)
      expect((await signIn(app, credentials.username, credentials.temporaryPassword)).response.status).toBe(401)
      expect((await signIn(app, 'MARIA.SANTOS', secretaryPassword)).response.status).toBe(200)
      expect((await agent.post('/api/auth/complete-first-login').send({ currentPassword: secretaryPassword, username: 'maria.s', password: 'An0ther!Passw0rd' })).status).toBe(409)
    })

    it('reissues credentials on a second activation and requires the change again', async () => {
      const { app } = setup()
      const secretary = await secretarySession(app)
      expect((await secretary.get('/api/accounts/types')).status).toBe(200)
      const fresh = await activateSecretary(app)
      expect((await secretary.get('/api/session')).status).toBe(401)
      expect((await signIn(app, 'ccs.secretary', secretaryPassword)).response.status).toBe(401)
      const { response } = await signIn(app, fresh.username, fresh.temporaryPassword)
      expect(response.body.user).toMatchObject({ username: fresh.username, mustChangeCredentials: true })
    })

    it('gives the secretary the pages every role has, and none of the Dean permissions', async () => {
      const { app } = setup()
      const secretary = await secretarySession(app)
      const { allowedPages, permissions } = (await secretary.get('/api/session')).body
      const { modules } = JSON.parse(readFileSync(new URL('./fixtures/doc003-modules.json', import.meta.url), 'utf8')) as { modules: { role: string; pages: string[] }[] }
      for (const module of modules.filter((entry) => entry.role === 'all')) expect(module.pages.some((page) => allowedPages.includes(page))).toBe(true)
      expect(permissions).toContain('account.provision')
      expect(permissions).not.toContain('account.activateSecretary')
      expect(permissions).not.toContain('role.manage')
      expect((await signIn(app, 'CCS-DEAN')).response.body.permissions).toContain('account.activateSecretary')
    })
  })

  describe('who may use the account routes', () => {
    const routes = [
      ['get', '/api/accounts/types', {}],
      ['get', '/api/accounts', {}],
      ['get', '/api/accounts/faculty', {}],
      ['post', '/api/accounts/faculty', { faculty: [faculty(1)] }],
      ['get', '/api/accounts/advisors', {}],
      ['put', '/api/accounts/advisors/1', { facultyIds: [] }],
      ['put', '/api/accounts/chairs/BSIT', { facultyId: 'QCU-PROF-IT' }],
      ['post', '/api/accounts/students', { students: [student(1)] }],
      ['post', '/api/accounts/QCU-STU-IT-B/active', { active: false }],
      ['post', '/api/accounts/secretary/activate', {}],
    ] as const

    it('answers 401 without a session', async () => {
      const { app } = setup()
      for (const [method, path, body] of routes) expect((await request(app)[method](path).send(body)).status, path).toBe(401)
    })

    it('denies students, faculty, and every other role that is not the secretary or the Dean', async () => {
      const { app } = setup()
      for (const id of ['QCU-STU-IT-A', 'QCU-PROF-IT', 'QCU-CHAIR-IT', 'ACCS-ADMIN']) {
        const { agent } = await signIn(app, id)
        for (const [method, path, body] of routes) {
          const response = await agent[method](path).send(body)
          expect([id, path, response.status, response.body.code]).toEqual([id, path, 403, 'FORBIDDEN'])
        }
      }
    })

    it('keeps the Dean to the account types and the secretary, and the secretary to everything else', async () => {
      const { app } = setup()
      const { agent: dean } = await signIn(app, 'CCS-DEAN')
      const deanRoutes = ['/api/accounts/types', '/api/accounts/secretary/activate']
      for (const [method, path, body] of routes.filter(([, path]) => !deanRoutes.includes(path))) expect((await dean[method](path).send(body)).status, path).toBe(403)
      const secretary = await secretarySession(app)
      expect((await secretary.post('/api/accounts/secretary/activate').send({})).status).toBe(403)
      expect((await secretary.get('/api/accounts/types')).status).toBe(200)
    })
  })

  describe('switching accounts on and off', () => {
    it('signs a deactivated person out at once and lets them back in when reactivated', async () => {
      const { app } = setup()
      const secretary = await secretarySession(app)
      const [made] = await importStudents(secretary, [student(1)])
      const { agent: pupil, response } = await signIn(app, made!.credentials.username, made!.credentials.temporaryPassword)
      expect(response.status).toBe(200)
      const off = await secretary.post(`/api/accounts/${made!.account.id}/active`).send({ active: false })
      expect([off.status, off.body.record]).toEqual([200, { id: made!.account.id, active: false }])
      expect((await pupil.get('/api/session')).status).toBe(401)
      expect((await signIn(app, made!.credentials.username, made!.credentials.temporaryPassword)).response.status).toBe(401)
      expect((await secretary.post(`/api/accounts/${made!.account.id}/active`).send({ active: true })).status).toBe(200)
      expect((await signIn(app, made!.credentials.username, made!.credentials.temporaryPassword)).response.status).toBe(200)
    })

    it('does not let anyone deactivate themselves', async () => {
      const { app } = setup()
      const secretary = await secretarySession(app)
      const own = await secretary.post('/api/accounts/QCU-SECRETARY/active').send({ active: false })
      expect([own.status, own.body]).toEqual([403, { error: "You can't deactivate your own account.", code: 'FORBIDDEN' }])
      const { agent: dean } = await signIn(app, 'CCS-DEAN')
      expect((await dean.post('/api/accounts/CCS-DEAN/active').send({ active: false })).status).toBe(403)
      expect((await secretary.get('/api/session')).status).toBe(200)
    })

    it('keeps the secretary to students, faculty, and chairs, and the secretary account to the Dean', async () => {
      const { app } = setup()
      const secretary = await secretarySession(app)
      for (const id of ['CCS-DEAN', 'ACCS-ADMIN', 'QCU-GUIDANCE', 'QCU-OSAS', 'QCU-ORG']) {
        expect((await secretary.post(`/api/accounts/${id}/active`).send({ active: false })).status, id).toBe(403)
      }
      expect((await signIn(app, 'CCS-DEAN')).response.status).toBe(200)
      expect((await secretary.post('/api/accounts/NOPE/active').send({ active: false })).status).toBe(404)
      expect((await secretary.post('/api/accounts/QCU-PROF-OTHER/active').send({})).status).toBe(400)
      // A seeded faculty member and a chair-only account are the secretary's to switch.
      for (const id of ['QCU-PROF-OTHER', 'QCU-CHAIR-CS']) expect((await secretary.post(`/api/accounts/${id}/active`).send({ active: false })).status, id).toBe(200)
      expect((await signIn(app, 'QCU-PROF-OTHER')).response.status).toBe(401)
    })

    it('lets the Dean switch the secretary off and on, keeping the secretary own details', async () => {
      const { app } = setup()
      const secretary = await secretarySession(app)
      const { agent: dean } = await signIn(app, 'CCS-DEAN')
      expect((await dean.post('/api/accounts/QCU-SECRETARY/active').send({ active: false })).status).toBe(200)
      expect((await secretary.get('/api/session')).status).toBe(401)
      expect((await signIn(app, 'ccs.secretary', secretaryPassword)).response.status).toBe(401)
      expect((await dean.post('/api/accounts/QCU-SECRETARY/active').send({ active: true })).status).toBe(200)
      expect((await signIn(app, 'ccs.secretary', secretaryPassword)).response.status).toBe(200)
      expect((await dean.post('/api/accounts/QCU-STU-IT-A/active').send({ active: false })).status).toBe(403)
    })

    it('does not let an administrator switch the secretary on with the shared seed password', async () => {
      const { app } = setup()
      const { agent: admin } = await signIn(app, 'ACCS-ADMIN')
      const on = await admin.post('/api/pages/P47/actions').send({ action: 'updateRoles', recordId: 'QCU-SECRETARY', reason: 'Switch on', payload: { roles: ['secretary'], active: true } })
      expect(on.status).toBe(200)
      expect((await signIn(app, 'QCU-SECRETARY', seedPassword)).response.status).toBe(401)
    })
  })

  describe('faculty accounts', () => {
    it('creates one or several, each with its own temporary credentials', async () => {
      const { app, authStore } = setup()
      const secretary = await secretarySession(app)
      const single = await secretary.post('/api/accounts/faculty').send(faculty(1))
      expect(single.status).toBe(200)
      expect(single.body.record).toMatchObject({ created: 1, failed: 0 })
      const [first] = single.body.record.results as Created[]
      expect(first).toMatchObject({ index: 0, status: 'created', account: { roles: ['professor'], program: 'BSIT', email: 'faculty.1@qcu.edu.ph', active: true, mustChangeCredentials: true }, invite: { sent: false } })
      const batch = await createFaculty(secretary, [faculty(2), faculty(3, 'BSCS'), faculty(4, 'BSIS')])
      const everyone = [first!, ...batch]
      expect(new Set(everyone.map((row) => row.credentials.temporaryPassword)).size).toBe(4)
      expect(new Set(everyone.map((row) => row.credentials.username)).size).toBe(4)
      for (const row of everyone) {
        expect(row.credentials.username).toMatch(/^prof\.faculty\d\.[a-z0-9]{4}$/)
        expect(passwordProblem(row.credentials.temporaryPassword)).toBeUndefined()
        expect((await authStore.load()).credentials[row.account.id]).toMatch(/^scrypt\$/)
      }
      // A new faculty member signs in with the temporary details and must replace them.
      const { response } = await signIn(app, batch[0]!.credentials.username, batch[0]!.credentials.temporaryPassword)
      expect(response.body.user).toMatchObject({ roles: ['professor'], mustChangeCredentials: true })
    })

    it('reports each row of a batch: duplicates and invalid rows fail alone', async () => {
      const { app } = setup()
      const secretary = await secretarySession(app)
      const rows = [faculty(1), faculty(1), { ...faculty(2), email: 'prof.it@access-ccs.com' }, { ...faculty(3), program: 'MBA' }, { name: 'X', email: 'nope' }, faculty(5)]
      const results = await createFaculty(secretary, rows)
      expect(results.map((row) => [row.index, row.status, row.code])).toEqual([[0, 'created', undefined], [1, 'error', 'DUPLICATE_EMAIL'], [2, 'error', 'DUPLICATE_EMAIL'], [3, 'error', 'INVALID_ROW'], [4, 'error', 'INVALID_ROW'], [5, 'created', undefined]])
      expect(results[1]!.error).toBe('An account with this email already exists.')
      expect(results[3]).toMatchObject({ error: 'Check the required fields.', fields: [{ path: 'program', message: 'Choose BSIT, BSCS, or BSIS.' }] })
      expect((await secretary.get('/api/accounts/faculty').query({ q: 'faculty.1' })).body.faculty).toHaveLength(1)
      // The email counts in any case.
      expect((await createFaculty(secretary, [{ ...faculty(7), email: 'FACULTY.1@QCU.EDU.PH' }]))[0]).toMatchObject({ status: 'error', code: 'DUPLICATE_EMAIL' })
    })

    it('accepts at most 25 rows a request', async () => {
      const { app } = setup()
      const secretary = await secretarySession(app)
      const many = await secretary.post('/api/accounts/faculty').send({ faculty: Array.from({ length: 26 }, (_, n) => faculty(n)) })
      expect([many.status, many.body.code]).toEqual([400, 'VALIDATION_ERROR'])
      expect((await secretary.post('/api/accounts/faculty').send({ faculty: [] })).status).toBe(400)
      expect((await secretary.get('/api/accounts/faculty').query({ q: 'faculty.' })).body.faculty).toEqual([])
    })

    it('searches and filters the faculty list, with advisers and chairs marked', async () => {
      const { app } = setup()
      const secretary = await secretarySession(app)
      const [csProf, itProf] = await createFaculty(secretary, [faculty(1, 'BSCS'), faculty(2, 'BSIT')])
      await secretary.put('/api/accounts/advisors/2').send({ facultyIds: [csProf!.account.id] })
      await secretary.put('/api/accounts/advisors/4').send({ facultyIds: [csProf!.account.id, itProf!.account.id] })
      const all = (await secretary.get('/api/accounts/faculty')).body.faculty as { id: string; program: string; advisorYears: number[]; chairProgram: string | null }[]
      expect(all.map((row) => row.id)).toEqual(expect.arrayContaining(['QCU-PROF-IT', 'QCU-PROF-OTHER', 'QCU-PROF-CS', 'QCU-CHAIR-IT', csProf!.account.id]))
      expect(all.find((row) => row.id === csProf!.account.id)).toMatchObject({ advisorYears: [2, 4], chairProgram: null })
      expect(all.find((row) => row.id === 'QCU-CHAIR-IT')).toMatchObject({ advisorYears: [], chairProgram: 'BSIT' })
      expect(all.some((row) => row.id === 'QCU-CHAIR-CS')).toBe(false)
      const bscs = (await secretary.get('/api/accounts/faculty').query({ program: 'BSCS' })).body.faculty as { program: string }[]
      expect(bscs.length).toBeGreaterThan(0)
      expect(bscs.every((row) => row.program === 'BSCS')).toBe(true)
      expect((await secretary.get('/api/accounts/faculty').query({ q: 'ROBIN' })).body.faculty.map((row: { id: string }) => row.id)).toEqual(['QCU-PROF-IT'])
      expect((await secretary.get('/api/accounts/faculty').query({ program: 'MBA' })).status).toBe(400)
    })
  })

  describe('student import', () => {
    it('creates students with temporary credentials, class spaces, and no adviser yet', async () => {
      const { app, repository } = setup()
      const secretary = await secretarySession(app)
      const results = await importStudents(secretary, [student(1), student(2, { program: 'BSCS', section: 'a', year: '2' })])
      expect(results[0]).toMatchObject({ status: 'created', account: { roles: ['student'], program: 'BSIT', section: 'A', year: 3, studentId: '26-1001', email: 'student.1@gmail.com' }, invite: { sent: false } })
      expect(results[1]).toMatchObject({ status: 'created', account: { section: 'A', year: 2, program: 'BSCS' } })
      const [{ account: first }, { account: second }] = results as [Created, Created]
      expect(first.adviserId).toBeUndefined()
      // The next request lays the new accounts over the repository; the class spaces are the ones for their program and section.
      await secretary.get('/api/accounts')
      const spaces = await peek(repository, (db) => db.spaces)
      expect(spaces.filter((space) => space.studentIds.includes(first.id)).map((space) => space.id)).toEqual(['SPACE-IT-A', 'SUBJECT-IT-DS'])
      expect(spaces.filter((space) => space.studentIds.includes(second.id)).map((space) => space.id)).toEqual(['SPACE-CS-A'])
      expect((await peek(repository, (db) => db.users)).find((user) => user.id === first.id)).toMatchObject({ spaceIds: ['SPACE-IT-A', 'SUBJECT-IT-DS'], title: 'CCS student' })
    })

    it('lets the student sign in by username, email, or student ID, and the account is held until the details are replaced', async () => {
      const { app } = setup()
      const secretary = await secretarySession(app)
      const [made] = await importStudents(secretary, [student(1)])
      const { username, temporaryPassword } = made!.credentials
      for (const identifier of [username, 'STUDENT.1@gmail.com', '26-1001']) {
        const { agent, response } = await signIn(app, identifier, temporaryPassword)
        expect(response.status, identifier).toBe(200)
        expect((await agent.get('/api/pages/P03')).body.code).toBe('CREDENTIALS_CHANGE_REQUIRED')
      }
      const { agent } = await signIn(app, username, temporaryPassword)
      expect((await agent.post('/api/auth/complete-first-login').send({ currentPassword: temporaryPassword, username: 'student.one', password: 'Student1!Passw0rd' })).status).toBe(200)
      const classes = (await agent.get('/api/pages/P07')).body.data.spaces as { id: string }[]
      expect(classes.map((space) => space.id)).toEqual(['SPACE-IT-A', 'SUBJECT-IT-DS'])
    })

    it('creates the good rows and names the problem with each bad one', async () => {
      const { app } = setup()
      const secretary = await secretarySession(app)
      const results = await importStudents(secretary, [
        student(1),
        student(2, { email: 'STU.IT.A@access-ccs.com' }),
        student(3, { studentId: 'qcu-2024-0101' }),
        student(4, { year: 5 }),
        student(1, { name: 'Second Student1', studentId: '26-1999' }),
        student(6, { studentId: '26-1001' }),
        student(7, { email: 'not-an-email' }),
        student(8, { program: 'ABC' }),
        student(9),
      ])
      expect(results.map((row) => [row.index, row.status, row.code])).toEqual([[0, 'created', undefined], [1, 'error', 'DUPLICATE_EMAIL'], [2, 'error', 'DUPLICATE_ID'], [3, 'error', 'INVALID_ROW'], [4, 'error', 'DUPLICATE_EMAIL'], [5, 'error', 'DUPLICATE_ID'], [6, 'error', 'INVALID_ROW'], [7, 'error', 'INVALID_ROW'], [8, 'created', undefined]])
      expect(results[2]!.error).toBe('An account with this student ID already exists.')
      expect(results[3]).toMatchObject({ fields: [{ path: 'year', message: 'Choose a year level from 1 to 4.' }] })
      expect(results[6]).toMatchObject({ fields: [{ path: 'email', message: 'Enter a valid email address.' }] })
      // Sending the same list again changes nothing: every row is a duplicate.
      const again = await importStudents(secretary, [student(1), student(9)])
      expect(again.map((row) => row.code)).toEqual(['DUPLICATE_EMAIL', 'DUPLICATE_EMAIL'])
      expect((await secretary.get('/api/accounts').query({ role: 'student' })).body.total).toBe(4 + 2)
    })

    // Hashing 25 passwords takes about 3 seconds alone, more when the whole suite runs in parallel.
    it('accepts at most 25 students a request', async () => {
      const { app } = setup()
      const secretary = await secretarySession(app)
      const rows = Array.from({ length: 26 }, (_, n) => student(n))
      expect((await secretary.post('/api/accounts/students').send({ students: rows })).status).toBe(400)
      expect((await secretary.post('/api/accounts/students').send({ students: rows.slice(0, 25) })).body.record).toMatchObject({ created: 25, failed: 0 })
      expect((await secretary.post('/api/accounts/students').send({ students: [] })).status).toBe(400)
      expect((await secretary.post('/api/accounts/students').send({})).status).toBe(400)
    }, 20_000)

    it('lists accounts for the secretary by role and search', async () => {
      const { app } = setup()
      const secretary = await secretarySession(app)
      await importStudents(secretary, [student(1), student(2)])
      const students = await secretary.get('/api/accounts').query({ role: 'student' })
      expect(students.body.total).toBe(4 + 2)
      expect(students.body.accounts.every((account: { roles: string[] }) => account.roles.includes('student'))).toBe(true)
      expect(JSON.stringify(students.body)).not.toMatch(/scrypt|username|password/i)
      expect((await secretary.get('/api/accounts').query({ q: '26-1002' })).body.accounts.map((a: { email: string }) => a.email)).toEqual(['student.2@gmail.com'])
      expect((await secretary.get('/api/accounts').query({ q: 'mira' })).body.accounts.map((a: { id: string }) => a.id)).toEqual(['QCU-STU-IT-A'])
      expect((await secretary.get('/api/accounts').query({ role: 'wizard' })).status).toBe(400)
    })
  })

  describe('advisers', () => {
    async function ready() {
      const context = setup()
      const secretary = await secretarySession(context.app)
      const [it, cs] = await createFaculty(secretary, [faculty(1, 'BSIT'), faculty(2, 'BSCS')])
      return { ...context, secretary, it: it!.account.id, cs: cs!.account.id }
    }

    it('resolves the adviser of a student from the year, preferring their program, then the first assigned', async () => {
      const { secretary, it, cs } = await ready()
      // The BSCS adviser is listed first, so the first-assigned fallback is observable.
      const set = await secretary.put('/api/accounts/advisors/3').send({ facultyIds: [cs, it] })
      expect([set.status, set.body.record]).toEqual([200, { yearLevel: 3, facultyIds: [cs, it], studentsUpdated: 0 }])
      const results = await importStudents(secretary, [student(1), student(2, { program: 'BSCS' }), student(3, { program: 'BSIS' }), student(4, { year: 1 })])
      const advisers = results.map((row) => row.account.adviserId)
      expect(advisers).toEqual([it, cs, cs, undefined])
    })

    it('recomputes when the assignments change, and lets one person advise several years', async () => {
      const { secretary, it, cs } = await ready()
      const [a, b, c, d] = (await importStudents(secretary, [student(1), student(2, { program: 'BSCS' }), student(3, { year: 1 }), student(4, { year: 3 })])).map((row) => row.account.id) as [string, string, string, string]
      const adviser = async () => { const found = await studentsById(secretary, 'Number'); return [a, b, c, d].map((id) => found.get(id)?.adviserId) }
      expect(await adviser()).toEqual([undefined, undefined, undefined, undefined])
      expect((await secretary.put('/api/accounts/advisors/3').send({ facultyIds: [it, cs] })).body.record.studentsUpdated).toBe(3)
      expect(await adviser()).toEqual([it, cs, undefined, it])
      // One person for two years; the BSCS student's year-3 choice falls back to the only one assigned.
      expect((await secretary.put('/api/accounts/advisors/1').send({ facultyIds: [it] })).body.record.studentsUpdated).toBe(1)
      await secretary.put('/api/accounts/advisors/3').send({ facultyIds: [it] })
      expect(await adviser()).toEqual([it, it, it, it])
      // Clearing a year takes the adviser away.
      expect((await secretary.put('/api/accounts/advisors/1').send({ facultyIds: [] })).status).toBe(200)
      expect(await adviser()).toEqual([it, it, undefined, it])
      const listing = (await secretary.get('/api/accounts/advisors')).body.advisors as { yearLevel: number; faculty: { id: string }[] }[]
      expect(listing.map((row) => [row.yearLevel, row.faculty.map((f) => f.id)])).toEqual([[1, []], [2, []], [3, [it]], [4, []]])
      expect((await secretary.get('/api/accounts/faculty').query({ q: 'Faculty1' })).body.faculty[0].advisorYears).toEqual([3])
      // The seeded demo students keep their seeded advisers.
      const seeded = (await secretary.get('/api/accounts').query({ q: 'QCU-STU-IT-A' })).body.accounts[0]
      expect(seeded.adviserId).toBe('QCU-PROF-IT')
    })

    it('works with seeded faculty, and the adviser of a student can then take their reports', async () => {
      const { app, secretary } = await ready()
      await secretary.put('/api/accounts/advisors/2').send({ facultyIds: ['QCU-PROF-CS'] })
      const [made] = await importStudents(secretary, [student(1, { program: 'BSCS', year: 2 })])
      expect(made!.account.adviserId).toBe('QCU-PROF-CS')
      const { agent: pupil } = await signIn(app, made!.credentials.username, made!.credentials.temporaryPassword)
      await pupil.post('/api/auth/complete-first-login').send({ currentPassword: made!.credentials.temporaryPassword, username: 'pupil.one', password: 'Student1!Passw0rd' })
      const filed = await pupil.post('/api/pages/P19/actions').send({ action: 'createReport', payload: { narrative: 'The lab timetable changed without notice.', category: 'General concern', severity: 'low', identity: 'named', ...concernChoices } })
      expect([filed.status, filed.body.record.stage]).toEqual([200, 'adviser'])
      const { agent: adviser } = await signIn(app, 'QCU-PROF-CS')
      expect((await adviser.get(`/api/pages/P22?id=${filed.body.record.id}`)).status).toBe(200)
    })

    it('rejects a year outside 1 to 4, people who are not faculty, and a malformed list', async () => {
      const { secretary, it } = await ready()
      for (const year of ['0', '5', 'x']) expect((await secretary.put(`/api/accounts/advisors/${year}`).send({ facultyIds: [it] })).status, year).toBe(400)
      for (const ids of [['QCU-STU-IT-A'], ['CCS-DEAN'], ['NOBODY'], [it, 'NOBODY']]) {
        const response = await secretary.put('/api/accounts/advisors/1').send({ facultyIds: ids })
        expect([response.status, response.body.code]).toEqual([400, 'VALIDATION_ERROR'])
      }
      expect((await secretary.put('/api/accounts/advisors/1').send({ facultyIds: 'QCU-PROF-IT' })).status).toBe(400)
      expect((await secretary.put('/api/accounts/advisors/1').send({})).status).toBe(400)
      expect((await secretary.get('/api/accounts/advisors')).body.advisors.every((row: { faculty: unknown[] }) => row.faculty.length === 0)).toBe(true)
    })

    it('counts advisers in the account types', async () => {
      const { secretary, it, cs } = await ready()
      await secretary.put('/api/accounts/advisors/1').send({ facultyIds: [it] })
      await secretary.put('/api/accounts/advisors/2').send({ facultyIds: [it, cs] })
      const types = (await secretary.get('/api/accounts/types')).body.types as { type: string; active: number; inactive: number; canManage: boolean }[]
      expect(types.find((row) => row.type === 'advisor')).toMatchObject({ active: 2, inactive: 0, canManage: true })
      expect(types.find((row) => row.type === 'secretary')).toMatchObject({ active: 2, inactive: 0, canManage: false })  // the activated placeholder and the roster secretary
      expect(types.find((row) => row.type === 'faculty')).toMatchObject({ active: 4 + 2 + facultyRoster.filter((p) => p.roles.includes('professor')).length })
    })
  })

  describe('program chairs', () => {
    it('adds the chair role to the choice and takes it from the previous holder of that program', async () => {
      const { app } = setup()
      const secretary = await secretarySession(app)
      const [chosen] = await createFaculty(secretary, [faculty(1, 'BSIT')])
      const set = await secretary.put('/api/accounts/chairs/BSIT').send({ facultyId: chosen!.account.id })
      expect([set.status, set.body.record]).toEqual([200, { program: 'BSIT', chairId: chosen!.account.id, previousChairIds: ['QCU-CHAIR-IT'] }])
      const rows = (await secretary.get('/api/accounts/faculty')).body.faculty as { id: string; chairProgram: string | null }[]
      expect(rows.find((row) => row.id === chosen!.account.id)?.chairProgram).toBe('BSIT')
      expect(rows.find((row) => row.id === 'QCU-CHAIR-IT')?.chairProgram).toBeNull()
      const { response } = await signIn(app, 'QCU-CHAIR-IT')
      expect(response.body.user.roles).toEqual(['professor'])
      const { response: chosenSignIn } = await signIn(app, chosen!.credentials.username, chosen!.credentials.temporaryPassword)
      expect(chosenSignIn.body.user.roles).toEqual(['professor', 'chair'])
      // The other program's chair is untouched.
      expect((await signIn(app, 'QCU-CHAIR-CS')).response.body.user.roles).toEqual(['chair'])
    })

    it('keeps a chair who was only a chair as faculty, and is repeatable', async () => {
      const { app } = setup()
      const secretary = await secretarySession(app)
      expect((await secretary.put('/api/accounts/chairs/BSCS').send({ facultyId: 'QCU-PROF-CS' })).body.record.previousChairIds).toEqual(['QCU-CHAIR-CS'])
      expect((await signIn(app, 'QCU-CHAIR-CS')).response.body.user.roles).toEqual(['professor'])
      expect((await signIn(app, 'QCU-PROF-CS')).response.body.user.roles).toEqual(['professor', 'chair'])
      expect((await secretary.put('/api/accounts/chairs/BSCS').send({ facultyId: 'QCU-PROF-CS' })).body.record.previousChairIds).toEqual([])
    })

    it('rejects a program that does not exist and a person from another program or outside the faculty', async () => {
      const { app } = setup()
      const secretary = await secretarySession(app)
      expect((await secretary.put('/api/accounts/chairs/MBA').send({ facultyId: 'QCU-PROF-IT' })).status).toBe(400)
      for (const facultyId of ['QCU-PROF-CS', 'QCU-STU-IT-A', 'CCS-DEAN', 'NOBODY']) {
        const response = await secretary.put('/api/accounts/chairs/BSIT').send({ facultyId })
        expect([facultyId, response.status, response.body.code]).toEqual([facultyId, 400, 'VALIDATION_ERROR'])
      }
      expect((await signIn(app, 'QCU-CHAIR-IT')).response.body.user.roles).toEqual(['chair', 'professor'])
    })
  })

  describe('across instances', () => {
    it('shows an account created on one instance to another, including one that starts cold', async () => {
      const context = setup()
      const secretary = await secretarySession(context.app)
      const [made] = await importStudents(secretary, [student(1)])
      const second = context.another()
      const { agent, response } = await signIn(second, made!.credentials.username, made!.credentials.temporaryPassword)
      expect(response.body.user).toMatchObject({ id: made!.account.id, mustChangeCredentials: true })
      expect((await agent.post('/api/auth/complete-first-login').send({ currentPassword: made!.credentials.temporaryPassword, username: 'student.one', password: 'Student1!Passw0rd' })).status).toBe(200)
      // The first instance sees the change the second one made.
      expect((await signIn(context.app, 'student.one', 'Student1!Passw0rd')).response.status).toBe(200)
      expect((await signIn(context.another(), 'STUDENT.ONE', 'Student1!Passw0rd')).response.status).toBe(200)
      expect((await signIn(context.another(), made!.credentials.username, made!.credentials.temporaryPassword)).response.status).toBe(401)
    })

    it('applies active, role, and adviser changes on every instance', async () => {
      const context = setup()
      const secretary = await secretarySession(context.app)
      const other = context.another()
      const { agent: onOther } = await signIn(other, 'QCU-PROF-OTHER')
      const { agent: chairOnOther } = await signIn(other, 'QCU-CHAIR-IT')
      expect((await secretary.post('/api/accounts/QCU-PROF-OTHER/active').send({ active: false })).status).toBe(200)
      expect((await secretary.put('/api/accounts/chairs/BSIT').send({ facultyId: 'QCU-PROF-IT' })).status).toBe(200)
      expect((await secretary.put('/api/accounts/advisors/4').send({ facultyIds: ['QCU-PROF-IT'] })).status).toBe(200)
      // The other instance applies the stored records to the seeded users it already had.
      expect((await onOther.get('/api/session')).status).toBe(401)
      expect((await chairOnOther.get('/api/session')).body.user.roles).toEqual(['professor'])
      expect((await signIn(other, 'QCU-PROF-IT')).response.body.user.roles).toEqual(['professor', 'chair'])
      const { agent: secretaryOnOther } = await signIn(other, 'ccs.secretary', secretaryPassword)
      expect((await secretaryOnOther.get('/api/accounts/advisors')).body.advisors[3].faculty.map((f: { id: string }) => f.id)).toEqual(['QCU-PROF-IT'])
      // A seeded account that was changed still signs in with the shared password.
      expect((await signIn(other, 'QCU-PROF-IT', seedPassword)).response.status).toBe(200)
    })

    it('persists a role change made on the administrator pages', async () => {
      const context = setup()
      const { agent: admin } = await signIn(context.app, 'ACCS-ADMIN')
      const change = await admin.post('/api/pages/P47/actions').send({ action: 'updateRoles', recordId: 'QCU-STU-IT-B', reason: 'Moved to the office', payload: { roles: ['guidance'] } })
      expect(change.status).toBe(200)
      const cold = context.another()
      expect((await signIn(cold, 'QCU-STU-IT-B')).response.body.user.roles).toEqual(['guidance'])
      // Only the fields the action changed are stored over the seeded user.
      const stored = (await context.authStore.load()).users.find((account) => account.id === 'QCU-STU-IT-B')!
      expect(stored).toMatchObject({ roles: ['guidance'], active: true, program: 'BSIT', section: 'B' })
      expect(stored).not.toHaveProperty('standing')
      expect((await admin.post('/api/pages/P47/actions').send({ action: 'updateRoles', recordId: 'QCU-STU-IT-B', reason: 'Account closed', payload: { roles: ['guidance'], active: false } })).status).toBe(200)
      expect((await signIn(context.another(), 'QCU-STU-IT-B')).response.status).toBe(401)
    })

    it('keeps own profile text on the instance while the stored account fields win', async () => {
      const context = setup()
      const secretary = await secretarySession(context.app)
      const { agent: prof } = await signIn(context.app, 'QCU-PROF-OTHER')
      expect((await prof.post('/api/pages/P39/actions').send({ action: 'saveProfile', payload: { title: 'Senior lecturer', bio: 'Updated bio.', education: 'MS CS', officeHours: 'Fridays' } })).status).toBe(200)
      await secretary.post('/api/accounts/QCU-PROF-OTHER/active').send({ active: true })
      await secretary.put('/api/accounts/advisors/2').send({ facultyIds: ['QCU-PROF-OTHER'] })
      expect((await prof.get('/api/pages/P39')).body.data.record.title).toBe('Senior lecturer')
    })
  })

  describe('what is written to the audit trail and the logs', () => {
    it('records each change with the actor and a reference, and never a username or password', async () => {
      const log = vi.spyOn(console, 'log').mockImplementation(() => {})
      const error = vi.spyOn(console, 'error').mockImplementation(() => {})
      const { app, repository, authStore } = setup()
      const secretaryCredentials = await activateSecretary(app)
      const { agent: secretary } = await signIn(app, secretaryCredentials.username, secretaryCredentials.temporaryPassword)
      await secretary.post('/api/auth/complete-first-login').send({ currentPassword: secretaryCredentials.temporaryPassword, username: 'maria.santos', password: secretaryPassword })
      const [prof] = await createFaculty(secretary, [faculty(1)])
      const [pupil] = await importStudents(secretary, [student(1)])
      await secretary.put('/api/accounts/advisors/3').send({ facultyIds: [prof!.account.id] })
      await secretary.put('/api/accounts/chairs/BSIT').send({ facultyId: prof!.account.id })
      await secretary.post(`/api/accounts/${pupil!.account.id}/active`).send({ active: false })
      await secretary.post(`/api/accounts/${pupil!.account.id}/active`).send({ active: true })
      const audit = (await peek(repository, (db) => db.audit)).slice(1)
      expect(audit.map((entry) => [entry.actorId, entry.action, entry.reference, entry.module])).toEqual([
        ['CCS-DEAN', 'Secretary account activated', 'QCU-SECRETARY', 'identity'],
        ['QCU-SECRETARY', 'Sign-in details set', 'QCU-SECRETARY', 'identity'],
        ['QCU-SECRETARY', 'Faculty account created', prof!.account.id, 'identity'],
        ['QCU-SECRETARY', 'Student account created', pupil!.account.id, 'identity'],
        ['QCU-SECRETARY', 'Year 3 advisers changed', 'year-3', 'identity'],
        ['QCU-SECRETARY', 'Program chair changed', 'BSIT', 'identity'],
        ['QCU-SECRETARY', 'Account deactivated', pupil!.account.id, 'identity'],
        ['QCU-SECRETARY', 'Account activated', pupil!.account.id, 'identity'],
      ])
      const secrets = [secretaryCredentials, prof!.credentials, pupil!.credentials].flatMap((c) => [c.username, c.temporaryPassword]).concat('maria.santos', secretaryPassword)
      const written = JSON.stringify([await peek(repository, (db) => db.audit), log.mock.calls, error.mock.calls])
      for (const secret of secrets) expect(written, secret).not.toContain(secret)
      // Only the hash is kept.
      const stored = JSON.stringify((await authStore.load()).credentials)
      for (const secret of secrets) expect(stored, secret).not.toContain(secret)
    })

    it('still returns the credentials when the audit write fails, and logs the failure without them', async () => {
      const error = vi.spyOn(console, 'error').mockImplementation(() => {})
      const { app, repository } = setup()
      const secretary = await secretarySession(app)
      const transact = repository.transact.bind(repository)
      vi.spyOn(repository, 'transact').mockImplementation(((work: Parameters<typeof transact>[0], collections?: Parameters<typeof transact>[1]) => {
        if (collections?.includes('audit')) return Promise.reject(new Error('audit table unavailable'))
        return transact(work, collections)
      }) as typeof repository.transact)
      const [made] = await importStudents(secretary, [student(1)])
      expect(made).toMatchObject({ status: 'created' })
      expect(JSON.parse(String(error.mock.calls[0]![0]))).toMatchObject({ level: 'error', msg: 'Audit entry not recorded', actions: ['Student account created'], error: { message: 'audit table unavailable' } })
      expect(JSON.stringify(error.mock.calls)).not.toContain(made!.credentials.temporaryPassword)
    })

    it('keeps decision codes and approval notes out of the account messages', async () => {
      const { app } = setup()
      const secretary = await secretarySession(app)
      const { agent: dean } = await signIn(app, 'CCS-DEAN')
      const texts: string[] = []
      const keep = (response: request.Response) => { texts.push(String(response.body.message ?? response.body.error)); for (const row of response.body.record?.results ?? []) texts.push(String(row.error ?? '')) }
      keep(await dean.post('/api/accounts/secretary/activate').send({}))
      keep(await secretary.post('/api/accounts/faculty').send({ faculty: [faculty(1), faculty(1), { name: '' }] }))
      keep(await secretary.post('/api/accounts/students').send({ students: [student(1), student(1), student(2, { year: 9 })] }))
      keep(await secretary.put('/api/accounts/advisors/1').send({ facultyIds: ['QCU-PROF-IT'] }))
      keep(await secretary.put('/api/accounts/advisors/1').send({ facultyIds: ['NOBODY'] }))
      keep(await secretary.put('/api/accounts/chairs/BSIT').send({ facultyId: 'QCU-PROF-IT' }))
      keep(await secretary.put('/api/accounts/chairs/BSIT').send({ facultyId: 'QCU-PROF-CS' }))
      keep(await secretary.post('/api/accounts/QCU-PROF-OTHER/active').send({ active: false }))
      keep(await secretary.post('/api/accounts/CCS-DEAN/active').send({ active: false }))
      keep(await secretary.post('/api/accounts/QCU-SECRETARY/active').send({ active: false }))
      keep(await secretary.post('/api/auth/complete-first-login').send({}))
      expect(texts.filter(Boolean).length).toBeGreaterThan(10)
      for (const text of texts) expect(text).not.toMatch(/\bD-\d\d\b|\bDOC\d{3}\b|\bTBD\b|\b[A-Z]{2,4}-\d{2}\b/)
    })
  })
})

describe('temporary passwords', () => {
  it('start with a letter or digit, so a spreadsheet opened from the downloaded CSV never reads one as a formula', () => {
    // About 1 in 15 would start with = + - or @ if the first character were not chosen on its own, so this many cannot pass by luck.
    for (let n = 0; n < 3000; n++) {
      const password = temporaryPassword()
      expect(password).toMatch(/^[A-Za-z0-9]/)
      expect(password).toHaveLength(14)
      expect(passwordProblem(password)).toBeUndefined()
      // No look-alikes, because these are read off a screen and typed.
      expect(password).not.toMatch(/[0O1lI]/)
    }
  })
})
