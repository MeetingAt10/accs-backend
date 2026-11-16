// Fixes from the QA report of 15 November 2026 (QA_andrew_11_15), batch A: bugs.
import request from 'supertest'
import { beforeEach, describe, expect, it } from 'vitest'

import { createApp } from '../src/app.js'
import { createMemoryAuthStore } from '../src/auth.js'
import { createMemoryRepository } from '../src/store.js'
import { seedPassword } from './helpers.js'

let repo: ReturnType<typeof createMemoryRepository>
let app: ReturnType<typeof createApp>
beforeEach(() => { repo = createMemoryRepository(); app = createApp(repo, { authStore: createMemoryAuthStore() }) })

async function login(id: string) {
  const agent = request.agent(app)
  expect((await agent.post('/api/auth/sign-in').send({ emailOrId: id, password: seedPassword })).status).toBe(200)
  return agent
}

describe('organization member count', () => {
  it('counts the representative and members on the list and the organization page ("0 members" before)', async () => {
    const student = await login('QCU-STU-IT-A')
    const listed = (await student.get('/api/pages/P09')).body.data.organizations.find((o: { id: string }) => o.id === 'ORG-COMPUTING')
    const page = (await student.get('/api/pages/P10?id=ORG-COMPUTING')).body.data.record
    expect(page.members).toHaveLength(2)
    expect(page.memberCount).toBe(2)
    expect(listed.memberCount).toBe(2)
  })
})

describe('restriction notifications', () => {
  it('tells the student in their notifications when features are paused and when they come back', async () => {
    const admin = await login('ACCS-ADMIN')
    const until = new Date(Date.now() + 7 * 86_400_000).toISOString().slice(0, 10)
    const applied = await admin.post('/api/pages/P35/actions').send({ action: 'applyRestriction', reason: 'Repeated rude comments', payload: { studentId: 'QCU-STU-IT-A', features: ['post.create'], until, basis: 'Code of conduct, section 4', decisionReference: 'OSAS-2026-014' } })
    expect(applied.status, JSON.stringify(applied.body)).toBe(200)
    const student = await login('QCU-STU-IT-A')
    const notices = (await student.get('/api/pages/P40')).body.data.notifications as { kind: string; title: string; body: string }[]
    const paused = notices.filter((n) => n.kind === 'restriction')
    expect(paused).toHaveLength(1)
    expect(paused[0]!.body).toBe(`Paused until ${until}: Posting. Reason: Code of conduct, section 4`)
    // Lifting it says so too.
    expect((await admin.post('/api/pages/P35/actions').send({ action: 'liftRestriction', recordId: applied.body.record.id, reason: 'Settled with OSAS', payload: {} })).status).toBe(200)
    const after = ((await student.get('/api/pages/P40')).body.data.notifications as { kind: string; body: string }[]).filter((n) => n.kind === 'restriction').map((n) => n.body)
    expect(after).toContain('Available again: Posting.')
  })

  it('cannot be muted', async () => {
    const student = await login('QCU-STU-IT-A')
    await student.post('/api/pages/P44/actions').send({ action: 'saveNotificationPreferences', payload: { priorities: { restriction: 'muted' } } })
    const admin = await login('ACCS-ADMIN')
    const until = new Date(Date.now() + 7 * 86_400_000).toISOString().slice(0, 10)
    await admin.post('/api/pages/P35/actions').send({ action: 'applyRestriction', reason: 'r', payload: { studentId: 'QCU-STU-IT-A', features: ['post.comment'], until, basis: 'b', decisionReference: 'd' } })
    const notices = (await student.get('/api/pages/P40')).body.data.notifications as { kind: string }[]
    expect(notices.some((n) => n.kind === 'restriction')).toBe(true)
  })
})

describe('restriction change requests', () => {
  it('closes a waiting change request once the administrator lifts the restriction (it stayed on the tab before)', async () => {
    const admin = await login('ACCS-ADMIN')
    const until = new Date(Date.now() + 7 * 86_400_000).toISOString().slice(0, 10)
    const applied = await admin.post('/api/pages/P35/actions').send({ action: 'applyRestriction', reason: 'r', payload: { studentId: 'QCU-STU-IT-A', features: ['post.create'], until, basis: 'b', decisionReference: 'd' } })
    const guidance = await login('QCU-GUIDANCE')
    const asked = await guidance.post('/api/pages/P35/actions').send({ action: 'referRestriction', reason: 'Student apologised', payload: { studentId: 'QCU-STU-IT-A', change: 'Lift' } })
    expect(asked.status, JSON.stringify(asked.body)).toBe(200)
    expect((await admin.post('/api/pages/P35/actions').send({ action: 'liftRestriction', recordId: applied.body.record.id, reason: 'As asked', payload: {} })).status).toBe(200)
    const referral = await repo.transact((unit) => unit.read().referrals.find((r) => r.id === asked.body.record.id))
    expect(referral).toMatchObject({ status: 'Done: restriction lifted', handledBy: 'ACCS-ADMIN' })
  })
})

describe('event contacts', () => {
  it('names a contact only when their profile can be opened', async () => {
    // The seeded appointment week is contacted through the Dean; make that account inactive, as on a stack with the roster.
    const event = await repo.transact((unit) => unit.read().events.find((e) => e.id === 'EVENT-0101')!)
    await repo.transact((unit) => { unit.read().users.find((u) => u.id === event.contactId)!.active = false })
    const student = await login('QCU-STU-IT-A')
    const events = (await student.get('/api/pages/P13')).body.data.events as { id: string; contactId: string }[]
    expect(events.find((e) => e.id === 'EVENT-0101')!.contactId).toBe('')
    // An active contact stays, and their profile opens.
    await repo.transact((unit) => { unit.read().users.find((u) => u.id === event.contactId)!.active = true })
    const again = (await student.get('/api/pages/P13')).body.data.events as { id: string; contactId: string }[]
    const contact = again.find((e) => e.id === 'EVENT-0101')!.contactId
    expect(contact).toBe(event.contactId)
    expect((await student.get(`/api/pages/P38?id=${contact}`)).body.data.record).toBeTruthy()
  })
})

describe('opening a student record with a note', () => {
  it('opens the record and keeps the note in the access log ("This page didn\'t load" before)', async () => {
    const guidance = await login('QCU-GUIDANCE')
    const page = await guidance.get('/api/pages/P34').query({ id: 'QCU-STU-IT-A', purpose: 'Case handling', note: 'Checking the October report' })
    expect(page.status, JSON.stringify(page.body)).toBe(200)
    expect(page.body.data.record).toBeTruthy()
    const opened = await repo.transact((unit) => unit.read().audit.filter((entry) => entry.action === 'Record opened').at(-1))
    expect(opened).toMatchObject({ actorId: 'QCU-GUIDANCE', purpose: 'Case handling', reason: 'Checking the October report' })
  })

  it('still opens without a note, and refuses a note over 500 characters', async () => {
    const guidance = await login('QCU-GUIDANCE')
    expect((await guidance.get('/api/pages/P34').query({ id: 'QCU-STU-IT-A', purpose: 'Case handling' })).status).toBe(200)
    expect((await guidance.get('/api/pages/P34').query({ id: 'QCU-STU-IT-A', purpose: 'Case handling', note: 'x'.repeat(501) })).status).toBe(400)
  })
})
