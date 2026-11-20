// Decisions of 20 November 2026 answering the third round of the QA report of 17 November (QA_andrew_11_17, V3).
import request from 'supertest'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { createApp } from '../src/app.js'
import { createMemoryRepository } from '../src/store.js'
import { seedPassword, secretarySession, setUpAuthStore } from './helpers.js'

let repo: ReturnType<typeof createMemoryRepository>
let app: ReturnType<typeof createApp>
beforeEach(() => { repo = createMemoryRepository(); app = createApp(repo, { authStore: setUpAuthStore() }) })

async function login(id: string) {
  const agent = request.agent(app)
  expect((await agent.post('/api/auth/sign-in').send({ emailOrId: id, password: seedPassword })).status).toBe(200)
  return agent
}

describe('the Secretary in Messages', () => {
  it('opens Messages and can write to students and faculty', async () => {
    const secretary = await secretarySession(app)
    const inbox = await secretary.get('/api/pages/P11')
    expect(inbox.status, JSON.stringify(inbox.body)).toBe(200)
    const recipients = (inbox.body.data.recipients as { id: string }[]).map((r) => r.id)
    expect(recipients).toEqual(expect.arrayContaining(['QCU-STU-IT-A', 'QCU-PROF-IT', 'QCU-CHAIR-CS', 'QCU-OSAS']))
    expect(recipients).not.toContain('QCU-SECRETARY')
  })

  it('messages a student, and the student can answer', async () => {
    const secretary = await secretarySession(app)
    const started = await secretary.post('/api/pages/P11/actions').send({ action: 'createThread', payload: { recipientId: 'QCU-STU-IT-A', body: 'Please bring your registration form.' } })
    expect(started.status, JSON.stringify(started.body)).toBe(200)
    const student = await login('QCU-STU-IT-A')
    const reply = await student.post('/api/pages/P12/actions').send({ action: 'sendMessage', recordId: started.body.record.id, payload: { body: 'Will do, thank you.' } })
    expect(reply.status, JSON.stringify(reply.body)).toBe(200)
  })

  it('can be written to first: a professor finds the Secretary among recipients', async () => {
    await secretarySession(app)
    const professor = await login('QCU-PROF-IT')
    const recipients = ((await professor.get('/api/pages/P11')).body.data.recipients as { id: string }[]).map((r) => r.id)
    expect(recipients).toContain('QCU-SECRETARY')
  })
})

const act = (agent: Awaited<ReturnType<typeof login>>, pageId: string, action: string, payload: object = {}, recordId?: string, reason?: string) =>
  agent.post(`/api/pages/${pageId}/actions`).send({ action, payload, recordId, reason })

// The test clock is 21 October 2026, 08:00 on campus (tests/setup-clock.ts).
describe('times for talking about a concern are still to come', () => {
  it('refuses a preferred time that has passed, and takes one still to come', async () => {
    const student = await login('QCU-STU-IT-A')
    const choose = (preferredAt: string) => act(student, 'P20', 'chooseTalkMode', { reportId: 'RPT-0241', mode: 'face_to_face', consent: { participate: true }, preferredAt })
    const past = await choose('2026-10-20T10:00')
    expect(past.status, JSON.stringify(past.body)).toBe(400)
    expect(JSON.stringify(past.body)).toContain('has not passed yet')
    expect((await choose('2026-10-21T07:30')).status).toBe(400)
    const later = await choose('2026-10-22T10:00')
    expect(later.status, JSON.stringify(later.body)).toBe(200)
  })

  it('refuses a new meeting time that has passed, but keeps a saved one when only the place changes', async () => {
    const student = await login('QCU-STU-IT-A')
    expect((await act(student, 'P20', 'chooseTalkMode', { reportId: 'RPT-0241', mode: 'face_to_face', consent: { participate: true } })).status).toBe(200)
    let adviser = await login('QCU-PROF-IT')
    const details = (payload: object) => act(adviser, 'P22', 'setTalkDetails', { reportId: 'RPT-0241', ...payload })
    expect((await details({ scheduledAt: '2026-10-19T09:00:00.000Z', place: 'Faculty room' })).status).toBe(400)
    const saved = await details({ scheduledAt: '2026-10-21T02:00:00.000Z', place: 'Faculty room' })
    expect(saved.status, JSON.stringify(saved.body)).toBe(200)
    // Two days on, the saved time has passed: changing only the place keeps it.
    vi.setSystemTime(new Date('2026-10-23T00:00:00.000Z'))
    try {
      adviser = await login('QCU-PROF-IT')
      expect((await details({ scheduledAt: '2026-10-21T02:00:00.000Z', place: 'Room 204' })).status).toBe(200)
      expect((await details({ scheduledAt: '2026-10-22T02:00:00.000Z', place: 'Room 204' })).status).toBe(400)
    } finally {
      vi.setSystemTime(new Date('2026-10-21T00:00:00.000Z'))
    }
  })
})

describe('newest first', () => {
  it('lists conversations by their latest message, direct and group alike', async () => {
    const professor = await login('QCU-PROF-IT')
    const started = await act(professor, 'P11', 'createGroupThread', { title: 'Capstone team', body: 'Hello team', memberIds: ['QCU-STU-IT-A', 'QCU-STU-RESTRICTED'] })
    expect(started.status, JSON.stringify(started.body)).toBe(200)
    const student = await login('QCU-STU-IT-A')
    const threads = (await student.get('/api/pages/P11')).body.data.threads as { id: string; updatedAt?: string }[]
    expect(threads[0].id).toBe(started.body.record.id)
    const times = threads.map((thread) => thread.updatedAt ?? '')
    expect(times).toEqual([...times].sort().reverse())
  })

  it('shows the latest audit events first on the administrator overview', async () => {
    const admin = await login('ACCS-ADMIN')
    for (const at of ['2026-10-21T05:00:00.000Z', '2026-10-21T06:00:00.000Z']) repo.read().audit.push({ id: `AUDIT-T-${at}`, at, actorId: 'ACCS-ADMIN', action: 'Settings changed', module: 'settings', reference: 'ACCS-ADMIN', result: 'Recorded' })
    const audit = (await admin.get('/api/pages/P45')).body.data.audit as { at: string }[]
    expect(audit.length).toBeGreaterThan(2)
    expect(audit.map((entry) => entry.at)).toEqual(audit.map((entry) => entry.at).sort().reverse())
  })
})

describe('the assistant', () => {
  const ask = async (question: string) => {
    const student = await login('QCU-STU-IT-A')
    const answer = await act(student, 'P41', 'assistantAsk', { question })
    expect(answer.status).toBe(200)
    return answer.body.record.reply as string
  }
  it('answers what anonymous reporting means instead of listing the student\'s reports', async () => {
    const reply = await ask('What does anonymous reporting mean?')
    expect(reply).toContain('alias')
    expect(reply).not.toContain('filed')
  })
  it('explains how to book an appointment instead of counting calendar items', async () => {
    expect(await ask('How do I book an appointment?')).toContain('Open Appointments')
  })
  it('still summarizes the person\'s own schedule when asked about it', async () => {
    expect(await ask('Show my schedule')).toContain('Your calendar has')
  })
  it('says when the evaluation closes', async () => {
    expect(await ask('When is the next evaluation?')).toMatch(/^1st Semester AY 2026-2027 is open until November 30, 2026\./)
  })
})
