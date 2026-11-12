// Issue #32: a faculty member who marks a time not available gives a reason. Only the faculty member (and the CCS
// Secretary) see it; students do not see unavailable times at all, and other offices see the time without the reason.
import request from 'supertest'
import { beforeEach, describe, expect, it } from 'vitest'

import { createApp } from '../src/app.js'
import { createMemoryAuthStore } from '../src/auth.js'
import { createMemoryRepository } from '../src/store.js'
import { seedPassword } from './helpers.js'

let repo: ReturnType<typeof createMemoryRepository>
let app: ReturnType<typeof createApp>
beforeEach(() => { repo = createMemoryRepository(); app = createApp(repo, { authStore: createMemoryAuthStore() }) })

async function login(id: string) {
  const agent = request.agent(app)
  expect((await agent.post('/api/auth/sign-in').send({ emailOrId: id, password: seedPassword })).status).toBe(200)
  return agent
}
type Agent = Awaited<ReturnType<typeof login>>
const when = { date: '2026-12-02', start: '13:00', end: '14:00' }
const save = (agent: Agent, payload: object, recordId?: string) => agent.post('/api/pages/P17/actions').send({ action: 'saveAvailability', ...(recordId ? { recordId } : {}), payload: { ...when, ...payload } })
const reason = 'Department meeting moved to this afternoon.'

describe('a reason for "not available"', () => {
  it('is required to mark a time not available, and refused on an open time', async () => {
    const professor = await login('QCU-PROF-IT')
    const missing = await save(professor, { state: 'unavailable' })
    expect([missing.status, missing.body.fields?.[0]]).toEqual([400, { path: 'reason', message: 'Give a reason for marking this time not available.' }])
    expect((await save(professor, { state: 'unavailable', reason: '   ' })).status).toBe(400)
    expect((await save(professor, { state: 'unavailable', reason: 'x'.repeat(301) })).status).toBe(400)
    const open = await save(professor, { state: 'open', reason })
    expect([open.status, open.body.fields?.[0]?.message]).toEqual([400, 'Only a time marked not available takes a reason.'])
    const saved = await save(professor, { state: 'unavailable', reason })
    expect(saved.status).toBe(200)
    expect(saved.body.record).toMatchObject({ state: 'unavailable', reason })
  })

  it('is cleared when the time is opened again', async () => {
    const professor = await login('QCU-PROF-IT')
    const id = (await save(professor, { state: 'unavailable', reason })).body.record.id as string
    const reopened = await save(professor, { state: 'open' }, id)
    expect(reopened.status).toBe(200)
    expect(repo.read().slots.find((s) => s.id === id)!.reason).toBeUndefined()
  })

  it('is shown to the faculty member, never to students, and not to other offices', async () => {
    const professor = await login('QCU-PROF-IT')
    const id = (await save(professor, { state: 'unavailable', reason })).body.record.id as string
    const own = ((await professor.get('/api/pages/P17')).body.data.slots as { id: string; reason?: string }[]).find((s) => s.id === id)
    expect(own?.reason).toBe(reason)
    expect(((await professor.get('/api/pages/P13')).body.data.slots as { id: string; reason?: string }[]).find((s) => s.id === id)?.reason).toBe(reason)
    // A student of that professor does not see the time at all.
    const student = await login('QCU-STU-IT-A')
    expect(((await student.get('/api/pages/P15?id=QCU-PROF-IT')).body.data.slots as { id: string }[]).map((s) => s.id)).not.toContain(id)
    expect(((await student.get('/api/pages/P13')).body.data.slots as { id: string }[]).map((s) => s.id)).not.toContain(id)
    // The Dean sees the time, without the reason.
    const fromDean = ((await (await login('CCS-DEAN')).get('/api/pages/P13')).body.data.slots as { id: string; reason?: string }[]).find((s) => s.id === id)
    expect(fromDean).toMatchObject({ id, state: 'unavailable' })
    expect(fromDean).not.toHaveProperty('reason')
  })

  it('still loads unavailable times stored without a reason', async () => {
    await repo.transact((unit) => { unit.read().slots.push({ id: 'SLOT-OLD', facultyId: 'QCU-PROF-IT', ...when, state: 'unavailable' }) })
    const professor = await login('QCU-PROF-IT')
    expect(((await professor.get('/api/pages/P17')).body.data.slots as { id: string }[]).map((s) => s.id)).toContain('SLOT-OLD')
    // Editing it again asks for a reason.
    expect((await save(professor, { state: 'unavailable' }, 'SLOT-OLD')).status).toBe(400)
    expect((await save(professor, { state: 'unavailable', reason }, 'SLOT-OLD')).status).toBe(200)
  })
})
