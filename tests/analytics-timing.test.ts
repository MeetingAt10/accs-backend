import request from 'supertest'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { createApp } from '../src/app.js'
import { createMemoryRepository, type History, type Report } from '../src/store.js'
import { seedPassword } from './helpers.js'

// P25 timing (CHR-03-V, DEAN-01-V): the median, trend and waiting times come from each report's own timestamps.
const now = Date.parse('2026-11-10T12:00:00.000Z')
const daysAgo = (days: number) => new Date(now - days * 86400000).toISOString()

let repo: ReturnType<typeof createMemoryRepository>
let app: ReturnType<typeof createApp>
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(now)
  repo = createMemoryRepository()
  app = createApp(repo)
})
afterEach(() => vi.useRealTimers())

async function analytics(query = '') {
  const agent = request.agent(app)
  expect((await agent.post('/api/auth/sign-in').send({ emailOrId: 'QCU-FAC-PAULA-DELACRUZ', password: seedPassword })).status).toBe(200)
  const response = await agent.get(`/api/pages/P25${query}`)
  expect(response.status).toBe(200)
  return response.body.data
}
const report = (id: string) => repo.read().reports.find((r) => r.id === id)!
const entry = (r: Report, at: string, action: string, stage = r.stage): History => ({ id: `H-${at}`, at, actorId: 'QCU-FAC-PAULA-DELACRUZ', actorRole: 'dean', action, reason: '', update: '', public: true, stage })
/** Every seeded report opened at one time, with a single "Submitted" entry, so the test sets each timeline itself. */
function resetTimelines(openedAt: string) {
  for (const r of repo.read().reports) { r.createdAt = openedAt; r.history = [entry(r, openedAt, 'Submitted')] }
}

describe('P25 timing from report history', () => {
  it('CHR-03-V / DEAN-01-V reports the median days to resolve from the Resolved and Closed entries', async () => {
    resetTimelines(daysAgo(20))
    const a = report('RPT-0241'); a.status = 'Resolved'; a.history.push(entry(a, daysAgo(16), 'Resolved'))
    const b = report('RPT-0242'); b.status = 'Closed'; b.history.push(entry(b, daysAgo(18), 'Closed'))
    const c = report('RPT-0243'); c.status = 'Resolved'; c.history.push(entry(c, daysAgo(11), 'Resolved'))
    const stat = (await analytics()).stats.find((s: { label: string }) => s.label === 'Median days to resolve')
    // 4, 2 and 9 days: the median is 4.
    expect(stat).toEqual({ label: 'Median days to resolve', value: 4, note: 'Across 3 resolved reports' })
  })

  it('takes the middle of an even count, rounded to one decimal, and says when nothing is resolved', async () => {
    resetTimelines(daysAgo(20))
    const median = async () => (await analytics()).stats.find((s: { label: string }) => s.label === 'Median days to resolve')
    expect(await median()).toMatchObject({ value: 0, note: 'No resolved reports yet' })
    const a = report('RPT-0241'); a.history.push(entry(a, daysAgo(19), 'Resolved'))
    const b = report('RPT-0242'); b.history.push(entry(b, daysAgo(17.5), 'Resolved'))
    // 1 and 2.5 days: the median is 1.75, shown as 1.8.
    expect(await median()).toMatchObject({ value: 1.8, note: 'Across 2 resolved reports' })
  })

  it('builds a weekly opened and resolved trend from the first active week to the last, with empty weeks kept', async () => {
    // Monday 2026-10-19 and Monday 2026-11-02 weeks, with an empty week between them.
    resetTimelines('2026-10-20T02:00:00.000Z')
    const late = report('RPT-0248'); late.createdAt = '2026-11-03T02:00:00.000Z'; late.history = [entry(late, late.createdAt, 'Submitted')]
    const a = report('RPT-0241'); a.history.push(entry(a, '2026-11-04T02:00:00.000Z', 'Resolved'))
    const trend = (await analytics()).trend
    expect(trend).toEqual([
      { label: '19 Oct', opened: 7, resolved: 0 },
      { label: '26 Oct', opened: 0, resolved: 0 },
      { label: '2 Nov', opened: 1, resolved: 1 },
    ])
  })

  it('measures waiting from when a report entered its stage, not from its latest response', async () => {
    resetTimelines(daysAgo(30))
    const dean = report('RPT-0243')
    dean.history.push(entry(dean, daysAgo(10), 'Transferred', 'chair'), entry(dean, daysAgo(6), 'Transferred', 'dean'), entry(dean, daysAgo(1), 'Response sent', 'dean'))
    const waiting = (await analytics()).waitingByStage.find((s: { label: string }) => s.label === 'Dean')
    expect(waiting).toEqual({ label: 'Dean', value: 6, count: 1 })
  })

  it('counts a report that never moved from its creation, and leaves resolved reports out of waiting', async () => {
    resetTimelines(daysAgo(3))
    const resolved = report('RPT-0241'); resolved.status = 'Resolved'; resolved.history.push(entry(resolved, daysAgo(1), 'Resolved'))
    const adviser = (await analytics()).waitingByStage.find((s: { label: string }) => s.label === 'Adviser')
    expect(adviser.count).toBe(repo.read().reports.filter((r) => r.stage === 'adviser' && r.status !== 'Resolved').length)
    expect(adviser.value).toBe(adviser.count ? 3 : 0)
  })

  it('CHR-03-I / DEAN-01-I gives an empty trend and zero waits for a period with no reports', async () => {
    const data = await analytics('?from=2030-01-01&to=2030-01-31')
    expect(data.trend).toEqual([])
    expect(data.waitingByStage.every((s: { value: number; count: number }) => s.value === 0 && s.count === 0)).toBe(true)
  })
})
