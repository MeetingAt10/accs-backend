import request from 'supertest'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { createApp } from '../src/app.js'
import { createMemoryAuthStore, hashPassword } from '../src/auth.js'
import { consoleResetMailer, createResetMailer, createSesResetMailer, noResetMailer, resetCodeText, type ResetCodeEmail, type ResetCodeMailer } from '../src/mail.js'
import type { User } from '../src/schemas.js'
import { createMemoryRepository } from '../src/store.js'

afterEach(() => vi.restoreAllMocks())

// An account created after the seed, so it can be emailed. Seeded demo accounts never are.
const ana: User = { id: 'USR-ANA', name: 'Ana Reyes', email: 'ana.reyes@example.com', roles: ['student'], program: 'BSIT', section: 'A', year: 3, studentId: '24-1234', restrictions: [], title: '', bio: '', education: '', officeHours: '', spaceIds: [], organizationIds: [], active: true }
const student = ana.id
const seeded = 'QCU-STU-IT-A'
const next = 'N3w!Passw0rdXyz'

/** An email channel that records what it would send, or fails when told to. */
function fakeEmail(fail = false) {
  const sent: ResetCodeEmail[] = []
  const mailer: ResetCodeMailer = {
    channel: 'email',
    async send(message) {
      if (fail) throw Object.assign(new Error('Email address is not verified'), { name: 'MessageRejected' })
      sent.push(message)
    },
  }
  return { mailer, sent }
}

async function appWith(resetMailer: ResetCodeMailer) {
  const authStore = createMemoryAuthStore()
  await authStore.update((data) => { data.users.push(ana); data.credentials[ana.id] = hashPassword('Str0ng!Passw0rd') })
  return { app: createApp(createMemoryRepository(), { authStore, resetMailer }), email: ana.email }
}

const forgot = (app: Awaited<ReturnType<typeof appWith>>['app'], emailOrId: string) => request(app).post('/api/auth/forgot-password').send({ emailOrId })

describe('reset code mailers', () => {
  it('sends a plain-text SES email from MAIL_FROM to the account holder', async () => {
    const commands: any[] = []
    const mailer = createSesResetMailer('no-reply@accs.example', { send: async (command: any) => { commands.push(command.input); return {} } } as never)
    await mailer.send({ userId: 'U1', to: 'mira@example.com', name: 'Mira <b>Solis</b>', code: '123456', expiresInMinutes: 15 })
    expect(commands).toHaveLength(1)
    const input = commands[0]
    expect(input.FromEmailAddress).toBe('no-reply@accs.example')
    expect(input.Destination).toEqual({ ToAddresses: ['mira@example.com'] })
    expect(input.Content.Simple.Subject.Data).toBe('Your ACCS password reset code')
    expect(input.Content.Simple.Body.Html).toBeUndefined()
    const text = input.Content.Simple.Body.Text.Data
    expect(text).toContain('123456')
    expect(text).toContain('15 minutes')
    expect(text).toBe(resetCodeText({ userId: 'U1', to: 'mira@example.com', name: 'Mira <b>Solis</b>', code: '123456', expiresInMinutes: 15 }))
  })

  it('lets an SES failure reach the caller', async () => {
    const mailer = createSesResetMailer('no-reply@accs.example', { send: async () => { throw new Error('throttled') } } as never)
    await expect(mailer.send({ userId: 'U1', to: 'a@example.com', name: 'A', code: '1', expiresInMinutes: 15 })).rejects.toThrow('throttled')
  })

  it('picks SES when MAIL_FROM is set, the console locally, and nothing in production', () => {
    expect(createResetMailer({ nodeEnv: 'production', mailFrom: 'no-reply@accs.example' }).channel).toBe('email')
    expect(createResetMailer({ nodeEnv: 'development', mailFrom: 'no-reply@accs.example' }).channel).toBe('email')
    expect(createResetMailer({ nodeEnv: 'development' })).toBe(consoleResetMailer)
    expect(createResetMailer({ nodeEnv: 'test' })).toBe(consoleResetMailer)
    expect(createResetMailer({ nodeEnv: 'production' })).toBe(noResetMailer)
  })
})

describe('forgot-password with an email channel', () => {
  it('emails the code to the account, never logs it, and the code resets the password', async () => {
    const { mailer, sent } = fakeEmail()
    const { app, email } = await appWith(mailer)
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})

    const response = await forgot(app, student)
    expect(response.status).toBe(200)
    expect(response.body.message).toMatch(/emailed/)
    expect(JSON.stringify(response.body)).not.toMatch(/\d{6}/)
    expect(sent).toHaveLength(1)
    expect(sent[0]).toMatchObject({ userId: student, to: email, expiresInMinutes: 15 })
    expect(sent[0]!.code).toMatch(/^\d{6}$/)
    expect(log.mock.calls.flat().join(' ')).not.toContain(sent[0]!.code)

    expect((await request(app).post('/api/auth/reset-password').send({ emailOrId: student, code: sent[0]!.code, password: next })).status).toBe(200)
    expect((await request(app).post('/api/auth/sign-in').send({ emailOrId: student, password: next })).status).toBe(200)
  })

  it('gives the same answer for an unknown account and sends nothing', async () => {
    const { mailer, sent } = fakeEmail()
    const { app } = await appWith(mailer)
    const known = await forgot(app, student)
    const unknown = await forgot(app, 'nobody@example.com')
    expect(unknown.status).toBe(200)
    expect(unknown.body).toEqual(known.body)
    expect(sent).toHaveLength(1)
  })

  it('never emails a seeded demo account, whose address may belong to someone real, and answers the same', async () => {
    const { mailer, sent } = fakeEmail()
    const { app } = await appWith(mailer)
    const expected = (await forgot(app, 'nobody@example.com')).body
    for (const id of [seeded, 'ACCS-ADMIN']) {
      const response = await forgot(app, id)
      expect(response.status).toBe(200)
      expect(response.body).toEqual(expected)
    }
    expect(sent).toHaveLength(0)
    // No code was issued, so a guess fails.
    expect((await request(app).post('/api/auth/reset-password').send({ emailOrId: 'ACCS-ADMIN', code: '123456', password: next })).status).toBe(400)
  })

  it('gives the same answer when delivery fails, and logs neither the code nor the address', async () => {
    const working = await appWith(fakeEmail().mailer)
    const expected = (await forgot(working.app, student)).body

    const { mailer } = fakeEmail(true)
    const { app, email } = await appWith(mailer)
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const response = await forgot(app, student)
    expect(response.status).toBe(200)
    expect(response.body).toEqual(expected)

    expect(error).toHaveBeenCalledTimes(1)
    const entry = JSON.parse(String(error.mock.calls[0]![0]))
    expect(entry).toEqual({ level: 'error', message: 'Reset code email not sent', userId: student, error: 'MessageRejected' })
    const everything = [...log.mock.calls, ...error.mock.calls].flat().join(' ')
    expect(everything).not.toMatch(/\d{6}/)
    expect(everything).not.toContain(email)
  })

  it('issues nothing in production without a channel, and points to an administrator', async () => {
    const { app } = await appWith(noResetMailer)
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    const response = await forgot(app, student)
    expect(response.status).toBe(200)
    expect(response.body.message).toMatch(/ask an ACCS administrator for a reset code/)
    expect(log).not.toHaveBeenCalled()
    // No code was issued, so any guess fails.
    expect((await request(app).post('/api/auth/reset-password').send({ emailOrId: student, code: '123456', password: next })).status).toBe(400)
  })
})
