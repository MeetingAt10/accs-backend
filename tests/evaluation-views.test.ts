import request from 'supertest'
import { beforeEach, describe, expect, it } from 'vitest'

import { createApp } from '../src/app.js'
import { createMemoryRepository, type Repository } from '../src/store.js'

describe('evaluation read models', () => {
  let repository: Repository
  let app: ReturnType<typeof createApp>

  beforeEach(() => {
    memory = createMemoryRepository()
    repository = memory
    app = createApp(repository)
  })

  async function login(accountId: string) {
    const agent = request.agent(app)
    const signedIn = await agent.post('/api/auth/sign-in').send({ emailOrId: accountId, password: 'Accs@Qcu2026!' })

    expect(signedIn.status).toBe(200)
    return agent
  }

  it('DEAN-03-V returns faculty completion and review status for the cycle editor', async () => {
    const dean = await login('CCS-DEAN')
    const response = await dean.get('/api/pages/P31?id=CYCLE-2026-2')

    expect(response.status).toBe(200)
    expect(response.body.data.facultyCompletion).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'QCU-PROF-IT',
          assigned: 1,
          submitted: 0,
        }),
      ]),
    )
    expect(response.body.data.facultyReviews).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'QCU-PROF-IT',
          status: 'Not yet',
        }),
      ]),
    )
    expect(JSON.stringify(response.body.data.facultyCompletion)).not.toContain('answers')
  })

  it('PRO-08-V/B includes a program reference average without exposing evaluator identities', async () => {
    const professor = await login('QCU-PROF-IT')
    const response = await professor.get(
      '/api/pages/P29?id=QCU-PROF-IT&cycle=CYCLE-2026-1',
    )

    expect(response.status).toBe(200)
    expect(response.body.data.programAverage.program).toBe('BSIT')
    expect(JSON.stringify(response.body.data)).not.toContain('evaluatorId')
    expect(JSON.stringify(response.body.data)).not.toContain('SAMPLE-EVALUATOR')

    // Once every BSIT evaluation in the cycle is in, the reference average is released.
    submitAll('BSIT', 'CYCLE-2026-1')
    const released = (await professor.get('/api/pages/P29?id=QCU-PROF-IT&cycle=CYCLE-2026-1')).body.data.programAverage
    expect(released.released).toBe(true)
    expect(released.criteria).toHaveLength(3)
    expect(JSON.stringify(released)).not.toContain('evaluatorId')
  })
})

/** Marks every assignment of the program's faculty in the cycle as submitted, with mid-scale answers. */
let memory: ReturnType<typeof createMemoryRepository>
function submitAll(program: string, cycleId: string) {
  const db = memory.read()
  const faculty = new Set(db.users.filter((u) => u.program === program && u.roles.some((r) => ['professor', 'chair', 'dean'].includes(r))).map((u) => u.id))
  for (const a of db.assignments) if (faculty.has(a.facultyId) && a.cycleId === cycleId && !a.submittedAt) Object.assign(a, { submittedAt: '2026-11-10T00:00:00.000Z', answers: { Q1: 3, Q2: 3, Q3: 3 } })
}

describe('program average release (D-08: 100% of assigned evaluations)', () => {
  let app: ReturnType<typeof createApp>
  beforeEach(() => { memory = createMemoryRepository(); app = createApp(memory) })
  const login = async (id: string) => { const agent = request.agent(app); expect((await agent.post('/api/auth/sign-in').send({ emailOrId: id, password: 'Accs@Qcu2026!' })).status).toBe(200); return agent }
  const programAverage = async (agent: Awaited<ReturnType<typeof login>>) => (await agent.get('/api/pages/P29?id=QCU-PROF-IT&cycle=CYCLE-2026-1')).body.data.programAverage

  it('withholds the average and its criteria while any assigned evaluation is missing, and gives the counts', async () => {
    const professor = await login('QCU-PROF-IT')
    const db = memory.read()
    const faculty = new Set(db.users.filter((u) => u.program === 'BSIT' && u.roles.some((r) => ['professor', 'chair', 'dean'].includes(r))).map((u) => u.id))
    const population = db.assignments.filter((a) => faculty.has(a.facultyId) && a.cycleId === 'CYCLE-2026-1')
    const average = await programAverage(professor)
    expect(average).toEqual({ program: 'BSIT', released: false, submitted: population.filter((a) => a.submittedAt).length, assigned: population.length, criteria: [] })
    expect(average.submitted).toBeLessThan(average.assigned)
  })

  it('still withholds it with one evaluation missing, and releases it at exactly 100%', async () => {
    const professor = await login('QCU-PROF-IT')
    submitAll('BSIT', 'CYCLE-2026-1')
    const last = memory.read().assignments.find((a) => a.id === 'EVAL-STU-IT-2')!
    delete last.submittedAt
    const almost = await programAverage(professor)
    expect(almost.released).toBe(false)
    expect(almost.assigned - almost.submitted).toBe(1)
    expect(almost.criteria).toEqual([])

    last.submittedAt = '2026-11-10T00:00:00.000Z'
    const full = await programAverage(professor)
    expect(full).toMatchObject({ released: true, submitted: full.assigned })
    expect(full.criteria.map((c: { label: string }) => c.label)).toEqual(['Clarity', 'Support', 'Fairness'])
    expect(full.criteria.every((c: { value: number }) => c.value > 0)).toBe(true)
  })

  it('counts only the program in question: missing BSCS evaluations do not hold back BSIT', async () => {
    const professor = await login('QCU-PROF-IT')
    submitAll('BSIT', 'CYCLE-2026-1')
    expect(memory.read().assignments.some((a) => a.facultyId === 'QCU-PROF-CS' && !a.submittedAt)).toBe(true)
    expect((await programAverage(professor)).released).toBe(true)
  })

  it('judges each cycle on its own, and needs every published cycle when no cycle is chosen', async () => {
    const professor = await login('QCU-PROF-IT')
    const db = memory.read()
    // A second published cycle where a BSIT evaluation is still missing.
    db.cycles.find((c) => c.id === 'CYCLE-2026-2')!.resultsPublished = true
    expect(db.assignments.some((a) => a.cycleId === 'CYCLE-2026-2' && a.facultyId === 'QCU-PROF-IT' && !a.submittedAt)).toBe(true)
    submitAll('BSIT', 'CYCLE-2026-1')
    expect((await programAverage(professor)).released).toBe(true)
    const allCycles = (await professor.get('/api/pages/P29?id=QCU-PROF-IT')).body.data.programAverage
    expect(allCycles.released).toBe(false)
    submitAll('BSIT', 'CYCLE-2026-2')
    expect((await professor.get('/api/pages/P29?id=QCU-PROF-IT')).body.data.programAverage.released).toBe(true)
  })

  it('does not release an average with nothing assigned', async () => {
    const professor = await login('QCU-PROF-IT')
    const db = memory.read()
    const faculty = new Set(db.users.filter((u) => u.program === 'BSIT').map((u) => u.id))
    db.assignments = db.assignments.filter((a) => a.cycleId !== 'CYCLE-2026-1' || !faculty.has(a.facultyId))
    expect(await programAverage(professor)).toEqual({ program: 'BSIT', released: false, submitted: 0, assigned: 0, criteria: [] })
  })
})
