// Issue #29: the President's Office is removed, and cases move Adviser → Program Chair → Dean → Guidance → OSAS in a fixed
// order, with OSAS as the last stage (team baseline "ACCS: Features and Flows", 10 November 2026).
import request from 'supertest'
import { beforeEach, describe, expect, it } from 'vitest'

import { applyAccounts } from '../src/accounts.js'
import { createApp } from '../src/app.js'
import { createMemoryAuthStore } from '../src/auth.js'
import { createRecordRepository } from '../src/persist.js'
import { createMemoryRecordStore } from '../src/records.js'
import { roles, type User } from '../src/schemas.js'
import { createMemoryRepository, type Report } from '../src/store.js'
import { seedPassword } from './helpers.js'

let repo: ReturnType<typeof createMemoryRepository>
let app: ReturnType<typeof createApp>
beforeEach(() => { repo = createMemoryRepository(); app = createApp(repo) })

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
  it('offers OSAS no way to forward or escalate: it is the last stage', async () => {
    const osas = await login('QCU-OSAS')
    const view = (await osas.get('/api/pages/P22?id=RPT-0246')).body.data.record
    expect(view.stage).toBe('osas')
    expect(view.allowedActions).toEqual(['respond', 'recordAction', 'milestone', 'resolve'])
    for (const type of ['transfer', 'escalate']) {
      expect((await act(osas, 'RPT-0246', type)).status).toBe(409)
      expect(report('RPT-0246').stage).toBe('osas')
    }
  })

  it('lets OSAS resolve and then close a case', async () => {
    const osas = await login('QCU-OSAS')
    expect((await act(osas, 'RPT-0246', 'resolve')).status).toBe(200)
    expect((await act(osas, 'RPT-0246', 'close')).status).toBe(200)
    expect(report('RPT-0246').status).toBe('Closed')
  })

  it('sends the Dean only to Guidance, and Guidance only to OSAS after a Case File', async () => {
    const dean = await login('QCU-DEAN')
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

  it('no longer accepts a "return" action or a President\'s Office stage', async () => {
    const osas = await login('QCU-OSAS')
    expect((await act(osas, 'RPT-0246', 'return')).status).toBe(400)
    const dean = await login('QCU-DEAN')
    expect((await act(dean, 'RPT-0243', 'transfer', { nextStage: 'executive' })).status).toBe(400)
  })
})

describe('the President\'s Office role is gone (issue #29)', () => {
  it('has no president role, label, permission or sample account', async () => {
    expect(roles).not.toContain('president')
    expect(repo.read().users.some((u) => u.id === 'QCU-PRESIDENT')).toBe(false)
    const session = (await (await login('QCU-DEAN')).get('/api/session')).body
    expect(Object.keys(session.roleLabels)).not.toContain('president')
    expect((await request(app).post('/api/auth/sign-in').send({ emailOrId: 'QCU-PRESIDENT', password: seedPassword })).status).toBe(401)
  })

  it('drops a stored president role, and deactivates an account left with no role', () => {
    const db = repo.read()
    const base = db.users.find((u) => u.id === 'QCU-OSAS')!
    const presidentOnly = { ...structuredClone(base), id: 'OLD-PRESIDENT', email: 'old.president@example.com', roles: ['president'], active: true } as unknown as User
    const both = { ...structuredClone(base), id: 'OLD-BOTH', email: 'old.both@example.com', roles: ['osas', 'president'], active: true } as unknown as User
    applyAccounts(db, [presidentOnly, both])
    expect(db.users.find((u) => u.id === 'OLD-PRESIDENT')).toMatchObject({ roles: [], active: false })
    expect(db.users.find((u) => u.id === 'OLD-BOTH')).toMatchObject({ roles: ['osas'], active: true })
  })
})

describe('reports stored at the removed stage (issue #29)', () => {
  it('reads a report stored with stage executive as being with OSAS, and OSAS can act on it', async () => {
    const store = createMemoryRecordStore()
    // A report saved before the change: at the President's Office, with that stage in its history and disclosures.
    await createRecordRepository(store).transact((unit) => {
      const r = unit.read().reports.find((item) => item.id === 'RPT-0246')! as unknown as Record<string, unknown> & Report
      ;(r as { stage: string }).stage = 'executive'
      r.history.push({ ...r.history.at(-1)!, id: 'H-OLD', actorId: 'QCU-PRESIDENT', actorRole: 'president', stage: 'executive' as never })
      ;(r as { disclosedTo: string[] }).disclosedTo = ['osas', 'executive']
    })

    const fresh = createRecordRepository(store)
    const stored = await fresh.view((unit) => unit.read().reports.find((r) => r.id === 'RPT-0246')!)
    expect(stored.stage).toBe('osas')
    expect(stored.history.map((h) => h.stage)).not.toContain('executive')
    expect(stored.disclosedTo).toEqual(['osas'])

    app = createApp(fresh, { authStore: createMemoryAuthStore() })
    const osas = await login('QCU-OSAS')
    const view = await osas.get('/api/pages/P22?id=RPT-0246')
    expect(view.status).toBe(200)
    expect(view.body.data.record.status).toBe('With OSAS')
    expect((await act(osas, 'RPT-0246', 'resolve')).status).toBe(200)
  })
})
