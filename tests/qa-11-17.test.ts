// Fixes and decisions from the QA of 17 November 2026 (QA_andrew_11_17 and testing_v2), decided 19 November 2026.
import request from 'supertest'
import { beforeEach, describe, expect, it } from 'vitest'

import { createApp } from '../src/app.js'
import { rolesProblem } from '../src/services.js'
import { createMemoryRepository } from '../src/store.js'
import { seedPassword, setUpAuthStore } from './helpers.js'

let repo: ReturnType<typeof createMemoryRepository>
let app: ReturnType<typeof createApp>
beforeEach(() => { repo = createMemoryRepository(); app = createApp(repo, { authStore: setUpAuthStore() }) })

async function login(id: string) {
  const agent = request.agent(app)
  expect((await agent.post('/api/auth/sign-in').send({ emailOrId: id, password: seedPassword })).status).toBe(200)
  return agent
}
type Agent = Awaited<ReturnType<typeof login>>
const setRoles = (admin: Agent, id: string, payload: object) => admin.post('/api/pages/P47/actions').send({ action: 'updateRoles', recordId: id, reason: 'QA check', payload })
const rolesOf = (id: string) => repo.read().users.find((u) => u.id === id)!.roles

describe('which roles one account may hold', () => {
  it('keeps a student a student: no administrator, professor or Dean on top (QA: all roles could be ticked and saved)', async () => {
    const admin = await login('ACCS-ADMIN')
    for (const roles of [['student', 'administrator'], ['student', 'professor', 'dean'], ['student', 'secretary']]) {
      const response = await setRoles(admin, 'QCU-STU-IT-A', { roles })
      expect([roles.join('+'), response.status, response.body.code]).toEqual([roles.join('+'), 400, 'VALIDATION_ERROR'])
      expect(response.body.error).toMatch(/student role only/)
    }
    expect(rolesOf('QCU-STU-IT-A')).toEqual(['student'])
  })

  it('gives faculty at most two roles, like Dean and professor', async () => {
    const admin = await login('ACCS-ADMIN')
    expect((await setRoles(admin, 'QCU-PROF-IT', { roles: ['professor', 'chair', 'dean'], program: 'BSIT' })).status).toBe(400)
    expect((await setRoles(admin, 'QCU-PROF-IT', { roles: ['professor', 'chair'], program: 'BSIT' })).status).toBe(200)
    expect(rolesOf('QCU-PROF-IT')).toEqual(['professor', 'chair'])
  })

  it('gives a section to students only, and only as letters (QA: section 200 was accepted)', async () => {
    const admin = await login('ACCS-ADMIN')
    expect((await setRoles(admin, 'QCU-PROF-IT', { roles: ['professor'], section: 'A' })).body.error).toBe('Only students have a section.')
    expect((await setRoles(admin, 'QCU-STU-IT-A', { roles: ['student'], section: '200' })).body.error).toBe('Use the section letter, like A.')
    expect((await setRoles(admin, 'QCU-STU-IT-A', { roles: ['student'], section: 'c' })).status).toBe(200)
    expect(repo.read().users.find((u) => u.id === 'QCU-STU-IT-A')!.section).toBe('C')
  })

  it('answers each problem in words', () => {
    expect(rolesProblem(['professor', 'professor'])).toBe('Choose each role once.')
    expect(rolesProblem(['organization', 'student'])).toMatch(/student role only/)
    expect(rolesProblem(['organization', 'professor'])).toBe('An organization account has the organization role only.')
    expect(rolesProblem(['dean', 'professor'])).toBeUndefined()
    expect(rolesProblem(['student'], 'AB')).toBeUndefined()
  })
})

describe('the student report progress (decided 19 November 2026)', () => {
  const statement = { narrative: 'Someone took my laptop charger from the lab.', category: 'General concern', severity: 'medium', identity: 'named' }
  const progress = async (student: Agent, id: string) => (await student.get(`/api/pages/P20?id=${id}`)).body.data.record.progress

  it('moves Submitted, Read, Escalated, Resolved, Closed', async () => {
    const { concernChoices } = await import('./helpers.js')
    const [student, adviser, chair, dean] = await Promise.all(['QCU-STU-CS', 'QCU-PROF-CS', 'QCU-CHAIR-CS', 'QCU-FAC-PAULA-DELACRUZ'].map(login))
    const id = (await student!.post('/api/pages/P19/actions').send({ action: 'createReport', payload: { ...statement, ...concernChoices } })).body.record.id as string
    expect(await progress(student!, id)).toMatchObject({ steps: ['Submitted', 'Read', 'Escalated', 'Resolved', 'Closed'], step: 0, label: 'Submitted' })
    // The Dean can look at it, but is not handling it, so it is not Read yet.
    await dean!.get(`/api/pages/P22?id=${id}`)
    expect((await progress(student!, id)).step).toBe(0)
    expect((await adviser!.get(`/api/pages/P22?id=${id}`)).status).toBe(200)
    expect(await progress(student!, id)).toMatchObject({ step: 1, label: 'Read', readAt: expect.any(String) })
    const act = (agent: Agent, type: string) => agent.post('/api/pages/P22/actions').send({ action: 'caseAction', recordId: id, reason: 'Next step', payload: { type, update: 'An update.' } })
    expect((await act(adviser!, 'escalate')).status).toBe(200)
    expect(await progress(student!, id)).toMatchObject({ step: 2, label: 'Escalated', escalatedTo: 'Program Chair' })
    expect((await act(chair!, 'resolve')).status).toBe(200)
    expect((await progress(student!, id)).label).toBe('Resolved')
    expect((await act(chair!, 'close')).status).toBe(200)
    expect((await progress(student!, id)).label).toBe('Closed')
  })
})

describe('the CCS Secretary calendar (decided 19 November 2026)', () => {
  it('opens the calendar and keeps to-dos', async () => {
    const { secretarySession } = await import('./helpers.js')
    const secretary = await secretarySession(app)
    expect((await secretary.get('/api/session')).body.allowedPages).toContain('P13')
    expect((await secretary.get('/api/pages/P13')).status).toBe(200)
    const due = new Date(Date.now() + 3 * 86_400_000).toISOString().slice(0, 10)
    const saved = await secretary.post('/api/pages/P13/actions').send({ action: 'createTodo', payload: { title: 'Prepare enrollment list', date: due } })
    expect(saved.status, JSON.stringify(saved.body)).toBe(200)
  })
})

describe('restriction end dates (decided 19 November 2026)', () => {
  it('needs tomorrow or later, not today', async () => {
    const admin = await login('ACCS-ADMIN')
    const day = (offset: number) => new Date(Date.now() + 8 * 3_600_000 + offset * 86_400_000).toISOString().slice(0, 10)
    const apply = (until: string) => admin.post('/api/pages/P35/actions').send({ action: 'applyRestriction', reason: 'r', payload: { studentId: 'QCU-STU-IT-A', features: ['post.create'], until, basis: 'b', decisionReference: 'd' } })
    expect((await apply(day(0))).body.error).toBe('Choose tomorrow or a later end date.')
    expect((await apply(day(1))).status).toBe(200)
  })
})

describe('to-do due dates (QA 17 November)', () => {
  it('refuses a past date', async () => {
    const student = await login('QCU-STU-IT-A')
    const day = (offset: number) => new Date(Date.now() + 8 * 3_600_000 + offset * 86_400_000).toISOString().slice(0, 10)
    const add = (date: string) => student.post('/api/pages/P13/actions').send({ action: 'createTodo', payload: { title: 'Finish lab report', date } })
    expect((await add(day(-1))).status).toBe(400)
    expect((await add(day(0))).status).toBe(200)
  })
})

describe('editing and deleting a sent message (decided 19 November 2026)', () => {
  const thread = 'THREAD-IT-A'
  const conversation = async (agent: Agent) => (await agent.get(`/api/pages/P12?id=${thread}`)).body.data.record.messages as { id: string; body: string; editedAt?: string; deleted?: boolean }[]

  it('lets the author edit, marks it edited, and lets no one else change it', async () => {
    const [prof, student] = await Promise.all(['QCU-PROF-IT', 'QCU-STU-IT-A'].map(login))
    const edited = await prof!.post('/api/pages/P12/actions').send({ action: 'editMessage', recordId: thread, payload: { messageId: 'MESSAGE-0101', body: 'Use this group for room changes only.' } })
    expect(edited.status, JSON.stringify(edited.body)).toBe(200)
    expect((await conversation(student!)).find((m) => m.id === 'MESSAGE-0101')).toMatchObject({ body: 'Use this group for room changes only.', editedAt: expect.any(String) })
    expect((await student!.post('/api/pages/P12/actions').send({ action: 'editMessage', recordId: thread, payload: { messageId: 'MESSAGE-0101', body: 'Changed by someone else' } })).status).toBe(403)
    expect((await student!.post('/api/pages/P12/actions').send({ action: 'deleteMessage', recordId: thread, payload: { messageId: 'MESSAGE-0101' } })).status).toBe(403)
  })

  it('deletes for everyone, leaving "Message deleted" in the inbox and nothing of the words', async () => {
    const [prof, student] = await Promise.all(['QCU-PROF-IT', 'QCU-STU-IT-A'].map(login))
    expect((await prof!.post('/api/pages/P12/actions').send({ action: 'deleteMessage', recordId: thread, payload: { messageId: 'MESSAGE-0101' } })).status).toBe(200)
    const gone = (await conversation(student!)).find((m) => m.id === 'MESSAGE-0101')!
    expect(gone).toMatchObject({ deleted: true, body: '' })
    const inbox = (await student!.get('/api/pages/P11')).body.data.threads as { id: string; lastMessage: string }[]
    expect(inbox.find((t) => t.id === thread)!.lastMessage).toBe('Message deleted')
    expect((await prof!.post('/api/pages/P12/actions').send({ action: 'editMessage', recordId: thread, payload: { messageId: 'MESSAGE-0101', body: 'Back again' } })).status).toBe(409)
  })
})
