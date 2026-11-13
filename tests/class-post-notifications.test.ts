// Students hear about it when a professor posts in their class space: a "New post in your class" notification that names
// the professor, the class and the post. Other people, the author, and students' own posts send nothing.
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
const post = (agent: Awaited<ReturnType<typeof login>>, extra: object = {}) => agent.post('/api/pages/P05/actions').send({ action: 'createPost', payload: { title: 'Week 6 notes', body: 'Trees and heaps are up.', audience: 'space:SUBJECT-IT-DS', kind: 'discussion', label: 'Discussion', ...extra } })
const classNotices = async (postId: string) => (await repo.transact((unit) => unit.read().notifications.filter((n) => n.kind === 'class' && n.recordId === postId).map((n) => ({ to: n.recipientId, title: n.title, body: n.body }))))

describe('class post notifications', () => {
  it('tells the class\'s students when their professor posts', async () => {
    const created = await post(await login('QCU-PROF-IT'))
    expect(created.status, JSON.stringify(created.body)).toBe(200)
    const notices = await classNotices(created.body.record.id)
    const students = await repo.transact((unit) => unit.read().spaces.find((s) => s.id === 'SUBJECT-IT-DS')!.studentIds)
    expect(notices.map((n) => n.to).sort()).toEqual([...students].sort())
    expect(notices[0]).toMatchObject({ title: 'New post in your class', body: 'Prof. Robin Elm posted in SBIT3A - CC 104 Data Structures: Week 6 notes' })
    // Nobody outside the class, and not the professor.
    expect(notices.map((n) => n.to)).not.toContain('QCU-STU-CS')
    expect(notices.map((n) => n.to)).not.toContain('QCU-PROF-IT')
  })

  it('sends nothing for a student\'s post', async () => {
    const created = await post(await login('QCU-STU-IT-A'))
    expect(created.status, JSON.stringify(created.body)).toBe(200)
    expect(await classNotices(created.body.record.id)).toEqual([])
  })

  it('does not send an announcement twice', async () => {
    const created = await post(await login('QCU-PROF-IT'), { kind: 'announcement', label: undefined, notifyMembers: true, priority: 'general', eventDate: '2026-12-01', eventTime: '09:00', eventPlace: 'IC 301', eventContact: 'Prof. Robin Elm' })
    expect(created.status, JSON.stringify(created.body)).toBe(200)
    expect(await classNotices(created.body.record.id)).toEqual([])
    const announced = await repo.transact((unit) => unit.read().notifications.filter((n) => n.kind === 'announcement' && n.recordId === created.body.record.id).length)
    expect(announced).toBeGreaterThan(0)
  })

  it('lets students choose how class posts reach them', async () => {
    const page = await (await login('QCU-STU-IT-A')).get('/api/pages/P43')
    expect(JSON.stringify(page.body.data)).toContain('"class"')
  })
})
