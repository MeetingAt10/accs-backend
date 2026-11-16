// Decisions of 16 November 2026 answering the QA report of 15 November (QA_andrew_11_15): the Secretary posts, the
// Organization representative messages, anyone starts a group, every role keeps to-dos, case status says where a case
// is going, and one search covers what each person may open.
import request from 'supertest'
import { beforeEach, describe, expect, it } from 'vitest'

import { createApp } from '../src/app.js'
import { createMemoryAuthStore } from '../src/auth.js'
import { createMemoryRepository } from '../src/store.js'
import { seedPassword, secretarySession } from './helpers.js'

let repo: ReturnType<typeof createMemoryRepository>
let app: ReturnType<typeof createApp>
beforeEach(() => { repo = createMemoryRepository(); app = createApp(repo, { authStore: createMemoryAuthStore() }) })

async function login(id: string) {
  const agent = request.agent(app)
  expect((await agent.post('/api/auth/sign-in').send({ emailOrId: id, password: seedPassword })).status).toBe(200)
  return agent
}
type Agent = Awaited<ReturnType<typeof login>>
const dean = 'QCU-FAC-PAULA-DELACRUZ'

describe('the Secretary in the forum', () => {
  it('posts a discussion and an announcement to the college, and not to a class', async () => {
    const secretary = await secretarySession(app)
    const post = (payload: object) => secretary.post('/api/pages/P05/actions').send({ action: 'createPost', payload: { title: 'Enrollment reminder', body: 'Bring your registration form.', audience: 'college', ...payload } })
    expect((await post({ kind: 'discussion', label: 'Discussion' })).status).toBe(200)
    const announced = await post({ kind: 'announcement', priority: 'important' })
    expect(announced.status, JSON.stringify(announced.body)).toBe(200)
    expect((await post({ kind: 'discussion', label: 'Discussion', audience: 'space:SUBJECT-IT-DS' })).status).toBe(403)
  })
})

describe('the Organization representative in Messages', () => {
  it('messages anyone, and the person can answer', async () => {
    const org = await login('QCU-ORG')
    const started = await org.post('/api/pages/P11/actions').send({ action: 'createThread', payload: { recipientId: 'QCU-PROF-CS', body: 'Can you judge our hackathon?' } })
    expect(started.status, JSON.stringify(started.body)).toBe(200)
    const professor = await login('QCU-PROF-CS')
    expect((await professor.post('/api/pages/P12/actions').send({ action: 'sendMessage', recordId: started.body.record.id, payload: { body: 'Yes, happy to.' } })).status).toBe(200)
  })
})

describe('group conversations', () => {
  const start = (agent: Agent, payload: object) => agent.post('/api/pages/P11/actions').send({ action: 'createGroupThread', payload: { title: 'Capstone team', body: 'Hello team', ...payload } })

  it('lets anyone start a named group with people they can message; members see it, others do not', async () => {
    const professor = await login('QCU-PROF-IT')
    const started = await start(professor, { memberIds: ['QCU-STU-IT-A', 'QCU-STU-RESTRICTED'] })
    expect(started.status, JSON.stringify(started.body)).toBe(200)
    const id = started.body.record.id as string
    const student = await login('QCU-STU-IT-A')
    const page = (await student.get(`/api/pages/P12?id=${id}`)).body.data
    expect(page.record).toMatchObject({ title: 'Capstone team', kind: 'group', groupKind: 'people' })
    expect(page.record.members.map((m: { id: string }) => m.id).sort()).toEqual(['QCU-PROF-IT', 'QCU-STU-IT-A', 'QCU-STU-RESTRICTED'])
    expect((await student.post('/api/pages/P12/actions').send({ action: 'sendMessage', recordId: id, payload: { body: 'Hi!' } })).status).toBe(200)
    // Each member was told, naming the group.
    const notice = await repo.transact((unit) => unit.read().notifications.find((n) => n.recipientId === 'QCU-STU-RESTRICTED' && n.recordId === id))
    expect(notice?.body).toBe('Demo Professor Charlie in Capstone team: Hello team')
    // Not a member: nothing.
    expect((await (await login('QCU-STU-CS')).get(`/api/pages/P12?id=${id}`)).status).toBe(404)
  })

  it('needs a name and two other people, and only people the starter can message', async () => {
    const student = await login('QCU-STU-IT-A')
    expect((await start(student, { title: '', memberIds: ['QCU-STU-IT-B', 'QCU-PROF-IT'] })).status).toBe(400)
    expect((await start(student, { memberIds: ['QCU-STU-IT-B'] })).status).toBe(400)
    // A BSCS student shares no class with this BSIT student.
    expect((await start(student, { memberIds: ['QCU-STU-IT-B', 'QCU-STU-CS'] })).status).toBe(404)
  })

  it('does not turn a direct message into the group the two people share', async () => {
    const professor = await login('QCU-PROF-IT')
    const group = (await start(professor, { memberIds: ['QCU-STU-IT-A', 'QCU-STU-RESTRICTED'] })).body.record.id as string
    const direct = await professor.post('/api/pages/P11/actions').send({ action: 'createThread', payload: { recipientId: 'QCU-STU-RESTRICTED', body: 'Just you' } })
    expect(direct.body.record.id).not.toBe(group)
  })
})

describe('to-dos for every role', () => {
  it('lets a professor and the Dean keep to-dos', async () => {
    for (const id of ['QCU-PROF-IT', dean]) {
      const agent = await login(id)
      expect((await agent.post('/api/pages/P13/actions').send({ action: 'createTodo', payload: { title: 'Prepare slides', date: '2026-10-25' } })).status, id).toBe(200)
    }
  })
})

describe('case status', () => {
  it('says where a case is escalated to, and "Case File at Guidance" once a case file is open', async () => {
    const student = await login('QCU-STU-IT-A')
    const reports = (await student.get('/api/pages/P18')).body.data.reports as { id: string; stage: string; status: string }[]
    for (const report of reports) {
      expect(report.status).not.toMatch(/^With /)
      if (!['Resolved', 'Closed', 'Draft', 'Case File at Guidance'].includes(report.status)) expect(report.status).toMatch(/^Escalated to /)
    }
    const filed = await repo.transact((unit) => unit.read().reports.find((r) => r.stage === 'guidance' && r.caseFileId))
    if (filed) {
      const guidance = await login('QCU-GUIDANCE')
      expect((await guidance.get(`/api/pages/P22?id=${filed.id}`)).body.data.record.status).toBe('Case File at Guidance')
    }
  })
})

describe('top search', () => {
  it('finds posts, spaces and people a student may open, and no records', async () => {
    const student = await login('QCU-STU-IT-A')
    const found = (await student.get('/api/search').query({ q: 'data' })).body
    expect(found.groups.posts.some((p: { title: string }) => p.title === 'Data Structures practice set')).toBe(true)
    expect(found.groups.spaces.map((s: { title: string }) => s.title)).toContain('SBIT3A - CC 104 Data Structures')
    expect(found.groups.records).toEqual([])
    expect((await student.get('/api/search').query({ q: 'Charlie' })).body.groups.people.map((p: { id: string }) => p.id)).toContain('QCU-PROF-IT')
  })

  it('finds cases by reference for a handler, and student records only where the role may open them', async () => {
    const theDean = await login(dean)
    const anyCase = (await theDean.get('/api/pages/P21')).body.data.cases[0] as { id: string }
    const byRef = (await theDean.get('/api/search').query({ q: anyCase.id })).body.groups.cases as { id: string; href: string }[]
    expect(byRef.map((c) => c.id)).toContain(anyCase.id)
    expect(byRef[0]!.href).toBe(`/cases/${anyCase.id}`)
    const records = (await theDean.get('/api/search').query({ q: 'Foxtrot' })).body.groups.records as { href: string }[]
    expect(records[0]?.href).toMatch(/^\/records\?q=/)
  })

  it('never searches what a report says, and asks for two letters', async () => {
    const student = await login('QCU-STU-IT-A')
    const narrative = await repo.transact((unit) => unit.read().reports.find((r) => r.ownerId === 'QCU-STU-IT-A')!.narrative)
    const word = narrative.split(/\s+/).find((w) => w.length > 6)!
    expect((await student.get('/api/search').query({ q: word })).body.groups.cases).toEqual([])
    expect((await student.get('/api/search').query({ q: 'a' })).status).toBe(400)
  })
})
