// Issue #34: OSAS records strikes against a reported student in a student-on-student complaint. Three unsettled strikes put
// the student's clearance on hold; OSAS records the settlement (letter or reprimand), which lifts the hold. The strikes stay
// on the record (team baseline "ACCS: Features and Flows", 10 November 2026, and the decision of 11 November 2026).
import request from 'supertest'
import { beforeEach, describe, expect, it } from 'vitest'

import { createApp } from '../src/app.js'
import { createMemoryAuthStore } from '../src/auth.js'
import { createRecordRepository } from '../src/persist.js'
import { createMemoryRecordStore } from '../src/records.js'
import { createMemoryRepository } from '../src/store.js'
import { seedPassword } from './helpers.js'

let repo: ReturnType<typeof createMemoryRepository>
let app: ReturnType<typeof createApp>
// RPT-0246 is a case at OSAS filed by QCU-STU-IT-A; it names QCU-STU-CS, the reported student, who has no case of their own.
beforeEach(() => {
  repo = createMemoryRepository()
  app = createApp(repo, { authStore: createMemoryAuthStore() })
  repo.read().reports.find((r) => r.id === 'RPT-0246')!.involvedUserIds = ['QCU-STU-CS']
})

async function login(id: string) {
  const agent = request.agent(app)
  expect((await agent.post('/api/auth/sign-in').send({ emailOrId: id, password: seedPassword })).status).toBe(200)
  return agent
}
type Agent = Awaited<ReturnType<typeof login>>
const strike = (agent: Agent, extra: object = {}) =>
  agent.post('/api/pages/P34/actions').send({ action: 'recordStrike', payload: { studentId: 'QCU-STU-CS', reportId: 'RPT-0246', kind: 'report', note: 'Bullying report confirmed in the meeting.', ...extra } })
const settle = (agent: Agent, extra: object = {}) =>
  agent.post('/api/pages/P34/actions').send({ action: 'settleStrikes', payload: { studentId: 'QCU-STU-CS', kind: 'reprimand', reference: 'OSAS-REP-2026-014', note: 'Reprimand issued.', ...extra } })
const record = async (agent: Agent, id = 'QCU-STU-CS') => (await agent.get(`/api/pages/P34?id=${id}&purpose=Case%20handling`)).body.data.record

describe('strikes and the clearance hold (issue #34)', () => {
  it('puts the clearance on hold at the third strike, and audits each step', async () => {
    const osas = await login('QCU-OSAS')
    for (const [n, kind] of [[1, 'report'], [2, 'no-show']] as const) {
      const response = await strike(osas, { kind })
      expect(response.status).toBe(200)
      expect(response.body.record.clearance).toEqual({ onHold: false, unsettledStrikes: n, totalStrikes: n, limit: 3 })
    }
    const third = await strike(osas)
    expect(third.body.message).toBe('Strike recorded. The student’s clearance is now on hold.')
    expect(third.body.record.clearance).toEqual({ onHold: true, unsettledStrikes: 3, totalStrikes: 3, limit: 3 })
    const actions = repo.read().audit.filter((a) => a.module === 'records').map((a) => a.action)
    expect(actions.filter((a) => a === 'Strike recorded')).toHaveLength(3)
    expect(actions.filter((a) => a === 'Clearance hold placed')).toHaveLength(1)
    // A fourth strike keeps the hold and does not place it again.
    expect((await strike(osas)).body.record.clearance).toMatchObject({ onHold: true, unsettledStrikes: 4 })
    expect(repo.read().audit.filter((a) => a.action === 'Clearance hold placed')).toHaveLength(1)
  })

  it('lifts the hold on settlement and keeps the strikes on the record', async () => {
    const osas = await login('QCU-OSAS')
    for (let i = 0; i < 3; i++) await strike(osas)
    const settled = await settle(osas)
    expect(settled.status).toBe(200)
    expect(settled.body.record.clearance).toEqual({ onHold: false, unsettledStrikes: 0, totalStrikes: 3, limit: 3 })
    expect(settled.body.record.strikes.every((s: { settled: boolean }) => s.settled)).toBe(true)
    const seen = await record(osas)
    expect(seen.strikes).toHaveLength(3)
    expect(seen.strikeSettlements).toEqual([expect.objectContaining({ kind: 'reprimand', reference: 'OSAS-REP-2026-014', strikeCount: 3 })])
    expect(repo.read().audit.some((a) => a.action === 'Clearance hold settled')).toBe(true)
  })

  it('starts a new count after a settlement, and refuses to settle when there is no hold', async () => {
    const osas = await login('QCU-OSAS')
    expect((await settle(osas)).status).toBe(409)
    for (let i = 0; i < 3; i++) await strike(osas)
    await settle(osas)
    expect((await settle(osas)).status).toBe(409)
    await strike(osas)
    await strike(osas)
    expect((await record(osas)).clearance).toEqual({ onHold: false, unsettledStrikes: 2, totalStrikes: 5, limit: 3 })
    await strike(osas)
    expect((await record(osas)).clearance).toEqual({ onHold: true, unsettledStrikes: 3, totalStrikes: 6, limit: 3 })
  })

  it('is recorded only by OSAS, from a case OSAS is handling, and never against the student who filed it', async () => {
    const osas = await login('QCU-OSAS')
    for (const id of ['QCU-GUIDANCE', 'CCS-DEAN', 'QCU-CHAIR-IT']) expect([id, (await strike(await login(id))).status]).toEqual([id, 403])
    // RPT-0243 is with the Dean, not OSAS.
    expect((await strike(osas, { reportId: 'RPT-0243' })).status).toBe(404)
    const reporter = await strike(osas, { studentId: 'QCU-STU-IT-A' })
    expect([reporter.status, reporter.body.error]).toEqual([409, 'A strike is recorded against the reported student, not the student who filed the concern.'])
    // A student OSAS has no case about.
    expect((await strike(osas, { studentId: 'QCU-STU-RESTRICTED' })).status).toBe(404)
    expect((await strike(osas, { note: '' })).status).toBe(400)
    expect(repo.read().strikes).toEqual([])
  })

  it('shows strikes and the hold on the student record to the offices that may open it, and lets only OSAS act', async () => {
    const osas = await login('QCU-OSAS')
    for (let i = 0; i < 3; i++) await strike(osas)
    for (const id of ['CCS-DEAN', 'QCU-CHAIR-CS', 'QCU-OSAS']) {
      const seen = await record(await login(id))
      expect([id, seen.clearance.onHold, seen.strikes.length, seen.canRecordStrikes]).toEqual([id, true, 3, id === 'QCU-OSAS'])
      expect(seen.strikes[0]).toMatchObject({ kind: 'report', caseReference: expect.stringMatching(/^CF-|^RPT-/), settled: false })
    }
    // The student who was reported cannot open the records page.
    expect((await (await login('QCU-STU-CS')).get('/api/pages/P34?id=QCU-STU-CS&purpose=Case%20handling')).status).toBe(403)
  })

  it('keeps strikes and settlements across instances', async () => {
    const store = createMemoryRecordStore()
    const first = createRecordRepository(store)
    await first.transact((unit) => { unit.read().reports.find((r) => r.id === 'RPT-0246')!.involvedUserIds = ['QCU-STU-CS'] })
    app = createApp(first, { authStore: createMemoryAuthStore() })
    const osas = await login('QCU-OSAS')
    for (let i = 0; i < 3; i++) await strike(osas)
    await settle(osas)
    const cold = createRecordRepository(store)
    const stored = await cold.view((unit) => ({ strikes: unit.read().strikes.length, settlements: unit.read().strikeSettlements.length }), ['strikes', 'strikeSettlements'])
    expect(stored).toEqual({ strikes: 3, settlements: 1 })
  })
})
