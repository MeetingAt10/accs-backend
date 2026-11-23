// QA v4 backend fixes: event time today, evaluation average, status-only queue rows, guidance chats, deleted posts, cycle sections.
import request from 'supertest'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { createApp } from '../src/app.js'
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
const announce = (agent: Awaited<ReturnType<typeof login>>, extra: object) => agent.post('/api/pages/P05/actions').send({ action: 'createPost', payload: { title: 'Event', body: 'Come along.', audience: 'college', kind: 'announcement', ...extra } })

describe('event today', () => {
  it('refuses a time that has passed today, accepts a later one', async () => {
    // Test clock: 2026-10-21 08:00 campus time.
    const dean = await login('QCU-FAC-PAULA-DELACRUZ')
    const past = await announce(dean, { eventDate: '2026-10-21', eventTime: '07:00', eventPlace: 'IC 301' })
    expect(past.status).toBe(400)
    expect(JSON.stringify(past.body)).toContain('Choose today or a later date for the event.')
    expect((await announce(dean, { eventDate: '2026-10-21', eventTime: '23:00', eventPlace: 'IC 301' })).status).toBe(200)
  })
})

describe('evaluation results', () => {
  it('averages only faculty with responses', async () => {
    const dean = await login('QCU-FAC-PAULA-DELACRUZ')
    const data = (await dean.get('/api/pages/P28')).body.data
    const answered = data.results.filter((r: { responses: number }) => r.responses > 0)
    const avg = data.stats.find((s: { label: string }) => s.label === 'Overall average').value
    expect(answered.length).toBeGreaterThan(0)
    expect(answered.length).toBeLessThan(data.results.length)
    expect(avg).toBeCloseTo(answered.reduce((t: number, r: { average: number }) => t + r.average, 0) / answered.length, 1)
  })
})

describe('case queue, status only', () => {
  it('sends no severity or category to a handler who moved the case on, and the filter cannot match it', async () => {
    const prof = await login('QCU-PROF-IT')
    const rows = (await prof.get('/api/pages/P21')).body.data.cases as Record<string, unknown>[]
    const moved = rows.find((r) => r.id === 'RPT-0246')!
    expect(moved.statusOnly).toBe(true)
    expect(moved).not.toHaveProperty('severity')
    expect(moved).not.toHaveProperty('category')
    const filtered = (await prof.get('/api/pages/P21?severity=medium')).body.data.cases as { id: string }[]
    expect(filtered.map((r) => r.id)).not.toContain('RPT-0246')
    expect(filtered.map((r) => r.id)).toContain('RPT-0241')
  })
})

describe('direct chat from Guidance', () => {
  it('opens for the professor and shows in the inbox', async () => {
    const guidance = await login('QCU-GUIDANCE')
    const made = await guidance.post('/api/pages/P11/actions').send({ action: 'createThread', payload: { recipientId: 'QCU-PROF-IT', body: 'Hello.' } })
    expect(made.status, JSON.stringify(made.body)).toBe(200)
    const prof = await login('QCU-PROF-IT')
    const threads = (await prof.get('/api/pages/P11')).body.data.threads as { id: string }[]
    expect(threads.map((t) => t.id)).toContain(made.body.record.id)
    expect((await prof.get(`/api/pages/P12?id=${made.body.record.id}`)).status).toBe(200)
  })
})

describe('deleted posts', () => {
  it('stay out of the home announcements', async () => {
    const dean = await login('QCU-FAC-PAULA-DELACRUZ')
    const made = await announce(dean, { title: 'Gone soon' })
    expect(made.status).toBe(200)
    const id = made.body.record.id
    const titles = async () => ((await dean.get('/api/pages/P03')).body.data.announcements as { title: string }[]).map((p) => p.title)
    expect(await titles()).toContain('Gone soon')
    repo.transact((unit) => { unit.read().posts.find((p) => p.id === id)!.removed = true })
    expect(await titles()).not.toContain('Gone soon')
    const feed = (await dean.get('/api/pages/P04')).body.data.posts as { id: string; title: string }[]
    expect(feed.find((p) => p.id === id)!.title).toBe('This content was removed.')
  })
})

describe('cycle completion by section', () => {
  it('counts submitted forms', async () => {
    const student = await login('QCU-STU-IT-A')
    const mine = repo.read().assignments.find((a) => a.evaluatorId === 'QCU-STU-IT-A' && a.cycleId === 'CYCLE-2026-1')!
    expect((await student.post('/api/pages/P27/actions').send({ action: 'submitEvaluation', recordId: mine.id, payload: { answers: { Q1: 4, Q2: 5, Q3: 4 } } })).status).toBe(200)
    const dean = await login('QCU-FAC-PAULA-DELACRUZ')
    const rows = (await dean.get('/api/pages/P31?id=CYCLE-2026-1')).body.data.completion as { title: string; submitted: number }[]
    expect(rows.find((r) => r.title === 'SBIT3A')!.submitted).toBe(1)
  })
})

describe('real calendar dates', () => {
  it('refuses a day that does not exist and keeps real ones', async () => {
    const { actionPayloads, isRealDate } = await import('../src/schemas.js')
    expect(isRealDate('2027-02-31')).toBe(false)
    expect(isRealDate('2027-02-30')).toBe(false)
    expect(isRealDate('2028-02-29')).toBe(true)
    expect(isRealDate('2027-12-31')).toBe(true)
    expect(actionPayloads.createTodo.safeParse({ title: 'Read', date: '2027-02-31' }).success).toBe(false)
    expect(actionPayloads.createTodo.safeParse({ title: 'Read', date: '2027-02-28' }).success).toBe(true)
  })
})

describe('evaluation completion', () => {
  it('is the share of assigned evaluations submitted, not 100 or 0', async () => {
    const dean = await login('QCU-FAC-PAULA-DELACRUZ').catch(() => undefined)
    const chair = dean ?? await login('QCU-CHAIR-IT')
    const res = await chair.get('/api/pages/P28')
    expect(res.status).toBe(200)
    const results = res.body.page?.data?.results ?? res.body.data?.results ?? []
    expect(results.length).toBeGreaterThan(0)
    for (const result of results) {
      expect(typeof result.assigned).toBe('number')
      expect(result.completion).toBe(result.assigned ? Math.round(result.responses / result.assigned * 100) : 0)
    }
  })
})
