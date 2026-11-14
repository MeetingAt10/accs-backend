// Issue #43: flagged content is hidden until it is reviewed (baseline chapter 10.4). While a post, comment or message has a
// moderation item that is Pending (a user's flag or a word-filter match) or referred to the CCS Secretary, only its author
// and the reviewers see it. "Keep" shows it again; "remove" and "remove and warn" work as before.
import request from 'supertest'
import { beforeEach, describe, expect, it } from 'vitest'

import { createApp } from '../src/app.js'
import { createMemoryAuthStore } from '../src/auth.js'
import { createMemoryRepository } from '../src/store.js'
import { secretarySession, seedPassword } from './helpers.js'

let repo: ReturnType<typeof createMemoryRepository>
let app: ReturnType<typeof createApp>
beforeEach(() => { repo = createMemoryRepository(); app = createApp(repo, { authStore: createMemoryAuthStore() }) })

async function login(id: string) {
  const agent = request.agent(app)
  expect((await agent.post('/api/auth/sign-in').send({ emailOrId: id, password: seedPassword })).status).toBe(200)
  return agent
}
type Agent = Awaited<ReturnType<typeof login>>
const moderate = (agent: Agent, recordId: string, decision: string) => agent.post('/api/pages/P50/actions').send({ action: 'moderate', recordId, reason: 'Reviewed', payload: { decision, notifyAuthor: false } })
const comments = async (agent: Agent, postId = 'POST-0102') => ((await agent.get(`/api/pages/P06?id=${postId}`)).body.data.record?.comments ?? []) as { id: string; underReview?: boolean }[]
const feedIds = async (agent: Agent) => ((await agent.get('/api/pages/P04')).body.data.posts as { id: string }[]).map((p) => p.id)
const latestModeration = () => repo.read().moderation.at(-1)!

describe('a flagged comment (the sample MOD-0101)', () => {
  it('is hidden from others until a moderator keeps it', async () => {
    // COMMENT-0101 on POST-0102, by QCU-STU-IT-B, flagged by QCU-STU-IT-A and still pending.
    const reporter = await login('QCU-STU-IT-A')
    expect((await comments(reporter)).map((c) => c.id)).not.toContain('COMMENT-0101')
    expect((await reporter.get('/api/pages/P06?id=POST-0102')).body.data.record.commentCount).toBe(0)
    expect(await comments(await login('QCU-STU-IT-B'))).toEqual([expect.objectContaining({ id: 'COMMENT-0101', underReview: true })])
    const admin = await login('ACCS-ADMIN')
    expect((await moderate(admin, 'MOD-0101', 'keep')).status).toBe(200)
    expect(await comments(reporter)).toEqual([expect.objectContaining({ id: 'COMMENT-0101' })])
    expect((await comments(reporter))[0]!.underReview).toBeUndefined()
  })

  it('stays removed after a moderator removes it', async () => {
    expect((await moderate(await login('ACCS-ADMIN'), 'MOD-0101', 'remove')).status).toBe(200)
    expect(await comments(await login('QCU-STU-IT-A'))).toEqual([expect.objectContaining({ id: 'COMMENT-0101', body: 'This content was removed after review.' })])
  })
})

describe('a flagged post', () => {
  it('leaves the feed and its page for everyone but the author and the moderators, and comes back when kept', async () => {
    // The seeded post is the demo Dean's, who is inactive here; the active Dean stands in as its author.
    repo.read().posts.find((p) => p.id === 'POST-0101')!.authorId = 'QCU-FAC-PAULA-DELACRUZ'
    const reader = await login('QCU-STU-IT-A')
    expect(await feedIds(reader)).toContain('POST-0101')
    expect((await reader.post('/api/pages/P06/actions').send({ action: 'flag', recordId: 'POST-0101', payload: { reason: 'Off topic' } })).status).toBe(200)
    const modId = latestModeration().id
    expect(await feedIds(reader)).not.toContain('POST-0101')
    expect((await reader.get('/api/pages/P06?id=POST-0101')).status).toBe(404)
    expect((await (await login('QCU-STU-CS')).get('/api/pages/P04')).body.data.posts.map((p: { id: string }) => p.id)).not.toContain('POST-0101')
    // Nobody else can comment on or react to it while it is held.
    expect((await reader.post('/api/pages/P06/actions').send({ action: 'comment', recordId: 'POST-0101', payload: { body: 'Me too' } })).status).toBe(404)
    expect((await reader.post('/api/pages/P06/actions').send({ action: 'react', recordId: 'POST-0101', payload: {} })).status).toBe(404)
    // The author (the Dean) still sees it, marked as under review.
    expect((await (await login('QCU-FAC-PAULA-DELACRUZ')).get('/api/pages/P06?id=POST-0101')).body.data.record).toMatchObject({ id: 'POST-0101', underReview: true })
    const admin = await login('ACCS-ADMIN')
    expect((await moderate(admin, modId, 'keep')).status).toBe(200)
    expect(await feedIds(reader)).toContain('POST-0101')
  })

  it('is removed for everyone when a moderator removes it, as before', async () => {
    const reader = await login('QCU-STU-IT-A')
    await reader.post('/api/pages/P06/actions').send({ action: 'flag', recordId: 'POST-0101', payload: { reason: 'Off topic' } })
    expect((await moderate(await login('ACCS-ADMIN'), latestModeration().id, 'warn')).status).toBe(200)
    expect((await reader.get('/api/pages/P06?id=POST-0101')).body.data.record).toMatchObject({ removed: true, body: 'This content was removed.' })
  })

  it('stays hidden while referred to the CCS Secretary, who can see it', async () => {
    const secretary = await secretarySession(app)
    const reader = await login('QCU-STU-IT-A')
    await reader.post('/api/pages/P06/actions').send({ action: 'flag', recordId: 'POST-0101', payload: { reason: 'Harassing tone' } })
    const modId = latestModeration().id
    // Before the referral, the Secretary is not one of its reviewers.
    expect((await secretary.get('/api/pages/P06?id=POST-0101')).status).toBe(404)
    expect((await moderate(await login('ACCS-ADMIN'), modId, 'refer')).status).toBe(200)
    expect(await feedIds(reader)).not.toContain('POST-0101')
    expect((await secretary.get('/api/pages/P06?id=POST-0101')).status).toBe(200)
    expect((await moderate(secretary, modId, 'keep')).status).toBe(200)
    expect(await feedIds(reader)).toContain('POST-0101')
  })
})

describe('a word-filter match', () => {
  it('is hidden from the moment it is posted, and its announcement notifies members only once kept', async () => {
    const organization = await login('QCU-ORG')
    const created = await organization.post('/api/pages/P05/actions').send({ action: 'createPost', payload: { title: 'Rules', body: 'Do not be stupid in the lab.', audience: 'organization:ORG-COMPUTING', kind: 'announcement', priority: 'important', notifyMembers: true, eventDate: '2027-01-15', eventTime: '13:00', eventPlace: 'IC 305', eventContact: 'Computing Society office' } })
    expect(created.status, JSON.stringify(created.body)).toBe(200)
    const postId = created.body.record.id as string
    expect(created.body.record.underReview).toBe(true)
    expect(latestModeration()).toMatchObject({ itemId: postId, source: 'Filter', status: 'Pending' })
    const member = await login('QCU-STU-IT-A')
    expect(await feedIds(member)).not.toContain(postId)
    expect(((await member.get('/api/pages/P13')).body.data.events as { postId?: string }[]).map((e) => e.postId)).not.toContain(postId)
    const notified = () => repo.read().notifications.filter((n) => n.recipientId === 'QCU-STU-IT-A' && n.recordId === postId)
    expect(notified()).toHaveLength(0)
    expect((await moderate(await login('ACCS-ADMIN'), latestModeration().id, 'keep')).status).toBe(200)
    expect(await feedIds(member)).toContain(postId)
    expect(notified()).toHaveLength(1)
  })
})

describe('a flagged message', () => {
  it('is hidden from the other members of the conversation until kept', async () => {
    const professor = await login('QCU-PROF-IT')
    expect((await professor.post('/api/pages/P12/actions').send({ action: 'flag', recordId: 'THREAD-DIRECT-1', payload: { reason: 'Inappropriate', itemType: 'message', itemId: 'MESSAGE-0102' } })).status).toBe(200)
    const thread = async (agent: Agent) => (await agent.get('/api/pages/P12?id=THREAD-DIRECT-1')).body.data
    const seenByProfessor = await thread(professor)
    expect(seenByProfessor.record.messages.map((m: { id: string }) => m.id)).not.toContain('MESSAGE-0102')
    expect(seenByProfessor.threads.find((t: { id: string }) => t.id === 'THREAD-DIRECT-1').lastMessage).toBe('')
    // The author still sees it, marked as under review.
    expect((await thread(await login('QCU-STU-IT-A'))).record.messages).toEqual([expect.objectContaining({ id: 'MESSAGE-0102', underReview: true })])
    expect((await moderate(await login('ACCS-ADMIN'), latestModeration().id, 'keep')).status).toBe(200)
    expect((await thread(professor)).record.messages.map((m: { id: string }) => m.id)).toContain('MESSAGE-0102')
  })
})
