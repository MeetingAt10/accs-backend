// Issue #33: evaluation is required for clearance, so each student has a completion status per cycle (baseline chapter
// 9.2). Finished: every student-form evaluation submitted. Not finished: the cycle is still open. Missing: the cycle
// closed first. The Secretary, the Dean and OSAS list students across the college on P53 (Clearance), the Program Chair
// their own program; a student sees their own status on P26.
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
const submit = (student: Agent, id: string) => student.post('/api/pages/P27/actions').send({ action: 'submitEvaluation', recordId: id, payload: { answers: { Q1: 4, Q2: 5, Q3: 4 } } })
const closeCycle = (id = 'CYCLE-2026-1') => repo.transact((unit) => { unit.read().cycles.find((c) => c.id === id)!.status = 'Closed' })
type Row = { student: { id: string }; program: string; year: number; section: string; evaluation: { status: string; label: string; submitted: number; total: number; cycleId: string } }
const list = async (agent: Agent, query = '') => {
  const response = await agent.get(`/api/pages/P53${query}`)
  expect(response.status, JSON.stringify(response.body)).toBe(200)
  return response.body.data as { students: Row[]; summary: Record<string, number>; cycle: { id: string }; cycles: { id: string }[]; filters: { scope: string; programs: string[] } }
}
const ids = (rows: Row[]) => rows.map((r) => r.student.id).sort()
const students = () => repo.read().users.filter((u) => u.roles.includes('student') && u.active).map((u) => u.id).sort()

describe("a student's own completion", () => {
  it('shows not finished, then finished after submitting, on the evaluations page', async () => {
    const student = await login('QCU-STU-IT-A')
    const before = (await student.get('/api/pages/P26')).body.data.completion
    expect(before).toEqual([expect.objectContaining({ cycleId: 'CYCLE-2026-1', status: 'pending', label: 'Not finished', submitted: 0, total: 1 })])
    expect((await submit(student, 'EVAL-STU-IT-1')).status).toBe(200)
    expect((await student.get('/api/pages/P26')).body.data.completion[0]).toMatchObject({ status: 'submitted', label: 'Finished', submitted: 1, total: 1 })
    // Faculty have no completion of their own.
    expect((await (await login('QCU-PROF-IT')).get('/api/pages/P26')).body.data.completion).toBeUndefined()
  })

  it('becomes missing once the cycle closes unfinished, and stays finished if it was finished', async () => {
    const finished = await login('QCU-STU-IT-A')
    await submit(finished, 'EVAL-STU-IT-1')
    await closeCycle()
    expect((await finished.get('/api/pages/P26')).body.data.completion[0]).toMatchObject({ status: 'submitted' })
    expect((await (await login('QCU-STU-IT-B')).get('/api/pages/P26')).body.data.completion[0]).toMatchObject({ status: 'missing', label: 'Missing', submitted: 0, total: 1 })
  })

  it('counts only published and closed cycles, newest first, and only the student form', async () => {
    await repo.transact((unit) => {
      const db = unit.read()
      db.cycles.push({ ...structuredClone(db.cycles[0]!), id: 'CYCLE-2027-1', title: 'Newer cycle', opens: '2027-06-01', closes: '2027-07-01', status: 'Published' })
      db.assignments.push({ id: 'EVAL-NEW-1', evaluatorId: 'QCU-STU-IT-A', facultyId: 'QCU-PROF-IT', cycleId: 'CYCLE-2027-1', relation: 'Student to faculty', subject: 'Data Structures' })
      // An old peer form addressed to the student does not count.
      db.assignments.push({ id: 'EVAL-OLD', evaluatorId: 'QCU-STU-IT-A', facultyId: 'QCU-PROF-IT', cycleId: 'CYCLE-2027-1', relation: 'Peer', subject: 'Old form' })
    })
    const completion = (await (await login('QCU-STU-IT-A')).get('/api/pages/P26')).body.data.completion
    // CYCLE-2026-2 is still in review.
    expect(completion.map((c: { cycleId: string; total: number }) => [c.cycleId, c.total])).toEqual([['CYCLE-2027-1', 1], ['CYCLE-2026-1', 1]])
  })
})

describe('the clearance list (P53)', () => {
  it('lists every active student for the Dean, OSAS and the Secretary, with the current cycle by default', async () => {
    for (const agent of [await login('CCS-DEAN'), await login('QCU-OSAS'), await secretarySession(app)]) {
      const data = await list(agent)
      expect(ids(data.students)).toEqual(students())
      expect(data.cycle.id).toBe('CYCLE-2026-1')
      expect(data.cycles.map((c) => c.id)).toEqual(['CYCLE-2026-1'])
      expect(data.filters.scope).toBe('College of Computer Studies')
    }
  })

  it('limits the Program Chair to their own program, even when asked for another', async () => {
    const chair = await login('QCU-CHAIR-IT')
    const data = await list(chair)
    expect(data.students.length).toBeGreaterThan(0)
    expect(new Set(data.students.map((r) => r.program))).toEqual(new Set(['BSIT']))
    expect(data.filters).toMatchObject({ scope: 'BSIT program', programs: ['BSIT'] })
    expect((await list(chair, '?program=BSCS')).students).toEqual([])
  })

  it('filters by program, year, section, status and name, and counts each status', async () => {
    const dean = await login('CCS-DEAN')
    await submit(await login('QCU-STU-IT-A'), 'EVAL-STU-IT-1')
    expect(ids((await list(dean, '?program=BSCS')).students)).toEqual(['QCU-STU-CS'])
    expect(ids((await list(dean, '?program=BSIT&year=3&section=B')).students)).toEqual(['QCU-STU-IT-B'])
    expect(ids((await list(dean, '?q=Mira')).students)).toEqual(['QCU-STU-IT-A'])
    expect(ids((await list(dean, '?status=submitted')).students)).toEqual(['QCU-STU-IT-A'])
    const unfinished = await list(dean, '?status=pending,missing')
    expect(ids(unfinished.students)).not.toContain('QCU-STU-IT-A')
    expect(unfinished.students.every((r) => r.evaluation.status === 'pending')).toBe(true)
    // The summary counts the students in scope and filters, before the status filter.
    const all = await list(dean)
    const counted = Object.values(all.summary).reduce((n, v) => n + v, 0)
    expect(counted).toBe(all.students.length)
    expect(all.summary.submitted).toBe(1)
    await closeCycle()
    expect((await list(dean, '?status=missing')).students.map((r) => r.evaluation.label)).toEqual(expect.arrayContaining(['Missing']))
  })

  it('leaves out deactivated students', async () => {
    await repo.transact((unit) => { unit.read().users.find((u) => u.id === 'QCU-STU-IT-B')!.active = false })
    expect(ids((await list(await login('CCS-DEAN'))).students)).not.toContain('QCU-STU-IT-B')
  })

  it('shows "nothing to evaluate" for a student with no professors in the cycle', async () => {
    await repo.transact((unit) => { const db = unit.read(); db.assignments = db.assignments.filter((a) => a.evaluatorId !== 'QCU-STU-CS') })
    const row = (await list(await login('CCS-DEAN'), '?program=BSCS')).students[0]!
    expect(row.evaluation).toMatchObject({ status: 'none', label: 'Nothing to evaluate', total: 0 })
  })

  it('opens a chosen published or closed cycle, but not a draft or one in review', async () => {
    const dean = await login('CCS-DEAN')
    expect((await list(dean, '?cycle=CYCLE-2026-1')).cycle.id).toBe('CYCLE-2026-1')
    expect((await dean.get('/api/pages/P53?cycle=CYCLE-2026-2')).status).toBe(404)
    expect((await dean.get('/api/pages/P53?cycle=CYCLE-NOPE')).status).toBe(404)
  })

  it('is closed to students, faculty, Guidance and the administrator', async () => {
    for (const id of ['QCU-STU-IT-A', 'QCU-PROF-IT', 'QCU-GUIDANCE', 'ACCS-ADMIN']) expect([id, (await (await login(id)).get('/api/pages/P53')).status]).toEqual([id, 403])
  })
})
