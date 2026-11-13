// Decided 12 November 2026: the System Administrator sets up the real Dean with their name and email. The Dean gets an
// invite with temporary credentials, chooses their own at first sign-in, and the shared sample password stops working.
// Once the account has a real email it is emailed like any other (reset codes, new concerns). No real names in the code.
import request from 'supertest'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { type Invite } from '../src/accounts.js'
import { createApp } from '../src/app.js'
import { createMemoryAuthStore } from '../src/auth.js'
import { type NewConcernEmail, type ResetCodeEmail } from '../src/mail.js'
import { createMemoryRepository } from '../src/store.js'
import { seedPassword, signIn } from './helpers.js'

let repo: ReturnType<typeof createMemoryRepository>
let authStore: ReturnType<typeof createMemoryAuthStore>
let app: ReturnType<typeof createApp>
let invites: Invite[]
let concernEmails: NewConcernEmail[]
let resetEmails: ResetCodeEmail[]
beforeEach(() => {
  invites = []; concernEmails = []; resetEmails = []
  repo = createMemoryRepository()
  authStore = createMemoryAuthStore()
  app = createApp(repo, {
    authStore,
    mailer: { send: async (invite) => { invites.push(invite); return { sent: true } } },
    concernMailer: { channel: 'email', send: async (m) => { concernEmails.push(m) } },
    resetMailer: { channel: 'email', send: async (m) => { resetEmails.push(m) } },
  })
  vi.spyOn(console, 'log').mockImplementation(() => {})
})
afterEach(() => { vi.restoreAllMocks() })

// A made-up person for the tests; the real Dean's details are entered in the running system, never in the code.
const dean = { name: 'Maria Clara Reyes', email: 'maria.reyes@example.edu' }
const newPassword = 'Dean#Passw0rd-2026'
async function setUp(body: object = dean) {
  const { agent } = await signIn(app, 'ACCS-ADMIN')
  return agent.post('/api/accounts/dean/setup').send(body)
}

describe('setting up the Dean', () => {
  it('sets the Dean\'s name and email, and emails temporary sign-in details', async () => {
    const response = await setUp()
    expect(response.status, JSON.stringify(response.body)).toBe(200)
    expect(response.body.message).toBe('The Dean account is set up and the sign-in details were emailed to the Dean.')
    expect(response.body.record.account).toMatchObject({ id: 'CCS-DEAN', name: dean.name, email: dean.email, roles: ['dean'], active: true, mustChangeCredentials: true })
    const { username, temporaryPassword } = response.body.record.credentials
    expect(invites).toEqual([expect.objectContaining({ accountId: 'CCS-DEAN', to: dean.email, name: dean.name, username, temporaryPassword })])
    expect(repo.read().audit.some((a) => a.action === 'Dean account set up' && a.reference === 'CCS-DEAN')).toBe(true)
    // Stored in the auth store, so every instance shows the real Dean.
    expect((await authStore.load()).users.find((u) => u.id === 'CCS-DEAN')).toMatchObject({ name: dean.name, email: dean.email })
  })

  it('lets the Dean sign in with the temporary details, choose their own, and ends the shared sample password', async () => {
    const { username, temporaryPassword } = (await setUp()).body.record.credentials
    const first = await signIn(app, username, temporaryPassword)
    expect(first.response.status).toBe(200)
    expect(first.response.body.user).toMatchObject({ id: 'CCS-DEAN', name: dean.name, mustChangeCredentials: true })
    expect((await first.agent.post('/api/auth/complete-first-login').send({ currentPassword: temporaryPassword, username: 'dean.reyes', password: newPassword })).status).toBe(200)
    // The shared sample password no longer opens the Dean's account, by ID or by the old sample email.
    for (const id of ['CCS-DEAN', 'QCU-DEAN', 'dean@qcu.edu.ph']) expect([id, (await signIn(app, id, seedPassword)).response.status]).toEqual([id, 401])
    const own = await signIn(app, dean.email, newPassword)
    expect(own.response.status).toBe(200)
    expect(own.response.body.user).toMatchObject({ id: 'CCS-DEAN', name: dean.name })
    // The Dean keeps every Dean permission.
    expect((await own.agent.get('/api/session')).body.permissions).toContain('account.activateSecretary')
  })

  it('ends any session still open on the sample password', async () => {
    const { agent: before } = await signIn(app, 'CCS-DEAN')
    expect((await before.get('/api/session')).status).toBe(200)
    await setUp()
    expect((await before.get('/api/session')).status).toBe(401)
  })

  it('is for the System Administrator only, and needs a name and an unused email', async () => {
    for (const id of ['CCS-DEAN', 'QCU-PROF-IT', 'QCU-OSAS', 'QCU-STU-IT-A']) {
      const { agent } = await signIn(app, id)
      expect([id, (await agent.post('/api/accounts/dean/setup').send(dean)).status]).toEqual([id, 403])
    }
    expect((await setUp({ name: dean.name })).status).toBe(400)
    expect((await setUp({ email: dean.email })).status).toBe(400)
    expect((await setUp({ ...dean, email: 'not an email' })).status).toBe(400)
    const taken = repo.read().users.find((u) => u.id === 'QCU-PROF-IT')!.email
    expect((await setUp({ ...dean, email: taken })).status).toBe(409)
    expect(invites).toEqual([])
  })

  it('can be run again, issuing new temporary details', async () => {
    const first = (await setUp()).body.record.credentials
    const second = (await setUp({ ...dean, email: 'maria.c.reyes@example.edu' })).body.record.credentials
    expect(second.temporaryPassword).not.toBe(first.temporaryPassword)
    expect((await signIn(app, first.username, first.temporaryPassword)).response.status).toBe(401)
    expect((await signIn(app, second.username, second.temporaryPassword)).response.status).toBe(200)
  })
})

describe('email once the Dean has a real address', () => {
  it('sends the Dean reset codes and new-concern emails, which the sample account never gets', async () => {
    // Before: the sample Dean is never emailed.
    await request(app).post('/api/auth/forgot-password').send({ emailOrId: 'CCS-DEAN' })
    expect(resetEmails).toEqual([])
    const { username, temporaryPassword } = (await setUp()).body.record.credentials
    const first = await signIn(app, username, temporaryPassword)
    await first.agent.post('/api/auth/complete-first-login').send({ currentPassword: temporaryPassword, username: 'dean.reyes', password: newPassword })
    await request(app).post('/api/auth/forgot-password').send({ emailOrId: dean.email })
    expect(resetEmails.map((m) => [m.userId, m.to])).toEqual([['CCS-DEAN', dean.email]])
    // A Program Chair reporting a student of their own program sends it to the Dean, who is now emailed.
    const { agent: chair } = await signIn(app, 'QCU-CHAIR-IT')
    const filed = await chair.post('/api/pages/P21/actions').send({ action: 'reportStudent', payload: { studentId: 'QCU-STU-IT-A', narrative: 'Disrupted the exam.', category: 'Bullying', subcategory: 'Intimidation or threats', severity: 'medium' } })
    expect(filed.status, JSON.stringify(filed.body)).toBe(200)
    expect(concernEmails.map((m) => [m.userId, m.to])).toEqual([['CCS-DEAN', dean.email]])
  })
})
