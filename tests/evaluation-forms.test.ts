// 360-degree evaluation (paper, Chapter 1 Scope item 5). Every cycle carries the student form: each student evaluates every
// professor of their class spaces. The Dean may add the peer form and the upward forms (Program Chair, Dean). Issue #47 had
// limited cycles to the student form; peer and upward forms were restored on 2026-11-24.
import request from 'supertest'
import { beforeEach, describe, expect, it } from 'vitest'

import { createApp } from '../src/app.js'
import { createMemoryRepository } from '../src/store.js'
import { seedPassword, setUpAuthStore, reviewAll } from './helpers.js'

let repo: ReturnType<typeof createMemoryRepository>
let app: ReturnType<typeof createApp>
beforeEach(() => { repo = createMemoryRepository(); app = createApp(repo, { authStore: setUpAuthStore() }) })

async function login(id: string) {
  const agent = request.agent(app)
  expect((await agent.post('/api/auth/sign-in').send({ emailOrId: id, password: seedPassword })).status).toBe(200)
  return agent
}
type Agent = Awaited<ReturnType<typeof login>>
const dates = { opens: '2027-01-01', closes: '2027-03-01' }
const cycleBody = { title: 'Student form cycle', instructions: 'Answer honestly.', ...dates, questions: [{ id: 'Q1', criterion: 'Teaching', text: 'Is the class clear?', type: 'rating', required: true }] }
async function draft(dean: Agent) {
  const created = await dean.post('/api/pages/P30/actions').send({ action: 'createCycle', payload: { title: 'Student form cycle', term: 'Term', ...dates } })
  expect(created.status).toBe(200)
  return created.body.record as { id: string; forms: string[] }
}
const save = (dean: Agent, id: string, extra: object = {}) => dean.post('/api/pages/P31/actions').send({ action: 'saveCycle', recordId: id, payload: { ...cycleBody, ...extra } })
const move = (dean: Agent, id: string, status: string) => dean.post('/api/pages/P31/actions').send({ action: 'cycleAction', recordId: id, payload: { status } })

describe('evaluation cycles: student form plus optional peer and upward forms', () => {
  it('always keeps the student form, and accepts the peer and upward forms', async () => {
    const dean = await login('QCU-FAC-PAULA-DELACRUZ')
    const cycle = await draft(dean)
    expect(cycle.forms).toEqual(['student'])
    for (const forms of [[], ['other']]) expect((await save(dean, cycle.id, { forms })).status).toBe(400)
    expect((await save(dean, cycle.id, { forms: ['peer'] })).body.record.forms).toEqual(['student', 'peer'])
    expect((await save(dean, cycle.id, { forms: ['student', 'upward-chair', 'upward-dean'] })).body.record.forms).toEqual(['student', 'upward-chair', 'upward-dean'])
    // The form list may be left out; the cycle keeps the forms it has.
    expect((await save(dean, cycle.id)).body.record.forms).toEqual(['student', 'upward-chair', 'upward-dean'])
  })

  it('assigns each student every professor of their class spaces, and nothing to faculty', async () => {
    const dean = await login('QCU-FAC-PAULA-DELACRUZ')
    const { id } = await draft(dean)
    await save(dean, id)
    expect((await move(dean, id, 'In review')).status).toBe(200)
    const db = repo.read()
    const generated = db.assignments.filter((a) => a.cycleId === id)
    expect(generated.length).toBeGreaterThan(0)
    expect(new Set(generated.map((a) => a.relation))).toEqual(new Set(['Student to faculty']))
    for (const a of generated) expect(db.users.find((u) => u.id === a.evaluatorId)!.roles, a.evaluatorId).toContain('student')
    const expected = db.users.filter((u) => u.roles.includes('student')).flatMap((s) => [...new Set(db.spaces.filter((sp) => sp.studentIds.includes(s.id)).flatMap((sp) => sp.professorIds))].map((f) => `${s.id}>${f}`)).sort()
    expect(generated.map((a) => `${a.evaluatorId}>${a.facultyId}`).sort()).toEqual(expected)
    // Publishing does not add anything new or duplicate anything.
    reviewAll(repo, id)
    expect((await move(dean, id, 'Published')).status).toBe(200)
    expect(repo.read().assignments.filter((a) => a.cycleId === id)).toHaveLength(generated.length)
  })

  it('assigns professors a peer in their program and their Program Chair and Dean when those forms are on', async () => {
    const dean = await login('QCU-FAC-PAULA-DELACRUZ')
    const { id } = await draft(dean)
    expect((await save(dean, id, { forms: ['student', 'peer', 'upward-chair', 'upward-dean'] })).status).toBe(200)
    expect((await move(dean, id, 'In review')).status).toBe(200)
    const db = repo.read()
    const generated = db.assignments.filter((a) => a.cycleId === id)
    expect(new Set(generated.map((a) => a.relation))).toEqual(new Set(['Student to faculty', 'Peer', 'Upward: Program Chair', 'Upward: Dean']))
    const mine = generated.filter((a) => a.evaluatorId === 'QCU-PROF-IT')
    expect(mine.filter((a) => a.relation === 'Peer').map((a) => a.facultyId)).toContain('QCU-PROF-OTHER')
    expect(mine.find((a) => a.relation === 'Upward: Program Chair')!.facultyId).toBe('QCU-CHAIR-IT')
    for (const a of generated.filter((x) => x.relation === 'Peer')) {
      const [from, to] = [db.users.find((u) => u.id === a.evaluatorId)!, db.users.find((u) => u.id === a.facultyId)!]
      expect([from.program, from.id !== to.id]).toEqual([to.program, true])
    }
  })

  it('lists and accepts a peer or upward form of the cycle, and refuses a form the cycle does not carry', async () => {
    const professor = await login('QCU-PROF-IT')
    const listed = (await professor.get('/api/pages/P26')).body.data.assignments.map((a: { id: string }) => a.id)
    expect(listed).toEqual(expect.arrayContaining(['EVAL-PEER-1', 'EVAL-UPWARD-1', 'EVAL-UPWARD-2']))
    const answers = { answers: { Q1: 4, Q2: 4, Q3: 4 } }
    expect((await professor.post('/api/pages/P27/actions').send({ action: 'submitEvaluation', recordId: 'EVAL-PEER-1', payload: answers })).status).toBe(200)

    await repo.transact((unit) => { unit.read().cycles[0]!.forms = ['student', 'peer'] })
    expect((await professor.get('/api/pages/P26')).body.data.assignments.map((a: { id: string }) => a.id)).not.toContain('EVAL-UPWARD-1')
    const refused = await professor.post('/api/pages/P27/actions').send({ action: 'submitEvaluation', recordId: 'EVAL-UPWARD-1', payload: answers })
    expect([refused.status, refused.body.error]).toEqual([409, 'This form is not part of this evaluation cycle.'])
  })

  it('still lets a student fill the student form', async () => {
    const student = await login('QCU-STU-IT-A')
    expect((await student.get('/api/pages/P26')).body.data.assignments.map((a: { id: string }) => a.id)).toContain('EVAL-STU-IT-1')
    expect((await student.post('/api/pages/P27/actions').send({ action: 'submitEvaluation', recordId: 'EVAL-STU-IT-1', payload: { answers: { Q1: 4, Q2: 5, Q3: 4 } } })).status).toBe(200)
  })

  it('has peer and upward forms in the sample data', () => {
    const db = repo.read()
    expect(db.cycles.find((c) => c.id === 'CYCLE-2026-1')!.forms).toEqual(['student', 'peer', 'upward-chair', 'upward-dean'])
    expect(db.assignments.filter((a) => a.relation !== 'Student to faculty' && !a.submittedAt).map((a) => a.id).sort()).toEqual(['EVAL-PEER-1', 'EVAL-UPWARD-1', 'EVAL-UPWARD-2'])
  })
})
