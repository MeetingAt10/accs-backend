// Issue #34 and the decision of 11 November 2026: the Dean recommends a strike against a reported student while the case
// is with the Dean, and OSAS confirms or rejects it once the case reaches OSAS. Only a confirmed strike counts. Three
// unsettled strikes put the student's clearance on hold; OSAS records the settlement (letter or reprimand), which lifts the
// hold, and the strikes stay on the record. No-show strikes are no longer recorded.
import request from 'supertest'
import { beforeEach, describe, expect, it } from 'vitest'

import { createApp } from '../src/app.js'
import { createMemoryAuthStore } from '../src/auth.js'
import { createRecordRepository } from '../src/persist.js'
import { createMemoryRecordStore } from '../src/records.js'
import { createMemoryRepository, type Repository, type Stage, type UnitOfWork } from '../src/store.js'
import { seedPassword } from './helpers.js'

let repo: Repository
let app: ReturnType<typeof createApp>
// Concerns that name QCU-STU-CS, the reported student. None of them was filed by QCU-STU-CS.
const cases = ['RPT-0243', 'RPT-0246', 'RPT-0247', 'RPT-0241', 'RPT-0245', 'RPT-0242']
const nameReported = (unit: UnitOfWork) => { for (const r of unit.read().reports) if (cases.includes(r.id)) r.involvedUserIds = [...r.involvedUserIds, 'QCU-STU-CS'] }
beforeEach(async () => {
  repo = createMemoryRepository()
  app = createApp(repo, { authStore: createMemoryAuthStore() })
  await repo.transact(nameReported)
})

async function login(id: string) {
  const agent = request.agent(app)
  expect((await agent.post('/api/auth/sign-in').send({ emailOrId: id, password: seedPassword })).status).toBe(200)
  return agent
}
type Agent = Awaited<ReturnType<typeof login>>
const moveTo = (reportId: string, stage: Stage) => repo.transact((unit) => { unit.read().reports.find((r) => r.id === reportId)!.stage = stage })
const state = () => repo.view((unit) => unit.read())
const recommend = (agent: Agent, extra: object = {}, page = 'P22') =>
  agent.post(`/api/pages/${page}/actions`).send({ action: 'recommendStrike', payload: { studentId: 'QCU-STU-CS', reportId: 'RPT-0243', note: 'Bullying confirmed in the meeting.', ...extra } })
const decide = (agent: Agent, strikeId: string, decision = 'confirm', note = '') =>
  agent.post('/api/pages/P22/actions').send({ action: 'decideStrike', payload: { strikeId, decision, note } })
const settle = (agent: Agent, extra: object = {}) =>
  agent.post('/api/pages/P34/actions').send({ action: 'settleStrikes', payload: { studentId: 'QCU-STU-CS', kind: 'reprimand', reference: 'OSAS-REP-2026-014', note: 'Reprimand issued.', ...extra } })
const record = async (agent: Agent, id = 'QCU-STU-CS') => (await agent.get(`/api/pages/P34?id=${id}&purpose=Case%20handling`)).body.data.record
/** One strike through the whole flow: the Dean recommends on case `n`, the case moves to OSAS, OSAS confirms. */
async function strike(n: number, dean: Agent, osas: Agent) {
  const reportId = cases[n]!
  await moveTo(reportId, 'dean')
  const recommended = await recommend(dean, { reportId })
  expect(recommended.status, recommended.body.error).toBe(200)
  await moveTo(reportId, 'osas')
  const confirmed = await decide(osas, recommended.body.record.id)
  expect(confirmed.status, confirmed.body.error).toBe(200)
  return confirmed
}

describe('the Dean recommends a strike and OSAS confirms it', () => {
  it("counts a strike only once OSAS confirms the Dean's recommendation", async () => {
    const [dean, osas] = [await login('CCS-DEAN'), await login('QCU-OSAS')]
    const recommended = await recommend(dean)
    expect(recommended.status).toBe(200)
    expect(recommended.body.message).toBe('Strike recommended. OSAS confirms it when the case reaches them.')
    expect(recommended.body.record).toMatchObject({ status: 'recommended', kind: 'report', recommendedBy: expect.objectContaining({ id: 'CCS-DEAN' }) })
    expect((await dean.get('/api/pages/P22?id=RPT-0243')).body.data.record).toMatchObject({ canRecommendStrike: true, canDecideStrike: false })
    expect((await record(dean)).clearance).toEqual({ onHold: false, unsettledStrikes: 0, totalStrikes: 0, limit: 3 })
    // OSAS sees the recommendation on the case once it arrives, and confirms it there.
    await moveTo('RPT-0243', 'osas')
    const seen = (await osas.get('/api/pages/P22?id=RPT-0243')).body.data.record
    expect(seen).toMatchObject({ canDecideStrike: true, canRecommendStrike: false, strikes: [expect.objectContaining({ id: recommended.body.record.id, status: 'recommended' })] })
    const confirmed = await decide(osas, recommended.body.record.id)
    expect(confirmed.status).toBe(200)
    expect(confirmed.body.message).toBe('Strike confirmed.')
    expect(confirmed.body.record.strike).toMatchObject({ status: 'confirmed', recordedBy: expect.objectContaining({ id: 'QCU-OSAS' }), recommendedBy: expect.objectContaining({ id: 'CCS-DEAN' }) })
    expect(confirmed.body.record.clearance).toEqual({ onHold: false, unsettledStrikes: 1, totalStrikes: 1, limit: 3 })
    expect((await decide(osas, recommended.body.record.id)).status).toBe(409)
    const actions = (await state()).audit.filter((a) => a.module === 'records').map((a) => a.action)
    expect(actions).toEqual(expect.arrayContaining(['Strike recommended', 'Strike confirmed']))
  })

  it('lets OSAS reject a recommendation with a reason, and a rejected strike never counts', async () => {
    const [dean, osas] = [await login('CCS-DEAN'), await login('QCU-OSAS')]
    const id = (await recommend(dean)).body.record.id
    await moveTo('RPT-0243', 'osas')
    expect((await decide(osas, id, 'reject')).status).toBe(400)
    const rejected = await decide(osas, id, 'reject', 'The meeting did not support the claim.')
    expect([rejected.status, rejected.body.message, rejected.body.record.strike.status, rejected.body.record.strike.decisionNote]).toEqual([200, 'Strike rejected. It does not count.', 'rejected', 'The meeting did not support the claim.'])
    expect(rejected.body.record.clearance).toEqual({ onHold: false, unsettledStrikes: 0, totalStrikes: 0, limit: 3 })
    expect((await decide(osas, id)).status).toBe(409)
    // A rejected recommendation does not block a new one on the same case.
    await moveTo('RPT-0243', 'dean')
    expect((await recommend(dean)).status).toBe(200)
  })

  it('lets only the Dean recommend, on a case with the Dean, against a student the concern names', async () => {
    const dean = await login('CCS-DEAN')
    for (const id of ['QCU-OSAS', 'QCU-GUIDANCE', 'QCU-CHAIR-IT', 'QCU-PROF-IT']) expect([id, (await recommend(await login(id))).status]).toEqual([id, 403])
    // RPT-0246 is at OSAS, not with the Dean.
    expect((await recommend(dean, { reportId: 'RPT-0246' })).status).toBe(404)
    const reporter = await recommend(dean, { studentId: 'QCU-STU-IT-B' })
    expect([reporter.status, reporter.body.error]).toEqual([409, 'A strike is recorded against the reported student, not the student who filed the concern.'])
    const notNamed = await recommend(dean, { studentId: 'QCU-STU-RESTRICTED' })
    expect([notNamed.status, notNamed.body.error]).toEqual([409, 'Recommend a strike only against a student named in the concern.'])
    expect((await recommend(dean, { studentId: 'QCU-PROF-IT' })).status).toBe(404)
    expect((await recommend(dean, { note: '' })).status).toBe(400)
    expect((await state()).strikes).toEqual([])
    // One strike per student per case, from the case page or the student record.
    expect((await recommend(dean, {}, 'P34')).status).toBe(200)
    expect((await recommend(dean)).status).toBe(409)
  })

  it('lets only OSAS decide, and only once the case is with OSAS', async () => {
    const [dean, osas] = [await login('CCS-DEAN'), await login('QCU-OSAS')]
    const id = (await recommend(dean)).body.record.id
    // Still with the Dean: OSAS cannot decide yet, and the Dean cannot confirm their own recommendation.
    expect((await decide(osas, id)).status).toBe(404)
    expect((await decide(dean, id)).status).toBe(403)
    await moveTo('RPT-0243', 'guidance')
    expect((await decide(osas, id)).status).toBe(404)
    expect((await decide(await login('QCU-GUIDANCE'), id)).status).toBe(403)
    await moveTo('RPT-0243', 'osas')
    expect((await decide(osas, 'STRIKE-9999')).status).toBe(404)
    expect((await decide(osas, id)).status).toBe(200)
  })

  it('no longer records strikes directly, and no-shows are not strikes', async () => {
    const osas = await login('QCU-OSAS')
    const direct = await osas.post('/api/pages/P34/actions').send({ action: 'recordStrike', payload: { studentId: 'QCU-STU-CS', reportId: 'RPT-0246', kind: 'no-show', note: 'Missed the meeting.' } })
    expect(direct.status).toBeGreaterThanOrEqual(400)
    expect((await recommend(await login('CCS-DEAN'), { kind: 'no-show' })).status).toBe(400)
    expect((await state()).strikes).toEqual([])
  })

  it('counts strikes stored before this rule, which OSAS recorded alone', async () => {
    await repo.transact((unit) => { unit.read().strikes.push({ id: 'STRIKE-0001', studentId: 'QCU-STU-CS', reportId: 'RPT-0246', kind: 'no-show', note: 'Recorded before 11 November.', actorId: 'QCU-OSAS', at: '2026-11-09T08:00:00.000Z' }) })
    const seen = await record(await login('QCU-OSAS'))
    expect(seen.clearance).toMatchObject({ unsettledStrikes: 1, totalStrikes: 1 })
    expect(seen.strikes[0]).toMatchObject({ status: 'confirmed', kind: 'no-show', recordedBy: expect.objectContaining({ id: 'QCU-OSAS' }) })
    expect(seen.strikes[0].recommendedBy).toBeUndefined()
  })
})

describe('strikes and the clearance hold (issue #34)', () => {
  it('puts the clearance on hold at the third confirmed strike, and audits each step', async () => {
    const [dean, osas] = [await login('CCS-DEAN'), await login('QCU-OSAS')]
    for (const n of [1, 2]) expect((await strike(n - 1, dean, osas)).body.record.clearance).toEqual({ onHold: false, unsettledStrikes: n, totalStrikes: n, limit: 3 })
    const third = await strike(2, dean, osas)
    expect(third.body.message).toBe('Strike confirmed. The student’s clearance is now on hold.')
    expect(third.body.record.clearance).toEqual({ onHold: true, unsettledStrikes: 3, totalStrikes: 3, limit: 3 })
    expect((await state()).audit.filter((a) => a.action === 'Clearance hold placed')).toHaveLength(1)
    // A fourth strike keeps the hold and does not place it again.
    expect((await strike(3, dean, osas)).body.record.clearance).toMatchObject({ onHold: true, unsettledStrikes: 4 })
    expect((await state()).audit.filter((a) => a.action === 'Clearance hold placed')).toHaveLength(1)
  })

  it('lifts the hold on settlement and keeps the strikes on the record', async () => {
    const [dean, osas] = [await login('CCS-DEAN'), await login('QCU-OSAS')]
    for (let n = 0; n < 3; n++) await strike(n, dean, osas)
    const settled = await settle(osas)
    expect(settled.status).toBe(200)
    expect(settled.body.record.clearance).toEqual({ onHold: false, unsettledStrikes: 0, totalStrikes: 3, limit: 3 })
    expect(settled.body.record.strikes.every((s: { settled: boolean }) => s.settled)).toBe(true)
    const seen = await record(osas)
    expect(seen.strikes).toHaveLength(3)
    expect(seen.strikeSettlements).toEqual([expect.objectContaining({ kind: 'reprimand', reference: 'OSAS-REP-2026-014', strikeCount: 3 })])
  })

  it('starts a new count after a settlement, refuses to settle without a hold, and settles only confirmed strikes', async () => {
    const [dean, osas] = [await login('CCS-DEAN'), await login('QCU-OSAS')]
    expect((await settle(osas)).status).toBe(409)
    for (let n = 0; n < 3; n++) await strike(n, dean, osas)
    // A pending recommendation is not part of the settlement.
    await moveTo(cases[3]!, 'dean')
    const pending = (await recommend(dean, { reportId: cases[3] })).body.record.id
    expect((await settle(osas)).status).toBe(200)
    expect((await state()).strikeSettlements[0]!.strikeIds).not.toContain(pending)
    expect((await settle(osas)).status).toBe(409)
    await strike(4, dean, osas)
    await strike(5, dean, osas)
    expect((await record(osas)).clearance).toEqual({ onHold: false, unsettledStrikes: 2, totalStrikes: 5, limit: 3 })
    await moveTo(cases[3]!, 'osas')
    expect((await decide(osas, pending)).status).toBe(200)
    expect((await record(osas)).clearance).toEqual({ onHold: true, unsettledStrikes: 3, totalStrikes: 6, limit: 3 })
  })

  it('shows strikes and the hold on the student record to the offices that may open it', async () => {
    const [dean, osas] = [await login('CCS-DEAN'), await login('QCU-OSAS')]
    for (let n = 0; n < 3; n++) await strike(n, dean, osas)
    for (const id of ['CCS-DEAN', 'QCU-CHAIR-CS', 'QCU-OSAS']) {
      const seen = await record(await login(id))
      expect([id, seen.clearance.onHold, seen.strikes.length, seen.canRecordStrikes, seen.canRecommendStrikes]).toEqual([id, true, 3, id === 'QCU-OSAS', id === 'CCS-DEAN'])
      expect(seen.strikes[0]).toMatchObject({ kind: 'report', status: 'confirmed', caseReference: expect.stringMatching(/^CF-|^RPT-/), settled: false })
    }
    // Settling stays with OSAS.
    expect((await settle(dean)).status).toBe(403)
    // The reported student cannot open the records page, and the reporter never sees strikes on their concern.
    expect((await (await login('QCU-STU-CS')).get('/api/pages/P34?id=QCU-STU-CS&purpose=Case%20handling')).status).toBe(403)
    const own = (await (await login('QCU-STU-IT-A')).get('/api/pages/P20?id=RPT-0246')).body.data.record
    expect(own).toBeDefined()
    expect(own.strikes).toBeUndefined()
  })

  it('keeps strikes and settlements across instances', async () => {
    const store = createMemoryRecordStore()
    repo = createRecordRepository(store)
    await repo.transact(nameReported)
    app = createApp(repo, { authStore: createMemoryAuthStore() })
    const [dean, osas] = [await login('CCS-DEAN'), await login('QCU-OSAS')]
    for (let n = 0; n < 3; n++) await strike(n, dean, osas)
    await settle(osas)
    const cold = createRecordRepository(store)
    const stored = await cold.view((unit) => ({ strikes: unit.read().strikes.map((s) => s.status), settlements: unit.read().strikeSettlements.length }), ['strikes', 'strikeSettlements'])
    expect(stored).toEqual({ strikes: ['confirmed', 'confirmed', 'confirmed'], settlements: 1 })
  })
})
