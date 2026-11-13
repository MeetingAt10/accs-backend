// Issue #35: one clearance status per student, worked out from the data (DOC003 D-02). On hold when the current cycle has
// closed and the student did not finish it, or when strikes are not settled with OSAS. A cycle that is still open blocks
// no one, and only the current (latest) cycle counts (decided 11 November 2026). The Secretary, the Dean and OSAS see it
// on P53 (the Program Chair for their program), the record (P34) shows it, and the student sees their own on P36. The
// Secretary sees the reason, not the number of strikes.
import request from 'supertest'
import { beforeEach, describe, expect, it } from 'vitest'

import { createApp } from '../src/app.js'
import { createMemoryAuthStore } from '../src/auth.js'
import { createMemoryRepository, type Strike } from '../src/store.js'
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
type Clearance = { status: string; label: string; reasons: { kind: string; message: string; unsettledStrikes?: number; cycleId?: string }[] }
const submit = (student: Agent, id: string) => student.post('/api/pages/P27/actions').send({ action: 'submitEvaluation', recordId: id, payload: { answers: { Q1: 4, Q2: 5, Q3: 4 } } })
const setCycle = (status: 'Published' | 'Closed', id = 'CYCLE-2026-1') => repo.transact((unit) => { unit.read().cycles.find((c) => c.id === id)!.status = status })
const addStrikes = (studentId: string, n: number, status?: Strike['status']) => repo.transact((unit) => {
  const db = unit.read()
  for (let i = 0; i < n; i++) db.strikes.push({ id: `STRIKE-T-${db.strikes.length + 1}`, studentId, reportId: 'RPT-0246', kind: 'report', note: 'Confirmed.', actorId: 'QCU-OSAS', at: '2026-11-11T08:00:00.000Z', ...(status ? { status } : {}) })
})
const rows = async (agent: Agent, query = '') => {
  const response = await agent.get(`/api/pages/P53${query}`)
  expect(response.status, JSON.stringify(response.body)).toBe(200)
  return response.body.data as { students: { student: { id: string }; clearance: Clearance }[]; clearanceSummary: { clear: number; onHold: number } }
}
const of = async (agent: Agent, id: string) => (await rows(agent)).students.find((r) => r.student.id === id)!.clearance
const own = async (id: string) => (await (await login(id)).get('/api/pages/P36')).body.data.record.clearance as Clearance

describe('the clearance status', () => {
  it('is clear by default, and an open cycle blocks no one', async () => {
    const dean = await login('CCS-DEAN')
    const data = await rows(dean)
    expect(data.students.every((r) => r.clearance.status === 'clear' && r.clearance.label === 'Clear' && r.clearance.reasons.length === 0)).toBe(true)
    expect(data.clearanceSummary).toEqual({ clear: data.students.length, onHold: 0 })
    expect(await own('QCU-STU-IT-B')).toEqual({ status: 'clear', label: 'Clear', reasons: [] })
  })

  it('holds a student who did not finish the current cycle once it closes', async () => {
    await submit(await login('QCU-STU-IT-A'), 'EVAL-STU-IT-1')
    await setCycle('Closed')
    const dean = await login('CCS-DEAN')
    expect(await of(dean, 'QCU-STU-IT-A')).toMatchObject({ status: 'clear' })
    expect(await of(dean, 'QCU-STU-IT-B')).toEqual({ status: 'on_hold', label: 'On hold', reasons: [{ kind: 'evaluation', message: 'Evaluations not finished for 1st Semester AY 2026-2027', cycleId: 'CYCLE-2026-1' }] })
    expect((await own('QCU-STU-IT-B')).status).toBe('on_hold')
    // Reopening the cycle lifts it again: the status is never stored.
    await setCycle('Published')
    expect((await of(dean, 'QCU-STU-IT-B')).status).toBe('clear')
  })

  it('counts only the current cycle', async () => {
    await setCycle('Closed')
    await repo.transact((unit) => {
      const db = unit.read()
      db.cycles.push({ ...structuredClone(db.cycles[0]!), id: 'CYCLE-2027-1', title: 'Next term', opens: '2027-06-01', closes: '2027-07-01', status: 'Published' })
    })
    // The older closed cycle was missed, but the current one is still open.
    expect((await of(await login('CCS-DEAN'), 'QCU-STU-IT-B')).status).toBe('clear')
    await setCycle('Closed', 'CYCLE-2027-1')
    // QCU-STU-IT-B has nothing to evaluate in the new cycle, so it holds no one.
    expect((await of(await login('CCS-DEAN'), 'QCU-STU-IT-B')).status).toBe('clear')
  })

  it('holds a student with unsettled strikes until OSAS settles them, and ignores pending ones', async () => {
    await addStrikes('QCU-STU-CS', 2)
    await addStrikes('QCU-STU-CS', 2, 'recommended')
    await addStrikes('QCU-STU-CS', 1, 'rejected')
    const dean = await login('CCS-DEAN')
    expect((await of(dean, 'QCU-STU-CS')).status).toBe('clear')
    await addStrikes('QCU-STU-CS', 1, 'confirmed')
    expect(await of(dean, 'QCU-STU-CS')).toEqual({ status: 'on_hold', label: 'On hold', reasons: [{ kind: 'strikes', message: 'Strikes not settled with OSAS', unsettledStrikes: 3 }] })
    expect((await own('QCU-STU-CS')).reasons[0]).toMatchObject({ kind: 'strikes', unsettledStrikes: 3 })
    // The Secretary sees the reason, not the number of strikes.
    const fromSecretary = await of(await secretarySession(app), 'QCU-STU-CS')
    expect(fromSecretary).toEqual({ status: 'on_hold', label: 'On hold', reasons: [{ kind: 'strikes', message: 'Strikes not settled with OSAS' }] })
    // OSAS settles; the hold lifts.
    await repo.transact((unit) => { unit.read().reports.find((r) => r.id === 'RPT-0246')!.involvedUserIds = ['QCU-STU-CS'] })
    const settled = await (await login('QCU-OSAS')).post('/api/pages/P34/actions').send({ action: 'settleStrikes', payload: { studentId: 'QCU-STU-CS', kind: 'letter', reference: 'OSAS-LTR-01', note: '' } })
    expect(settled.status, JSON.stringify(settled.body)).toBe(200)
    expect((await of(dean, 'QCU-STU-CS')).status).toBe('clear')
  })

  it('lists both reasons when both apply', async () => {
    await setCycle('Closed')
    await addStrikes('QCU-STU-IT-B', 3)
    expect((await of(await login('QCU-OSAS'), 'QCU-STU-IT-B')).reasons.map((r) => r.kind)).toEqual(['evaluation', 'strikes'])
  })

  it('filters the list by clearance and counts each, within the Program Chair\'s program', async () => {
    expect((await submit(await login('QCU-STU-IT-A'), 'EVAL-STU-IT-1')).status).toBe(200)
    await setCycle('Closed')
    const dean = await login('CCS-DEAN')
    const onHold = await rows(dean, '?clearance=on_hold')
    expect(onHold.students.map((r) => r.student.id)).not.toContain('QCU-STU-IT-A')
    expect(onHold.students.every((r) => r.clearance.status === 'on_hold')).toBe(true)
    expect((await rows(dean, '?clearance=clear')).students.map((r) => r.student.id)).toContain('QCU-STU-IT-A')
    const all = await rows(dean)
    expect(all.clearanceSummary).toEqual({ clear: all.students.length - onHold.students.length, onHold: onHold.students.length })
    expect((await dean.get('/api/pages/P53?clearance=maybe')).status).toBe(400)
    const chair = await rows(await login('QCU-CHAIR-CS'), '?clearance=on_hold')
    expect(chair.students.map((r) => r.student.id)).toEqual(['QCU-STU-CS'])
  })

  it('shows on the student record for the offices that may open it', async () => {
    await addStrikes('QCU-STU-CS', 3)
    const record = (await (await login('CCS-DEAN')).get('/api/pages/P34?id=QCU-STU-CS&purpose=Case%20handling')).body.data.record
    expect(record.clearanceStatus).toMatchObject({ status: 'on_hold', reasons: [expect.objectContaining({ kind: 'strikes', unsettledStrikes: 3 })] })
    // The Secretary still cannot open student records.
    expect((await (await secretarySession(app)).get('/api/pages/P34?id=QCU-STU-CS&purpose=Case%20handling')).status).toBe(403)
  })
})
