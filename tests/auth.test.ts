import serverless from 'serverless-http'
import request from 'supertest'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { createApp } from '../src/app.js'
import { createMemoryAuthStore, hashPassword, passwordProblem, verifyPassword } from '../src/auth.js'
import { createMemoryResetStore, resetPolicy } from '../src/resets.js'
import { createMemorySessionStore, sessionIdOf, sessionPolicy } from '../src/sessions.js'
import type { User } from '../src/schemas.js'
import { createMemoryRepository } from '../src/store.js'

const password = 'Str0ng!Passw0rd'
const ana: User = { id: 'USR-ANA', name: 'Ana Reyes', email: 'ana.reyes@example.com', roles: ['student'], program: 'BSIT', section: 'A', year: 3, studentId: '24-1234', restrictions: [], title: '', bio: '', education: '', officeHours: '', spaceIds: ['SPACE-IT-A', 'SUBJECT-IT-DS'], organizationIds: [], active: true }
const withAna = (authStore = createMemoryAuthStore()) => { void authStore.update(data => { data.users.push(ana); data.credentials[ana.id] = hashPassword(password) }); return authStore }
const newApp = () => createApp(createMemoryRepository(), { authStore: withAna() })

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

describe('sign-in', () => {
  it('signs in by email and ID, restores the session and signs out', async () => {
    const app = newApp()
    const byEmail = await request(app).post('/api/auth/sign-in').send({ emailOrId: 'ANA.REYES@example.com', password })
    expect(byEmail.status).toBe(200)
    expect(byEmail.body.user).toMatchObject({ id: 'USR-ANA', roles: ['student'], studentId: '24-1234', spaceIds: ['SPACE-IT-A', 'SUBJECT-IT-DS'] })
    const agent = request.agent(app)
    await agent.post('/api/auth/sign-in').send({ emailOrId: '24-1234', password })
    expect((await agent.get('/api/session')).body.user.id).toBe('USR-ANA')
    expect((await agent.get('/api/pages/P03')).status).toBe(200)
    await agent.post('/api/auth/sign-out').send({})
    expect((await agent.get('/api/session')).status).toBe(401)

    const byId = await request(app).post('/api/auth/sign-in').send({ emailOrId: '24-1234', password, remember: true })
    expect(String(byId.headers['set-cookie'])).toMatch(/Max-Age=2592000/)
    expect(String((await request(app).post('/api/auth/sign-in').send({ emailOrId: '24-1234', password })).headers['set-cookie'])).not.toMatch(/Max-Age/)
  })

  it('shares a stored user across app instances through the auth store', async () => {
    const authStore = withAna()
    const first = createApp(createMemoryRepository(), { authStore })
    const second = createApp(createMemoryRepository(), { authStore })
    const cookie = String((await request(first).post('/api/auth/sign-in').send({ emailOrId: ana.email, password })).headers['set-cookie'][0]).split(';')[0]
    // Separate session stores, so the second instance does not know this session.
    expect((await request(second).get('/api/session').set('Cookie', cookie)).status).toBe(401)
    expect((await request(second).post('/api/auth/sign-in').send({ emailOrId: ana.email, password })).status).toBe(200)
  })

  it('accepts a session on every instance that shares the session store', async () => {
    const authStore = withAna()
    const sessionStore = createMemorySessionStore()
    const first = createApp(createMemoryRepository(), { authStore, sessionStore })
    const second = createApp(createMemoryRepository(), { authStore, sessionStore })
    const created = await request(first).post('/api/auth/sign-in').send({ emailOrId: ana.email, password })
    const cookie = String(created.headers['set-cookie'][0]).split(';')[0]
    expect((await request(second).get('/api/session').set('Cookie', cookie)).body.user.id).toBe('USR-ANA')
  })

  it('rejects wrong passwords with a generic error', async () => {
    const app = newApp()
    const wrong = await request(app).post('/api/auth/sign-in').send({ emailOrId: ana.email, password: 'Wrong!Passw0rd' })
    const unknown = await request(app).post('/api/auth/sign-in').send({ emailOrId: 'nobody@example.com', password })
    for (const response of [wrong, unknown]) {
      expect(response.status).toBe(401)
      expect(response.body).toEqual({ error: 'The email, ID, or password is incorrect.', code: 'INVALID_CREDENTIALS' })
    }
  })

  it('has no public registration route', async () => {
    // Without a session the shared auth gate answers 401 first; signed in, the route is simply unknown.
    const agent = request.agent(newApp())
    await agent.post('/api/auth/sign-in').send({ emailOrId: ana.email, password })
    expect((await agent.post('/api/auth/register').send({ email: ana.email, password })).status).toBe(404)
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

  it('does not give a client more attempts for a forged X-Forwarded-For outside Lambda', async () => {
    const app = newApp()
    const attempt = (n: number, pw: string) => request(app).post('/api/auth/sign-in').set('X-Forwarded-For', `10.0.0.${n}`).send({ emailOrId: 'QCU-STU-IT-A', password: pw })
    for (let n = 0; n < 5; n++) expect((await attempt(n, 'Wrong!Passw0rd')).status).toBe(401)
    expect((await attempt(5, 'Accs@Qcu2026!')).status).toBe(429)
  })

  describe('per client, through the Lambda handler', () => {
    const seeded = 'Accs@Qcu2026!'
    // An API Gateway HTTP API event: `sourceIp` is the connection's address, which the caller cannot set.
    const signInFrom = async (handler: ReturnType<typeof serverless>, sourceIp: string, pw: string, headers: Record<string, string> = {}, emailOrId = 'QCU-STU-IT-A') => {
      const result = await handler({
        version: '2.0', routeKey: '$default', rawPath: '/api/auth/sign-in', rawQueryString: '', isBase64Encoded: false,
        headers: { 'content-type': 'application/json', ...headers },
        body: JSON.stringify({ emailOrId, password: pw }),
        requestContext: { stage: '$default', requestId: 'r', http: { method: 'POST', path: '/api/auth/sign-in', protocol: 'HTTP/1.1', sourceIp, userAgent: 'test' } },
      }, {}) as { statusCode: number }
      return result.statusCode
    }
    const failFiveTimes = async (handler: ReturnType<typeof serverless>, sourceIp: string) => {
      for (let n = 0; n < 5; n++) expect(await signInFrom(handler, sourceIp, 'Wrong!Passw0rd')).toBe(401)
    }

    it('does not block the same account from a different client', async () => {
      const handler = serverless(newApp())
      await failFiveTimes(handler, '203.0.113.7')
      expect(await signInFrom(handler, '203.0.113.7', seeded)).toBe(429)
      expect(await signInFrom(handler, '198.51.100.9', seeded)).toBe(200)
    })

    it('still limits the client that keeps failing, even after the owner signs in elsewhere', async () => {
      const handler = serverless(newApp())
      await failFiveTimes(handler, '203.0.113.7')
      expect(await signInFrom(handler, '198.51.100.9', seeded)).toBe(200)
      expect(await signInFrom(handler, '203.0.113.7', 'Wrong!Passw0rd')).toBe(429)
      expect(await signInFrom(handler, '203.0.113.7', seeded)).toBe(429)
    })

    it('counts each client separately for the same account', async () => {
      const handler = serverless(newApp())
      await failFiveTimes(handler, '203.0.113.7')
      await failFiveTimes(handler, '198.51.100.9')
      expect(await signInFrom(handler, '192.0.2.1', seeded)).toBe(200)
    })

    it('does not give a client more attempts for a forged X-Forwarded-For', async () => {
      const handler = serverless(newApp())
      for (let n = 0; n < 5; n++) expect(await signInFrom(handler, '203.0.113.7', 'Wrong!Passw0rd', { 'x-forwarded-for': `10.0.0.${n}, 203.0.113.7` })).toBe(401)
      expect(await signInFrom(handler, '203.0.113.7', seeded, { 'x-forwarded-for': '10.0.0.99, 203.0.113.7' })).toBe(429)
    })

    it('does not let a client spend its attempts on one spelling and continue on another', async () => {
      const handler = serverless(newApp())
      for (const spelling of ['QCU-STU-IT-A', 'qcu-stu-it-a', ' QCU-STU-IT-A ', 'Qcu-Stu-It-A', 'qcu-STU-it-A']) expect(await signInFrom(handler, '203.0.113.7', 'Wrong!Passw0rd', {}, spelling)).toBe(401)
      expect(await signInFrom(handler, '203.0.113.7', seeded)).toBe(429)
    })
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

  it('changes the password for a signed-in user, seeded or stored', async () => {
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

describe('reset code limits and office-assisted reset', () => {
  const admin = async (app: ReturnType<typeof newApp>) => String((await request(app).post('/api/auth/sign-in').send({ emailOrId: 'QCU-ADMIN', password: 'Accs@Qcu2026!' })).headers['set-cookie'][0]).split(';')[0]!
  const reset = (app: ReturnType<typeof newApp>, code: string) => request(app).post('/api/auth/reset-password').send({ emailOrId: 'QCU-STU-IT-A', code, password: 'An0ther!Passw0rd' })
  const wrongCode = (code: string) => (code === '000000' ? '111111' : '000000')

  it('kills a code after five wrong guesses, even when they are spread across instances', async () => {
    const shared = { authStore: createMemoryAuthStore(), sessionStore: createMemorySessionStore(), resetStore: createMemoryResetStore() }
    const first = createApp(createMemoryRepository(), shared)
    const second = createApp(createMemoryRepository(), shared)
    const issued = await request(first).post('/api/admin/accounts/QCU-STU-IT-A/reset-code').set('Cookie', await admin(first)).send({})
    const code = issued.body.record.code as string
    for (let n = 0; n < 3; n++) expect((await reset(first, wrongCode(code))).status).toBe(400)
    for (let n = 0; n < 2; n++) expect((await reset(second, wrongCode(code))).status).toBe(400)
    // Each instance has seen fewer than five failures, but the code itself has none left.
    const third = createApp(createMemoryRepository(), shared)
    expect((await reset(third, code)).status).toBe(400)
  })

  it('applies a cooldown to self-service requests', async () => {
    const resetStore = createMemoryResetStore()
    const app = createApp(createMemoryRepository(), { authStore: createMemoryAuthStore(), resetStore })
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    for (let n = 0; n < 2; n++) expect((await request(app).post('/api/auth/forgot-password').send({ emailOrId: 'QCU-STU-IT-A' })).status).toBe(200)
    expect(log).toHaveBeenCalledTimes(1)
  })

  it('states the documented limits', () => {
    expect(resetPolicy).toMatchObject({ cooldownMs: 60 * 1000, maxPerWindow: 5, windowMs: 60 * 60 * 1000 })
  })

  it('stops issuing at the hourly cap, with the same answer as for an unknown account', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    try {
      const app = createApp(createMemoryRepository(), { authStore: createMemoryAuthStore(), resetStore: createMemoryResetStore() })
      const log = vi.spyOn(console, 'log').mockImplementation(() => {})
      const forgot = (emailOrId: string) => request(app).post('/api/auth/forgot-password').send({ emailOrId })
      const unknown = await forgot('nobody@example.com')
      expect(unknown.status).toBe(200)
      const start = Date.now()

      for (let n = 1; n <= resetPolicy.maxPerWindow; n++) {
        const issued = await forgot('QCU-STU-IT-A')
        expect([issued.status, issued.body]).toEqual([200, unknown.body])
        expect(log).toHaveBeenCalledTimes(n)
        vi.advanceTimersByTime(resetPolicy.cooldownMs)
      }

      // Past the cooldown but inside the hour: refused, and the caller cannot tell.
      const refused = await forgot('QCU-STU-IT-A')
      expect([refused.status, refused.body]).toEqual([200, unknown.body])
      expect(log).toHaveBeenCalledTimes(resetPolicy.maxPerWindow)

      vi.setSystemTime(start + resetPolicy.windowMs)
      expect((await forgot('QCU-STU-IT-A')).status).toBe(200)
      expect(log).toHaveBeenCalledTimes(resetPolicy.maxPerWindow + 1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('answers a request inside the cooldown the same way, and issues nothing', async () => {
    const app = createApp(createMemoryRepository(), { authStore: createMemoryAuthStore(), resetStore: createMemoryResetStore() })
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    const forgot = () => request(app).post('/api/auth/forgot-password').send({ emailOrId: 'QCU-STU-IT-A' })
    const first = await forgot()
    const second = await forgot()
    expect([second.status, second.body]).toEqual([first.status, first.body])
    expect(log).toHaveBeenCalledTimes(1)
  })

  it('lets an administrator issue a code once, audited, that resets the password', async () => {
    const repository = createMemoryRepository()
    const app = createApp(repository, { authStore: createMemoryAuthStore() })
    const cookie = await admin(app)
    const issued = await request(app).post('/api/admin/accounts/QCU-STU-IT-A/reset-code').set('Cookie', cookie).send({})
    expect(issued.status).toBe(200)
    expect(issued.body.record.code).toMatch(/^\d{6}$/)
    expect(repository.read().audit.some(a => a.action === 'Password reset code issued' && a.reference === 'QCU-STU-IT-A' && a.actorId === 'QCU-ADMIN')).toBe(true)
    expect(JSON.stringify(repository.read().audit)).not.toContain(issued.body.record.code)
    expect((await reset(app, issued.body.record.code)).status).toBe(200)
    expect((await request(app).post('/api/auth/sign-in').send({ emailOrId: 'QCU-STU-IT-A', password: 'An0ther!Passw0rd' })).status).toBe(200)
  })

  it('refuses the admin endpoint to other roles and unknown accounts', async () => {
    const app = newApp()
    const student = String((await request(app).post('/api/auth/sign-in').send({ emailOrId: 'QCU-STU-IT-B', password: 'Accs@Qcu2026!' })).headers['set-cookie'][0]).split(';')[0]!
    expect((await request(app).post('/api/admin/accounts/QCU-STU-IT-A/reset-code').set('Cookie', student).send({})).status).toBe(403)
    expect((await request(app).post('/api/admin/accounts/QCU-STU-IT-A/reset-code').send({})).status).toBe(401)
    expect((await request(app).post('/api/admin/accounts/NOPE/reset-code').set('Cookie', await admin(app)).send({})).status).toBe(404)
  })
})
