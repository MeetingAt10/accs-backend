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

// Decided 20 November 2026: a permission change is a request the Secretary approves, and an approved change takes effect.
describe('permission change requests', () => {
  const propose = (agent: Awaited<ReturnType<typeof login>>, role: string, permission: string, allowed: boolean) =>
    act(agent, 'P48', 'updatePermission', { role, permission, allowed }, undefined, 'QA check of the approval flow')
  const decide = (agent: Awaited<ReturnType<typeof login>>, key: string, decision: 'approve' | 'reject') =>
    act(agent, 'P48', 'decidePermission', { key, decision }, undefined, 'Reviewed with the Dean')
  const permissionsOf = async (id: string) => ((await (await login(id)).get('/api/session')).body.permissions as string[])

  it('changes nothing until the Secretary approves, then applies to everyone with that role', async () => {
    const secretary = await secretarySession(app)
    const admin = await login('ACCS-ADMIN')
    const proposed = await propose(admin, 'osas', 'post.create', false)
    expect(proposed.status, JSON.stringify(proposed.body)).toBe(200)
    expect(proposed.body.message).toBe('Sent to the CCS Secretary for approval.')
    expect(await permissionsOf('QCU-OSAS')).toContain('post.create')
    // The Secretary is told, and sees the request as one she can decide.
    expect(repo.read().notifications.some((n) => n.kind === 'permission' && n.recordId === 'osas:post.create')).toBe(true)
    const matrix = (await secretary.get('/api/pages/P48')).body.data
    expect(matrix.permissionRequests).toEqual([expect.objectContaining({ key: 'osas:post.create', allowed: false, proposedBy: 'Demo Administrator', canDecide: true })])
    expect((await decide(secretary, 'osas:post.create', 'approve')).status).toBe(200)
    expect(await permissionsOf('QCU-OSAS')).not.toContain('post.create')
    const osas = await login('QCU-OSAS')
    expect((await act(osas, 'P05', 'createPost', { title: 'Office hours', body: 'We are open.', audience: 'college', kind: 'discussion', label: 'Discussion' })).status).toBe(403)
    const after = (await secretary.get('/api/pages/P48')).body.data
    expect(after.permissionRequests).toEqual([])
    expect(after.permissionMatrix.find((row: { key: string }) => row.key === 'post.create').roles).not.toContain('osas')
  })

  it('leaves the permission as it was when the request is rejected', async () => {
    const secretary = await secretarySession(app)
    const admin = await login('ACCS-ADMIN')
    await propose(admin, 'osas', 'post.create', false)
    expect((await decide(secretary, 'osas:post.create', 'reject')).status).toBe(200)
    expect(await permissionsOf('QCU-OSAS')).toContain('post.create')
  })

  it('never lets anyone approve their own request: the administrator decides the Secretary\'s', async () => {
    const secretary = await secretarySession(app)
    expect((await propose(secretary, 'secretary', 'roster.view', true)).status).toBe(200)
    expect((await decide(secretary, 'secretary:roster.view', 'approve')).status).toBe(403)
    const admin = await login('ACCS-ADMIN')
    expect((await decide(admin, 'secretary:roster.view', 'approve')).status).toBe(200)
  })

  it('keeps who manages roles, accounts, approvals and the audit trail out of reach of any request', async () => {
    const admin = await login('ACCS-ADMIN')
    for (const permission of ['role.manage', 'permission.review', 'account.provision', 'audit.view']) {
      const response = await propose(admin, 'student', permission, true)
      expect([permission, response.status]).toEqual([permission, 400])
    }
  })

  it('refuses a decision from someone who does not review permissions', async () => {
    const admin = await login('ACCS-ADMIN')
    await propose(admin, 'osas', 'post.create', false)
    const dean = await login('QCU-FAC-PAULA-DELACRUZ')
    expect((await decide(dean, 'osas:post.create', 'approve')).status).toBe(403)
  })
})

describe('role changes by the Secretary', () => {
  it('lets the Secretary change roles, like the administrator (decided 20 November 2026)', async () => {
    const secretary = await secretarySession(app)
    const saved = await act(secretary, 'P47', 'updateRoles', { roles: ['professor', 'chair'], program: 'BSIT' }, 'QCU-PROF-IT', 'Named BSIT chair')
    expect(saved.status, JSON.stringify(saved.body)).toBe(200)
    expect(repo.read().users.find((u) => u.id === 'QCU-PROF-IT')!.roles).toEqual(['professor', 'chair'])
  })

  it('sets a student\'s year level, within what the campus teaches', async () => {
    const admin = await login('ACCS-ADMIN')
    expect((await act(admin, 'P47', 'updateRoles', { roles: ['student'], year: 4, section: 'B' }, 'QCU-STU-IT-A', 'Moved up')).status).toBe(200)
    expect(repo.read().users.find((u) => u.id === 'QCU-STU-IT-A')).toMatchObject({ year: 4, section: 'B' })
    expect((await act(admin, 'P47', 'updateRoles', { roles: ['professor'], year: 2 }, 'QCU-PROF-IT', 'Wrong field')).body.error).toBe('Only students have a year level.')
    repo.read().users.find((u) => u.id === 'QCU-STU-CS')!.campus = 'BAT'
    expect((await act(admin, 'P47', 'updateRoles', { roles: ['student'], year: 3 }, 'QCU-STU-CS', 'Moved up')).body.error).toMatch(/1st and 2nd year only/)
  })
})

describe('an approved permission change on every instance', () => {
  it('applies on another instance that shares only the accounts store', async () => {
    const authStore = setUpAuthStore()
    const first = createApp(createMemoryRepository(), { authStore })
    const second = createApp(createMemoryRepository(), { authStore })
    const signInTo = async (instance: typeof first, id: string) => {
      const agent = request.agent(instance)
      expect((await agent.post('/api/auth/sign-in').send({ emailOrId: id, password: seedPassword })).status).toBe(200)
      return agent
    }
    const secretary = await secretarySession(first)
    const admin = await signInTo(first, 'ACCS-ADMIN')
    expect((await act(admin, 'P48', 'updatePermission', { role: 'osas', permission: 'post.create', allowed: false }, undefined, 'QA check')).status).toBe(200)
    expect((await act(secretary, 'P48', 'decidePermission', { key: 'osas:post.create', decision: 'approve' }, undefined, 'Agreed')).status).toBe(200)
    const osasElsewhere = await signInTo(second, 'QCU-OSAS')
    expect((await osasElsewhere.get('/api/session')).body.permissions).not.toContain('post.create')
  })
})

describe('adding people to a group', () => {
  const startGroup = async () => {
    const professor = await login('QCU-PROF-IT')
    const started = await act(professor, 'P11', 'createGroupThread', { title: 'Capstone team', body: 'Hello team', memberIds: ['QCU-STU-IT-A', 'QCU-STU-RESTRICTED'] })
    expect(started.status, JSON.stringify(started.body)).toBe(200)
    return { professor, id: started.body.record.id as string }
  }

  it('lets a member add people they can message, who then see the whole conversation', async () => {
    const { professor, id } = await startGroup()
    const added = await act(professor, 'P12', 'addGroupMembers', { memberIds: ['QCU-CHAIR-IT'] }, id)
    expect(added.status, JSON.stringify(added.body)).toBe(200)
    const chair = await login('QCU-CHAIR-IT')
    const page = (await chair.get(`/api/pages/P12?id=${id}`)).body.data.record
    expect(page.members.map((m: { id: string }) => m.id)).toContain('QCU-CHAIR-IT')
    expect(page.messages.map((m: { body: string }) => m.body)).toContain('Hello team')
    expect(page.unread).toBe(0)
    expect(repo.read().notifications.some((n) => n.recipientId === 'QCU-CHAIR-IT' && n.recordId === id)).toBe(true)
  })

  it('refuses people the member cannot message, people already in it, and direct conversations', async () => {
    const { professor, id } = await startGroup()
    expect((await act(professor, 'P12', 'addGroupMembers', { memberIds: ['QCU-STU-CS'] }, id)).status).toBe(404)
    expect((await act(professor, 'P12', 'addGroupMembers', { memberIds: ['QCU-STU-IT-A'] }, id)).status).toBe(409)
    const student = await login('QCU-STU-IT-A')
    expect((await act(student, 'P12', 'addGroupMembers', { memberIds: ['QCU-STU-RESTRICTED'] }, 'THREAD-DIRECT-1')).status).toBe(409)
  })
})

describe('unsent messages', () => {
  it('keeps a draft per conversation on the server until it is sent', async () => {
    const student = await login('QCU-STU-IT-A')
    expect((await act(student, 'P12', 'saveMessageDraft', { body: 'Half a thought' }, 'THREAD-IT-A')).status).toBe(200)
    // Another device sees the same draft.
    const elsewhere = await login('QCU-STU-IT-A')
    expect((await elsewhere.get('/api/pages/P12?id=THREAD-IT-A')).body.data.record.draft).toMatchObject({ body: 'Half a thought', attachments: [] })
    // Other people never see it.
    const professor = await login('QCU-PROF-IT')
    expect((await professor.get('/api/pages/P12?id=THREAD-IT-A')).body.data.record.draft).toBeUndefined()
    expect((await act(elsewhere, 'P12', 'sendMessage', { body: 'Half a thought, finished.' }, 'THREAD-IT-A')).status).toBe(200)
    expect((await student.get('/api/pages/P12?id=THREAD-IT-A')).body.data.record.draft).toBeUndefined()
  })

  it('forgets a draft that is emptied, and refuses a conversation the person is not in', async () => {
    const student = await login('QCU-STU-IT-A')
    await act(student, 'P12', 'saveMessageDraft', { body: 'Something' }, 'THREAD-IT-A')
    expect((await act(student, 'P12', 'saveMessageDraft', { body: '   ' }, 'THREAD-IT-A')).status).toBe(200)
    expect((await student.get('/api/pages/P12?id=THREAD-IT-A')).body.data.record.draft).toBeUndefined()
    const outsider = await login('QCU-STU-CS')
    expect((await act(outsider, 'P12', 'saveMessageDraft', { body: 'Hi' }, 'THREAD-IT-A')).status).toBe(404)
  })
})
