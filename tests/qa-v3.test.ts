// Decisions of 20 November 2026 answering the third round of the QA report of 17 November (QA_andrew_11_17, V3).
import request from 'supertest'
import { beforeEach, describe, expect, it } from 'vitest'

import { createApp } from '../src/app.js'
import { createMemoryRepository } from '../src/store.js'
import { seedPassword, secretarySession, setUpAuthStore } from './helpers.js'

let repo: ReturnType<typeof createMemoryRepository>
let app: ReturnType<typeof createApp>
beforeEach(() => { repo = createMemoryRepository(); app = createApp(repo, { authStore: setUpAuthStore() }) })

async function login(id: string) {
  const agent = request.agent(app)
  expect((await agent.post('/api/auth/sign-in').send({ emailOrId: id, password: seedPassword })).status).toBe(200)
  return agent
}

describe('the Secretary in Messages', () => {
  it('opens Messages and can write to students and faculty', async () => {
    const secretary = await secretarySession(app)
    const inbox = await secretary.get('/api/pages/P11')
    expect(inbox.status, JSON.stringify(inbox.body)).toBe(200)
    const recipients = (inbox.body.data.recipients as { id: string }[]).map((r) => r.id)
    expect(recipients).toEqual(expect.arrayContaining(['QCU-STU-IT-A', 'QCU-PROF-IT', 'QCU-CHAIR-CS', 'QCU-OSAS']))
    expect(recipients).not.toContain('QCU-SECRETARY')
  })

  it('messages a student, and the student can answer', async () => {
    const secretary = await secretarySession(app)
    const started = await secretary.post('/api/pages/P11/actions').send({ action: 'createThread', payload: { recipientId: 'QCU-STU-IT-A', body: 'Please bring your registration form.' } })
    expect(started.status, JSON.stringify(started.body)).toBe(200)
    const student = await login('QCU-STU-IT-A')
    const reply = await student.post('/api/pages/P12/actions').send({ action: 'sendMessage', recordId: started.body.record.id, payload: { body: 'Will do, thank you.' } })
    expect(reply.status, JSON.stringify(reply.body)).toBe(200)
  })

  it('can be written to first: a professor finds the Secretary among recipients', async () => {
    await secretarySession(app)
    const professor = await login('QCU-PROF-IT')
    const recipients = ((await professor.get('/api/pages/P11')).body.data.recipients as { id: string }[]).map((r) => r.id)
    expect(recipients).toContain('QCU-SECRETARY')
  })
})
