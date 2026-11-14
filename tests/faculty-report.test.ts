// Decided 12 November 2026: a faculty member can report a student. The report starts with the student's Program Chair (the
// Dean when the Chair is the one reporting) and follows the usual case flow. The student is not told when it is filed, the
// offices see who reported, the student never does, and the categories are the concern categories.
import request from 'supertest'
import { beforeEach, describe, expect, it } from 'vitest'

import { createApp } from '../src/app.js'
import { createMemoryAuthStore } from '../src/auth.js'
import { type NewConcernEmail } from '../src/mail.js'
import { createMemoryRepository } from '../src/store.js'
import { seedPassword } from './helpers.js'

let repo: ReturnType<typeof createMemoryRepository>
let app: ReturnType<typeof createApp>
let sent: NewConcernEmail[]
beforeEach(() => {
  sent = []
  repo = createMemoryRepository()
  app = createApp(repo, { authStore: createMemoryAuthStore(), concernMailer: { channel: 'console', send: async (m) => { sent.push(m) } } })
})

async function login(id: string) {
  const agent = request.agent(app)
  expect((await agent.post('/api/auth/sign-in').send({ emailOrId: id, password: seedPassword })).status).toBe(200)
  return agent
}
type Agent = Awaited<ReturnType<typeof login>>
const incident = { studentId: 'QCU-STU-IT-A', narrative: 'Shouted at a classmate and pushed their bag off the table during lab.', category: 'Bullying', subcategory: 'Intimidation or threats', severity: 'medium', location: 'IC 301', occurredOn: '2026-11-10' }
const file = (agent: Agent, extra: object = {}) => agent.post('/api/pages/P21/actions').send({ action: 'reportStudent', payload: { ...incident, ...extra } })
const reportOf = (id: string) => repo.read().reports.find((r) => r.id === id)!

describe('a faculty member reports a student', () => {
  it('sends the report to the student\'s Program Chair, who sees who reported and whom', async () => {
    const professor = await login('QCU-PROF-IT')
    const filed = await file(professor)
    expect(filed.status, JSON.stringify(filed.body)).toBe(200)
    expect(filed.body.message).toBe(`Report sent to ${filed.body.record.office}.`)
    const id = filed.body.record.id as string
    expect(reportOf(id)).toMatchObject({ source: 'faculty', ownerId: 'QCU-PROF-IT', reportedStudentId: 'QCU-STU-IT-A', involvedUserIds: ['QCU-STU-IT-A'], stage: 'chair', program: 'BSIT', identity: 'named' })
    expect(reportOf(id).consent).toBeUndefined()
    const chair = await login('QCU-CHAIR-IT')
    const seen = (await chair.get(`/api/pages/P22?id=${id}`)).body.data.record
    expect(seen).toMatchObject({ source: 'faculty', narrative: incident.narrative, category: 'Bullying', reporter: expect.objectContaining({ id: 'QCU-PROF-IT' }), reportedStudent: expect.objectContaining({ id: 'QCU-STU-IT-A' }) })
    expect(seen.allowedActions).toContain('escalate')
    // The Chair is notified and emailed, like a new concern.
    expect(repo.read().notifications.some((n) => n.recipientId === 'QCU-CHAIR-IT' && n.recordId === id)).toBe(true)
    expect(sent.map((m) => m.userId)).toEqual(['QCU-CHAIR-IT'])
    expect(repo.read().audit.some((a) => a.action === 'Student reported by faculty' && a.reference === id)).toBe(true)
  })

  it('goes to the Dean when the Program Chair reports a student of their own program', async () => {
    const filed = await file(await login('QCU-CHAIR-IT'))
    expect(filed.status, JSON.stringify(filed.body)).toBe(200)
    expect(reportOf(filed.body.record.id).stage).toBe('dean')
    expect((await (await login('QCU-FAC-PAULA-DELACRUZ')).get(`/api/pages/P22?id=${filed.body.record.id}`)).body.data.record.allowedActions).toContain('transfer')
  })

  it('does not tell the student, who cannot see it anywhere', async () => {
    const id = (await file(await login('QCU-PROF-IT'))).body.record.id as string
    expect(repo.read().notifications.filter((n) => n.recipientId === 'QCU-STU-IT-A' && n.recordId === id)).toEqual([])
    const student = await login('QCU-STU-IT-A')
    expect(((await student.get('/api/pages/P18')).body.data.reports as { id: string }[]).map((r) => r.id)).not.toContain(id)
    expect((await student.get(`/api/pages/P20?id=${id}`)).status).toBe(404)
    expect((await student.get(`/api/pages/P22?id=${id}`)).status).toBe(403)
  })

  it('lets the reporter follow the status, but not the notes, and keeps others out', async () => {
    const professor = await login('QCU-PROF-IT')
    const id = (await file(professor)).body.record.id as string
    const chair = await login('QCU-CHAIR-IT')
    expect((await chair.post('/api/pages/P22/actions').send({ action: 'addNote', recordId: id, payload: { body: 'Spoke with the class adviser.' } })).status).toBe(200)
    expect((await chair.post('/api/pages/P22/actions').send({ action: 'caseAction', recordId: id, reason: 'Needs the Dean', payload: { type: 'escalate', update: 'Sent to the Dean.' } })).status).toBe(200)
    const own = (await professor.get(`/api/pages/P22?id=${id}`)).body.data.record
    expect(own).toMatchObject({ statusOnly: true, source: 'faculty', stage: 'dean', narrative: incident.narrative, reportedStudent: expect.objectContaining({ id: 'QCU-STU-IT-A' }) })
    expect(own.notes).toBeUndefined()
    expect(own.statusNotice).toMatch(/^You filed this report\./)
    expect(((await professor.get('/api/pages/P21')).body.data.cases as { id: string }[]).map((r) => r.id)).toContain(id)
    // The reporter cannot act on it, and is told when it moves.
    expect((await professor.post('/api/pages/P22/actions').send({ action: 'addNote', recordId: id, payload: { body: 'x' } })).status).toBe(404)
    expect(repo.read().notifications.some((n) => n.recipientId === 'QCU-PROF-IT' && n.recordId === id && n.kind === 'case' && n.pageId === 'P22')).toBe(true)
    // Another professor and another program's Chair see nothing.
    expect((await (await login('QCU-PROF-OTHER')).get(`/api/pages/P22?id=${id}`)).status).toBe(404)
    expect((await (await login('QCU-CHAIR-CS')).get(`/api/pages/P22?id=${id}`)).status).toBe(404)
  })

  it('can lead to a strike: the Dean recommends one against the reported student', async () => {
    const id = (await file(await login('QCU-PROF-IT'))).body.record.id as string
    await repo.transact((unit) => { unit.read().reports.find((r) => r.id === id)!.stage = 'dean' })
    const recommended = await (await login('QCU-FAC-PAULA-DELACRUZ')).post('/api/pages/P22/actions').send({ action: 'recommendStrike', payload: { studentId: 'QCU-STU-IT-A', reportId: id, note: 'Confirmed with witnesses.' } })
    expect(recommended.status, JSON.stringify(recommended.body)).toBe(200)
  })

  it('is open to faculty only, uses the concern categories, and needs an active student', async () => {
    for (const id of ['QCU-STU-IT-B', 'QCU-GUIDANCE', 'QCU-OSAS', 'ACCS-ADMIN']) expect([id, (await file(await login(id))).status]).toEqual([id, 403])
    const professor = await login('QCU-PROF-IT')
    expect((await file(professor, { category: 'Coffee' })).status).toBe(400)
    expect((await file(professor, { subcategory: 'Grades' })).status).toBe(400)
    expect((await file(professor, { category: 'Other (please specify)', subcategory: undefined })).status).toBe(400)
    expect((await file(professor, { studentId: 'QCU-PROF-OTHER' })).status).toBe(404)
    expect((await file(professor, { studentId: 'NOBODY' })).status).toBe(404)
    expect((await file(professor, { narrative: '  ' })).status).toBe(400)
    const page = (await professor.get('/api/pages/P21')).body.data
    expect(page.canReportStudent).toBe(true)
    expect(page.categoryOptions.map((c: { label: string }) => c.label)).toContain('Bullying')
    expect(page.reportableStudents.map((s: { id: string }) => s.id)).toEqual(expect.arrayContaining(['QCU-STU-IT-A', 'QCU-STU-RESTRICTED']))
    expect((await (await login('QCU-GUIDANCE')).get('/api/pages/P21')).body.data.canReportStudent).toBeUndefined()
  })
})
