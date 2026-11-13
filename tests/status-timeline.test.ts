// Issue #30: an office a case has moved past keeps its status updates and is told about later steps (team baseline
// "ACCS: Features and Flows", 10 November 2026). The Program Chair and the Dean oversee every concern in scope anyway.
import request from 'supertest'
import { beforeEach, describe, expect, it } from 'vitest'

import { isEarlierHandler } from '../src/access.js'
import { createApp } from '../src/app.js'
import { createMemoryAuthStore } from '../src/auth.js'
import { createMemoryRepository } from '../src/store.js'
import { concernChoices, seedPassword } from './helpers.js'

let repo: ReturnType<typeof createMemoryRepository>
let app: ReturnType<typeof createApp>
beforeEach(() => { repo = createMemoryRepository(); app = createApp(repo, { authStore: createMemoryAuthStore() }) })

async function login(id: string) {
  const agent = request.agent(app)
  expect((await agent.post('/api/auth/sign-in').send({ emailOrId: id, password: seedPassword })).status).toBe(200)
  return agent
}
type Agent = Awaited<ReturnType<typeof login>>
const statement = { narrative: 'Someone took my laptop charger from the lab.', category: 'General concern', severity: 'medium', identity: 'named' }
const file = async (student: Agent, extra: object = {}) => (await student.post('/api/pages/P19/actions').send({ action: 'createReport', payload: { ...statement, ...concernChoices, ...extra } })).body.record.id as string
const act = (agent: Agent, id: string, type: string, update = 'An update.') => agent.post('/api/pages/P22/actions').send({ action: 'caseAction', recordId: id, reason: 'Next step', payload: { type, update } })
const view = async (agent: Agent, id: string) => (await agent.get(`/api/pages/P22?id=${id}`)).body.data.record
const caseNotices = (userId: string, id: string) => repo.read().notifications.filter((n) => n.recipientId === userId && n.recordId === id && n.kind === 'case').length
const users = () => new Map(repo.read().users.map((u) => [u.id, u]))
const report = (id: string) => repo.read().reports.find((r) => r.id === id)!

describe('status timeline for offices the case moved past (issue #30)', () => {
  it('gives the adviser the status timeline after escalating, without the statement, messages or later notes', async () => {
    const [student, adviser, chair] = await Promise.all(['QCU-STU-CS', 'QCU-PROF-CS', 'QCU-CHAIR-CS'].map(login))
    const id = await file(student!)
    await student!.post('/api/pages/P20/actions').send({ action: 'chooseTalkMode', payload: { reportId: id, mode: 'chat', consent: { participate: true } } })
    await student!.post('/api/pages/P20/actions').send({ action: 'sendReportMessage', recordId: id, payload: { body: 'Please help me.' } })
    expect((await act(adviser!, id, 'escalate', 'Sent to the chair.')).status).toBe(200)
    await chair!.post('/api/pages/P22/actions').send({ action: 'addNote', recordId: id, payload: { body: 'Chair private note' } })
    expect((await act(chair!, id, 'recordAction', 'The chair met the student.')).status).toBe(200)

    const seen = await view(adviser!, id)
    expect(seen).toMatchObject({ statusOnly: true, stage: 'chair', office: 'Program Chair', status: 'With Program Chair', statusNotice: 'This concern is now with Program Chair. You can follow its status here.' })
    expect(seen.timeline.map((t: { action: string; office: string }) => [t.action, t.office])).toEqual([['Submitted', 'Adviser'], ['Transferred', 'Program Chair'], ['Action recorded', 'Program Chair']])
    const text = JSON.stringify(seen)
    for (const secret of [statement.narrative, 'Please help me.', 'Chair private note', 'Noa Vale']) expect(text).not.toContain(secret)
    // The case shows in the adviser's queue as a status row, and the adviser cannot act on it.
    expect(((await adviser!.get('/api/pages/P21')).body.data.cases as { id: string; statusOnly?: boolean }[]).find((c) => c.id === id)).toMatchObject({ statusOnly: true })
    expect((await act(adviser!, id, 'resolve')).status).toBe(404)
  })

  it('tells the adviser about each later step, but not about its own escalation', async () => {
    const [student, adviser, chair, dean] = await Promise.all(['QCU-STU-CS', 'QCU-PROF-CS', 'QCU-CHAIR-CS', 'CCS-DEAN'].map(login))
    const id = await file(student!)
    const before = caseNotices('QCU-PROF-CS', id)
    expect((await act(adviser!, id, 'escalate')).status).toBe(200)
    expect(caseNotices('QCU-PROF-CS', id)).toBe(before)
    expect((await act(chair!, id, 'recordAction')).status).toBe(200)
    expect((await act(chair!, id, 'escalate')).status).toBe(200)
    expect((await act(dean!, id, 'resolve')).status).toBe(200)
    expect(caseNotices('QCU-PROF-CS', id)).toBe(before + 3)
    // The chair, now an earlier handler too, hears about the Dean's step.
    expect(caseNotices('QCU-CHAIR-CS', id)).toBeGreaterThanOrEqual(1)
  })

  it('keeps Guidance following a case after forwarding it to OSAS, and tells it about OSAS steps', async () => {
    const [dean, guidance, osas] = await Promise.all(['CCS-DEAN', 'QCU-GUIDANCE', 'QCU-OSAS'].map(login))
    expect((await act(dean!, 'RPT-0243', 'transfer')).status).toBe(200)
    expect((await act(guidance!, 'RPT-0243', 'convert')).status).toBe(200)
    expect((await act(guidance!, 'RPT-0243', 'transfer')).status).toBe(200)
    const before = caseNotices('QCU-GUIDANCE', 'RPT-0243')
    expect((await act(osas!, 'RPT-0243', 'milestone', 'Student called in.')).status).toBe(200)
    expect(caseNotices('QCU-GUIDANCE', 'RPT-0243')).toBe(before + 1)
    const seen = await view(guidance!, 'RPT-0243')
    expect(seen).toMatchObject({ statusOnly: true, office: 'OSAS' })
    expect(seen.timeline.at(-1)).toMatchObject({ action: 'Milestone added', office: 'OSAS' })
    expect(seen).not.toHaveProperty('narrative')
  })

  it('never includes an adviser the concern is about, at any stage', async () => {
    const [student, chair, dean] = await Promise.all(['QCU-STU-CS', 'QCU-CHAIR-CS', 'CCS-DEAN'].map(login))
    const id = await file(student!, { aboutAdvisor: true })
    expect((await act(chair!, id, 'escalate')).status).toBe(200)
    expect((await act(dean!, id, 'recordAction')).status).toBe(200)
    expect(isEarlierHandler(users().get('QCU-PROF-CS')!, report(id))).toBe(false)
    expect((await (await login('QCU-PROF-CS')).get(`/api/pages/P22?id=${id}`)).status).toBe(404)
    expect(repo.read().notifications.some((n) => n.recipientId === 'QCU-PROF-CS' && n.recordId === id)).toBe(false)
  })

  it('never treats a person named in the concern as an earlier handler, so they are not told about it', async () => {
    // RPT-0246 has passed Guidance and is at OSAS. If it names the Guidance officer, Guidance must not follow it.
    report('RPT-0246').involvedUserIds = ['QCU-GUIDANCE']
    expect(isEarlierHandler(users().get('QCU-GUIDANCE')!, report('RPT-0246'))).toBe(false)
    const before = repo.read().notifications.filter((n) => n.recipientId === 'QCU-GUIDANCE' && n.recordId === 'RPT-0246').length
    expect((await act(await login('QCU-OSAS'), 'RPT-0246', 'milestone')).status).toBe(200)
    expect(repo.read().notifications.filter((n) => n.recipientId === 'QCU-GUIDANCE' && n.recordId === 'RPT-0246')).toHaveLength(before)
    expect((await (await login('QCU-GUIDANCE')).get('/api/pages/P22?id=RPT-0246')).status).toBe(404)
  })

  it('is not an earlier handler for the current office, the student, or an office the case never reached', async () => {
    const [student, adviser] = await Promise.all(['QCU-STU-CS', 'QCU-PROF-CS'].map(login))
    const id = await file(student!)
    const u = users()
    expect(isEarlierHandler(u.get('QCU-PROF-CS')!, report(id))).toBe(false)
    expect(isEarlierHandler(u.get('QCU-STU-CS')!, report(id))).toBe(false)
    expect(isEarlierHandler(u.get('QCU-GUIDANCE')!, report(id))).toBe(false)
    expect((await (await login('QCU-GUIDANCE')).get(`/api/pages/P22?id=${id}`)).status).toBe(404)
    expect((await act(adviser!, id, 'escalate')).status).toBe(200)
    expect(isEarlierHandler(users().get('QCU-PROF-CS')!, report(id))).toBe(true)
  })

  it('leaves the Program Chair and the Dean with the full read-only view after the case moves on', async () => {
    const [student, adviser, chair, dean] = await Promise.all(['QCU-STU-CS', 'QCU-PROF-CS', 'QCU-CHAIR-CS', 'CCS-DEAN'].map(login))
    const id = await file(student!)
    await act(adviser!, id, 'escalate')
    await act(chair!, id, 'escalate')
    await act(dean!, id, 'transfer')
    for (const overseer of [chair!, dean!]) expect(await view(overseer, id)).toMatchObject({ readOnly: true, narrative: statement.narrative })
  })
})
