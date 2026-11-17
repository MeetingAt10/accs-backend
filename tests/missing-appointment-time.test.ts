// An appointment whose time was later removed broke Home, Calendar and Appointments for both people on it
// ("This record isn't available to you" on the professor's home, 17 November 2026).
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
const appointmentOf = async (facultyId: string) => repo.transact((unit) => unit.read().consultations.find((c) => c.facultyId === facultyId)!)

describe('appointments whose time is gone', () => {
  it('still opens Home, Calendar and Appointments for the professor and the student', async () => {
    const c = await appointmentOf('QCU-PROF-IT')
    await repo.transact((unit) => { const db = unit.read(); db.slots = db.slots.filter((s) => s.id !== c.slotId) })
    for (const who of ['QCU-PROF-IT', c.studentId]) {
      const agent = await login(who)
      for (const page of ['P03', 'P13', 'P14']) {
        const res = await agent.get(`/api/pages/${page}`)
        if (res.status === 403) continue // a page this role does not have
        expect(res.status, `${who} ${page} ${JSON.stringify(res.body)}`).toBe(200)
      }
    }
    const listed = ((await (await login('QCU-PROF-IT')).get('/api/pages/P14')).body.data.consultations as { id: string; slot: { state: string; date: string } }[]).find((x) => x.id === c.id)
    expect(listed?.slot).toMatchObject({ state: 'removed' })
  })

  it('keeps the booked time on a new appointment, so it still shows if the time goes', async () => {
    const student = await login('QCU-STU-IT-A')
    const open = repo.read().slots.find((s) => s.facultyId === 'QCU-PROF-IT' && s.state === 'open')!
    const booked = await student.post('/api/pages/P15/actions').send({ action: 'createConsultation', payload: { slotId: open.id, purpose: 'Academic question' } })
    expect(booked.status, JSON.stringify(booked.body)).toBe(200)
    const stored = await repo.transact((unit) => unit.read().consultations.find((x) => x.slotId === open.id)!)
    expect(stored).toMatchObject({ slotDate: open.date, slotStart: open.start, slotEnd: open.end })
  })

  it('refuses to delete a time that has an appointment on record, even a finished one', async () => {
    const c = await appointmentOf('QCU-PROF-IT')
    await repo.transact((unit) => { const db = unit.read(); db.consultations.find((x) => x.id === c.id)!.status = 'cancelled'; db.slots.find((s) => s.id === c.slotId)!.state = 'open' })
    const res = await (await login('QCU-PROF-IT')).post('/api/pages/P17/actions').send({ action: 'deleteAvailability', recordId: c.slotId, payload: {} })
    expect(res.status).toBe(409)
    expect(await repo.transact((unit) => unit.read().slots.some((s) => s.id === c.slotId))).toBe(true)
  })
})
