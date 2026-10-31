import request from 'supertest'
import { describe, expect, it } from 'vitest'

import { app } from '../src/app.js'
import { env } from '../src/env.js'

describe('CORS', () => {
  it('parses a comma-separated origin list', () => {
    expect(Array.isArray(env.CORS_ORIGIN)).toBe(true)
    expect(env.CORS_ORIGIN.length).toBeGreaterThan(0)
  })

  it('echoes an allowed origin with credentials', async () => {
    const origin = env.CORS_ORIGIN[0]
    const res = await request(app).get('/api/health').set('Origin', origin)
    expect(res.headers['access-control-allow-origin']).toBe(origin)
    expect(res.headers['access-control-allow-credentials']).toBe('true')
  })

  it('does not allow an unknown origin', async () => {
    const res = await request(app).get('/api/health').set('Origin', 'https://evil.example')
    expect(res.headers['access-control-allow-origin']).toBeUndefined()
  })
})
