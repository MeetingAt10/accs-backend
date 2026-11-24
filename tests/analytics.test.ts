import request from 'supertest'
import { beforeEach, describe, expect, it } from 'vitest'

import { createApp } from '../src/app.js'
import { createMemoryRepository } from '../src/store.js'
import { setUpAuthStore } from './helpers.js'

let repo = createMemoryRepository()
let app = createApp(repo, { authStore: setUpAuthStore() })

beforeEach(() => {
  repo = createMemoryRepository()
  app = createApp(repo, { authStore: setUpAuthStore() })
})

async function signIn(accountId: string) {
  const agent = request.agent(app)
  const response = await agent.post('/api/auth/sign-in').send({ emailOrId: accountId, password: 'Accs@Qcu2026!' })
  expect(response.status).toBe(200)
  return agent
}

describe('case analytics filters', () => {
  it('CHR-05-V applies the case-reference search within the permitted program scope', async () => {
    const dean = await signIn('QCU-FAC-PAULA-DELACRUZ')
    const match = await dean.get('/api/pages/P25?q=rpt-0241')
    const noMatch = await dean.get('/api/pages/P25?q=missing-reference')

    expect(match.status).toBe(200)
    expect(match.body.data.stats.find((stat: { label: string }) => stat.label === 'Open').value).toBe(1)
    expect(noMatch.body.data.stats.find((stat: { label: string }) => stat.label === 'Open').value).toBe(0)
  })
  it('rejects a date that is not a real calendar day', async () => {
    const dean = await signIn('QCU-FAC-PAULA-DELACRUZ')
    for (const query of ['from=2026-02-31', 'to=not-a-date']) {
      const response = await dean.get(`/api/pages/P25?${query}`)
      expect(response.status).toBe(400)
      expect(response.body.code).toBe('VALIDATION_ERROR')
      expect(response.body.fields).toContainEqual({ path: query.split('=')[0], message: 'Enter a real date as YYYY-MM-DD.' })
    }
  })

  it('returns visible cases newest first', async () => {
    repo.read().reports.forEach((report, index) => {
      report.createdAt = `2026-11-${String(index + 1).padStart(2, '0')}T12:00:00.000Z`
    })
    const dean = await signIn('QCU-FAC-PAULA-DELACRUZ')
    const response = await dean.get('/api/pages/P25')
    const cases = response.body.data.cases as { id: string; createdAt: string }[]

    expect(response.status).toBe(200)
    expect(cases.length).toBeGreaterThan(1)
    expect(cases.map((row) => row.id)).toEqual(
      [...cases].sort((a, b) => b.createdAt.localeCompare(a.createdAt)).map((row) => row.id),
    )
  })
})
