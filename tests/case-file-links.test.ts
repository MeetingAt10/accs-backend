// A case can be opened by its Case File number as well as its report ID, so links that use the number shown on screen
// (CF-...) work for every office that may open the case, and for the student who filed it.
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

describe('opening a case by its Case File number', () => {
  it('opens the same case as its report ID, for Guidance, OSAS and the student', async () => {
    const guidance = await login('QCU-GUIDANCE')
    const byNumber = await guidance.get('/api/pages/P22?id=CF-0245')
    expect(byNumber.status).toBe(200)
    expect(byNumber.body.data.record).toMatchObject({ id: 'RPT-0245', caseFileId: 'CF-0245' })
    expect((await (await login('QCU-OSAS')).get('/api/pages/P22?id=CF-0246')).body.data.record).toMatchObject({ id: 'RPT-0246' })
    expect((await (await login('QCU-STU-IT-A')).get('/api/pages/P20?id=CF-0245')).body.data.record).toMatchObject({ id: 'RPT-0245' })
  })

  it('takes actions named by the Case File number', async () => {
    const guidance = await login('QCU-GUIDANCE')
    const acted = await guidance.post('/api/pages/P22/actions').send({ action: 'addNote', recordId: 'CF-0245', payload: { body: 'Session booked.' } })
    expect(acted.status, JSON.stringify(acted.body)).toBe(200)
    expect(repo.read().reports.find((r) => r.id === 'RPT-0245')!.notes.at(-1)!.body).toBe('Session booked.')
  })

  it('keeps every access rule: no one gets a case through its number that they could not open by its ID', async () => {
    // Guidance does not handle RPT-0246 (now with OSAS) as the current office; the student who did not file it gets nothing.
    expect((await (await login('QCU-STU-IT-B')).get('/api/pages/P20?id=CF-0245')).status).toBe(404)
    expect((await (await login('QCU-PROF-OTHER')).get('/api/pages/P22?id=CF-0245')).status).toBe(404)
    expect((await (await login('QCU-GUIDANCE')).post('/api/pages/P22/actions').send({ action: 'addNote', recordId: 'CF-0246', payload: { body: 'x' } })).status).toBe(404)
    expect((await (await login('QCU-GUIDANCE')).get('/api/pages/P22?id=CF-9999')).status).toBe(404)
  })
})
