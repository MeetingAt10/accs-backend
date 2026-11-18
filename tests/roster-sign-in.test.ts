// Reported 17 November 2026: a tester signed in to a real faculty member's account with the shared seed password, by
// typing the made-up address (in any letter case, e.g. "@acSs..."). Real people on the roster never use the shared
// password: they sign in only with credentials set up for them, and a session opened the old way stops working.
import request from 'supertest'
import { beforeEach, describe, expect, it } from 'vitest'

import { createApp } from '../src/app.js'
import { createMemoryAuthStore, hashPassword } from '../src/auth.js'
import { facultyRoster } from '../src/faculty-roster.js'
import { createMemoryRepository } from '../src/store.js'
import { seedPassword } from './helpers.js'

let authStore: ReturnType<typeof createMemoryAuthStore>
let app: ReturnType<typeof createApp>
beforeEach(() => { authStore = createMemoryAuthStore(); app = createApp(createMemoryRepository(), { authStore }) })
const signIn = (emailOrId: string, password = seedPassword) => request(app).post('/api/auth/sign-in').send({ emailOrId, password })
const professor = facultyRoster.find((person) => person.roles.includes('professor') && person.id !== 'QCU-FAC-PAULA-DELACRUZ')!
const secretary = facultyRoster.find((person) => person.roles.includes('secretary'))!

describe('real people on the roster', () => {
  it('cannot be signed in to with the shared seed password, by email in any case or by ID', async () => {
    const [local, domain] = professor.email.split('@')
    for (const attempt of [professor.email, professor.email.toUpperCase(), `${local}@${domain!.replace('access', 'acSs').replace('ccs', 'CCS')}`, professor.id]) {
      const response = await signIn(attempt)
      expect(response.status, attempt).toBe(401)
      expect(response.body.code).toBe('INVALID_CREDENTIALS')
    }
  })

  it('includes the real Dean and the real Secretary', async () => {
    expect((await signIn('QCU-FAC-PAULA-DELACRUZ')).status).toBe(401)
    expect((await signIn(secretary.id)).status).toBe(401)
  })

  it('still lets the made-up demo accounts sign in with the seed password', async () => {
    expect((await signIn('QCU-STU-IT-A')).status).toBe(200)
    expect((await signIn('ACCS-ADMIN')).status).toBe(200)
  })

  it('signs a real person in with credentials set up for them', async () => {
    await authStore.update((data) => { data.credentials[professor.id] = hashPassword('Their-Own#Pass-2026') })
    expect((await signIn(professor.email, 'Their-Own#Pass-2026')).status).toBe(200)
    expect((await signIn(professor.email)).status).toBe(401)
  })

  it('ends a session that a real person\'s account has without a credential of its own', async () => {
    // On production: the development stack lets testers switch to any account (tests/dev-toolbox.test.ts).
    app = createApp(createMemoryRepository(), { authStore, stack: { tablePrefix: 'accs-prod-', nodeEnv: 'production' } })
    await authStore.update((data) => { data.credentials[professor.id] = hashPassword('Their-Own#Pass-2026') })
    const agent = request.agent(app)
    expect((await agent.post('/api/auth/sign-in').send({ emailOrId: professor.id, password: 'Their-Own#Pass-2026' })).status).toBe(200)
    expect((await agent.get('/api/session')).status).toBe(200)
    // As if the session had been opened with the shared password before this fix: the account has no credential.
    await authStore.update((data) => { delete data.credentials[professor.id] })
    expect((await agent.get('/api/session')).status).toBe(401)
  })

  it('lets the administrator set up the real Dean, who then signs in with the new credentials only', async () => {
    const admin = request.agent(app)
    expect((await admin.post('/api/auth/sign-in').send({ emailOrId: 'ACCS-ADMIN', password: seedPassword })).status).toBe(200)
    const setUp = await admin.post('/api/accounts/dean/setup').send({ name: 'Dean of CCS', email: 'dean.ccs@example.edu' })
    expect(setUp.status, JSON.stringify(setUp.body)).toBe(200)
    const { username, temporaryPassword } = setUp.body.record.credentials
    expect((await signIn(username, temporaryPassword)).status).toBe(200)
    expect((await signIn('QCU-FAC-PAULA-DELACRUZ')).status).toBe(401)
  })
})
