import request from 'supertest'
import { describe, expect, it } from 'vitest'

import { canPage } from '../src/access.js'
import { createApp } from '../src/app.js'
import { createMemoryRepository } from '../src/store.js'

const accounts: Record<string, string> = { student: 'QCU-STU-IT-A', organization: 'QCU-ORG', professor: 'QCU-PROF-IT', staff: 'QCU-STAFF', chair: 'QCU-CHAIR-IT', dean: 'QCU-DEAN', administrator: 'QCU-ADMIN', guidance: 'QCU-GUIDANCE', osas: 'QCU-OSAS', president: 'QCU-PRESIDENT' }
const pageIds = Array.from({ length: 50 }, (_, n) => `P${String(n + 3).padStart(2, '0')}`)
const app = createApp(createMemoryRepository())
const signIn = async (id: string) => {
  const agent = request.agent(app)
  const response = await agent.post('/api/auth/sign-in').send({ emailOrId: id, password: 'Accs@Qcu2026!' })
  expect(response.status).toBe(200)
  return { agent, user: response.body.user }
}

describe('role x page matrix over the API', () => {
  for (const [role, id] of Object.entries(accounts)) {
    it(`${role}: 403 outside canPage, reachable inside it`, async () => {
      const { agent, user } = await signIn(id)
      for (const pageId of pageIds) {
        const { status } = await agent.get(`/api/pages/${pageId}`)
        if (canPage(user, pageId)) expect([200, 404], `${role} ${pageId}`).toContain(status)
        else expect(status, `${role} ${pageId}`).toBe(403)
      }
    })
  }

  it('returns 401 for every page when signed out', async () => {
    for (const pageId of pageIds) expect((await request(app).get(`/api/pages/${pageId}`)).status, pageId).toBe(401)
  })

  it('keeps students out of records, restrictions management and administration', async () => {
    const { agent } = await signIn(accounts.student!)
    // P36 (own standing) is the one student-allowed page in P33-P36.
    for (const pageId of ['P33', 'P34', 'P35', ...Array.from({ length: 8 }, (_, n) => `P${45 + n}`)]) expect((await agent.get(`/api/pages/${pageId}`)).status, pageId).toBe(403)
    expect((await agent.get('/api/pages/P36')).status).toBe(200)
  })
})
