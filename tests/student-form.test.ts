// Issue #47: evaluation cycles use the student form only (baseline chapter 9.1). Each student evaluates every professor of
// their class spaces. Cycles stored with peer or upward forms still load and keep their submitted results, but those
// forms are no longer generated, listed as to do, or accepted.
import request from 'supertest'
import { beforeEach, describe, expect, it } from 'vitest'

import { createApp } from '../src/app.js'
import { createMemoryAuthStore } from '../src/auth.js'
import { createMemoryRepository } from '../src/store.js'
import { seedPassword } from './helpers.js'

let repo: ReturnType<typeof createMemoryRepository>
let app: ReturnType<typeof createApp>
beforeEach(() => { repo = createMemoryRepository(); app = createApp(repo, { authStore: createMemoryAuthStore() }) })

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

describe('evaluation cycles use the student form only', () => {
  it('creates and saves cycles with the student form, and refuses any other form', async () => {
    const dean = await login('QCU-FAC-PAULA-DELACRUZ')
    const cycle = await draft(dean)
    expect(cycle.forms).toEqual(['student'])
    for (const forms of [['peer'], ['student', 'peer'], ['upward-chair'], ['upward-dean'], []]) {
      const refused = await save(dean, cycle.id, { forms })
      expect([JSON.stringify(forms), refused.status]).toEqual([JSON.stringify(forms), 400])
    }
    expect((await save(dean, cycle.id, { forms: ['peer'] })).body.fields?.[0]).toMatchObject({ message: 'Evaluation cycles use the student form only.' })
    // The form list may be left out; the cycle keeps the student form.
    expect((await save(dean, cycle.id)).body.record.forms).toEqual(['student'])
    expect((await save(dean, cycle.id, { forms: ['student'] })).body.record.forms).toEqual(['student'])
  })

  it('turns a stored draft with old forms into a student-form cycle when it is saved', async () => {
    await repo.transact((unit) => { unit.read().cycles.find((c) => c.id === 'CYCLE-2026-2')!.forms = ['student', 'peer'] })
    const saved = await save(await login('QCU-FAC-PAULA-DELACRUZ'), 'CYCLE-2026-2')
    expect([saved.status, saved.body.record.forms]).toEqual([200, ['student']])
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
    expect((await move(dean, id, 'Published')).status).toBe(200)
    expect(repo.read().assignments.filter((a) => a.cycleId === id)).toHaveLength(generated.length)
  })

  it('keeps a stored cycle with old forms, and its submitted peer answers in the results', async () => {
    await repo.transact((unit) => {
      const db = unit.read()
      db.cycles[0]!.forms = ['student', 'peer', 'upward-chair']
      db.assignments.push(
        { id: 'EVAL-OLD-PEER', evaluatorId: 'QCU-PROF-OTHER', facultyId: 'QCU-PROF-IT', cycleId: 'CYCLE-2026-1', relation: 'Peer', subject: 'Faculty peer review', submittedAt: '2026-10-20T08:00:00.000Z', answers: { Q1: 1, Q2: 1, Q3: 1 } },
        { id: 'EVAL-OLD-UPWARD', evaluatorId: 'QCU-PROF-IT', facultyId: 'QCU-CHAIR-IT', cycleId: 'CYCLE-2026-1', relation: 'Upward: Program Chair', subject: 'Program leadership' },
      )
    })
    const professor = await login('QCU-PROF-IT')
    const before = (await professor.get('/api/pages/P29?id=QCU-PROF-IT')).body.data.record
    expect(before.responses).toBe(6)
    // An unsubmitted old form is no longer a to-do and can't be submitted.
    expect((await professor.get('/api/pages/P26')).body.data.assignments.map((a: { id: string }) => a.id)).not.toContain('EVAL-OLD-UPWARD')
    const refused = await professor.post('/api/pages/P27/actions').send({ action: 'submitEvaluation', recordId: 'EVAL-OLD-UPWARD', payload: { answers: { Q1: 4, Q2: 4, Q3: 4 } } })
    expect([refused.status, refused.body.error]).toEqual([409, 'This form is no longer used. Evaluations use the student form only.'])
    // The one who submitted an old form still sees it.
    expect((await (await login('QCU-PROF-OTHER')).get('/api/pages/P26')).body.data.assignments.map((a: { id: string }) => a.id)).toContain('EVAL-OLD-PEER')
  })

  it('still lets a student fill the student form', async () => {
    const student = await login('QCU-STU-IT-A')
    expect((await student.get('/api/pages/P26')).body.data.assignments.map((a: { id: string }) => a.id)).toContain('EVAL-STU-IT-1')
    expect((await student.post('/api/pages/P27/actions').send({ action: 'submitEvaluation', recordId: 'EVAL-STU-IT-1', payload: { answers: { Q1: 4, Q2: 5, Q3: 4 } } })).status).toBe(200)
  })

  it('has no peer or upward assignments in the sample data', () => {
    const db = repo.read()
    expect(db.cycles.map((c) => c.forms)).toEqual(db.cycles.map(() => ['student']))
    expect(db.assignments.filter((a) => a.relation !== 'Student to faculty').map((a) => a.id)).toEqual([])
  })
})
