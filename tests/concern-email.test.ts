// Issue #37: when a student files a concern, the office receiving it (the adviser, or the Program Chair for a concern
// that goes around the adviser) also gets an email that a concern arrived, with a link and no details of the concern.
// A conflicted adviser is never emailed, and a failed email never blocks filing.
import request from 'supertest'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { createApp } from '../src/app.js'
import { createMemoryAuthStore } from '../src/auth.js'
import { createNewConcernMailer, createSesNewConcernMailer, newConcernText, type MailChannel, type NewConcernEmail, type NewConcernMailer } from '../src/mail.js'
import { createMemoryRepository } from '../src/store.js'
import { concernChoices, seedPassword } from './helpers.js'

let repo: ReturnType<typeof createMemoryRepository>
let app: ReturnType<typeof createApp>
let sent: NewConcernEmail[]
function recordingMailer(channel: MailChannel = 'console', fail = false): NewConcernMailer {
  return { channel, async send(message) { if (fail) throw new Error('SES refused'); sent.push(message) } }
}
function start(mailer: NewConcernMailer) {
  repo = createMemoryRepository()
  app = createApp(repo, { authStore: createMemoryAuthStore(), concernMailer: mailer })
}
beforeEach(() => { sent = []; start(recordingMailer()) })
afterEach(() => { vi.restoreAllMocks() })

async function login(id: string) {
  const agent = request.agent(app)
  expect((await agent.post('/api/auth/sign-in').send({ emailOrId: id, password: seedPassword })).status).toBe(200)
  return agent
}
const statement = { narrative: 'A classmate keeps posting edited photos of me in our section chat.', category: 'Cyberbullying', subcategory: 'Posting photos or videos without consent', severity: 'high', identity: 'named' }
const file = async (extra: object = {}, student = 'QCU-STU-IT-A') => {
  const response = await (await login(student)).post('/api/pages/P19/actions').send({ action: 'createReport', payload: { ...statement, ...concernChoices, ...extra } })
  expect(response.status, response.body.error).toBe(200)
  return response
}
const email = (id: string) => repo.read().users.find((u) => u.id === id)!.email

describe('the new-concern email', () => {
  it('goes to the adviser once the concern is filed, with a link to the case', async () => {
    const filed = await file()
    const id = filed.body.record.id as string
    expect(sent).toEqual([{ userId: 'QCU-PROF-IT', to: email('QCU-PROF-IT'), name: expect.any(String), link: `http://localhost:5173/cases/${id}` }])
    // The in-app notification is still sent.
    expect(repo.read().notifications.some((n) => n.recipientId === 'QCU-PROF-IT' && n.recordId === id)).toBe(true)
  })

  it('carries no details of the concern', async () => {
    const filed = await file()
    const text = newConcernText(sent[0]!)
    const reporter = repo.read().users.find((u) => u.id === 'QCU-STU-IT-A')!
    for (const detail of [statement.narrative, statement.category, statement.subcategory, reporter.name, reporter.studentId!, filed.body.record.alias, 'high']) expect(text, detail).not.toContain(detail)
    expect(text).toContain('A new concern has been sent to you in ACCS.')
    expect(text).toContain(sent[0]!.link)
  })

  it('goes to the Program Chair, not the adviser, for a concern about the adviser', async () => {
    await file({ aboutAdvisor: true })
    expect(sent.map((m) => m.userId)).toEqual(['QCU-CHAIR-IT'])
  })

  it('never goes to an adviser the concern names', async () => {
    const adviser = repo.read().users.find((u) => u.id === 'QCU-PROF-IT')!
    await file({ narrative: `Si ${adviser.name} laging absent sa class namin.` })
    expect(sent.map((m) => m.userId)).toEqual(['QCU-CHAIR-IT'])
    sent = []
    await file({ involvedUserIds: ['QCU-PROF-IT'] })
    expect(sent.map((m) => m.userId)).not.toContain('QCU-PROF-IT')
  })

  it('does not block filing when the email fails, and logs the failure without the address', async () => {
    start(recordingMailer('email', true))
    // Seeded accounts are never emailed on the email channel, so the student gets an adviser who is not one.
    await repo.transact((unit) => {
      const db = unit.read()
      const seeded = db.users.find((u) => u.id === 'QCU-PROF-IT')!
      db.users.push({ ...seeded, id: 'CCS-PROF-REAL', email: 'real.adviser@example.edu', name: 'Real Adviser' })
      db.users.find((u) => u.id === 'QCU-STU-IT-A')!.adviserId = 'CCS-PROF-REAL'
    })
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
    const filed = await file()
    expect(repo.read().reports.some((r) => r.id === filed.body.record.id)).toBe(true)
    const logged = errors.mock.calls.map((call) => String(call[0])).find((line) => line.includes('New concern email not sent'))!
    expect(JSON.parse(logged)).toMatchObject({ level: 'error', userId: 'CCS-PROF-REAL', reportId: filed.body.record.id, error: 'Error' })
    expect(logged).not.toContain('real.adviser@example.edu')
  })

  it('emails real accounts but never the seeded demo accounts on the email channel', async () => {
    start(recordingMailer('email'))
    await file()
    expect(sent).toEqual([])
    await repo.transact((unit) => {
      const db = unit.read()
      db.users.push({ ...db.users.find((u) => u.id === 'QCU-PROF-IT')!, id: 'CCS-PROF-REAL', email: 'real.adviser@example.edu' })
      db.users.find((u) => u.id === 'QCU-STU-IT-A')!.adviserId = 'CCS-PROF-REAL'
    })
    await file()
    expect(sent.map((m) => [m.userId, m.to])).toEqual([['CCS-PROF-REAL', 'real.adviser@example.edu']])
  })

  it('sends nothing on the "none" channel, and never puts an address in the response', async () => {
    start(recordingMailer('none'))
    const filed = await file()
    expect(sent).toEqual([])
    expect(JSON.stringify(filed.body)).not.toContain(email('QCU-PROF-IT'))
    expect(filed.body.outbox).toBeUndefined()
  })

  it('is sent only when a concern is filed, not for other case actions', async () => {
    const id = (await file()).body.record.id as string
    sent = []
    const adviser = await login('QCU-PROF-IT')
    expect((await adviser.post('/api/pages/P22/actions').send({ action: 'addNote', recordId: id, payload: { body: 'Called the student.' } })).status).toBe(200)
    expect(sent).toEqual([])
  })
})

describe('the mail channels', () => {
  it('sends plain text through SES from MAIL_FROM', async () => {
    const commands: unknown[] = []
    const mailer = createSesNewConcernMailer('accs@example.edu', { send: async (command: unknown) => { commands.push(command); return {} } } as never)
    const message = { userId: 'CCS-PROF-REAL', to: 'real.adviser@example.edu', name: 'Real Adviser', link: 'https://accs.example.edu/cases/RPT-0300' }
    await mailer.send(message)
    expect((commands[0] as { input: unknown }).input).toEqual({
      FromEmailAddress: 'accs@example.edu',
      Destination: { ToAddresses: ['real.adviser@example.edu'] },
      Content: { Simple: { Subject: { Data: 'New concern in ACCS', Charset: 'UTF-8' }, Body: { Text: { Data: newConcernText(message), Charset: 'UTF-8' } } } },
    })
  })

  it('uses SES with MAIL_FROM, a log line on local runs, and nothing in production without it', () => {
    expect(createNewConcernMailer({ nodeEnv: 'production', mailFrom: 'accs@example.edu' }).channel).toBe('email')
    expect(createNewConcernMailer({ nodeEnv: 'development' }).channel).toBe('console')
    expect(createNewConcernMailer({ nodeEnv: 'production' }).channel).toBe('none')
  })
})
