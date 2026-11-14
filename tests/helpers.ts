import request from 'supertest'
import { expect } from 'vitest'

import type { createApp } from '../src/app.js'

type App = ReturnType<typeof createApp>

/** What a student sends with every concern besides the statement: the agreement and the three choices. Everything is off, so only the adviser can read it. */
export const concernChoices = { consent: { readStatement: true }, allowChair: false, allowDean: false, aboutAdvisor: false }

/** The shared password of the seeded accounts in tests. */
export const seedPassword = 'Accs@Qcu2026!'
/** What the secretary chooses on the first sign-in. */
export const secretaryPassword = 'Sec#Passw0rd-2026'

export async function signIn(app: App, emailOrId: string, password = seedPassword) {
  const agent = request.agent(app)
  const response = await agent.post('/api/auth/sign-in').send({ emailOrId, password })
  return { agent, response }
}

/** The Dean activates the secretary. Returns the one-time credentials from the response. */
export async function activateSecretary(app: App, body: object = {}) {
  const { agent: dean, response } = await signIn(app, 'QCU-FAC-PAULA-DELACRUZ')
  expect(response.status).toBe(200)
  const activated = await dean.post('/api/accounts/secretary/activate').send(body)
  expect(activated.status).toBe(200)
  return activated.body.record.credentials as { username: string; temporaryPassword: string }
}

/** Activates the secretary and completes the first sign-in. Returns the signed-in agent. */
export async function secretarySession(app: App, username = 'ccs.secretary') {
  const credentials = await activateSecretary(app)
  const { agent, response } = await signIn(app, credentials.username, credentials.temporaryPassword)
  expect(response.status).toBe(200)
  const set = await agent.post('/api/auth/complete-first-login').send({ currentPassword: credentials.temporaryPassword, username, password: secretaryPassword })
  expect(set.status).toBe(200)
  return agent
}
