// Messages: each person sees the other person's name on a direct conversation, and people can send files and pictures.
// Files go straight to storage through a signed upload; the message is saved only when every file is the sender's own
// upload with the declared size and type, and only the conversation's members get a link to it.
import request from 'supertest'
import { beforeEach, describe, expect, it } from 'vitest'

import { createApp } from '../src/app.js'
import { createMemoryAuthStore } from '../src/auth.js'
import { createMemoryMaterialStorage } from '../src/material-storage.js'
import { createMemoryRepository } from '../src/store.js'
import { seedPassword } from './helpers.js'

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
const photo = { fileName: 'Room 301.jpg', contentType: 'image/jpeg', size: 120_000 }
const pdf = { fileName: 'Rubric.pdf', contentType: 'application/pdf', size: 300_000 }
/** Asks for an upload, then stands in for the browser's PUT. */
async function upload(agent: Agent, userId: string, file: typeof photo) {
  const started = await agent.post('/api/messages/uploads').send(file)
  expect(started.status, JSON.stringify(started.body)).toBe(200)
  const attachment = started.body.record.attachment as typeof photo & { id: string }
  storage.put(`materials/messages/${userId}/${attachment.id}/${file.fileName.replace(/[^A-Za-z0-9._-]+/g, '_')}`, file.size, file.contentType)
  return attachment
}
const send = (agent: Agent, threadId: string, payload: object) => agent.post('/api/pages/P12/actions').send({ action: 'sendMessage', recordId: threadId, payload })
const thread = async (agent: Agent, id: string) => (await agent.get(`/api/pages/P12?id=${id}`)).body.data

describe('direct conversation names', () => {
  it('shows each person the other person, not themselves', async () => {
    const dean = await login('QCU-FAC-PAULA-DELACRUZ')
    const created = await dean.post('/api/pages/P11/actions').send({ action: 'createThread', payload: { recipientId: 'QCU-PROF-IT', body: 'helo' } })
    expect(created.status, JSON.stringify(created.body)).toBe(200)
    const id = created.body.record.id as string
    expect(created.body.record.title).toBe('Demo Professor Charlie')
    expect((await thread(dean, id)).record.title).toBe('Demo Professor Charlie')
    const professor = await login('QCU-PROF-IT')
    const seen = await thread(professor, id)
    expect(seen.record.title).toBe('Dr. Paula Joy L. Dela Cruz')
    expect(seen.threads.find((t: { id: string }) => t.id === id).title).toBe('Dr. Paula Joy L. Dela Cruz')
    // Searching finds it by the name each person sees.
    expect((await professor.get('/api/pages/P11?q=Paula')).body.data.threads.map((t: { id: string }) => t.id)).toContain(id)
  })

  it('keeps a conversation with its own topic as it is', async () => {
    const professor = await login('QCU-PROF-IT')
    expect((await thread(professor, 'THREAD-DIRECT-1')).record.title).toBe('Academic consultation')
  })
})

describe('files in messages', () => {
  it('sends a picture and a PDF that only the members can open', async () => {
    const student = await login('QCU-STU-IT-A')
    const files = [await upload(student, 'QCU-STU-IT-A', photo), await upload(student, 'QCU-STU-IT-A', pdf)]
    const sent = await send(student, 'THREAD-DIRECT-1', { body: 'Here is the room and the rubric.', attachments: files })
    expect(sent.status, JSON.stringify(sent.body)).toBe(200)
    expect(sent.body.record.attachments).toEqual(files)
    expect(JSON.stringify(sent.body)).not.toContain('materials/messages/')
    // Sent files are copies the upload URL cannot overwrite.
    expect(repo.read().threads.find((t) => t.id === 'THREAD-DIRECT-1')!.messages.at(-1)!.attachments!.map((a) => a.key)).toEqual([expect.stringMatching(/^materials\/sent\//), expect.stringMatching(/^materials\/sent\//)])

    const professor = await login('QCU-PROF-IT')
    const record = (await thread(professor, 'THREAD-DIRECT-1')).record
    const message = record.messages.at(-1)
    expect(message.attachments).toEqual(files)
    const base = `/api/threads/THREAD-DIRECT-1/messages/${message.id}/files`
    // A picture can open in the browser; any file downloads.
    const inline = await professor.get(`${base}/${files[0]!.id}?inline=1&format=json`)
    expect(inline.status).toBe(200)
    expect(inline.body.record.url).toContain('&inline=1')
    const download = await professor.get(`${base}/${files[1]!.id}`)
    expect(download.status).toBe(302)
    expect(download.headers.location).toContain('name=Rubric.pdf')
    expect(download.headers.location).not.toContain('inline')
    // A PDF never opens inline, even when asked.
    expect((await professor.get(`${base}/${files[1]!.id}?inline=1&format=json`)).body.record.url).not.toContain('inline')
    // Someone outside the conversation gets nothing.
    expect((await (await login('QCU-STU-CS')).get(`${base}/${files[0]!.id}?format=json`)).status).toBe(404)
  })

  it('sends a file with no words, and shows it in the conversation list', async () => {
    const student = await login('QCU-STU-IT-A')
    const file = await upload(student, 'QCU-STU-IT-A', pdf)
    const sent = await send(student, 'THREAD-DIRECT-1', { attachments: [file] })
    expect(sent.status, JSON.stringify(sent.body)).toBe(200)
    const listed = (await thread(student, 'THREAD-DIRECT-1')).threads.find((t: { id: string }) => t.id === 'THREAD-DIRECT-1')
    expect(listed.lastMessage).toBe('Sent Rubric.pdf')
  })

  it('starts a conversation with a file', async () => {
    const dean = await login('QCU-FAC-PAULA-DELACRUZ')
    const file = await upload(dean, 'QCU-FAC-PAULA-DELACRUZ', photo)
    const created = await dean.post('/api/pages/P11/actions').send({ action: 'createThread', payload: { recipientId: 'QCU-PROF-IT', body: '', attachments: [file] } })
    expect(created.status, JSON.stringify(created.body)).toBe(200)
    expect((await thread(dean, created.body.record.id)).record.messages[0].attachments).toEqual([file])
  })

  it('refuses an empty message, a file not yet uploaded, and someone else\'s upload', async () => {
    const student = await login('QCU-STU-IT-A')
    expect((await send(student, 'THREAD-DIRECT-1', { body: '  ' })).status).toBe(400)
    // Asked for, never uploaded.
    const started = (await student.post('/api/messages/uploads').send(photo)).body.record.attachment
    const missing = await send(student, 'THREAD-DIRECT-1', { body: 'x', attachments: [started] })
    expect(missing.status).toBe(409)
    expect(missing.body.error).toContain('has not finished uploading')
    // The professor's upload cannot be attached by the student: the key is looked up under the student's own ID.
    const professor = await login('QCU-PROF-IT')
    const theirs = await upload(professor, 'QCU-PROF-IT', photo)
    expect((await send(student, 'THREAD-DIRECT-1', { body: 'x', attachments: [theirs] })).status).toBe(409)
    // Stored with a different size than declared.
    const resized = await upload(student, 'QCU-STU-IT-A', photo)
    expect((await send(student, 'THREAD-DIRECT-1', { attachments: [{ ...resized, size: 1 }] })).status).toBe(409)
    // Nothing was saved by any of these.
    expect((await thread(student, 'THREAD-DIRECT-1')).record.messages).toHaveLength(1)
  })

  it('accepts only allowed types and sizes, and at most five files', async () => {
    const student = await login('QCU-STU-IT-A')
    expect((await student.post('/api/messages/uploads').send({ fileName: 'run.exe', contentType: 'application/x-msdownload', size: 10 })).status).toBe(400)
    expect((await student.post('/api/messages/uploads').send({ fileName: 'photo.pdf', contentType: 'image/png', size: 10 })).status).toBe(400)
    expect((await student.post('/api/messages/uploads').send({ ...pdf, size: 10 * 1024 * 1024 + 1 })).status).toBe(400)
    expect((await student.post('/api/messages/uploads').send({ fileName: 'a.gif', contentType: 'image/gif', size: 10 })).status).toBe(200)
    const files = await Promise.all(Array.from({ length: 6 }, () => upload(student, 'QCU-STU-IT-A', pdf)))
    expect((await send(student, 'THREAD-DIRECT-1', { attachments: files })).status).toBe(400)
  })

  it('says files are not set up when there is no storage', async () => {
    const plain = createApp(createMemoryRepository(), { authStore: createMemoryAuthStore() })
    const agent = request.agent(plain)
    await agent.post('/api/auth/sign-in').send({ emailOrId: 'QCU-STU-IT-A', password: seedPassword })
    expect((await agent.post('/api/messages/uploads').send(photo)).status).toBe(409)
  })
})
