// Pictures and videos on forum posts: posts also take MP4 and WebM videos (up to 100 MB), and people who can read the post
// get a short-lived CloudFront signed URL for its pictures and videos. Messages keep the picture-and-file list.
import { createVerify, generateKeyPairSync } from 'node:crypto'

import request from 'supertest'
import { beforeEach, describe, expect, it } from 'vitest'

import { createApp } from '../src/app.js'
import { createMemoryMaterialStorage } from '../src/material-storage.js'
import { createMediaSigner, signCloudFrontUrl } from '../src/media-cdn.js'
import { createMemoryRepository } from '../src/store.js'
import { seedPassword, setUpAuthStore } from './helpers.js'

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } })
const now = Date.UTC(2026, 10, 25, 8, 0, 0)

/** Checks a canned-policy signed URL the way CloudFront does, and returns its expiry. */
function verified(link: string) {
  const url = new URL(link)
  const expires = Number(url.searchParams.get('Expires'))
  const signature = url.searchParams.get('Signature')!.replace(/-/g, '+').replace(/_/g, '=').replace(/~/g, '/')
  for (const name of ['Expires', 'Signature', 'Key-Pair-Id']) url.searchParams.delete(name)
  const resource = url.toString().replace(/\?$/, '')
  const policy = JSON.stringify({ Statement: [{ Resource: resource, Condition: { DateLessThan: { 'AWS:EpochTime': expires } } }] })
  expect(createVerify('RSA-SHA1').update(policy).verify(publicKey, signature, 'base64')).toBe(true)
  return { expires, keyPairId: link.split('Key-Pair-Id=')[1], resource }
}

describe('CloudFront signed URLs', () => {
  it('signs a canned policy CloudFront accepts', () => {
    const link = signCloudFrontUrl('https://media.example.net/materials/posts/A/clip.mp4', 'K2EXAMPLE', privateKey, 1_800_000_000)
    expect(link).toMatch(/^https:\/\/media\.example\.net\/materials\/posts\/A\/clip\.mp4\?Expires=1800000000&Signature=[A-Za-z0-9~_-]+&Key-Pair-Id=K2EXAMPLE$/)
    expect(verified(link)).toMatchObject({ expires: 1_800_000_000, keyPairId: 'K2EXAMPLE' })
  })

  it('reads the key once, encodes the key path and expires after the given time', async () => {
    let reads = 0
    const signer = createMediaSigner('media.example.net', 'K2EXAMPLE', async () => { reads++; return privateKey }, () => now)
    const link = await signer.url('materials/posts/01J/My clip.webm', 3600)
    await signer.url('materials/posts/01J/b.png', 300)
    expect(reads).toBe(1)
    expect(verified(link)).toMatchObject({ expires: now / 1000 + 3600, resource: 'https://media.example.net/materials/posts/01J/My%20clip.webm' })
  })

  it('tries the key again after a failed read', async () => {
    let reads = 0
    const signer = createMediaSigner('media.example.net', 'K', async () => { if (++reads === 1) throw new Error('throttled'); return privateKey })
    await expect(signer.url('materials/posts/a.png', 300)).rejects.toThrow('throttled')
    await expect(signer.url('materials/posts/a.png', 300)).resolves.toContain('Key-Pair-Id=K')
  })
})

let app: ReturnType<typeof createApp>
let storage: ReturnType<typeof createMemoryMaterialStorage>
beforeEach(() => {
  storage = createMemoryMaterialStorage()
  app = createApp(createMemoryRepository(), { authStore: setUpAuthStore(), materialStorage: storage, mediaSigner: createMediaSigner('media.example.net', 'K2EXAMPLE', async () => privateKey) })
})
async function login(id: string) {
  const agent = request.agent(app)
  expect((await agent.post('/api/auth/sign-in').send({ emailOrId: id, password: seedPassword })).status).toBe(200)
  return agent
}
type Agent = Awaited<ReturnType<typeof login>>
type File = { fileName: string; contentType: string; size: number }
const video: File = { fileName: 'Demo.mp4', contentType: 'video/mp4', size: 60 * 1024 * 1024 }
const photo: File = { fileName: 'Board.webp', contentType: 'image/webp', size: 90_000 }
const pdf: File = { fileName: 'Week 6.pdf', contentType: 'application/pdf', size: 200_000 }
async function upload(agent: Agent, userId: string, file: File) {
  const started = await agent.post('/api/uploads').send(file)
  expect(started.status, JSON.stringify(started.body)).toBe(200)
  const attachment = started.body.record.attachment as File & { id: string }
  storage.put(`materials/messages/${userId}/${attachment.id}/${file.fileName.replace(/[^A-Za-z0-9._-]+/g, '_')}`, file.size, file.contentType)
  return attachment
}
const create = (agent: Agent, attachments: object[]) => agent.post('/api/pages/P05/actions').send({ action: 'createPost', payload: { title: 'Demo day', body: 'Our demo.', audience: 'space:SUBJECT-IT-DS', kind: 'discussion', label: 'Discussion', attachments } })

describe('media on posts', () => {
  it('takes MP4 and WebM videos up to 100 MB on posts only', async () => {
    const professor = await login('QCU-PROF-IT')
    expect((await professor.post('/api/uploads').send(video)).status).toBe(200)
    expect((await professor.post('/api/uploads').send({ fileName: 'clip.webm', contentType: 'video/webm', size: 100 * 1024 * 1024 })).status).toBe(200)
    const tooBig = await professor.post('/api/uploads').send({ ...video, size: 100 * 1024 * 1024 + 1 })
    expect(tooBig.status).toBe(400)
    expect(JSON.stringify(tooBig.body)).toContain('Send a video of at most 100 MB.')
    expect((await professor.post('/api/uploads').send({ fileName: 'clip.mov', contentType: 'video/quicktime', size: 1000 })).status).toBe(400)
    expect((await professor.post('/api/uploads').send({ fileName: 'clip.webm', contentType: 'video/mp4', size: 1000 })).status).toBe(400)
    // Pictures keep their 10 MB limit, and Messages take no videos.
    expect((await professor.post('/api/uploads').send({ ...photo, size: 10 * 1024 * 1024 + 1 })).status).toBe(400)
    expect((await professor.post('/api/messages/uploads').send(video)).status).toBe(400)
  })

  it('gives readers signed CloudFront links for pictures and videos, and S3 links for other files', async () => {
    const professor = await login('QCU-PROF-IT')
    const files = [await upload(professor, 'QCU-PROF-IT', video), await upload(professor, 'QCU-PROF-IT', photo), await upload(professor, 'QCU-PROF-IT', pdf)]
    const created = await create(professor, files)
    expect(created.status, JSON.stringify(created.body)).toBe(200)
    const id = created.body.record.id as string
    const student = await login('QCU-STU-IT-A')
    const link = async (fileId: string, query = '?inline=1&format=json') => (await student.get(`/api/posts/${id}/files/${fileId}${query}`)).body.record.url as string

    const clip = verified(await link(files[0]!.id))
    expect(clip.resource).toMatch(/^https:\/\/media\.example\.net\/materials\/posts\/[0-9A-Z]{26}\/Demo\.mp4$/)
    expect(clip.expires - Date.now() / 1000).toBeGreaterThan(3500)
    const picture = verified(await link(files[1]!.id))
    expect(picture.expires - Date.now() / 1000).toBeLessThanOrEqual(300)
    expect(await link(files[2]!.id)).toMatch(/^memory:\/\/download\/materials\/posts\/.*Week_6\.pdf/)
    // A download (no inline) still comes from S3 under the file's name.
    expect(await link(files[0]!.id, '?format=json')).toMatch(/^memory:\/\/download\/.*name=Demo\.mp4$/)
    const redirect = await student.get(`/api/posts/${id}/files/${files[0]!.id}?inline=1`)
    expect(redirect.status).toBe(302)
    expect(redirect.headers.location).toContain('https://media.example.net/materials/posts/')

    // Someone who cannot read the post gets no link.
    expect((await (await login('QCU-STU-CS')).get(`/api/posts/${id}/files/${files[0]!.id}?inline=1&format=json`)).status).toBe(404)
  })

  it('refuses a video that is too large when the post is saved', async () => {
    const professor = await login('QCU-PROF-IT')
    const clip = await upload(professor, 'QCU-PROF-IT', video)
    expect((await create(professor, [{ ...clip, size: 100 * 1024 * 1024 + 1 }])).status).toBe(409)
  })
})
