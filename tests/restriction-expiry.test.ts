import request from 'supertest'
import { beforeEach, describe, expect, it } from 'vitest'

import { createApp } from '../src/app.js'
import { createMemoryRepository } from '../src/store.js'

let repository = createMemoryRepository()
let app = createApp(repository)

beforeEach(() => {
  repository = createMemoryRepository()
  app = createApp(repository)
})

async function signIn(accountId: string) {
  const agent = request.agent(app)
  const response = await agent.post('/api/auth/sign-in').send({ emailOrId: accountId, password: 'Accs@Qcu2026!' })
  expect(response.status).toBe(200)
  return agent
}

describe('restriction expiry and role defaults', () => {
  it('STU-11-V / ADM-03-I expires restrictions in standing and rejects a late lift', async () => {
    const restriction = repository.read().restrictions[0]!
    restriction.until = '2000-01-01'

    const student = await signIn('QCU-STU-RESTRICTED')
    const standing = await student.get('/api/pages/P36')
    expect(standing.status).toBe(200)
    expect(standing.body.data.record.standing).toBe('Good standing')
    expect(standing.body.data.record.restrictions).toEqual([])

    const admin = await signIn('ACCS-ADMIN')
    const restrictionList = await admin.get('/api/pages/P35')
    expect(restrictionList.body.data.restrictions[0].active).toBe(false)
    const lateLift = await admin
      .post('/api/pages/P35/actions')
      .send({
        action: 'liftRestriction',
        recordId: restriction.id,
        reason: 'This restriction has expired.',
        payload: {},
      })
    expect(lateLift.status).toBe(409)
  })

  it('returns the compact shell default to administration roles and comfortable to students', async () => {
    const admin = await signIn('ACCS-ADMIN')
    const student = await signIn('QCU-STU-IT-A')

    expect((await admin.get('/api/pages/P43')).body.data.settings.density).toBe('compact')
    expect((await student.get('/api/pages/P43')).body.data.settings.density).toBe('comfortable')
  })
})
