// Cases move Adviser → Program Chair → Dean → Guidance → OSAS → President's Office in a fixed order (issue #29). The
// President's Office stage was removed on 2026-11-10 and restored on 2026-11-24 to match the paper (Chapter 1,
// Significance of the Study): it receives only executive-level cases from OSAS and can return them to OSAS.
import request from 'supertest'
import { beforeEach, describe, expect, it } from 'vitest'

import { applyAccounts } from '../src/accounts.js'
import { createApp } from '../src/app.js'
import { createRecordRepository } from '../src/persist.js'
import { createMemoryRecordStore } from '../src/records.js'
import { roles, type User } from '../src/schemas.js'
import { createMemoryRepository, type Report } from '../src/store.js'
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
const act = (agent: Agent, recordId: string, type: string, extra: object = {}) =>
  agent.post('/api/pages/P22/actions').send({ action: 'caseAction', recordId, reason: 'Reviewed the case', payload: { type, update: 'An update.', ...extra } })
const report = (id: string) => repo.read().reports.find((r) => r.id === id)!

describe('fixed case order (issue #29)', () => {
  it('lets OSAS transfer a case to the President\'s Office, which can return it to OSAS', async () => {
    const osas = await login('QCU-OSAS')
    const view = (await osas.get('/api/pages/P22?id=RPT-0246')).body.data.record
    expect(view.stage).toBe('osas')
    expect(view.allowedActions).toEqual(['respond', 'recordAction', 'milestone', 'resolve', 'transfer'])
    expect((await act(osas, 'RPT-0246', 'escalate')).status).toBe(409)
    expect((await act(osas, 'RPT-0246', 'transfer')).status).toBe(200)
    expect(report('RPT-0246').stage).toBe('executive')

    const president = await login('QCU-PRESIDENT')
    const atPresident = (await president.get('/api/pages/P22?id=RPT-0246')).body.data.record
    expect(atPresident.allowedActions).toEqual(['respond', 'recordAction', 'resolve', 'return'])
    expect((await act(president, 'RPT-0246', 'transfer')).status).toBe(409)
    expect((await act(president, 'RPT-0246', 'return')).status).toBe(200)
    expect(report('RPT-0246').stage).toBe('osas')
  })

  it('passes over an office whose every member is involved in the report', async () => {
    // RPT-0242 is with the BSIT Program Chair; it is about the Dean, so escalating it skips the Dean.
    const deans = repo.read().users.filter((u) => u.roles.includes('dean')).map((u) => u.id)
    report('RPT-0242').involvedUserIds.push(...deans)
    const sent = await act(await login('QCU-CHAIR-IT'), 'RPT-0242', 'escalate')
    expect(sent.status, JSON.stringify(sent.body)).toBe(200)
    expect(report('RPT-0242').stage).toBe('guidance')
  })

  it('refuses an escalation when no office further on can take the report', async () => {
    const offices = repo.read().users.filter((u) => u.roles.some((r) => ['dean', 'guidance', 'osas', 'president'].includes(r))).map((u) => u.id)
    report('RPT-0242').involvedUserIds.push(...offices)
    const refused = await act(await login('QCU-CHAIR-IT'), 'RPT-0242', 'escalate')
    expect([refused.status, report('RPT-0242').stage]).toEqual([409, 'chair'])
  })

  it('lets OSAS resolve and then close a case', async () => {
    const osas = await login('QCU-OSAS')
    expect((await act(osas, 'RPT-0246', 'resolve')).status).toBe(200)
    expect((await act(osas, 'RPT-0246', 'close')).status).toBe(200)
    expect(report('RPT-0246').status).toBe('Closed')
  })

  it('sends the Dean only to Guidance, and Guidance only to OSAS after a Case File', async () => {
    const dean = await login('QCU-FAC-PAULA-DELACRUZ')
    expect((await act(dean, 'RPT-0243', 'transfer', { nextStage: 'osas' })).status).toBe(409)
    expect(report('RPT-0243').stage).toBe('dean')
    expect((await act(dean, 'RPT-0243', 'transfer')).status).toBe(200)
    expect(report('RPT-0243').stage).toBe('guidance')

    const guidance = await login('QCU-GUIDANCE')
    expect((await act(guidance, 'RPT-0243', 'transfer')).status).toBe(409)
    expect((await act(guidance, 'RPT-0243', 'convert')).status).toBe(200)
    expect((await act(guidance, 'RPT-0243', 'transfer')).status).toBe(200)
    expect(report('RPT-0243').stage).toBe('osas')
  })

  it('refuses a return from OSAS and a jump from the Dean to the President\'s Office', async () => {
    const osas = await login('QCU-OSAS')
    expect((await act(osas, 'RPT-0246', 'return')).status).toBe(409)
    const dean = await login('QCU-FAC-PAULA-DELACRUZ')
    expect((await act(dean, 'RPT-0243', 'transfer', { nextStage: 'executive' })).status).toBe(409)
  })
})

describe('the President\'s Office role (restored 2026-11-24)', () => {
  it('has a president role, label and sample account that can sign in', async () => {
    expect(roles).toContain('president')
    expect(repo.read().users.some((u) => u.id === 'QCU-PRESIDENT' && u.roles.includes('president'))).toBe(true)
    const session = (await (await login('QCU-PRESIDENT')).get('/api/session')).body
    expect(Object.keys(session.roleLabels)).toContain('president')
  })

  it('keeps a stored president role', () => {
    const db = repo.read()
    const base = db.users.find((u) => u.id === 'QCU-OSAS')!
    const presidentOnly = { ...structuredClone(base), id: 'OLD-PRESIDENT', email: 'old.president@example.com', roles: ['president'], active: true } as unknown as User
    applyAccounts(db, [presidentOnly])
    expect(db.users.find((u) => u.id === 'OLD-PRESIDENT')).toMatchObject({ roles: ['president'], active: true })
  })
})

describe('reports stored at the President\'s Office stage', () => {
  it('reads a report stored with stage executive as still being with the President\'s Office', async () => {
    const store = createMemoryRecordStore()
    await createRecordRepository(store).transact((unit) => {
      const r = unit.read().reports.find((item) => item.id === 'RPT-0246')! as unknown as Record<string, unknown> & Report
      ;(r as { stage: string }).stage = 'executive'
    })
    const fresh = createRecordRepository(store)
    const stored = await fresh.view((unit) => unit.read().reports.find((r) => r.id === 'RPT-0246')!)
    expect(stored.stage).toBe('executive')

    app = createApp(fresh, { authStore: setUpAuthStore() })
    const president = await login('QCU-PRESIDENT')
    const view = await president.get('/api/pages/P22?id=RPT-0246')
    expect(view.status).toBe(200)
    expect(view.body.data.record).toMatchObject({ office: "President's Office" })
    expect((await act(president, 'RPT-0246', 'resolve')).status).toBe(200)
  })
})

describe('student IDs stored in the old format (19 November 2026)', () => {
  it('reads QCU-2024-0101 as 24-0101 and leaves a new-format ID alone', () => {
    const db = repo.read()
    const base = db.users.find((u) => u.id === 'QCU-STU-IT-A')!
    const old = { ...structuredClone(base), id: 'OLD-ID-STUDENT', email: 'old.id@example.com', studentId: 'QCU-2023-0456' }
    const current = { ...structuredClone(base), id: 'NEW-ID-STUDENT', email: 'new.id@example.com', studentId: '25-0999' }
    applyAccounts(db, [old, current])
    expect(db.users.find((u) => u.id === 'OLD-ID-STUDENT')!.studentId).toBe('23-0456')
    expect(db.users.find((u) => u.id === 'NEW-ID-STUDENT')!.studentId).toBe('25-0999')
  })
})

describe('home dashboard report order (QA v5 C7)', () => {
  it('lists open, high-severity, most recently updated reports first and closed last', async () => {
    const db = repo.read()
    const student = db.users.find((u) => u.roles.includes('student') && db.reports.some((r) => r.ownerId === u.id))!
    const mine = db.reports.filter((r) => r.ownerId === student.id)
    const base = mine[0]
    const make = (id: string, status: string, severity: Report['severity'], updatedAt: string) => ({ ...base, id, status, severity, updatedAt, caseFileId: undefined })
    mine.forEach((r) => { db.reports.splice(db.reports.indexOf(r), 1) })
    db.reports.push(make('C7-closed', 'Closed', 'high', '2026-11-20T00:00:00Z'), make('C7-low', 'With adviser', 'low', '2026-11-20T00:00:00Z'), make('C7-old', 'With adviser', 'high', '2026-11-01T00:00:00Z'), make('C7-new', 'With adviser', 'high', '2026-11-10T00:00:00Z'))
    const agent = await login(student.studentId ?? student.id)
    const ids = (await agent.get('/api/pages/P03')).body.data.reports.map((r: { id: string }) => r.id)
    expect(ids).toEqual(['C7-new', 'C7-old', 'C7-low', 'C7-closed'])
  })
})
