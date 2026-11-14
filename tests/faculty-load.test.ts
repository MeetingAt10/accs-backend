// Issue #39: the CCS Secretary uploads each faculty member's class load for a term, and the consultation times faculty
// open may not overlap a class. The columns are assumed until a sample load file is provided.
import request from 'supertest'
import { beforeEach, describe, expect, it } from 'vitest'

import { createApp } from '../src/app.js'
import { createMemoryAuthStore } from '../src/auth.js'
import { createMemoryRepository } from '../src/store.js'
import { secretarySession, seedPassword } from './helpers.js'

let repo: ReturnType<typeof createMemoryRepository>
let app: ReturnType<typeof createApp>
beforeEach(() => { repo = createMemoryRepository(); app = createApp(repo, { authStore: createMemoryAuthStore() }) })

async function login(id: string) {
  const agent = request.agent(app)
  expect((await agent.post('/api/auth/sign-in').send({ emailOrId: id, password: seedPassword })).status).toBe(200)
  return agent
}
type Agent = Awaited<ReturnType<typeof login>>
const email = (id: string) => repo.read().users.find((u) => u.id === id)!.email
const term = { term: '2nd Semester AY 2026-2027', startsOn: '2026-11-01', endsOn: '2027-03-31' }
// 2026-12-02 is a Wednesday.
const wednesdayClass = () => ({ facultyEmail: email('QCU-PROF-IT'), day: 'Wednesday', start: '13:00', end: '14:30', subject: 'CC 104 Data Structures', section: 'SBIT3A', room: 'IC 301' })
const upload = (agent: Agent, rows: object[], extra: object = {}) => agent.post('/api/pages/P54/actions').send({ action: 'uploadLoadSchedule', payload: { ...term, rows, ...extra } })
const open = (agent: Agent, date: string, start: string, end: string, state = 'open', reason?: string) =>
  agent.post('/api/pages/P17/actions').send({ action: 'saveAvailability', payload: { date, start, end, state, ...(reason ? { reason } : {}) } })

describe('uploading a faculty load', () => {
  it('saves every class of the term and shows it on the faculty load page and to the faculty member', async () => {
    const secretary = await secretarySession(app)
    const saved = await upload(secretary, [wednesdayClass(), { facultyEmail: email('QCU-PROF-OTHER'), day: 'mon', start: '07:30', end: '09:00', subject: 'IT 201' }])
    expect(saved.status, JSON.stringify(saved.body)).toBe(200)
    expect(saved.body.record).toEqual({ term: term.term, faculty: 2, classes: 2, conflicts: 0 })
    const page = (await secretary.get('/api/pages/P54')).body.data
    expect(page.term).toEqual(term)
    const prof = page.faculty.find((f: { id: string }) => f.id === 'QCU-PROF-IT')
    expect(prof.classes).toEqual([expect.objectContaining({ day: 'Wed', start: '13:00', end: '14:30', subject: 'CC 104 Data Structures', section: 'SBIT3A', room: 'IC 301' })])
    expect(page.faculty.find((f: { id: string }) => f.id === 'QCU-PROF-OTHER').classes[0]).toMatchObject({ day: 'Mon' })
    expect((await (await login('QCU-PROF-IT')).get('/api/pages/P17')).body.data.load).toHaveLength(1)
    expect(repo.read().audit.some((a) => a.action === 'Faculty load uploaded' && a.reference === term.term)).toBe(true)
  })

  it('saves nothing when a row is wrong, and names every problem by row', async () => {
    const secretary = await secretarySession(app)
    const refused = await upload(secretary, [
      wednesdayClass(),
      { ...wednesdayClass(), facultyEmail: 'nobody@qcu.edu.ph' },
      { ...wednesdayClass(), day: 'Sunday', start: '15:00', end: '16:00' },
      { ...wednesdayClass(), start: '16:00', end: '15:00' },
      { ...wednesdayClass(), start: '14:00', end: '15:00', subject: 'Overlapping class' },
    ])
    expect(refused.status).toBe(400)
    expect(refused.body.fields).toEqual([
      { path: 'rows.1.facultyEmail', message: 'No active faculty account has this email.' },
      { path: 'rows.2.day', message: 'Use a day from Mon to Sat.' },
      { path: 'rows.3.end', message: 'The end time must be later than the start time.' },
      { path: 'rows.4.start', message: 'This class overlaps CC 104 Data Structures (Wed 13:00 to 14:30) for the same faculty member.' },
    ])
    expect(repo.read().loadSchedules).toEqual([])
    expect((await upload(secretary, [wednesdayClass()], { endsOn: '2026-10-01' })).status).toBe(400)
  })

  it('replaces a faculty member\'s classes for the term when uploaded again, and leaves the others', async () => {
    const secretary = await secretarySession(app)
    await upload(secretary, [wednesdayClass(), { facultyEmail: email('QCU-PROF-OTHER'), day: 'Mon', start: '07:30', end: '09:00', subject: 'IT 201' }])
    await upload(secretary, [{ ...wednesdayClass(), day: 'Thu' }])
    const byFaculty = (id: string) => repo.read().loadSchedules.filter((c) => c.facultyId === id).map((c) => c.day)
    expect(byFaculty('QCU-PROF-IT')).toEqual(['Thu'])
    expect(byFaculty('QCU-PROF-OTHER')).toEqual(['Mon'])
  })

  it('is for the CCS Secretary only', async () => {
    for (const id of ['QCU-FAC-PAULA-DELACRUZ', 'QCU-PROF-IT', 'ACCS-ADMIN']) {
      const agent = await login(id)
      expect([id, (await agent.get('/api/pages/P54')).status]).toEqual([id, 403])
      expect([id, (await upload(agent, [wednesdayClass()])).status]).toEqual([id, 403])
    }
  })
})

describe('availability against the load', () => {
  it('refuses an open time that overlaps a class in the term, and allows it outside the class, the day or the term', async () => {
    await upload(await secretarySession(app), [wednesdayClass()])
    const professor = await login('QCU-PROF-IT')
    const refused = await open(professor, '2026-12-02', '14:00', '15:00')
    expect([refused.status, refused.body.error]).toEqual([409, 'This time overlaps your class CC 104 Data Structures (Wed 13:00 to 14:30). Choose a time outside your load.'])
    expect((await open(professor, '2026-12-02', '14:30', '15:30')).status).toBe(200)
    expect((await open(professor, '2026-12-03', '13:00', '14:00')).status).toBe(200)
    // A Wednesday after the term ends.
    expect((await open(professor, '2027-04-07', '13:00', '14:00')).status).toBe(200)
    // Marking a class time not available is fine.
    expect((await open(professor, '2026-12-09', '13:00', '14:00', 'unavailable', 'Class time.')).status).toBe(200)
  })

  it('lists times opened before the load that now overlap a class', async () => {
    const professor = await login('QCU-PROF-IT')
    const early = (await open(professor, '2026-12-02', '13:30', '14:00')).body.record.id as string
    const secretary = await secretarySession(app)
    const saved = await upload(secretary, [wednesdayClass()])
    expect(saved.body.record.conflicts).toBe(1)
    expect(saved.body.message).toBe('Load saved. 1 appointment time overlaps a class; see the list.')
    const prof = (await secretary.get('/api/pages/P54')).body.data.faculty.find((f: { id: string }) => f.id === 'QCU-PROF-IT')
    expect(prof.conflicts).toEqual([expect.objectContaining({ slotId: early, subject: 'CC 104 Data Structures', day: 'Wed' })])
  })

  it('shows the Secretary the reasons faculty gave for times not available (#32)', async () => {
    const professor = await login('QCU-PROF-IT')
    const id = (await open(professor, '2026-12-04', '09:00', '10:00', 'unavailable', 'Faculty meeting.')).body.record.id as string
    const secretary = await secretarySession(app)
    await upload(secretary, [wednesdayClass()])
    const prof = (await secretary.get('/api/pages/P54')).body.data.faculty.find((f: { id: string }) => f.id === 'QCU-PROF-IT')
    expect(prof.slots.find((s: { id: string }) => s.id === id)).toMatchObject({ state: 'unavailable', reason: 'Faculty meeting.' })
  })
})
