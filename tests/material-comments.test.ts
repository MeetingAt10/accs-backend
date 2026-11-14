// Comments under class materials: the subject's students and professors ask and answer under each material. Others
// cannot see or add them; a student removes their own comment and a professor of the subject removes any.
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
const act = (agent: Agent, action: string, recordId: string, payload: object) => agent.post('/api/pages/P08/actions').send({ action, recordId, payload })
const materials = async (agent: Agent) => (await agent.get('/api/pages/P08?id=SUBJECT-IT-DS')).body.data.record.materials as { id: string; comments: { id: string; body: string; canDelete: boolean; author: { name: string } }[] }[]
async function shareLink() {
  const professor = await login('QCU-PROF-IT')
  const added = await act(professor, 'addMaterial', '', { spaceId: 'SUBJECT-IT-DS', title: 'Week 5 slides', url: 'https://drive.google.com/file/d/abc' })
  expect(added.status, JSON.stringify(added.body)).toBe(200)
  return { professor, id: added.body.record.id as string }
}

describe('comments on class materials', () => {
  it('lets the class ask and the professor answer', async () => {
    const { professor, id } = await shareLink()
    const student = await login('QCU-STU-IT-A')
    const asked = await act(student, 'commentMaterial', id, { body: 'Is slide 12 in the quiz?' })
    expect(asked.status, JSON.stringify(asked.body)).toBe(200)
    expect((await act(professor, 'commentMaterial', id, { body: 'Yes, slides 10 to 14.' })).status).toBe(200)
    const [material] = await materials(student)
    expect(material!.comments.map((c) => [c.author.name, c.body, c.canDelete])).toEqual([
      ['Demo Student Foxtrot', 'Is slide 12 in the quiz?', true],
      ['Demo Professor Charlie', 'Yes, slides 10 to 14.', false],
    ])
    // The professor may remove any comment on the subject's materials.
    expect((await materials(professor))[0]!.comments.every((c) => c.canDelete)).toBe(true)
  })

  it('keeps people outside the subject out', async () => {
    const { id } = await shareLink()
    const outsider = await login('QCU-STU-CS')
    expect((await act(outsider, 'commentMaterial', id, { body: 'Hello' })).status).toBe(404)
  })

  it('removes a comment by its author or a professor, not by a classmate', async () => {
    const { professor, id } = await shareLink()
    const student = await login('QCU-STU-IT-A')
    const commentId = (await act(student, 'commentMaterial', id, { body: 'Question one.' })).body.record.id as string
    const classmate = await login('QCU-STU-RESTRICTED')
    expect((await act(classmate, 'deleteMaterialComment', id, { commentId })).status).toBe(403)
    expect((await act(professor, 'deleteMaterialComment', id, { commentId })).status).toBe(200)
    expect((await materials(student))[0]!.comments).toEqual([])
  })

  it('refuses blocked words and students who may not comment', async () => {
    const { id } = await shareLink()
    const student = await login('QCU-STU-IT-A')
    const rude = await act(student, 'commentMaterial', id, { body: 'bobo ng slides' })
    expect(rude.status).toBe(400)
    expect(JSON.stringify(rude.body)).toContain('Please rephrase')
    // Demo Student India has the "post.comment" restriction.
    expect((await act(await login('QCU-STU-RESTRICTED'), 'commentMaterial', id, { body: 'Hello' })).status).toBe(403)
    expect((await materials(student))[0]!.comments).toEqual([])
  })
})
