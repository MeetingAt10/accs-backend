// Issue #84: posts, comments and messages with curse words (English and Filipino, including disguised spellings) are flagged
// automatically. The item is held for a moderator (#43): hidden from everyone but its author until someone decides.
import request from 'supertest'
import { beforeEach, describe, expect, it } from 'vitest'

import { createApp } from '../src/app.js'
import { createMemoryAuthStore } from '../src/auth.js'
import { findFlaggedWord } from '../src/profanity.js'
import { createMemoryRepository } from '../src/store.js'
import { seedPassword } from './helpers.js'

describe('the word list', () => {
  it('finds English and Filipino curse words', () => {
    for (const text of ['what the fuck', 'This is bullshit.', 'Putangina naman', 'tang ina mo', 'Ang gago mo', 'bobo talaga', 'ULOL', 'you idiot', 'gagong to'])
      expect(findFlaggedWord(text), text).toBeDefined()
  })

  it('finds disguised spellings', () => {
    for (const text of ['f.u.c.k this', 'sh1t', 'fuuuuck', 'g a g o', 'b1tch', 'pvta', 'tang!na', 'F*U*C*K'])
      expect(findFlaggedWord(text), text).toBeDefined()
  })

  it('leaves ordinary words alone, including ones that contain a flagged word', () => {
    for (const text of ['The computation is due Friday.', 'We read Dickens in class.', 'Leche flan for the party!', 'Gagawin ko bukas.', 'Tangalin ang lumang post.', 'Is the class assignment due?', 'Ang hayop sa zoo ay malusog.', 'Thanks for the help', 'Scunthorpe'])
      expect(findFlaggedWord(text), text).toBeUndefined()
  })
})

let repo: ReturnType<typeof createMemoryRepository>
let app: ReturnType<typeof createApp>
beforeEach(() => { repo = createMemoryRepository(); app = createApp(repo, { authStore: createMemoryAuthStore() }) })

async function login(id: string) {
  const agent = request.agent(app)
  expect((await agent.post('/api/auth/sign-in').send({ emailOrId: id, password: seedPassword })).status).toBe(200)
  return agent
}
const latest = () => repo.read().moderation.at(-1)!
const post = (agent: Awaited<ReturnType<typeof login>>, title: string, body: string) =>
  agent.post('/api/pages/P05/actions').send({ action: 'createPost', payload: { title, body, audience: 'college', kind: 'discussion', label: 'Rant', anonymous: false } })

describe('automatic flags (issue #84)', () => {
  it('holds a post with a curse word in the title or the body, and not a clean one', async () => {
    const student = await login('QCU-STU-IT-A')
    const before = repo.read().moderation.length
    const clean = await post(student, 'Lab schedule', 'Is IC 301 free on Monday?')
    expect(clean.status, JSON.stringify(clean.body)).toBe(200)
    expect(repo.read().moderation).toHaveLength(before)
    const flagged = await post(student, 'Ang gago ng schedule', 'Walang abiso.')
    expect(flagged.status).toBe(200)
    expect(flagged.body.record.underReview).toBe(true)
    expect(latest()).toMatchObject({ itemType: 'post', itemId: flagged.body.record.id, source: 'Filter', status: 'Pending', authorId: 'QCU-STU-IT-A' })
    expect(latest().reason).toMatch(/^Automatic/)
    // Others do not see it until a moderator keeps it.
    const other = await login('QCU-STU-IT-B')
    const feed = (await other.get('/api/pages/P04')).body.data.posts as { id: string }[]
    expect(feed.map((p) => p.id)).not.toContain(flagged.body.record.id)
  })

  it('holds a comment and a message with a curse word', async () => {
    const student = await login('QCU-STU-IT-A')
    const commented = await student.post('/api/pages/P06/actions').send({ action: 'comment', recordId: 'POST-0102', payload: { body: 'sh1t, same here' } })
    expect(commented.status, JSON.stringify(commented.body)).toBe(200)
    expect(latest()).toMatchObject({ itemType: 'comment', parentId: 'POST-0102', source: 'Filter', status: 'Pending' })
    const sent = await student.post('/api/pages/P12/actions').send({ action: 'sendMessage', recordId: 'THREAD-IT-A', payload: { body: 'putangina, late na naman' } })
    expect(sent.status, JSON.stringify(sent.body)).toBe(200)
    expect(latest()).toMatchObject({ itemType: 'message', parentId: 'THREAD-IT-A', source: 'Filter', status: 'Pending' })
  })

  it('holds the first message of a new conversation', async () => {
    const student = await login('QCU-STU-IT-A')
    const created = await student.post('/api/pages/P11/actions').send({ action: 'createThread', payload: { recipientId: 'QCU-PROF-IT', body: 'bobo ng system' } })
    expect(created.status, JSON.stringify(created.body)).toBe(200)
    expect(latest()).toMatchObject({ itemType: 'message', parentId: created.body.record.id, source: 'Filter', status: 'Pending' })
  })
})
