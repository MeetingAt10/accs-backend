import request from 'supertest'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { createApp } from '../src/app.js'
import { createMemoryAuthStore, type AuthStore } from '../src/auth.js'
import { createMemoryRepository } from '../src/store.js'

afterEach(() => vi.restoreAllMocks())

const password = 'Accs@Qcu2026!'
const brokenStore: AuthStore = {
  load: async () => { throw new Error('auth store unreachable') },
  update: async () => { throw new Error('auth store unreachable') },
}

describe('error responses and logging', () => {
  it('logs an unexpected error once as JSON, without the request body, and answers 500', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    const app = createApp(createMemoryRepository(), { authStore: brokenStore })
    const response = await request(app).post('/api/auth/sign-in?next=%2Fhome').send({ emailOrId: 'QCU-STU-IT-A', password })
    expect(response.status).toBe(500)
    expect(response.body).toEqual({ error: 'The request could not be completed.', code: 'INTERNAL_ERROR' })
    expect(log).toHaveBeenCalledTimes(1)
    const line = String(log.mock.calls[0]![0])
    expect(JSON.parse(line)).toMatchObject({ level: 'error', msg: 'Unhandled error', method: 'POST', path: '/api/auth/sign-in', status: 500, error: { name: 'Error', message: 'auth store unreachable' } })
    expect(line).not.toContain(password)
    expect(line).not.toContain('QCU-STU-IT-A')
    expect(line).not.toContain('next=')
  })

  it('answers 413 for a body over the limit instead of 500, and does not log it', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    const app = createApp(createMemoryRepository(), { authStore: createMemoryAuthStore() })
    const response = await request(app).post('/api/auth/sign-in').set('Content-Type', 'application/json').send(JSON.stringify({ emailOrId: 'x'.repeat(200 * 1024), password }))
    expect(response.status).toBe(413)
    expect(response.body).toEqual({ error: 'The request is too large.', code: 'VALIDATION_ERROR' })
    expect(log).not.toHaveBeenCalled()
  })

  it('does not log expected client errors', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    const app = createApp(createMemoryRepository(), { authStore: createMemoryAuthStore() })
    expect((await request(app).post('/api/auth/sign-in').send({ emailOrId: 'QCU-STU-IT-A', password: 'Wrong!Passw0rd' })).status).toBe(401)
    expect((await request(app).post('/api/auth/sign-in').send({})).status).toBe(400)
    expect((await request(app).get('/api/session')).status).toBe(401)
    expect((await request(app).post('/api/auth/sign-in').set('Content-Type', 'application/json').send('{bad json')).status).toBe(400)
    expect(log).not.toHaveBeenCalled()
  })
})
