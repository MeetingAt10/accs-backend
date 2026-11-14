// Issue #31: the Program Chair and the Dean have access to every concern in scope, and the adviser can mark a concern
// confidential so that they see its status only (team baseline "ACCS: Features and Flows", 10 November 2026).
import request from 'supertest'
import { beforeEach, describe, expect, it } from 'vitest'

import { createApp } from '../src/app.js'
import { createMemoryAuthStore } from '../src/auth.js'
import { consentWording } from '../src/consent.js'
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
const statement = { narrative: 'A classmate keeps posting about me.', category: 'General concern', severity: 'high', identity: 'named' }
const file = async (student: Agent, extra: object = {}) => (await student.post('/api/pages/P19/actions').send({ action: 'createReport', payload: { ...statement, ...concernChoices, ...extra } })).body.record.id as string
const mark = (agent: Agent, id: string, confidential: boolean, reason = 'The student asked to keep this with me') =>
  agent.post('/api/pages/P22/actions').send({ action: 'setConfidential', recordId: id, reason, payload: { confidential } })
const escalate = (agent: Agent, id: string) => agent.post('/api/pages/P22/actions').send({ action: 'caseAction', recordId: id, reason: 'Needs the chair', payload: { type: 'escalate', update: 'Sent to the chair.' } })
const view = async (agent: Agent, id: string) => (await agent.get(`/api/pages/P22?id=${id}`)).body.data.record
const report = (id: string) => repo.read().reports.find((r) => r.id === id)!

describe('the confidential mark (issue #31)', () => {
  it('limits the Program Chair and the Dean to the status, and keeps the details from them', async () => {
    const [student, adviser, chair, dean] = await Promise.all(['QCU-STU-CS', 'QCU-PROF-CS', 'QCU-CHAIR-CS', 'QCU-FAC-PAULA-DELACRUZ'].map(login))
    const id = await file(student!)
    await student!.post('/api/pages/P20/actions').send({ action: 'chooseTalkMode', payload: { reportId: id, mode: 'chat', consent: { participate: true } } })
    await adviser!.post('/api/pages/P22/actions').send({ action: 'sendReportMessage', recordId: id, payload: { body: 'I am here to help.' } })
    expect((await mark(adviser!, id, true)).status).toBe(200)

    for (const overseer of [chair!, dean!]) {
      const seen = await view(overseer, id)
      expect(seen).toMatchObject({ id, statusOnly: true, confidential: true, status: 'With Adviser', office: 'Adviser' })
      expect(seen.timeline.map((entry: { action: string }) => entry.action)).toEqual(['Submitted', 'Marked confidential'])
      const text = JSON.stringify(seen)
      for (const secret of [statement.narrative, 'Demo Student Hotel', 'I am here to help.', 'The student asked']) expect(text).not.toContain(secret)
      expect(seen).not.toHaveProperty('narrative')
      expect(seen).not.toHaveProperty('reporter')
      expect(seen).not.toHaveProperty('messages')
      expect(seen).not.toHaveProperty('notes')
    }
    // The adviser and the student still see everything.
    expect(await view(adviser!, id)).toMatchObject({ narrative: statement.narrative, confidential: true, readOnly: false })
    expect((await student!.get(`/api/pages/P20?id=${id}`)).body.data.record).toMatchObject({ confidential: true })
  })

  it('keeps the student\'s answers on a concern filed under the earlier consent wording', async () => {
    const [student, chair, dean] = await Promise.all(['QCU-STU-CS', 'QCU-CHAIR-CS', 'QCU-FAC-PAULA-DELACRUZ'].map(login))
    const id = await file(student!)
    Object.assign(report(id), { consent: { ...report(id).consent!, version: '2026-11-05' }, allowChair: false, allowDean: true })
    expect(JSON.stringify((await chair!.get(`/api/pages/P22?id=${id}`)).body)).not.toContain(statement.narrative)
    expect(await view(dean!, id)).toMatchObject({ narrative: statement.narrative, allowChair: false, allowDean: true })
  })

  it('keeps the words of a confidential report out of its similar-report group', async () => {
    const chair = await login('QCU-CHAIR-IT')
    const before = (await chair.get('/api/pages/P23')).body.data.clusters.find((c: { id: string }) => c.id === 'CLUSTER-0101')
    expect(before.title).toBe('Lab schedule changes')
    report('RPT-0241').confidential = true
    const cluster = (await chair.get('/api/pages/P23')).body.data.clusters.find((c: { id: string }) => c.id === 'CLUSTER-0101')
    expect(cluster).toMatchObject({ title: 'Similar reports', phrases: [], dissenting: '' })
    expect(JSON.stringify((await chair.get('/api/pages/P24?id=CLUSTER-0101')).body.data.record)).not.toContain('Lab schedule')
  })

  it('still counts a confidential concern in the chair’s and the Dean’s lists and analytics', async () => {
    const [student, adviser, chair] = await Promise.all(['QCU-STU-CS', 'QCU-PROF-CS', 'QCU-CHAIR-CS'].map(login))
    const id = await file(student!)
    await mark(adviser!, id, true)
    const listed = ((await chair!.get('/api/pages/P21')).body.data.cases as { id: string; statusOnly?: boolean }[]).find((c) => c.id === id)
    expect(listed).toMatchObject({ statusOnly: true })
    const openStat = ((await chair!.get('/api/pages/P25')).body.data.stats as { label: string; value: number }[]).find((s) => s.label === 'Open')!.value
    expect(openStat).toBeGreaterThan(0)
  })

  it('keeps a confidential concern with the adviser until the mark is removed', async () => {
    const [student, adviser, chair] = await Promise.all(['QCU-STU-CS', 'QCU-PROF-CS', 'QCU-CHAIR-CS'].map(login))
    const id = await file(student!)
    await mark(adviser!, id, true)
    const blocked = await escalate(adviser!, id)
    expect([blocked.status, blocked.body.error]).toEqual([409, 'This concern is confidential. Remove the confidential mark before escalating it.'])
    expect(report(id).stage).toBe('adviser')

    expect((await mark(adviser!, id, false)).status).toBe(200)
    expect((await view(chair!, id))).toMatchObject({ narrative: statement.narrative, readOnly: true })
    expect((await escalate(adviser!, id)).status).toBe(200)
    expect(report(id).stage).toBe('chair')
  })

  it('records every change in the history and the audit trail, tells the student, and needs a reason', async () => {
    const [student, adviser] = await Promise.all(['QCU-STU-CS', 'QCU-PROF-CS'].map(login))
    const id = await file(student!)
    const noReason = await mark(adviser!, id, true, '  ')
    expect(noReason.status).toBe(400)
    expect(report(id).confidential).toBeUndefined()

    expect((await mark(adviser!, id, true)).status).toBe(200)
    expect((await mark(adviser!, id, true)).status).toBe(409)
    expect((await mark(adviser!, id, false)).status).toBe(200)
    expect(report(id).history.slice(-2).map((h) => [h.action, h.actorId, h.public])).toEqual([['Marked confidential', 'QCU-PROF-CS', true], ['Confidential mark removed', 'QCU-PROF-CS', true]])
    expect(repo.read().audit.filter((a) => a.reference === id).map((a) => a.action)).toEqual(expect.arrayContaining(['Marked confidential', 'Confidential mark removed']))
    expect(repo.read().notifications.filter((n) => n.recipientId === 'QCU-STU-CS' && n.recordId === id && n.kind === 'case')).toHaveLength(2)
    const history = (await student!.get(`/api/pages/P20?id=${id}`)).body.data.record.history as { action: string }[]
    expect(history.map((h) => h.action)).toContain('Marked confidential')
    expect(JSON.stringify(history)).not.toContain('The student asked')
  })

  it('can be set only by the adviser, only while the concern is with them, and never on a concern about the adviser', async () => {
    const [student, adviser, chair, dean] = await Promise.all(['QCU-STU-CS', 'QCU-PROF-CS', 'QCU-CHAIR-CS', 'QCU-FAC-PAULA-DELACRUZ'].map(login))
    const id = await file(student!)
    expect((await mark(chair!, id, true)).status).toBe(404)
    expect((await mark(dean!, id, true)).status).toBe(404)
    expect((await escalate(adviser!, id)).status).toBe(200)
    // At the chair stage the adviser no longer handles it, and the chair is not the adviser.
    expect((await mark(adviser!, id, true)).status).toBe(404)
    expect([(await mark(chair!, id, true)).status, report(id).confidential]).toEqual([409, undefined])

    const about = await file(student!, { aboutAdvisor: true })
    expect((await mark(chair!, about, true)).status).toBe(409)
    expect(report(about).confidential).toBeUndefined()
  })
})

describe('what readers who are not handling the concern see (issue #31)', () => {
  it('shows the chair and the Dean an alias when the student shared their name with the adviser only', async () => {
    const [student, chair, dean] = await Promise.all(['QCU-STU-CS', 'QCU-CHAIR-CS', 'QCU-FAC-PAULA-DELACRUZ'].map(login))
    const id = await file(student!, { identity: 'anonymous' })
    expect((await student!.post('/api/pages/P20/actions').send({ action: 'discloseIdentity', recordId: id, payload: {} })).status).toBe(200)
    expect(report(id).disclosedTo).toEqual(['adviser'])
    expect((await view(await login('QCU-PROF-CS'), id)).reporter).toMatchObject({ name: 'Demo Student Hotel' })
    for (const overseer of [chair!, dean!]) {
      const seen = await view(overseer, id)
      expect(seen.reporter).toMatchObject({ anonymous: true })
      expect(JSON.stringify(seen)).not.toContain('Demo Student Hotel')
    }
  })

  it('shows an office that handled the case earlier its status, not the statement (issue #30)', async () => {
    const [dean, guidance] = await Promise.all(['QCU-FAC-PAULA-DELACRUZ', 'QCU-GUIDANCE'].map(login))
    const act = (agent: Agent, type: string) => agent.post('/api/pages/P22/actions').send({ action: 'caseAction', recordId: 'RPT-0243', reason: 'Next step', payload: { type, update: 'Moved on.' } })
    expect((await act(dean!, 'transfer')).status).toBe(200)
    expect((await act(guidance!, 'convert')).status).toBe(200)
    expect((await act(guidance!, 'transfer')).status).toBe(200)
    const seen = await view(guidance!, 'RPT-0243')
    expect(seen).toMatchObject({ statusOnly: true, stage: 'osas', office: 'OSAS' })
    expect(seen).not.toHaveProperty('narrative')
    expect(seen).not.toHaveProperty('messages')
  })
})

describe('filing without the chair and Dean questions (issue #31)', () => {
  it('files with only the agreement and the about-the-adviser answer, and stores the new wording', async () => {
    const student = await login('QCU-STU-CS')
    const response = await student.post('/api/pages/P19/actions').send({ action: 'createReport', payload: { ...statement, consent: { readStatement: true }, aboutAdvisor: false } })
    expect(response.status).toBe(200)
    const stored = report(response.body.record.id)
    expect(stored.consent).toMatchObject({ version: consentWording.version, wording: consentWording.report })
    expect(consentWording.report).toContain('The Program Chair of my program and the Dean can also read it, unless my adviser marks it confidential')
    expect(consentWording.report).not.toContain('I choose whether')
  })
})
