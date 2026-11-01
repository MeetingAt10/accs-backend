import request from 'supertest'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { createApp } from '../src/app.js'
import { createMemoryAuthStore, hashPassword, passwordProblem, verifyPassword } from '../src/auth.js'
import { createMemorySessionStore, sessionIdOf, sessionPolicy } from '../src/sessions.js'
import { createMemoryRepository } from '../src/store.js'

const password = 'Str0ng!Passw0rd'
const student = { fullName: 'Ana Reyes', email: 'Ana.Reyes@example.com', identifier: '24-1234', role: 'student', program: 'BSIT', yearLevel: 3, section: 'A', password }
const newApp = () => createApp(createMemoryRepository(), { authStore: createMemoryAuthStore() })

afterEach(() => vi.restoreAllMocks())

describe('password helpers', () => {
  it('hashes with scrypt and verifies', () => {
    const hash = hashPassword(password)
    expect(hash).toMatch(/^scrypt\$[^$]+\$[^$]+$/)
    expect(verifyPassword(password, hash)).toBe(true)
    expect(verifyPassword('nope', hash)).toBe(false)
    expect(verifyPassword(password, 'garbage')).toBe(false)
  })

  it('requires length, upper, lower, digit and symbol', () => {
    expect(passwordProblem(password)).toBeUndefined()
    for (const weak of ['Sh0rt!a', 'alllowercase1!', 'ALLUPPERCASE1!', 'NoDigitsHere!!', 'NoSymbols12345']) expect(passwordProblem(weak)).toBeDefined()
  })
})

describe('registration and sign-in', () => {
  it('registers, restores the session, signs out and signs back in by email and ID', async () => {
    const app = newApp()
    const agent = request.agent(app)
    const created = await agent.post('/api/auth/register').send(student)
    expect(created.status).toBe(201)
    expect(String(created.headers['set-cookie'])).toContain('accs_session=')
    expect(created.body.user).toMatchObject({ name: 'Ana Reyes', email: 'ana.reyes@example.com', roles: ['student'], studentId: '24-1234', program: 'BSIT', section: 'A', year: 3, spaceIds: ['SPACE-IT-A', 'SUBJECT-IT-DS'] })
    expect((await agent.get('/api/session')).body.user.id).toBe(created.body.user.id)
    expect((await agent.get('/api/pages/P03')).status).toBe(200)

    await agent.post('/api/auth/sign-out').send({})
    expect((await request(app).get('/api/session')).status).toBe(401)

    const byEmail = await request(app).post('/api/auth/sign-in').send({ emailOrId: 'ANA.REYES@example.com', password })
    expect(byEmail.status).toBe(200)
    expect(byEmail.body.user.id).toBe(created.body.user.id)
    const byId = await request(app).post('/api/auth/sign-in').send({ emailOrId: '24-1234', password, remember: true })
    expect(byId.status).toBe(200)
    expect(String(byId.headers['set-cookie'])).toMatch(/Max-Age=2592000/)
    expect(String((await request(app).post('/api/auth/sign-in').send({ emailOrId: '24-1234', password })).headers['set-cookie'])).not.toMatch(/Max-Age/)
  })

  it('shares a registered user across app instances through the auth store', async () => {
    const authStore = createMemoryAuthStore()
    const first = createApp(createMemoryRepository(), { authStore })
    const second = createApp(createMemoryRepository(), { authStore })
    const created = await request(first).post('/api/auth/register').send(student)
    const cookie = String(created.headers['set-cookie'][0]).split(';')[0]
    // Separate session stores, so the second instance does not know this session.
    expect((await request(second).get('/api/session').set('Cookie', cookie)).status).toBe(401)
    expect((await request(second).post('/api/auth/sign-in').send({ emailOrId: 'ana.reyes@example.com', password })).status).toBe(200)
  })

  it('accepts a session on every instance that shares the session store', async () => {
    const authStore = createMemoryAuthStore()
    const sessionStore = createMemorySessionStore()
    const first = createApp(createMemoryRepository(), { authStore, sessionStore })
    const second = createApp(createMemoryRepository(), { authStore, sessionStore })
    const created = await request(first).post('/api/auth/register').send(student)
    const cookie = String(created.headers['set-cookie'][0]).split(';')[0]
    expect((await request(second).get('/api/session').set('Cookie', cookie)).body.user.id).toBe(created.body.user.id)
  })

  it('rejects wrong passwords with a generic error', async () => {
    const app = newApp()
    await request(app).post('/api/auth/register').send(student)
    const wrong = await request(app).post('/api/auth/sign-in').send({ emailOrId: 'ana.reyes@example.com', password: 'Wrong!Passw0rd' })
    const unknown = await request(app).post('/api/auth/sign-in').send({ emailOrId: 'nobody@example.com', password })
    for (const response of [wrong, unknown]) {
      expect(response.status).toBe(401)
      expect(response.body).toEqual({ error: 'The email, ID, or password is incorrect.', code: 'INVALID_CREDENTIALS' })
    }
  })

  it('rejects weak passwords, bad identifiers, missing student fields and privileged roles', async () => {
    const app = newApp()
    for (const bad of [{ ...student, password: 'weak' }, { ...student, identifier: '2024-1234' }, { ...student, program: undefined }, { ...student, section: 'Z' }, { ...student, role: 'administrator' }, { ...student, role: 'guidance' }, { ...student, role: 'chair' }]) {
      const response = await request(app).post('/api/auth/register').send(bad)
      expect(response.status).toBe(400)
      expect(response.body.code).toBe('VALIDATION_ERROR')
    }
    expect((await request(app).post('/api/auth/register').send({ ...student, role: 'professor', program: undefined, yearLevel: undefined, section: undefined, identifier: '2024-1234' })).status).toBe(201)
  })

  it('rejects duplicate emails and identifiers, including seeded ones', async () => {
    const app = newApp()
    expect((await request(app).post('/api/auth/register').send(student)).status).toBe(201)
    const email = await request(app).post('/api/auth/register').send({ ...student, email: 'ANA.REYES@example.com', identifier: '24-9999' })
    expect(email.status).toBe(409)
    expect(email.body.code).toBe('CONFLICT')
    expect((await request(app).post('/api/auth/register').send({ ...student, email: 'other@example.com' })).status).toBe(409)
    expect((await request(app).post('/api/auth/register').send({ ...student, email: 'stu.it.a@qcu.edu.ph', identifier: '24-9999' })).status).toBe(409)
  })

  it('throttles after five failures per identifier', async () => {
    const app = newApp()
    const attempt = (pw: string) => request(app).post('/api/auth/sign-in').send({ emailOrId: 'QCU-STU-IT-A', password: pw })
    for (let n = 0; n < 5; n++) expect((await attempt('Wrong!Passw0rd')).status).toBe(401)
    const blocked = await attempt('Accs@Qcu2026!')
    expect(blocked.status).toBe(429)
    expect(blocked.body.code).toBe('TOO_MANY_ATTEMPTS')
    expect((await request(app).post('/api/auth/sign-in').send({ emailOrId: 'QCU-STU-IT-B', password: 'Accs@Qcu2026!' })).status).toBe(200)
  })

  it('no longer signs in by account ID alone or lists demo accounts', async () => {
    const app = newApp()
    expect((await request(app).post('/api/auth/sign-in').send({ accountId: 'QCU-STU-IT-A' })).status).toBe(400)
    expect((await request(app).get('/api/demo-accounts')).status).toBe(401)
  })
})

describe('password reset and change', () => {
  it('issues a single-use code that resets the password', async () => {
    const app = newApp()
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    await request(app).post('/api/auth/register').send(student)
    const forgot = await request(app).post('/api/auth/forgot-password').send({ emailOrId: 'ana.reyes@example.com' })
    expect(forgot.status).toBe(200)
    expect(forgot.body.ok).toBe(true)
    expect(JSON.stringify(forgot.body)).not.toMatch(/\d{6}/)
    const code = String(log.mock.calls.flat().join(' ')).match(/: (\d{6})/)![1]
    const next = 'N3w!Passw0rdXyz'

    const wrong = await request(app).post('/api/auth/reset-password').send({ emailOrId: 'ana.reyes@example.com', code: code === '000000' ? '111111' : '000000', password: next })
    expect(wrong.status).toBe(400)
    expect(wrong.body.code).toBe('INVALID_CODE')
    expect((await request(app).post('/api/auth/reset-password').send({ emailOrId: 'ana.reyes@example.com', code, password: 'weak' })).status).toBe(400)
    expect((await request(app).post('/api/auth/reset-password').send({ emailOrId: 'ana.reyes@example.com', code, password: next })).status).toBe(200)
    expect((await request(app).post('/api/auth/reset-password').send({ emailOrId: 'ana.reyes@example.com', code, password: next })).status).toBe(400)

    expect((await request(app).post('/api/auth/sign-in').send({ emailOrId: 'ana.reyes@example.com', password })).status).toBe(401)
    expect((await request(app).post('/api/auth/sign-in').send({ emailOrId: 'ana.reyes@example.com', password: next })).status).toBe(200)
  })

  it('answers forgot-password the same for unknown accounts', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    const response = await request(newApp()).post('/api/auth/forgot-password').send({ emailOrId: 'nobody@example.com' })
    expect(response.status).toBe(200)
    expect(response.body.ok).toBe(true)
    expect(log).not.toHaveBeenCalled()
  })

  it('changes the password for a signed-in user, seeded or registered', async () => {
    const app = newApp()
    expect((await request(app).post('/api/auth/change-password').send({ currentPassword: password, password })).status).toBe(401)

    const agent = request.agent(app)
    await agent.post('/api/auth/sign-in').send({ emailOrId: 'QCU-STU-IT-A', password: 'Accs@Qcu2026!' })
    const next = 'N3w!Passw0rdXyz'
    expect((await agent.post('/api/auth/change-password').send({ currentPassword: 'Wrong!Passw0rd', password: next })).status).toBe(400)
    expect((await agent.post('/api/auth/change-password').send({ currentPassword: 'Accs@Qcu2026!', password: 'weak' })).status).toBe(400)
    expect((await agent.post('/api/auth/change-password').send({ currentPassword: 'Accs@Qcu2026!', password: next })).status).toBe(200)
    expect((await request(app).post('/api/auth/sign-in').send({ emailOrId: 'QCU-STU-IT-A', password: 'Accs@Qcu2026!' })).status).toBe(401)
    expect((await request(app).post('/api/auth/sign-in').send({ emailOrId: 'QCU-STU-IT-A', password: next })).status).toBe(200)
  })
})

describe('server-side sessions', () => {
  const cookieOf = (response: request.Response) => String(response.headers['set-cookie'][0]).split(';')[0]!
  const signIn = (app: ReturnType<typeof newApp>, remember = false) => request(app).post('/api/auth/sign-in').send({ emailOrId: 'QCU-STU-IT-A', password: 'Accs@Qcu2026!', remember })
  const sessionStatus = async (app: ReturnType<typeof newApp>, cookie: string) => (await request(app).get('/api/session').set('Cookie', cookie)).status

  it('stores only a hash of the opaque cookie token', async () => {
    const sessionStore = createMemorySessionStore()
    const app = createApp(createMemoryRepository(), { authStore: createMemoryAuthStore(), sessionStore })
    const token = cookieOf(await signIn(app)).slice('accs_session='.length)
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(await sessionStore.get(token)).toBeUndefined()
    expect(await sessionStore.get(sessionIdOf(token))).toMatchObject({ userId: 'QCU-STU-IT-A', status: 'active', activeRoleId: 'student', remember: false })
  })

  it('revokes the session on sign-out, so a copied cookie stops working', async () => {
    const app = newApp()
    const cookie = cookieOf(await signIn(app))
    expect(await sessionStatus(app, cookie)).toBe(200)
    await request(app).post('/api/auth/sign-out').set('Cookie', cookie).send({})
    expect(await sessionStatus(app, cookie)).toBe(401)
  })

  it('rejects old signed-token cookies and malformed values', async () => {
    const app = newApp()
    const legacy = `${Buffer.from(JSON.stringify({ id: 'QCU-ADMIN', roles: ['administrator'] })).toString('base64url')}.c2lnbmF0dXJl`
    for (const value of [legacy, '', 'x'.repeat(43)]) expect(await sessionStatus(app, `accs_session=${value}`)).toBe(401)
  })

  it('expires idle sessions and sessions past their absolute lifetime', async () => {
    const app = newApp()
    const normal = cookieOf(await signIn(app))
    const remembered = cookieOf(await signIn(app, true))
    const start = Date.now()
    const clock = vi.spyOn(Date, 'now').mockReturnValue(start + sessionPolicy.normal.idleMs + 1000)
    expect(await sessionStatus(app, normal)).toBe(401)
    expect(await sessionStatus(app, remembered)).toBe(200)
    clock.mockReturnValue(start + sessionPolicy.remember.absoluteMs + 1000)
    expect(await sessionStatus(app, remembered)).toBe(401)
  })

  it('keeps a session alive while it is used within the idle window', async () => {
    const app = newApp()
    const cookie = cookieOf(await signIn(app))
    const start = Date.now()
    const clock = vi.spyOn(Date, 'now')
    for (let step = 1; step <= 3; step++) {
      clock.mockReturnValue(start + step * (sessionPolicy.normal.idleMs - 60 * 1000))
      expect(await sessionStatus(app, cookie)).toBe(200)
    }
  })

  it('ends the sessions of a deactivated account immediately', async () => {
    const app = newApp()
    const student = cookieOf(await signIn(app))
    const admin = cookieOf(await request(app).post('/api/auth/sign-in').send({ emailOrId: 'QCU-ADMIN', password: 'Accs@Qcu2026!' }))
    const update = await request(app).post('/api/pages/P47/actions').set('Cookie', admin).send({ action: 'updateRoles', recordId: 'QCU-STU-IT-A', reason: 'Account closed', payload: { roles: ['student'], active: false } })
    expect(update.status).toBe(200)
    expect(await sessionStatus(app, student)).toBe(401)
  })

  it('signs out other devices on a password change and every device on a reset', async () => {
    const app = newApp()
    const current = cookieOf(await signIn(app))
    const other = cookieOf(await signIn(app))
    expect((await request(app).post('/api/auth/change-password').set('Cookie', current).send({ currentPassword: 'Accs@Qcu2026!', password: 'N3w!Passw0rdXyz' })).status).toBe(200)
    expect(await sessionStatus(app, current)).toBe(200)
    expect(await sessionStatus(app, other)).toBe(401)

    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    await request(app).post('/api/auth/forgot-password').send({ emailOrId: 'QCU-STU-IT-A' })
    const code = String(log.mock.calls.at(-1)?.[0]).match(/(\d{6})$/)![1]
    expect((await request(app).post('/api/auth/reset-password').send({ emailOrId: 'QCU-STU-IT-A', code, password: 'An0ther!Passw0rd' })).status).toBe(200)
    expect(await sessionStatus(app, current)).toBe(401)
  })
})
