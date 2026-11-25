// Fixes from the QA report of 15 November 2026 (QA_andrew_11_15), batch B: rules about dates and reporting your own
// content, enforced by the API so a changed screen cannot get around them. The suite clock starts on 21 October 2026
// (tests/setup-clock.ts); a test moves it forward to make a seeded time lie in the past.
import request from 'supertest'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { createApp } from '../src/app.js'
import { createMemoryRepository } from '../src/store.js'
import { concernChoices, seedPassword, setUpAuthStore } from './helpers.js'

// The Dean on a stack with the CCS roster (tests seed it).
const dean = 'QCU-FAC-PAULA-DELACRUZ'

let repo: ReturnType<typeof createMemoryRepository>
let app: ReturnType<typeof createApp>
beforeEach(() => {
  vi.setSystemTime(new Date('2026-10-21T00:00:00.000Z'))
  repo = createMemoryRepository()
  app = createApp(repo, { authStore: setUpAuthStore() })
})

async function login(id: string) {
  const agent = request.agent(app)
  expect((await agent.post('/api/auth/sign-in').send({ emailOrId: id, password: seedPassword })).status).toBe(200)
  return agent
}
const fields = (body: { fields?: { path: string; message: string }[] }) => Object.fromEntries((body.fields ?? []).map((f) => [f.path, f.message]))

describe('times in the past', () => {
  it('refuses opening an availability time that has already begun (campus time)', async () => {
    // 21 October, 10:00 in Manila.
    vi.setSystemTime(new Date('2026-10-21T02:00:00.000Z'))
    const professor = await login('QCU-PROF-IT')
    const save = (date: string, start: string, end: string) => professor.post('/api/pages/P17/actions').send({ action: 'saveAvailability', payload: { date, start, end, state: 'open' } })
    const yesterday = await save('2026-10-20', '13:00', '13:30')
    expect(yesterday.status).toBe(400)
    expect(fields(yesterday.body).date).toBe('Choose a date and time from now on.')
    expect((await save('2026-10-21', '09:00', '09:30')).status).toBe(400)
    expect((await save('2026-10-21', '15:00', '15:30')).status, 'later today').toBe(200)
  })

  it('hides open times that have passed from students and refuses booking them; the professor still sees them', async () => {
    const slot = await repo.transact((unit) => unit.read().slots.find((s) => s.id === 'SLOT-0101')!)
    expect(slot).toMatchObject({ date: '2026-10-29', state: 'open' })
    // The day after the slot.
    vi.setSystemTime(new Date('2026-10-30T00:00:00.000Z'))
    const student = await login('QCU-STU-IT-A')
    const offered = (await student.get('/api/pages/P15?id=QCU-PROF-IT')).body.data.slots as { id: string }[]
    expect(offered.map((s) => s.id)).not.toContain('SLOT-0101')
    const booked = await student.post('/api/pages/P15/actions').send({ action: 'createConsultation', payload: { slotId: 'SLOT-0101', category: 'Class or subject', subcategory: 'Exam or quiz review', details: 'Midterm in CC 104' } })
    expect(booked.status).toBe(409)
    expect(booked.body.error).toBe('That time has passed. Pick a later time.')
    const own = (await (await login('QCU-PROF-IT')).get('/api/pages/P17')).body.data.slots as { id: string }[]
    expect(own.map((s) => s.id)).toContain('SLOT-0101')
  })

  it('refuses an event date before today, and accepts today', async () => {
    const professor = await login('QCU-PROF-IT')
    const post = (eventDate: string) => professor.post('/api/pages/P05/actions').send({ action: 'createPost', payload: { title: 'Lab orientation', body: 'Bring your ID.', audience: 'space:SUBJECT-IT-DS', kind: 'announcement', priority: 'general', eventDate, eventTime: '09:00', eventPlace: 'IC 301', eventContact: 'Demo Professor Charlie' } })
    const past = await post('2026-10-20')
    expect(past.status).toBe(400)
    expect(fields(past.body).eventDate).toBe('Choose today or a later date for the event.')
    expect((await post('2026-10-21')).status).toBe(200)
  })
})

describe('when something happened', () => {
  it('refuses a future date on a concern and on a faculty report', async () => {
    const student = await login('QCU-STU-IT-A')
    const concern = await student.post('/api/pages/P19/actions').send({ action: 'createReport', payload: { narrative: 'Lab schedule changes are not announced.', category: 'General concern', severity: 'low', identity: 'named', ...concernChoices, occurredOn: '2026-10-22' } })
    expect(fields(concern.body).occurredOn).toBe('Choose today or an earlier date: it cannot be in the future.')
    const professor = await login('QCU-PROF-IT')
    const report = await professor.post('/api/pages/P21/actions').send({ action: 'reportStudent', payload: { studentId: 'QCU-STU-IT-A', narrative: 'Shouted at a classmate.', category: 'Bullying', subcategory: 'Intimidation or threats', severity: 'medium', occurredOn: '2026-11-02' } })
    expect(report.status).toBe(400)
    expect(fields(report.body).occurredOn).toBe('Choose today or an earlier date: it cannot be in the future.')
  })
})

describe('ongoing incidents', () => {
  it('accepts ongoing without a date, and refuses neither a date nor ongoing', async () => {
    const student = await login('QCU-STU-IT-A')
    const base = { narrative: 'The professor is always late to class.', category: 'General concern', severity: 'low', identity: 'named', ...concernChoices }
    const file = (extra: object) => student.post('/api/pages/P19/actions').send({ action: 'createReport', payload: { ...base, occurredOn: undefined, ...extra } })
    const ongoing = await file({ ongoing: true })
    expect(ongoing.status).toBe(200)
    expect(ongoing.body.record.occurredOn).toBeUndefined()
    expect(ongoing.body.record.ongoing).toBe(true)
    const neither = await file({})
    expect(neither.status).toBe(400)
    expect(fields(neither.body).occurredOn).toBe('Choose when it happened, or mark it as ongoing.')
    expect(fields((await file({ ongoing: true, occurredOn: '2026-10-22' })).body).occurredOn).toBe('Choose today or an earlier date: it cannot be in the future.')
  })
})

describe('reporting your own content', () => {
  it('refuses reporting your own post, comment or message, and still lets others report them', async () => {
    const professor = await login('QCU-ORG-AWS')
    const own = await professor.post('/api/pages/P06/actions').send({ action: 'flag', recordId: 'POST-0109', payload: { reason: 'Test', itemType: 'post' } })
    expect(own.status).toBe(400)
    expect(own.body.error).toBe('You cannot report your own post, comment or message.')
    const student = await login('QCU-STU-IT-A')
    expect((await student.post('/api/pages/P06/actions').send({ action: 'flag', recordId: 'POST-0109', payload: { reason: 'Wrong date', itemType: 'post' } })).status).toBe(200)
    const ownMessage = await student.post('/api/pages/P12/actions').send({ action: 'flag', recordId: 'THREAD-DIRECT-1', payload: { reason: 'Test', itemType: 'message', itemId: 'MESSAGE-0102' } })
    expect(ownMessage.status).toBe(400)
  })
})

describe('analytics date range', () => {
  it('refuses a start date after the end date', async () => {
    const theDean = await login(dean)
    const wrong = await theDean.get('/api/pages/P25').query({ from: '2026-12-01', to: '2026-11-01' })
    expect(wrong.status).toBe(400)
    expect(fields(wrong.body).from).toBe('The start date must be on or before the end date.')
    expect((await theDean.get('/api/pages/P25').query({ from: '2026-10-01', to: '2026-10-31' })).status).toBe(200)
  })
})
