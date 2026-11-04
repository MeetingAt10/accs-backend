import request from 'supertest'
import { describe, expect, it } from 'vitest'

import { createApp } from '../src/app.js'
import { createMemoryAuthStore } from '../src/auth.js'
import { createUlidFactory, ulid } from '../src/ids.js'
import { createMemoryRepository } from '../src/store.js'
import { concernChoices } from './helpers.js'

const zeros = () => Buffer.alloc(10)
const password = 'Accs@Qcu2026!'

describe('ulid', () => {
  it('encodes the time as the ULID specification does', () => {
    expect(createUlidFactory(() => 1469918176385, zeros)().slice(0, 10)).toBe('01ARYZ6S41')
  })

  it('uses 26 Crockford base32 characters', () => {
    for (let n = 0; n < 1000; n++) expect(ulid()).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/)
  })

  it('strictly increases within a millisecond and sorts in creation order', () => {
    const next = createUlidFactory(() => 1469918176385)
    const ids = Array.from({ length: 10000 }, () => next())
    expect(new Set(ids).size).toBe(ids.length)
    expect([...ids].sort()).toEqual(ids)
  })

  it('sorts later milliseconds after earlier ones, whatever the random part is', () => {
    let time = 1000
    const random = [Buffer.alloc(10, 0xff), zeros()]
    const next = createUlidFactory(() => time, () => random.shift()!)
    const first = next()
    time = 1001
    expect(next() > first).toBe(true)
  })

  it('keeps increasing when the clock moves back', () => {
    let time = 5000
    const next = createUlidFactory(() => time)
    const first = next()
    time = 1000
    const second = next()
    expect(second > first).toBe(true)
    expect(second.slice(0, 10)).toBe(first.slice(0, 10))
  })

  it('carries into the time when the random part is exhausted', () => {
    const next = createUlidFactory(() => 1000, () => Buffer.alloc(10, 0xff))
    const first = next()
    const second = next()
    expect(second > first).toBe(true)
    expect(second).toHaveLength(26)
  })
})

describe('generated IDs across instances', () => {
  const report = { narrative: 'The lab timetable changed without notice.', category: 'General concern', severity: 'low', identity: 'named', ...concernChoices }
  const signIn = async (app: ReturnType<typeof createApp>, id: string) => {
    const agent = request.agent(app)
    expect((await agent.post('/api/auth/sign-in').send({ emailOrId: id, password })).status).toBe(200)
    return agent
  }

  it('does not reuse an ID on a second instance', async () => {
    const authStore = createMemoryAuthStore()
    const [first, second] = await Promise.all([1, 2].map(() => signIn(createApp(createMemoryRepository(), { authStore }), 'QCU-STU-CS')))
    const [a, b] = await Promise.all([first!, second!].map(agent => agent.post('/api/pages/P19/actions').send({ action: 'createReport', payload: report })))
    expect(a!.status).toBe(200)
    expect(b!.status).toBe(200)
    expect(a!.body.record.id).toMatch(/^RPT-[0-9A-Z]{26}$/)
    expect(a!.body.record.id).not.toBe(b!.body.record.id)
  })

  it('recognizes generated report IDs in assistant questions and keeps the ownership check', async () => {
    const app = createApp(createMemoryRepository(), { authStore: createMemoryAuthStore() })
    const owner = await signIn(app, 'QCU-STU-CS')
    const created = await owner.post('/api/pages/P19/actions').send({ action: 'createReport', payload: report })
    const id = created.body.record.id as string
    const ask = (agent: Awaited<ReturnType<typeof signIn>>, question: string) => agent.post('/api/pages/P41/actions').send({ action: 'assistantAsk', payload: { question } })

    const own = await ask(owner, `Explain the milestones on report ${id}`)
    expect(own.body.record.reply).toContain(id)
    expect(own.body.record.reply).not.toContain('RPT-0248')

    const other = await ask(await signIn(app, 'QCU-STU-IT-B'), `Explain the milestones on report ${id}`)
    expect(other.body.record.reply).toContain('I cannot answer that one')
  })
})
