import request from 'supertest'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { createApp } from '../src/app.js'
import { createMemoryRepository } from '../src/store.js'
import { secretarySession, seedPassword } from './helpers.js'

let repo: ReturnType<typeof createMemoryRepository>
let app: ReturnType<typeof createApp>
beforeEach(() => {
  repo = createMemoryRepository()
  app = createApp(repo)
  // Activating the secretary logs that its invite was not sent.
  vi.spyOn(console, 'log').mockImplementation(() => {})
  const db = repo.read()
  const original = db.moderation.find((m) => m.id === 'MOD-0101')!
  // A second user report that nobody refers, and an automatic filter flag, which cannot be referred.
  db.moderation.push({ ...structuredClone(original), id: 'MOD-0102' }, { ...structuredClone(original), id: 'MOD-0103', source: 'Filter' })
})
afterEach(() => vi.restoreAllMocks())

async function login(id: string) {
  const agent = request.agent(app)
  expect((await agent.post('/api/auth/sign-in').send({ emailOrId: id, password: seedPassword })).status).toBe(200)
  return agent
}
type Agent = Awaited<ReturnType<typeof login>>
const moderate = (agent: Agent, recordId: string, decision: string) =>
  agent.post('/api/pages/P50/actions').send({ action: 'moderate', recordId, reason: 'Needs the secretary', payload: { decision, notifyAuthor: false } })
const item = (id: string) => repo.read().moderation.find((m) => m.id === id)!

describe('moderation referrals go to the CCS Secretary (D-04)', () => {
  it('refuses a referral while no CCS Secretary account is active, and leaves the item pending', async () => {
    repo.read().users.find((u) => u.id === 'QCU-SECRETARY-MARICRIS-FERNANDEZ')!.active = false
    const admin = await login('ACCS-ADMIN')
    const response = await moderate(admin, 'MOD-0101', 'refer')
    expect(response.status).toBe(409)
    expect(response.body.error).toMatch(/CCS Secretary account is not active/)
    expect(item('MOD-0101').status).toBe('Pending')
    expect(item('MOD-0101').history).toHaveLength(0)
  })

  it('refers to the secretary, notifies them, and only the secretary can then decide', async () => {
    const secretary = await secretarySession(app)
    const admin = await login('ACCS-ADMIN')
    const before = repo.read().notifications.length

    const referred = await moderate(admin, 'MOD-0101', 'refer')
    expect(referred.status).toBe(200)
    expect(referred.body.record.status).toBe('Referred to the CCS Secretary')
    expect(repo.read().notifications.slice(before)).toEqual(['QCU-SECRETARY', 'QCU-SECRETARY-MARICRIS-FERNANDEZ'].map((recipientId) => expect.objectContaining({ recipientId, kind: 'moderation', pageId: 'P50', recordId: 'MOD-0101' })))

    // The moderator can no longer decide it or refer it again.
    expect((await moderate(admin, 'MOD-0101', 'remove')).status).toBe(409)
    expect((await moderate(admin, 'MOD-0101', 'refer')).status).toBe(409)
    expect((await moderate(secretary, 'MOD-0101', 'refer')).status).toBe(409)

    const decided = await moderate(secretary, 'MOD-0101', 'remove')
    expect(decided.status).toBe(200)
    expect(decided.body.record.status).toBe('Removed')
    expect(decided.body.record.history.map((h: { actorId: string; decision: string }) => [h.actorId, h.decision])).toEqual([['ACCS-ADMIN', 'refer'], ['QCU-SECRETARY', 'remove']])
    const post = repo.read().posts.find((p) => p.id === item('MOD-0101').parentId)!
    expect(post.comments.find((c) => c.id === item('MOD-0101').itemId)!.body).toBe('This content was removed after review.')
    expect((await moderate(secretary, 'MOD-0101', 'keep')).status).toBe(409)
  })

  it('shows the secretary only referred items, before and after deciding them', async () => {
    const secretary = await secretarySession(app)
    const admin = await login('ACCS-ADMIN')
    expect((await secretary.get('/api/pages/P49')).body.data.moderation).toEqual([])
    expect((await moderate(admin, 'MOD-0101', 'refer')).status).toBe(200)

    const listed = (await secretary.get('/api/pages/P49')).body.data.moderation
    expect(listed.map((m: { id: string }) => m.id)).toEqual(['MOD-0101'])
    expect(JSON.stringify(listed)).not.toMatch(/authorId|reporterId/)
    expect((await secretary.get('/api/pages/P50?id=MOD-0101')).status).toBe(200)
    expect((await secretary.get('/api/pages/P50?id=MOD-0102')).status).toBe(404)

    expect((await moderate(secretary, 'MOD-0101', 'keep')).status).toBe(200)
    expect((await secretary.get('/api/pages/P49')).body.data.moderation.map((m: { id: string; status: string }) => [m.id, m.status])).toEqual([['MOD-0101', 'Kept']])
    // The moderator still sees everything.
    expect((await admin.get('/api/pages/P49')).body.data.moderation).toHaveLength(3)
  })

  it('does not let the secretary act on an item that was not referred', async () => {
    const secretary = await secretarySession(app)
    expect((await moderate(secretary, 'MOD-0102', 'remove')).status).toBe(404)
    expect(item('MOD-0102').status).toBe('Pending')
  })

  it('keeps automatic filter flags out of referrals', async () => {
    await secretarySession(app)
    const admin = await login('ACCS-ADMIN')
    expect((await moderate(admin, 'MOD-0103', 'refer')).status).toBe(403)
    expect(item('MOD-0103').status).toBe('Pending')
  })

  it('keeps other roles out of moderation', async () => {
    const dean = await login('QCU-FAC-PAULA-DELACRUZ')
    expect((await dean.get('/api/pages/P49')).status).toBe(403)
    expect((await moderate(dean, 'MOD-0101', 'remove')).status).toBe(403)
  })

  it('gives the secretary the moderation notification category', async () => {
    const secretary = await secretarySession(app)
    expect((await secretary.get('/api/pages/P44')).body.data.categories).toContain('moderation')
  })
})
