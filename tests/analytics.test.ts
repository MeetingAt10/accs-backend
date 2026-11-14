import request from 'supertest'
import { beforeEach, describe, expect, it } from 'vitest'

import { createApp } from '../src/app.js'
import { createMemoryRepository } from '../src/store.js'

let app = createApp(createMemoryRepository())

beforeEach(() => {
  app = createApp(createMemoryRepository())
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
})
