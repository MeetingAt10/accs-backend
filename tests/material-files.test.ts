// Issue #44, part 2: class material files. The professor gets a signed upload for exactly the declared type and size,
// uploads straight to storage, then confirms; students see the file once confirmed and download it through a short-lived
// link after an access check. Up to 25 MB; PDF, Word, PowerPoint, Excel, plain text, PNG and JPG.
import { S3Client } from '@aws-sdk/client-s3'
import request from 'supertest'
import { beforeEach, describe, expect, it } from 'vitest'

import { createApp } from '../src/app.js'
import { createMemoryAuthStore } from '../src/auth.js'
import { createMemoryMaterialStorage, createS3MaterialStorage, safeFileName } from '../src/material-storage.js'
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
const pdf = { spaceId: 'SUBJECT-IT-DS', title: 'Week 6 notes', note: 'Trees.', fileName: 'Week 6 Notes.pdf', contentType: 'application/pdf', size: 2_000_000 }
const start = (agent: Agent, extra: object = {}) => agent.post('/api/materials/uploads').send({ ...pdf, ...extra })
const complete = (agent: Agent, id: string) => agent.post(`/api/materials/${id}/complete`).send({})
const materials = async (agent: Agent) => (await agent.get('/api/pages/P08?id=SUBJECT-IT-DS')).body.data.record.materials as { id: string; kind: string; status?: string; key?: string; downloadUrl?: string }[]
/** Starts an upload, stores the file as the browser would, and confirms it. */
async function uploaded(agent: Agent, extra: object = {}) {
  const started = await start(agent, extra)
  expect(started.status, JSON.stringify(started.body)).toBe(200)
  const { material } = started.body.record
  const key = repo.read().materials.find((m) => m.id === material.id)!.key!
  storage.put(key, material.size, material.contentType)
  expect((await complete(agent, material.id)).status).toBe(200)
  return material.id as string
}

describe('uploading a class material file', () => {
  it('gives the professor a signed upload for exactly that type and size, and keeps the file from students until confirmed', async () => {
    const professor = await login('QCU-PROF-IT')
    const started = await start(professor)
    expect(started.status, JSON.stringify(started.body)).toBe(200)
    const { material, upload } = started.body.record
    expect(material).toMatchObject({ kind: 'file', status: 'pending', fileName: 'Week 6 Notes.pdf', contentType: 'application/pdf', size: 2_000_000 })
    expect(material.key).toBeUndefined()
    expect(upload).toMatchObject({ method: 'PUT', headers: { 'Content-Type': 'application/pdf', 'Content-Length': '2000000' }, expiresInSeconds: 600 })
    expect(repo.read().materials.at(-1)!.key).toBe(`materials/SUBJECT-IT-DS/${material.id}/Week_6_Notes.pdf`)
    const student = await login('QCU-STU-IT-A')
    expect((await materials(student)).map((m) => m.id)).not.toContain(material.id)
    expect((await materials(professor)).find((m) => m.id === material.id)).toMatchObject({ status: 'pending' })
    expect((await student.get(`/api/materials/${material.id}/file`)).status).toBe(404)
  })

  it('confirms only when the stored file matches, then shows it to students with a download link', async () => {
    const professor = await login('QCU-PROF-IT')
    const { material } = (await start(professor)).body.record
    const key = repo.read().materials.find((m) => m.id === material.id)!.key!
    // Nothing uploaded yet.
    expect((await complete(professor, material.id)).status).toBe(409)
    // A different size than declared is refused and the stored file is removed.
    storage.put(key, 3_000_000, 'application/pdf')
    const wrong = await complete(professor, material.id)
    expect([wrong.status, wrong.body.error]).toEqual([409, 'The uploaded file does not match what was declared. Upload it again.'])
    expect(storage.objects.has(key)).toBe(false)
    storage.put(key, 2_000_000, 'application/pdf')
    expect((await complete(professor, material.id)).body.record).toMatchObject({ status: 'ready' })
    const student = await login('QCU-STU-IT-A')
    const shown = (await materials(student)).find((m) => m.id === material.id)!
    expect(shown).toMatchObject({ kind: 'file', status: 'ready', downloadUrl: `/api/materials/${material.id}/file` })
    expect(shown.key).toBeUndefined()
    const download = await student.get(`/api/materials/${material.id}/file`).redirects(0)
    // The confirmed file is a copy the upload URL cannot overwrite; the upload itself is gone.
    const frozen = repo.read().materials.find((m) => m.id === material.id)!.key!
    expect(frozen).toMatch(/^materials\/classes\//)
    expect(storage.objects.has(key)).toBe(false)
    expect([download.status, download.headers.location]).toEqual([302, `memory://download/${frozen}?name=Week_6_Notes.pdf`])
    expect(repo.read().audit.filter((a) => a.reference === material.id).map((a) => a.action)).toEqual(['Class material file upload started', 'Class material added'])
  })

  it('accepts only the allowed types, matching extensions and files up to 25 MB', async () => {
    const professor = await login('QCU-PROF-IT')
    const refused = async (extra: object, path: string) => { const r = await start(professor, extra); expect([JSON.stringify(extra), r.status, r.body.fields?.[0]?.path]).toEqual([JSON.stringify(extra), 400, path]) }
    await refused({ contentType: 'application/zip', fileName: 'slides.zip' }, 'contentType')
    await refused({ contentType: 'text/html', fileName: 'page.html' }, 'contentType')
    await refused({ contentType: 'application/pdf', fileName: 'notes.exe' }, 'fileName')
    await refused({ contentType: 'image/png', fileName: 'photo.jpg' }, 'fileName')
    await refused({ size: 25 * 1024 * 1024 + 1 }, 'size')
    await refused({ size: 0 }, 'size')
    for (const [contentType, fileName] of [['application/vnd.openxmlformats-officedocument.presentationml.presentation', 'Lecture.pptx'], ['image/jpeg', 'board.JPEG'], ['text/plain', 'readme.txt'], ['application/vnd.ms-excel', 'grades.xls']]) {
      expect([fileName, (await start(professor, { contentType, fileName, size: 25 * 1024 * 1024 })).status]).toEqual([fileName, 200])
    }
  })

  it('is for the subject\'s professors only, and is downloaded only by its professors and students', async () => {
    expect((await start(await login('QCU-STU-IT-A'))).status).toBe(403)
    expect((await start(await login('QCU-FAC-PAULA-DELACRUZ'))).status).toBe(403)
    expect((await start(await login('QCU-PROF-OTHER'))).status).toBe(404)
    expect((await start(await login('QCU-PROF-IT'), { spaceId: 'SPACE-IT-A' })).status).toBe(404)
    const id = await uploaded(await login('QCU-PROF-IT'))
    expect((await (await login('QCU-STU-IT-A')).get(`/api/materials/${id}/file`).redirects(0)).status).toBe(302)
    expect((await (await login('QCU-CHAIR-IT')).get(`/api/materials/${id}/file`).redirects(0)).status).toBe(302)
    for (const other of ['QCU-STU-IT-B', 'QCU-PROF-OTHER', 'QCU-FAC-PAULA-DELACRUZ']) expect([other, (await (await login(other)).get(`/api/materials/${id}/file`)).status]).toEqual([other, 404])
    // Only the subject's professors confirm an upload.
    const { material } = (await start(await login('QCU-PROF-IT'))).body.record
    expect((await complete(await login('QCU-STU-IT-A'), material.id)).status).toBe(403)
  })

  it('deletes the stored file when the material is removed, and keeps the file when it is renamed', async () => {
    const professor = await login('QCU-PROF-IT')
    const id = await uploaded(professor)
    const key = repo.read().materials.find((m) => m.id === id)!.key!
    const renamed = await professor.post('/api/pages/P08/actions').send({ action: 'updateMaterial', recordId: id, payload: { title: 'Week 6 notes (final)' } })
    expect(renamed.status, JSON.stringify(renamed.body)).toBe(200)
    expect((await professor.post('/api/pages/P08/actions').send({ action: 'updateMaterial', recordId: id, payload: { title: 'x', url: 'https://example.edu' } })).status).toBe(400)
    expect(storage.objects.has(key)).toBe(true)
    expect((await professor.post('/api/pages/P08/actions').send({ action: 'removeMaterial', recordId: id, payload: {} })).status).toBe(200)
    expect(storage.objects.has(key)).toBe(false)
  })

  it('still requires a link when a link material is changed', async () => {
    const professor = await login('QCU-PROF-IT')
    const added = await professor.post('/api/pages/P08/actions').send({ action: 'addMaterial', payload: { spaceId: 'SUBJECT-IT-DS', title: 'Slides', url: 'https://example.edu/a' } })
    expect((await professor.post('/api/pages/P08/actions').send({ action: 'updateMaterial', recordId: added.body.record.id, payload: { title: 'Slides' } })).status).toBe(400)
  })

  it('says files are not set up when there is no bucket, and links still work', async () => {
    app = createApp(repo, { authStore: createMemoryAuthStore() })
    const professor = await login('QCU-PROF-IT')
    const refused = await start(professor)
    expect([refused.status, refused.body.error]).toEqual([409, 'File uploads are not set up yet. Share a link instead.'])
    expect(repo.read().materials).toEqual([])
    expect((await professor.post('/api/pages/P08/actions').send({ action: 'addMaterial', payload: { spaceId: 'SUBJECT-IT-DS', title: 'Slides', url: 'https://example.edu/a' } })).status).toBe(200)
  })
})

describe('S3 storage', () => {
  it('signs no checksum of an empty body into an upload, so S3 accepts the real file', async () => {
    const saved = { ...process.env }
    Object.assign(process.env, { AWS_REGION: 'ap-southeast-1', AWS_ACCESS_KEY_ID: 'AKIDEXAMPLE', AWS_SECRET_ACCESS_KEY: 'secret' })
    try {
      const put = await createS3MaterialStorage('accs-dev-materials').uploadUrl('materials/S/M/notes.pdf', 'application/pdf', 1234)
      expect(put).not.toMatch(/checksum/i)
    } finally {
      process.env = saved
    }
  })

  it('signs an upload that only accepts the declared type and size, and a download under the original name', async () => {
    const s3 = new S3Client({ region: 'ap-southeast-1', credentials: { accessKeyId: 'AKIDEXAMPLE', secretAccessKey: 'secret' } })
    const s3Storage = createS3MaterialStorage('accs-dev-materials', s3)
    const put = new URL(await s3Storage.uploadUrl('materials/S/M/notes.pdf', 'application/pdf', 1234))
    expect(put.pathname).toContain('materials/S/M/notes.pdf')
    expect(put.searchParams.get('X-Amz-Expires')).toBe('600')
    expect(put.searchParams.get('X-Amz-SignedHeaders')!.split(';')).toEqual(expect.arrayContaining(['content-length', 'content-type', 'host']))
    const get = new URL(await s3Storage.downloadUrl('materials/S/M/notes.pdf', 'Week 6 "notes".pdf'))
    expect(get.searchParams.get('X-Amz-Expires')).toBe('300')
    expect(get.searchParams.get('response-content-disposition')).toBe('attachment; filename="Week_6_notes_.pdf"')
    // No slash survives, so a name cannot leave its folder in the bucket.
    expect(safeFileName('../../etc/passwd')).toBe('_.._etc_passwd')
    expect(safeFileName('...')).toBe('file')
  })
})
