// Frontend #11: "Sign out of other devices" ends every other session of the account and keeps the one that asked.
import request from 'supertest'
import { describe, expect, it } from 'vitest'

import { createApp } from '../src/app.js'
import { createMemoryAuthStore } from '../src/auth.js'
import { createMemoryRepository } from '../src/store.js'
import { seedPassword } from './helpers.js'

async function signedIn(app: ReturnType<typeof createApp>, id: string) {
  const agent = request.agent(app)
  expect((await agent.post('/api/auth/sign-in').send({ emailOrId: id, password: seedPassword })).status).toBe(200)
  return agent
}

describe('sign out of other devices', () => {
  it('ends the other sessions and keeps this one', async () => {
    const repo = createMemoryRepository()
    const app = createApp(repo, { authStore: createMemoryAuthStore() })
    const [laptop, phone, other] = [await signedIn(app, 'QCU-STU-IT-A'), await signedIn(app, 'QCU-STU-IT-A'), await signedIn(app, 'QCU-PROF-IT')]
    const response = await laptop.post('/api/auth/sign-out-others').send({})
    expect(response.status).toBe(200)
    expect(response.body.message).toBe('Signed out of your other devices. This one stays signed in.')
    expect((await laptop.get('/api/session')).status).toBe(200)
    expect((await phone.get('/api/session')).status).toBe(401)
    // Another account's session is untouched.
    expect((await other.get('/api/session')).status).toBe(200)
    const audit = await repo.view((unit) => unit.read().audit)
    expect(audit.some((entry) => entry.action === 'Signed out of other devices' && entry.reference === 'QCU-STU-IT-A')).toBe(true)
  })

  it('needs a signed-in session', async () => {
    const app = createApp(createMemoryRepository(), { authStore: createMemoryAuthStore() })
    expect((await request(app).post('/api/auth/sign-out-others').send({})).status).toBe(401)
  })
})
