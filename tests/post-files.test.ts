// Pictures and files on posts: uploaded like message files, checked against storage before the post is saved, and
// opened only by people who can read the post. An edit keeps the files unless it names them.
import request from 'supertest'
import { beforeEach, describe, expect, it } from 'vitest'

import { createApp } from '../src/app.js'
import { createMemoryAuthStore } from '../src/auth.js'
import { createMemoryMaterialStorage } from '../src/material-storage.js'
import { createMemoryRepository } from '../src/store.js'
import { secretarySession, seedPassword } from './helpers.js'

let repo: ReturnType<typeof createMemoryRepository>
let app: ReturnType<typeof createApp>
let storage: ReturnType<typeof createMemoryMaterialStorage>
beforeEach(() => {
  repo = createMemoryRepository()
  storage = createMemoryMaterialStorage()
  app = createApp(repo, { authStore: createMemoryAuthStore(), materialStorage: storage })
})

async function login(id: string) {
  const agent = request.agent(app)
  expect((await agent.post('/api/auth/sign-in').send({ emailOrId: id, password: seedPassword })).status).toBe(200)
  return agent
}
type Agent = Awaited<ReturnType<typeof login>>
const photo = { fileName: 'Board.jpg', contentType: 'image/jpeg', size: 90_000 }
const pdf = { fileName: 'Week 6.pdf', contentType: 'application/pdf', size: 200_000 }
async function upload(agent: Agent, userId: string, file: typeof photo) {
  const started = await agent.post('/api/uploads').send(file)
  expect(started.status, JSON.stringify(started.body)).toBe(200)
  const attachment = started.body.record.attachment as typeof photo & { id: string }
  storage.put(`materials/messages/${userId}/${attachment.id}/${file.fileName.replace(/[^A-Za-z0-9._-]+/g, '_')}`, file.size, file.contentType)
  return attachment
}
const create = (agent: Agent, payload: object) => agent.post('/api/pages/P05/actions').send({ action: 'createPost', payload: { title: 'Week 6 board', audience: 'space:SUBJECT-IT-DS', kind: 'discussion', label: 'Discussion', ...payload } })
const view = async (agent: Agent, id: string) => (await agent.get(`/api/pages/P06?id=${id}`)).body.data.record

describe('files on posts', () => {
  it('posts a picture and a PDF that the class can open and others cannot', async () => {
    const professor = await login('QCU-PROF-IT')
    const files = [await upload(professor, 'QCU-PROF-IT', photo), await upload(professor, 'QCU-PROF-IT', pdf)]
    const created = await create(professor, { body: 'Notes from today.', attachments: files })
    expect(created.status, JSON.stringify(created.body)).toBe(200)
    expect(created.body.record.attachments).toEqual(files)
    expect(JSON.stringify(created.body)).not.toContain('materials/messages/')
    const id = created.body.record.id as string

    const student = await login('QCU-STU-IT-A')
    expect((await view(student, id)).attachments).toEqual(files)
    const picture = await student.get(`/api/posts/${id}/files/${files[0]!.id}?inline=1&format=json`)
    expect(picture.status).toBe(200)
    expect(picture.body.record.url).toContain('&inline=1')
    const download = await student.get(`/api/posts/${id}/files/${files[1]!.id}`)
    expect(download.status).toBe(302)
    expect(download.headers.location).toContain('name=Week_6.pdf')
    // A student of another program cannot read the class post, so cannot open its files.
    expect((await (await login('QCU-STU-CS')).get(`/api/posts/${id}/files/${files[0]!.id}?format=json`)).status).toBe(404)
  })

  it('lets the Secretary open the files of a post referred to them', async () => {
    const professor = await login('QCU-PROF-IT')
    const file = await upload(professor, 'QCU-PROF-IT', pdf)
    const id = (await create(professor, { body: 'See the file.', attachments: [file] })).body.record.id as string
    repo.read().moderation.push({ id: 'MOD-TEST', itemType: 'post', itemId: id, parentId: id, authorId: 'QCU-PROF-IT', reporterId: 'QCU-STU-IT-A', source: 'User', reason: 'Check', excerpt: '', status: 'Referred to the CCS Secretary', at: '2026-11-14T00:00:00.000Z', history: [{ at: '2026-11-14T00:00:00.000Z', actorId: 'ACCS-ADMIN', decision: 'refer', reason: 'Yours' }] } as never)
    const secretary = await secretarySession(app)
    expect((await secretary.get(`/api/posts/${id}/files/${file.id}?format=json`)).status).toBe(200)
  })

  it('removes the copies already made when a later file fails', async () => {
    const student = await login('QCU-STU-IT-A')
    const files = [await upload(student, 'QCU-STU-IT-A', photo), await upload(student, 'QCU-STU-IT-A', pdf)]
    const before = storage.objects.size
    const copy = storage.copy
    let calls = 0
    storage.copy = async (from, to) => { if (++calls === 2) throw new Error('S3 unavailable'); return copy(from, to) }
    expect((await create(student, { body: 'Two files', attachments: files })).status).toBe(500)
    storage.copy = copy
    expect(storage.objects.size).toBe(before)
  })

  it('leaves no copy of a file behind when the post is refused', async () => {
    const student = await login('QCU-STU-IT-A')
    const picture = await upload(student, 'QCU-STU-IT-A', photo)
    const before = storage.objects.size
    // Students cannot post announcements: refused after the file check, so its copy is removed again.
    expect((await create(student, { body: 'Hi', kind: 'announcement', audience: 'college', attachments: [picture] })).status).toBe(403)
    expect((await student.post('/api/pages/P01/actions').send({ action: 'createPost', payload: { title: 'x', body: 'Hi', audience: 'college', kind: 'discussion', label: 'Discussion', attachments: [picture] } })).status).toBe(403)
    expect(storage.objects.size).toBe(before)
  })

  it('never shows the author of an anonymous post in a file link', async () => {
    const student = await login('QCU-STU-IT-A')
    const picture = await upload(student, 'QCU-STU-IT-A', photo)
    const created = await create(student, { body: 'Ganito yung room.', audience: 'college', label: 'Rant', anonymous: true, attachments: [picture] })
    expect(created.status, JSON.stringify(created.body)).toBe(200)
    const link = await (await login('QCU-STU-IT-B')).get(`/api/posts/${created.body.record.id}/files/${picture.id}?format=json`)
    expect(link.status).toBe(200)
    expect(link.body.record.url).toContain('materials/posts/')
    expect(link.body.record.url).not.toContain('QCU-STU-IT-A')
  })

  it('posts pictures with no words, but not an empty post', async () => {
    const student = await login('QCU-STU-IT-A')
    expect((await create(student, { body: '' })).status).toBe(400)
    const picture = await upload(student, 'QCU-STU-IT-A', photo)
    const created = await create(student, { body: '', attachments: [picture] })
    expect(created.status, JSON.stringify(created.body)).toBe(200)
  })

  it('keeps files on an edit that leaves them out, and removes them when told to', async () => {
    const professor = await login('QCU-PROF-IT')
    const file = await upload(professor, 'QCU-PROF-IT', pdf)
    const id = (await create(professor, { body: 'See the file.', attachments: [file] })).body.record.id as string
    const edit = (payload: object) => professor.post('/api/pages/P06/actions').send({ action: 'updatePost', recordId: id, payload: { title: 'Week 6 board', label: 'Discussion', ...payload } })
    expect((await edit({ body: 'See the file. Updated.' })).status).toBe(200)
    expect((await view(professor, id)).attachments).toEqual([file])
    // Removing every file from a post with no words is refused, and nothing changes.
    expect((await edit({ body: '', attachments: [] })).status).toBe(400)
    expect((await edit({ body: 'No file now.', attachments: [] })).status).toBe(200)
    expect((await view(professor, id)).attachments).toBeUndefined()
  })

  it('refuses a file that was never uploaded, or someone else\'s', async () => {
    const student = await login('QCU-STU-IT-A')
    const never = (await student.post('/api/uploads').send(photo)).body.record.attachment
    expect((await create(student, { body: 'x', attachments: [never] })).status).toBe(409)
    const professor = await login('QCU-PROF-IT')
    const theirs = await upload(professor, 'QCU-PROF-IT', photo)
    expect((await create(student, { body: 'x', attachments: [theirs] })).status).toBe(409)
  })

  it('hides the files of a removed post', async () => {
    const professor = await login('QCU-PROF-IT')
    const file = await upload(professor, 'QCU-PROF-IT', photo)
    const id = (await create(professor, { body: 'Board.', attachments: [file] })).body.record.id as string
    await repo.transact((unit) => { unit.read().posts.find((p) => p.id === id)!.removed = true })
    expect((await view(professor, id)).attachments).toBeUndefined()
    expect((await professor.get(`/api/posts/${id}/files/${file.id}?format=json`)).status).toBe(404)
  })
})
