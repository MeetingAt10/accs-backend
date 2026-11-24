// QA v5 C16: the records list follows the viewer's scope. A Chair sees only their program; Guidance sees only students
// in Guidance or OSAS cases (an imported student with no case is not listed until one reaches the office).
import request from 'supertest'
import { beforeEach, expect, it } from 'vitest'

import { createApp } from '../src/app.js'
import { createMemoryRepository } from '../src/store.js'
import { seedPassword, setUpAuthStore } from './helpers.js'

let app: ReturnType<typeof createApp>
beforeEach(() => { app = createApp(createMemoryRepository(), { authStore: setUpAuthStore() }) })

async function students(id: string) {
  const agent = request.agent(app)
  expect((await agent.post('/api/auth/sign-in').send({ emailOrId: id, password: seedPassword })).status).toBe(200)
  return (await agent.get('/api/pages/P33')).body.data.students as { program?: string }[]
}

it('a Chair lists only students of their own program', async () => {
  for (const [id, program] of [['QCU-CHAIR-IT', 'BSIT'], ['QCU-CHAIR-CS', 'BSCS']]) {
    const list = await students(id)
    expect(list.length).toBeGreaterThan(0)
    expect(list.every((s) => s.program === program)).toBe(true)
  }
})

it('Guidance lists fewer students than the Dean: only those with a case at the office', async () => {
  expect((await students('QCU-GUIDANCE')).length).toBeLessThan((await students('QCU-FAC-PAULA-DELACRUZ')).length)
})
