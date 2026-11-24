// Issue #86: posts and comments have a choice of reactions. One per person; the same one again removes it, another one
// replaces it. Reactions stored before (a list of user IDs) count as "like".
import request from 'supertest'
import { beforeEach, describe, expect, it } from 'vitest'

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
type Agent = Awaited<ReturnType<typeof login>>
const react = (agent: Agent, reaction?: string) => agent.post('/api/pages/P06/actions').send({ action: 'react', recordId: 'POST-0102', payload: reaction ? { reaction } : {} })
const view = async (agent: Agent) => (await agent.get('/api/pages/P06?id=POST-0102')).body.data.record

describe('reactions (issue #86)', () => {
  it('adds, changes and removes a reaction, with counts per reaction', async () => {
    const [a, b] = [await login('QCU-STU-IT-A'), await login('QCU-STU-IT-B')]
    expect((await react(a, 'love')).status).toBe(200)
    expect((await react(b, 'love')).status).toBe(200)
    let seen = await view(a)
    expect(seen).toMatchObject({ myReaction: 'love', reactionCount: 2, reacted: true })
    expect(seen.reactionCounts).toMatchObject({ love: 2, like: 0 })
    // Another reaction replaces the first; the same one again removes it.
    await react(a, 'laugh')
    seen = await view(a)
    expect(seen.reactionCounts).toMatchObject({ love: 1, laugh: 1 })
    await react(a, 'laugh')
    seen = await view(a)
    expect(seen).toMatchObject({ myReaction: null, reactionCount: 1, reacted: false })
    expect((await react(a, 'angry')).status).toBe(400)
    // The record carries the react permission, so the feed list can show the button per post.
    expect(seen.canReact).toBe(true)
  })

  it('reads a reaction stored before the choice as "like", and an empty payload as "like"', async () => {
    await repo.transact((unit) => { unit.read().posts.find((p) => p.id === 'POST-0102')!.reactions = ['QCU-STU-IT-B'] })
    const [a, b] = [await login('QCU-STU-IT-A'), await login('QCU-STU-IT-B')]
    expect((await view(b))).toMatchObject({ myReaction: 'like', reactionCount: 1 })
    await react(a)
    expect((await view(a)).reactionCounts).toMatchObject({ like: 2 })
    // Changing the old reaction moves it into the new map.
    await react(b, 'support')
    expect((await view(b)).reactionCounts).toMatchObject({ like: 1, support: 1 })
  })

  it('lets the System Administrator react, since P06 offers the buttons to anyone who reads the post (code review, 23 November 2026)', async () => {
    const admin = await login('ACCS-ADMIN')
    expect((await admin.get('/api/pages/P06?id=POST-0101')).body.data.canReact).toBe(true)
    const reacted = await admin.post('/api/pages/P06/actions').send({ action: 'react', recordId: 'POST-0101', payload: { reaction: 'like' } })
    expect(reacted.status, JSON.stringify(reacted.body)).toBe(200)
  })

  it.each(['QCU-FAC-PAULA-DELACRUZ', 'QCU-CHAIR-IT', 'QCU-PROF-IT'])('lets %s react to a college post and to a comment (QA v5 F16)', async (id) => {
    const student = await login('QCU-STU-IT-A')
    const commented = await student.post('/api/pages/P06/actions').send({ action: 'comment', recordId: 'POST-0101', payload: { body: 'Noted, thank you.' } })
    const commentId = (commented.body.record.comments as { id: string }[]).at(-1)!.id
    const agent = await login(id)
    expect((await agent.get('/api/pages/P06?id=POST-0101')).body.data).toMatchObject({ canReact: true, record: { canReact: true } })
    const post = await agent.post('/api/pages/P06/actions').send({ action: 'react', recordId: 'POST-0101', payload: { reaction: 'like' } })
    expect(post.status, JSON.stringify(post.body)).toBe(200)
    const onComment = await agent.post('/api/pages/P06/actions').send({ action: 'reactComment', recordId: 'POST-0101', payload: { commentId, reaction: 'like' } })
    expect(onComment.status, JSON.stringify(onComment.body)).toBe(200)
  })

  it('reacts to a comment', async () => {
    const a = await login('QCU-STU-IT-A')
    const comment = await a.post('/api/pages/P06/actions').send({ action: 'comment', recordId: 'POST-0102', payload: { body: 'Same here, thanks for asking.' } })
    const commentId = (comment.body.record.comments as { id: string }[]).at(-1)!.id
    const reacted = await a.post('/api/pages/P06/actions').send({ action: 'reactComment', recordId: 'POST-0102', payload: { commentId, reaction: 'support' } })
    expect(reacted.status, JSON.stringify(reacted.body)).toBe(200)
    const seen = (reacted.body.record.comments as { id: string; myReaction: string; reactionCounts: Record<string, number> }[]).find((c) => c.id === commentId)!
    expect(seen).toMatchObject({ myReaction: 'support' })
    expect(seen.reactionCounts.support).toBe(1)
    expect((await a.post('/api/pages/P06/actions').send({ action: 'reactComment', recordId: 'POST-0102', payload: { commentId: 'NOPE', reaction: 'like' } })).status).toBe(404)
  })
})
