// Issue #85: people can add a profile photo. It shows wherever the person shows (directory, posts, My profile), never on
// anonymous posts, and only small JPEG, PNG or WebP images are accepted.
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
type Agent = Awaited<ReturnType<typeof login>>
const photo = 'data:image/jpeg;base64,' + 'A'.repeat(4000)
const setPhoto = (agent: Agent, value: string | null) => agent.post('/api/pages/P39/actions').send({ action: 'setProfilePhoto', payload: { photo: value } })

describe('profile photos (issue #85)', () => {
  it('sets a photo that shows on My profile, in the directory and on posts, then removes it', async () => {
    const prof = await login('QCU-PROF-IT')
    const saved = await setPhoto(prof, photo)
    expect(saved.status, JSON.stringify(saved.body)).toBe(200)
    expect(saved.body.record.photo).toBe(photo)
    expect((await prof.get('/api/pages/P39')).body.data.record.photo).toBe(photo)
    const student = await login('QCU-STU-IT-A')
    const people = (await student.get('/api/pages/P37')).body.data.people as { id: string; photo?: string }[]
    expect(people.find((p) => p.id === 'QCU-PROF-IT')?.photo).toBe(photo)
    const feed = (await student.get('/api/pages/P04')).body.data.posts as { author: { id?: string; photo?: string } }[]
    expect(feed.filter((p) => p.author.id === 'QCU-PROF-IT').every((p) => p.author.photo === photo)).toBe(true)
    expect((await setPhoto(prof, null)).status).toBe(200)
    expect((await prof.get('/api/pages/P39')).body.data.record.photo).toBeUndefined()
  })

  it('never shows a photo on an anonymous post', async () => {
    const student = await login('QCU-STU-IT-A')
    await setPhoto(student, photo)
    const created = await student.post('/api/pages/P05/actions').send({ action: 'createPost', payload: { title: 'Lab hours', body: 'Can the lab open on Saturday?', audience: 'college', kind: 'discussion', label: 'Discussion', anonymous: true } })
    expect(created.status, JSON.stringify(created.body)).toBe(200)
    expect(created.body.record.author.photo).toBeUndefined()
    expect(created.body.record.author.anonymous).toBe(true)
  })

  it('refuses other file types and oversized images', async () => {
    const student = await login('QCU-STU-IT-A')
    expect((await setPhoto(student, 'data:image/gif;base64,AAAA')).status).toBe(400)
    expect((await setPhoto(student, 'https://example.com/me.jpg')).status).toBe(400)
    expect((await setPhoto(student, 'data:image/png;base64,' + 'A'.repeat(108_000))).status).toBe(400)
    expect(repo.read().photos['QCU-STU-IT-A']).toBeUndefined()
  })
})
