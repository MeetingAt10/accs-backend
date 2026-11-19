// Fixes and decisions from the QA of 17 November 2026 (QA_andrew_11_17 and testing_v2), decided 19 November 2026.
import request from 'supertest'
import { beforeEach, describe, expect, it } from 'vitest'

import { createApp } from '../src/app.js'
import { rolesProblem } from '../src/services.js'
import { createMemoryRepository } from '../src/store.js'
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
const setRoles = (admin: Agent, id: string, payload: object) => admin.post('/api/pages/P47/actions').send({ action: 'updateRoles', recordId: id, reason: 'QA check', payload })
const rolesOf = (id: string) => repo.read().users.find((u) => u.id === id)!.roles

describe('which roles one account may hold', () => {
  it('keeps a student a student: no administrator, professor or Dean on top (QA: all roles could be ticked and saved)', async () => {
    const admin = await login('ACCS-ADMIN')
    for (const roles of [['student', 'administrator'], ['student', 'professor', 'dean'], ['student', 'secretary']]) {
      const response = await setRoles(admin, 'QCU-STU-IT-A', { roles })
      expect([roles.join('+'), response.status, response.body.code]).toEqual([roles.join('+'), 400, 'VALIDATION_ERROR'])
      expect(response.body.error).toMatch(/student role only/)
    }
    expect(rolesOf('QCU-STU-IT-A')).toEqual(['student'])
  })

  it('gives faculty at most two roles, like Dean and professor', async () => {
    const admin = await login('ACCS-ADMIN')
    expect((await setRoles(admin, 'QCU-PROF-IT', { roles: ['professor', 'chair', 'dean'], program: 'BSIT' })).status).toBe(400)
    expect((await setRoles(admin, 'QCU-PROF-IT', { roles: ['professor', 'chair'], program: 'BSIT' })).status).toBe(200)
    expect(rolesOf('QCU-PROF-IT')).toEqual(['professor', 'chair'])
  })

  it('gives a section to students only, and only as letters (QA: section 200 was accepted)', async () => {
    const admin = await login('ACCS-ADMIN')
    expect((await setRoles(admin, 'QCU-PROF-IT', { roles: ['professor'], section: 'A' })).body.error).toBe('Only students have a section.')
    expect((await setRoles(admin, 'QCU-STU-IT-A', { roles: ['student'], section: '200' })).body.error).toBe('Use the section letter, like A.')
    expect((await setRoles(admin, 'QCU-STU-IT-A', { roles: ['student'], section: 'c' })).status).toBe(200)
    expect(repo.read().users.find((u) => u.id === 'QCU-STU-IT-A')!.section).toBe('C')
  })

  it('answers each problem in words', () => {
    expect(rolesProblem(['professor', 'professor'])).toBe('Choose each role once.')
    expect(rolesProblem(['organization', 'student'])).toMatch(/student role only/)
    expect(rolesProblem(['organization', 'professor'])).toBe('An organization account has the organization role only.')
    expect(rolesProblem(['dean', 'professor'])).toBeUndefined()
    expect(rolesProblem(['student'], 'AB')).toBeUndefined()
  })
})

describe('the student report progress (decided 19 November 2026)', () => {
  const statement = { narrative: 'Someone took my laptop charger from the lab.', category: 'General concern', severity: 'medium', identity: 'named' }
  const progress = async (student: Agent, id: string) => (await student.get(`/api/pages/P20?id=${id}`)).body.data.record.progress

  it('moves Submitted, Read, Escalated, Resolved, Closed', async () => {
    const { concernChoices } = await import('./helpers.js')
    const [student, adviser, chair, dean] = await Promise.all(['QCU-STU-CS', 'QCU-PROF-CS', 'QCU-CHAIR-CS', 'QCU-FAC-PAULA-DELACRUZ'].map(login))
    const id = (await student!.post('/api/pages/P19/actions').send({ action: 'createReport', payload: { ...statement, ...concernChoices } })).body.record.id as string
    expect(await progress(student!, id)).toMatchObject({ steps: ['Submitted', 'Read', 'Escalated', 'Resolved', 'Closed'], step: 0, label: 'Submitted' })
    // The Dean can look at it, but is not handling it, so it is not Read yet.
    await dean!.get(`/api/pages/P22?id=${id}`)
    expect((await progress(student!, id)).step).toBe(0)
    expect((await adviser!.get(`/api/pages/P22?id=${id}`)).status).toBe(200)
    expect(await progress(student!, id)).toMatchObject({ step: 1, label: 'Read', readAt: expect.any(String) })
    const act = (agent: Agent, type: string) => agent.post('/api/pages/P22/actions').send({ action: 'caseAction', recordId: id, reason: 'Next step', payload: { type, update: 'An update.' } })
    expect((await act(adviser!, 'escalate')).status).toBe(200)
    expect(await progress(student!, id)).toMatchObject({ step: 2, label: 'Escalated', escalatedTo: 'Program Chair' })
    expect((await act(chair!, 'resolve')).status).toBe(200)
    expect((await progress(student!, id)).label).toBe('Resolved')
    expect((await act(chair!, 'close')).status).toBe(200)
    expect((await progress(student!, id)).label).toBe('Closed')
  })
})

describe('the CCS Secretary calendar (decided 19 November 2026)', () => {
  it('opens the calendar and keeps to-dos', async () => {
    const { secretarySession } = await import('./helpers.js')
    const secretary = await secretarySession(app)
    expect((await secretary.get('/api/session')).body.allowedPages).toContain('P13')
    expect((await secretary.get('/api/pages/P13')).status).toBe(200)
    const due = new Date(Date.now() + 3 * 86_400_000).toISOString().slice(0, 10)
    const saved = await secretary.post('/api/pages/P13/actions').send({ action: 'createTodo', payload: { title: 'Prepare enrollment list', date: due } })
    expect(saved.status, JSON.stringify(saved.body)).toBe(200)
  })
})

describe('restriction end dates (decided 19 November 2026)', () => {
  it('needs tomorrow or later, not today', async () => {
    const admin = await login('ACCS-ADMIN')
    const day = (offset: number) => new Date(Date.now() + 8 * 3_600_000 + offset * 86_400_000).toISOString().slice(0, 10)
    const apply = (until: string) => admin.post('/api/pages/P35/actions').send({ action: 'applyRestriction', reason: 'r', payload: { studentId: 'QCU-STU-IT-A', features: ['post.create'], until, basis: 'b', decisionReference: 'd' } })
    expect((await apply(day(0))).body.error).toBe('Choose tomorrow or a later end date.')
    expect((await apply(day(1))).status).toBe(200)
  })
})

describe('to-do due dates (QA 17 November)', () => {
  it('refuses a past date', async () => {
    const student = await login('QCU-STU-IT-A')
    const day = (offset: number) => new Date(Date.now() + 8 * 3_600_000 + offset * 86_400_000).toISOString().slice(0, 10)
    const add = (date: string) => student.post('/api/pages/P13/actions').send({ action: 'createTodo', payload: { title: 'Finish lab report', date } })
    expect((await add(day(-1))).status).toBe(400)
    expect((await add(day(0))).status).toBe(200)
  })
})

describe('editing and deleting a sent message (decided 19 November 2026)', () => {
  const thread = 'THREAD-IT-A'
  const conversation = async (agent: Agent) => (await agent.get(`/api/pages/P12?id=${thread}`)).body.data.record.messages as { id: string; body: string; editedAt?: string; deleted?: boolean }[]

  it('lets the author edit, marks it edited, and lets no one else change it', async () => {
    const [prof, student] = await Promise.all(['QCU-PROF-IT', 'QCU-STU-IT-A'].map(login))
    const edited = await prof!.post('/api/pages/P12/actions').send({ action: 'editMessage', recordId: thread, payload: { messageId: 'MESSAGE-0101', body: 'Use this group for room changes only.' } })
    expect(edited.status, JSON.stringify(edited.body)).toBe(200)
    expect((await conversation(student!)).find((m) => m.id === 'MESSAGE-0101')).toMatchObject({ body: 'Use this group for room changes only.', editedAt: expect.any(String) })
    expect((await student!.post('/api/pages/P12/actions').send({ action: 'editMessage', recordId: thread, payload: { messageId: 'MESSAGE-0101', body: 'Changed by someone else' } })).status).toBe(403)
    expect((await student!.post('/api/pages/P12/actions').send({ action: 'deleteMessage', recordId: thread, payload: { messageId: 'MESSAGE-0101' } })).status).toBe(403)
  })

  it('deletes for everyone, leaving "Message deleted" in the inbox and nothing of the words', async () => {
    const [prof, student] = await Promise.all(['QCU-PROF-IT', 'QCU-STU-IT-A'].map(login))
    expect((await prof!.post('/api/pages/P12/actions').send({ action: 'deleteMessage', recordId: thread, payload: { messageId: 'MESSAGE-0101' } })).status).toBe(200)
    const gone = (await conversation(student!)).find((m) => m.id === 'MESSAGE-0101')!
    expect(gone).toMatchObject({ deleted: true, body: '' })
    const inbox = (await student!.get('/api/pages/P11')).body.data.threads as { id: string; lastMessage: string }[]
    expect(inbox.find((t) => t.id === thread)!.lastMessage).toBe('Message deleted')
    expect((await prof!.post('/api/pages/P12/actions').send({ action: 'editMessage', recordId: thread, payload: { messageId: 'MESSAGE-0101', body: 'Back again' } })).status).toBe(409)
  })
})

describe('the administrator changing restrictions (QA 17 November: only Lift was possible)', () => {
  const day = (offset: number) => new Date(Date.now() + 8 * 3_600_000 + offset * 86_400_000).toISOString().slice(0, 10)
  async function applied(admin: Agent, extra: object = {}) {
    const response = await admin.post('/api/pages/P35/actions').send({ action: 'applyRestriction', reason: 'r', payload: { studentId: 'QCU-STU-IT-A', features: ['post.create'], until: day(7), basis: 'b', decisionReference: 'd', ...extra } })
    expect(response.status, JSON.stringify(response.body)).toBe(200)
    return response.body.record.id as string
  }
  const restrictionNotices = () => repo.read().notifications.filter((n) => n.recipientId === 'QCU-STU-IT-A' && n.kind === 'restriction')

  it('extends and shortens an active restriction, tells the student, and closes the waiting request', async () => {
    const admin = await login('ACCS-ADMIN')
    const id = await applied(admin)
    const guidance = await login('QCU-GUIDANCE')
    const asked = await guidance.post('/api/pages/P35/actions').send({ action: 'referRestriction', reason: 'Needs more time', payload: { studentId: 'QCU-STU-IT-A', change: 'Extend' } })
    expect(asked.status, JSON.stringify(asked.body)).toBe(200)
    const change = (until: string) => admin.post('/api/pages/P35/actions').send({ action: 'changeRestrictionEnd', recordId: id, reason: 'As requested', payload: { until } })
    expect((await change(day(14))).body.message).toBe('Restriction extended.')
    expect(restrictionNotices().at(-1)!.body).toBe(`Now paused until ${day(14)}: Posting.`)
    expect(repo.read().referrals.find((r) => r.id === asked.body.record.id)).toMatchObject({ status: 'Done: restriction extended' })
    expect((await change(day(3))).body.message).toBe('Restriction shortened.')
    expect((await change(day(0))).status).toBe(400)
    expect((await (await login('QCU-OSAS')).post('/api/pages/P35/actions').send({ action: 'changeRestrictionEnd', recordId: id, reason: 'x', payload: { until: day(5) } })).status).toBe(403)
  })

  it('declines a change request and tells the office that asked', async () => {
    const admin = await login('ACCS-ADMIN')
    await applied(admin)
    const asked = await (await login('QCU-GUIDANCE')).post('/api/pages/P35/actions').send({ action: 'referRestriction', reason: 'Student apologised', payload: { studentId: 'QCU-STU-IT-A', change: 'Lift' } })
    const declined = await admin.post('/api/pages/P35/actions').send({ action: 'declineReferral', recordId: asked.body.record.id, reason: 'The decision stands', payload: {} })
    expect(declined.status, JSON.stringify(declined.body)).toBe(200)
    expect(repo.read().referrals.find((r) => r.id === asked.body.record.id)!.status).toBe('Declined')
    expect(repo.read().notifications.at(-1)).toMatchObject({ recipientId: 'QCU-GUIDANCE', body: 'Your request to lift a restriction was declined. Reason: The decision stands' })
    expect((await admin.post('/api/pages/P35/actions').send({ action: 'declineReferral', recordId: asked.body.record.id, reason: 'again', payload: {} })).status).toBe(409)
  })

  it('applies without notifying the student when the administrator unticks it', async () => {
    const admin = await login('ACCS-ADMIN')
    const before = restrictionNotices().length
    await applied(admin, { notifyStudent: false })
    expect(restrictionNotices()).toHaveLength(before)
    await applied(admin)
    expect(restrictionNotices()).toHaveLength(before + 1)
  })
})

describe('audit lists (QA 17 November: the oldest entry came first)', () => {
  it('lists the newest entry first', async () => {
    const admin = await login('ACCS-ADMIN')
    const day = new Date(Date.now() + 8 * 3_600_000 + 7 * 86_400_000).toISOString().slice(0, 10)
    expect((await admin.post('/api/pages/P35/actions').send({ action: 'applyRestriction', reason: 'r', payload: { studentId: 'QCU-STU-IT-A', features: ['post.create'], until: day, basis: 'b', decisionReference: 'd' } })).status).toBe(200)
    const trail = (await admin.get('/api/pages/P51')).body.data.audit as { action: string; at: string }[]
    expect(trail[0]!.action).toBe('Restriction applied')
    expect(trail.map((e) => e.at)).toEqual([...trail.map((e) => e.at)].sort().reverse())
  })
})

describe('monitoring trend (QA 17 November: only today was shown)', () => {
  it('shows the last seven days, oldest first, with empty days at 0', async () => {
    const student = await login('QCU-STU-IT-A')
    await student.post('/api/pages/P41/actions').send({ action: 'assistantAsk', payload: { question: 'What can you help me with?' } })
    const trend = (await (await login('ACCS-ADMIN')).get('/api/pages/P52')).body.data.trend as { label: string; value: number }[]
    expect(trend).toHaveLength(7)
    expect(trend.map((d) => d.label)).toEqual([...trend.map((d) => d.label)].sort())
    expect(trend.at(-1)!.value).toBeGreaterThanOrEqual(1)
  })
})

describe('moderation review context (QA 17 November)', () => {
  it('shows a flagged message with the messages around it, the flagged one marked', async () => {
    const student = await login('QCU-STU-IT-A')
    for (const body of ['First note', 'Second note', 'This is the flagged one', 'After it']) await student.post('/api/pages/P12/actions').send({ action: 'sendMessage', recordId: 'THREAD-IT-A', payload: { body } })
    const flagged = repo.read().threads.find((t) => t.id === 'THREAD-IT-A')!.messages.find((m) => m.body === 'This is the flagged one')!
    const prof = await login('QCU-PROF-IT')
    expect((await prof.post('/api/pages/P12/actions').send({ action: 'flag', recordId: 'THREAD-IT-A', payload: { itemType: 'message', itemId: flagged.id, reason: 'Rude' } })).status).toBe(200)
    const modId = repo.read().moderation.at(-1)!.id
    const messages = (await (await login('ACCS-ADMIN')).get(`/api/pages/P50?id=${modId}`)).body.data.messages as { body: string; flagged: boolean }[]
    expect(messages.map((m) => [m.body, m.flagged])).toEqual([['Use this group for room changes and class reminders. Message me directly for anything personal.', false], ['First note', false], ['Second note', false], ['This is the flagged one', true], ['After it', false]])
  })
})

describe('evaluation review and cycle dates (QA 17 November)', () => {
  const day = (offset: number) => new Date(Date.now() + 8 * 3_600_000 + offset * 86_400_000).toISOString().slice(0, 10)

  it('waits for every faculty review before the Dean can publish (it could be published while still in review)', async () => {
    const dean = await login('QCU-FAC-PAULA-DELACRUZ')
    const publish = () => dean.post('/api/pages/P31/actions').send({ action: 'cycleAction', recordId: 'CYCLE-2026-2', payload: { status: 'Published' } })
    const early = await publish()
    expect(early.status).toBe(409)
    expect(early.body.error).toMatch(/not reviewed the questions yet/)
    const { reviewAll } = await import('./helpers.js')
    reviewAll(repo, 'CYCLE-2026-2')
    expect((await publish()).status).toBe(200)
  })

  it('needs a comment when a professor asks for changes', async () => {
    const prof = await login('QCU-PROF-IT')
    const review = (payload: object) => prof.post('/api/pages/P32/actions').send({ action: 'reviewQuestions', recordId: 'CYCLE-2026-2', payload })
    expect((await review({ decision: 'changes', note: '  ' })).status).toBe(400)
    expect((await review({ decision: 'changes', note: 'Question 2 is unclear.' })).status).toBe(200)
  })

  it('refuses an opening date in the past', async () => {
    const dean = await login('QCU-FAC-PAULA-DELACRUZ')
    const create = (opens: string) => dean.post('/api/pages/P30/actions').send({ action: 'createCycle', payload: { title: 'Summer', term: 'Summer', opens, closes: day(40) } })
    expect((await create(day(-1))).status).toBe(400)
    expect((await create(day(0))).status).toBe(200)
  })
})

describe('saving a profile (QA 17 November: an all-blank profile was saved)', () => {
  it('needs at least one field', async () => {
    const prof = await login('QCU-PROF-IT')
    const save = (payload: object) => prof.post('/api/pages/P39/actions').send({ action: 'saveProfile', payload: { title: '', bio: '', education: '', officeHours: '', ...payload } })
    expect((await save({ title: '   ' })).status).toBe(400)
    expect((await save({ bio: 'Teaches data structures.' })).status).toBe(200)
  })
})

describe('reviewed evaluation questions (QA 17 November)', () => {
  it('marks a cycle reviewed once the professor sends a review, so it can leave "to review"', async () => {
    const prof = await login('QCU-PROF-IT')
    const cycles = async () => (await prof.get('/api/pages/P26')).body.data.reviewCycles as { id: string; reviewed: boolean }[]
    expect((await cycles()).find((c) => c.id === 'CYCLE-2026-2')).toMatchObject({ reviewed: false })
    expect((await prof.post('/api/pages/P32/actions').send({ action: 'reviewQuestions', recordId: 'CYCLE-2026-2', payload: { decision: 'reviewed', note: '' } })).status).toBe(200)
    expect((await cycles()).find((c) => c.id === 'CYCLE-2026-2')).toMatchObject({ reviewed: true })
  })
})

describe('the assistant and Help (QA 17 November)', () => {
  it('answers a greeting as a greeting', async () => {
    const student = await login('QCU-STU-IT-A')
    const answer = await student.post('/api/pages/P41/actions').send({ action: 'assistantAsk', payload: { question: 'hello' } })
    expect(answer.body.record.reply).toMatch(/^Hello, /)
  })

  it('offers more than one suggestion, and Help search matches the question only', async () => {
    const student = await login('QCU-STU-IT-A')
    expect(((await student.get('/api/pages/P41')).body.data.suggestions as string[]).length).toBeGreaterThan(3)
    const faq = (await student.get('/api/pages/P42').query({ q: 'roles' })).body.data.faq as { question: string }[]
    expect(faq.map((f) => f.question)).toEqual(['How are roles assigned?'])
  })
})

describe('the CCS Secretary in the Feed, like the Dean (QA 19 November)', () => {
  it('posts discussions to CCS and Faculty, publishes announcements, and reads faculty posts', async () => {
    const { secretarySession } = await import('./helpers.js')
    const secretary = await secretarySession(app)
    const post = (audience: string, kind = 'discussion') => secretary.post('/api/pages/P05/actions').send({ action: 'createPost', payload: { title: 'Enrollment reminder', body: 'Submit your forms by Friday.', audience, kind, ...(kind === 'announcement' ? { priority: 'general' } : { label: 'Discussion' }) } })
    for (const [audience, kind] of [['college', 'discussion'], ['faculty', 'discussion'], ['college', 'announcement'], ['faculty', 'announcement']] as const) {
      const response = await post(audience, kind)
      expect([audience, kind, response.status, JSON.stringify(response.body).slice(0, 200)]).toEqual([audience, kind, 200, expect.any(String)])
    }
    const feed = (await secretary.get('/api/pages/P04')).body.data.posts as { audience: string; authorId?: string }[]
    expect(feed.some((p) => p.audience === 'faculty')).toBe(true)
    expect((await secretary.get('/api/pages/P05')).body.data.audiences).toEqual(expect.arrayContaining(['college', 'faculty']))
  })
})

describe('urgent announcements (QA 19 November)', () => {
  it('reach everyone in the audience at once, even unticked and muted, and not the author', async () => {
    const dean = await login('QCU-FAC-PAULA-DELACRUZ')
    repo.read().settings['QCU-STU-IT-A'] = { theme: 'system', density: 'comfortable', priorities: { announcement: 'muted' } }
    const before = repo.read().notifications.length
    const created = await dean.post('/api/pages/P05/actions').send({ action: 'createPost', payload: { title: 'Campus closed today', body: 'Classes move online because of the storm.', audience: 'college', kind: 'announcement', priority: 'urgent', notifyMembers: false } })
    expect(created.status, JSON.stringify(created.body)).toBe(200)
    const sent = repo.read().notifications.slice(before).filter((n) => n.kind === 'announcement')
    const recipients = new Set(sent.map((n) => n.recipientId))
    const active = repo.read().users.filter((u) => u.active && u.id !== 'QCU-FAC-PAULA-DELACRUZ').map((u) => u.id)
    expect([...recipients].sort()).toEqual(active.sort())
    expect(recipients.has('QCU-STU-IT-A')).toBe(true)
    expect(sent[0]).toMatchObject({ title: 'Urgent announcement', body: 'Urgent: Campus closed today', priority: 'high' })
  })

  it('leaves a general announcement without Notify members quiet', async () => {
    const dean = await login('QCU-FAC-PAULA-DELACRUZ')
    const before = repo.read().notifications.length
    await dean.post('/api/pages/P05/actions').send({ action: 'createPost', payload: { title: 'Library hours', body: 'Open until 8 PM.', audience: 'college', kind: 'announcement', priority: 'general', notifyMembers: false } })
    expect(repo.read().notifications.slice(before).filter((n) => n.kind === 'announcement')).toHaveLength(0)
  })
})

describe('important announcements (decided 19 November 2026)', () => {
  it('reach everyone in the audience without Notify members, but respect a muted category', async () => {
    const dean = await login('QCU-FAC-PAULA-DELACRUZ')
    repo.read().settings['QCU-STU-IT-B'] = { theme: 'system', density: 'comfortable', priorities: { announcement: 'muted' } }
    const before = repo.read().notifications.length
    const created = await dean.post('/api/pages/P05/actions').send({ action: 'createPost', payload: { title: 'Batch photo for release', body: 'Pick up your photos at the CCS office.', audience: 'college', kind: 'announcement', priority: 'important', notifyMembers: false } })
    expect(created.status, JSON.stringify(created.body)).toBe(200)
    const sent = repo.read().notifications.slice(before).filter((n) => n.kind === 'announcement')
    const recipients = sent.map((n) => n.recipientId)
    expect(recipients).toContain('QCU-STU-IT-A')
    expect(recipients).not.toContain('QCU-STU-IT-B')
    expect(recipients).not.toContain('QCU-FAC-PAULA-DELACRUZ')
    expect(sent[0]).toMatchObject({ title: 'New college announcement', body: 'Important: Batch photo for release' })
  })
})

describe('faculty review, sections and comments (QA 19 November)', () => {
  it('asks every active professor to review the questions when a cycle goes to review', async () => {
    const dean = await login('QCU-FAC-PAULA-DELACRUZ')
    const created = await dean.post('/api/pages/P30/actions').send({ action: 'createCycle', payload: { title: 'Summer term', term: 'Summer', opens: new Date(Date.now() + 8 * 3_600_000).toISOString().slice(0, 10), closes: '2027-03-01' } })
    const id = created.body.record.id as string
    const cycle = repo.read().cycles.find((c) => c.id === id)!
    cycle.instructions = 'Rate each statement.'
    cycle.questions = [{ id: 'Q1', criterion: 'Clarity', text: 'Explains clearly.', type: 'rating', required: true }]
    const before = repo.read().notifications.length
    expect((await dean.post('/api/pages/P31/actions').send({ action: 'cycleAction', recordId: id, payload: { status: 'In review' } })).status).toBe(200)
    const asked = new Set(repo.read().notifications.slice(before).filter((n) => n.kind === 'evaluation' && n.pageId === 'P32').map((n) => n.recipientId))
    const professors = repo.read().users.filter((u) => u.active && u.roles.includes('professor')).map((u) => u.id)
    expect([...asked].sort()).toEqual(professors.sort())
    const reviews = (await dean.get(`/api/pages/P31?id=${id}`)).body.data.facultyReviews as { id: string }[]
    expect(reviews.map((r) => r.id).sort()).toEqual(professors.sort())
  })

  it('lists only section groups as sections on Home, not subjects', async () => {
    const sections = (await (await login('QCU-PROF-IT')).get('/api/pages/P03')).body.data.sections as { id: string; title: string }[]
    expect(sections.map((s) => s.title)).not.toContain('Data Structures, SBIT3A')
    expect(sections.map((s) => s.id)).toContain('SPACE-IT-A')
  })

  it('lets professors and Chairs comment on college posts', async () => {
    for (const who of ['QCU-PROF-IT', 'QCU-CHAIR-CS']) {
      const agent = await login(who)
      const commented = await agent.post('/api/pages/P06/actions').send({ action: 'comment', recordId: 'POST-0101', payload: { body: `A note from ${who}.` } })
      expect([who, commented.status, JSON.stringify(commented.body).slice(0, 160)]).toEqual([who, 200, expect.any(String)])
    }
  })
})

describe('organization members (QA 19 November)', () => {
  it('shows each member with their id and section', async () => {
    const members = (await (await login('QCU-STU-IT-A')).get('/api/pages/P10?id=ORG-COMPUTING')).body.data.record.members as { id: string; name: string; section?: string }[]
    const student = members.find((m) => m.id === 'QCU-STU-IT-A')!
    expect(student).toMatchObject({ organizationRole: 'Member', program: 'BSIT' })
    expect(student.section).toMatch(/^SBIT3A$/)
    expect(members.find((m) => m.id === 'QCU-ORG')).toMatchObject({ organizationRole: 'Officer' })
  })
})
