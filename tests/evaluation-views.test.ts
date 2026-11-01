import request from 'supertest'
import { beforeEach, describe, expect, it } from 'vitest'

import { createApp } from '../src/app.js'
import { createMemoryRepository, type Repository } from '../src/store.js'

describe('evaluation read models', () => {
  let repository: Repository
  let app: ReturnType<typeof createApp>

  beforeEach(() => {
    repository = createMemoryRepository()
    app = createApp(repository)
  })

  async function login(accountId: string) {
    const agent = request.agent(app)
    const signedIn = await agent.post('/api/auth/sign-in').send({ emailOrId: accountId, password: 'Accs@Qcu2026!' })

    expect(signedIn.status).toBe(200)
    return agent
  }

  it('DEAN-03-V returns faculty completion and review status for the cycle editor', async () => {
    const dean = await login('QCU-DEAN')
    const response = await dean.get('/api/pages/P31?id=CYCLE-2026-2')

    expect(response.status).toBe(200)
    expect(response.body.data.facultyCompletion).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'QCU-PROF-IT',
          assigned: 1,
          submitted: 0,
        }),
      ]),
    )
    expect(response.body.data.facultyReviews).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'QCU-PROF-IT',
          status: 'Not yet',
        }),
      ]),
    )
    expect(JSON.stringify(response.body.data.facultyCompletion)).not.toContain('answers')
  })

  it('PRO-08-V/B includes a program reference average without exposing evaluator identities', async () => {
    const professor = await login('QCU-PROF-IT')
    const response = await professor.get(
      '/api/pages/P29?id=QCU-PROF-IT&cycle=CYCLE-2026-1',
    )

    expect(response.status).toBe(200)
    expect(response.body.data.programAverage.program).toBe('BSIT')
    expect(response.body.data.programAverage.criteria).toHaveLength(3)
    expect(JSON.stringify(response.body.data)).not.toContain('evaluatorId')
    expect(JSON.stringify(response.body.data)).not.toContain('SAMPLE-EVALUATOR')
  })
})
