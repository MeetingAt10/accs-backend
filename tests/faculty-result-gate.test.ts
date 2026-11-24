// Paper Fig 3.14 (restored 2026-11-24): a faculty member's full result (criteria, themes, follow-up notes) shows only once
// 100% of their program has rated; until then the result is the faculty average only.
import request from 'supertest'
import { beforeEach, describe, expect, it } from 'vitest'

import { createApp } from '../src/app.js'
import { createMemoryRepository } from '../src/store.js'
import { seedPassword, setUpAuthStore } from './helpers.js'

let repo: ReturnType<typeof createMemoryRepository>
let app: ReturnType<typeof createApp>
beforeEach(() => { repo = createMemoryRepository(); app = createApp(repo, { authStore: setUpAuthStore() }) })

async function login(id: string) {
  const agent = request.agent(app)
  expect((await agent.post('/api/auth/sign-in').send({ emailOrId: id, password: seedPassword })).status).toBe(200)
  return agent
}
const result = async (id: string) => (await (await login('QCU-CHAIR-IT')).get(`/api/pages/P29?id=${id}&cycle=CYCLE-2026-1`)).body.data.record

describe('faculty results wait for 100% of the program', () => {
  it('shows the faculty average only while any BSIT evaluation is missing', async () => {
    const record = await result('QCU-PROF-IT')
    expect(record).toMatchObject({ released: false, criteria: [], themes: [], followUps: [], canFollowUp: false })
    expect(record.average).toBeGreaterThan(0)
  })

  it('shows the full result and the follow-up notes once every BSIT evaluation is in', async () => {
    await repo.transact((unit) => {
      const db = unit.read()
      const bsit = new Set(db.users.filter((u) => u.program === 'BSIT').map((u) => u.id))
      for (const a of db.assignments) if (bsit.has(a.facultyId) && !a.submittedAt) Object.assign(a, { submittedAt: '2026-11-20T00:00:00.000Z', answers: { Q1: 4, Q2: 4, Q3: 4 } })
    })
    const chair = await login('QCU-CHAIR-IT')
    expect((await chair.post('/api/pages/P29/actions').send({ action: 'saveFollowUp', recordId: 'QCU-PROF-IT', payload: { note: 'Discussed the results.' } })).status).toBe(200)
    const record = (await chair.get('/api/pages/P29?id=QCU-PROF-IT&cycle=CYCLE-2026-1')).body.data.record
    expect(record).toMatchObject({ released: true, canFollowUp: true })
    expect(record.criteria).toHaveLength(3)
    expect(record.followUps.map((f: { note: string }) => f.note)).toEqual(['Discussed the results.'])
  })
})
