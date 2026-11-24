import type { Database } from '../src/store.js'
import request from 'supertest'
import { expect } from 'vitest'

import type { createApp } from '../src/app.js'
import { createMemoryAuthStore, hashPassword } from '../src/auth.js'
import { rosterUserIds } from '../src/store.js'

type App = ReturnType<typeof createApp>

/** What a student sends with every concern besides the statement: the agreement and the three choices. Everything is off, so only the adviser can read it. */
export const concernChoices = { occurredOn: '2026-10-15', consent: { readStatement: true }, allowChair: false, allowDean: false, aboutAdvisor: false }

/** The shared password of the seeded accounts in tests. */
export const seedPassword = 'Accs@Qcu2026!'

// Real people on the roster (the Dean among them) never sign in with the shared seed password. Most tests stand for
// accounts already set up, so their roster accounts start with that password stored as their own credential. Tests about
// setting accounts up use a plain createMemoryAuthStore().
const rosterCredential = hashPassword(seedPassword)
/** An auth store in which every roster account is already set up, with `seedPassword` as its own password. */
export const setUpAuthStore = () => createMemoryAuthStore({ credentials: Object.fromEntries([...rosterUserIds].map((id) => [id, rosterCredential])) })
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

/** Every faculty member with assignments in the cycle has reviewed its questions, so it can be published (QA 17 November). */
export function reviewAll(repo: { read(): Database }, cycleId: string) {
  const db = repo.read()
  const cycle = db.cycles.find((c) => c.id === cycleId)!
  // Every active professor reviews the questions (QA 19 November), and publishing waits for all of them (QA 17 November, V3).
  for (const facultyId of db.users.filter((u) => u.active && u.roles.includes('professor')).map((u) => u.id))
    if (!cycle.reviews.some((r) => r.userId === facultyId)) cycle.reviews.push({ userId: facultyId, decision: 'reviewed', note: '', at: new Date().toISOString() })
}
