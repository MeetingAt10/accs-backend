// Appointments (decided 11 November 2026): "consultations" are called appointments, and the student picks what an
// appointment is for from a category and a sub-category. The current booking screen's free purpose still works.
import request from 'supertest'
import { beforeEach, describe, expect, it } from 'vitest'

import { appointmentCategories, appointmentProblem, concernFollowUp, otherAppointment, purposeOf } from '../src/appointments.js'
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
const openSlot = () => repo.read().slots.find((s) => s.facultyId === 'QCU-PROF-IT' && s.state === 'open')!.id
const book = (student: Agent, choice: object) => student.post('/api/pages/P15/actions').send({ action: 'createConsultation', payload: { slotId: openSlot(), ...choice } })

describe('the appointment categories', () => {
  it('lists what an appointment can be for, each with sub-categories, and "Other" asks for a description', () => {
    expect(appointmentCategories.map((c) => c.label)).toEqual(['Academic advising', 'Class or subject', 'Thesis or capstone', 'Career or internship', 'Documents and signatures', 'Personal concern', 'Concern follow-up', otherAppointment])
    for (const c of appointmentCategories) {
      if (c.label === otherAppointment) expect([c.subcategories, c.requiresDetail]).toEqual([[], true])
      else expect(c.subcategories.length, c.label).toBeGreaterThanOrEqual(1)
      expect(new Set(c.subcategories).size, c.label).toBe(c.subcategories.length)
    }
    expect(appointmentCategories.filter((c) => c.system).map((c) => c.label)).toEqual(['Concern follow-up'])
  })

  it('checks a choice, and still accepts a free purpose from the current screen', () => {
    expect(appointmentProblem({ category: 'Class or subject', subcategory: 'Exam or quiz review' })).toBeUndefined()
    expect(appointmentProblem({ category: 'Class or subject', subcategory: 'Exam or quiz review', details: 'Midterm in CC 104' })).toBeUndefined()
    expect(appointmentProblem({ category: 'Class or subject' })?.path).toBe('subcategory')
    expect(appointmentProblem({ category: 'Class or subject', subcategory: 'Clearance signature' })?.path).toBe('subcategory')
    expect(appointmentProblem({ category: otherAppointment })?.path).toBe('details')
    expect(appointmentProblem({ category: otherAppointment, subcategory: 'Grades or standing', details: 'x' })?.path).toBe('subcategory')
    expect(appointmentProblem({ category: otherAppointment, details: 'Borrow a book' })).toBeUndefined()
    expect(appointmentProblem({ category: 'Coffee' })?.path).toBe('category')
    expect(appointmentProblem({ category: concernFollowUp.category, subcategory: concernFollowUp.subcategory })).toEqual({ path: 'category', message: 'Book a time for a concern from the concern page.' })
    expect(appointmentProblem({ purpose: 'Go over my project rubric' })).toBeUndefined()
    expect(appointmentProblem({})?.path).toBe('category')
    expect(appointmentProblem({ subcategory: 'Grades or standing' })?.path).toBe('category')
    expect([purposeOf({ category: 'Class or subject', subcategory: 'Exam or quiz review' }), purposeOf({ category: otherAppointment, details: ' Borrow a book ' }), purposeOf({ purpose: ' Rubric ' })]).toEqual(['Exam or quiz review', 'Borrow a book', 'Rubric'])
  })
})

describe('booking an appointment', () => {
  it('sends the list for the dropdowns on the booking pages, without the concern follow-up', async () => {
    const student = await login('QCU-STU-IT-A')
    for (const page of ['P14', 'P15?id=QCU-PROF-IT']) {
      const options = (await student.get(`/api/pages/${page}`)).body.data.appointmentCategories as { label: string }[]
      expect(options.map((c) => c.label)).toEqual(appointmentCategories.filter((c) => !c.system).map((c) => c.label))
    }
  })

  it('refuses a time opened before the faculty load and now during a class', async () => {
    const slot = repo.read().slots.find((s) => s.id === openSlot())!
    const day = (['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const)[new Date(`${slot.date}T00:00:00Z`).getUTCDay()]!
    repo.read().loadSchedules.push({ id: 'LOAD-TEST', facultyId: slot.facultyId, term: 'Test', startsOn: slot.date, endsOn: slot.date, day: day as never, start: slot.start, end: slot.end, subject: 'CC 104', uploadedBy: 'QCU-SECRETARY', at: slot.date })
    const refused = await book(await login('QCU-STU-IT-A'), { purpose: 'Advising' })
    expect([refused.status, refused.body.error]).toEqual([409, 'The faculty member has a class at that time. Pick another time.'])
  })

  it('stores what the appointment is for, and the professor sees it with the request', async () => {
    const student = await login('QCU-STU-IT-A')
    const booked = await book(student, { category: 'Class or subject', subcategory: 'Exam or quiz review', details: 'Midterm in CC 104' })
    expect(booked.status).toBe(200)
    expect(booked.body.record).toMatchObject({ category: 'Class or subject', subcategory: 'Exam or quiz review', details: 'Midterm in CC 104', purpose: 'Exam or quiz review', status: 'Requested' })
    const professor = await login('QCU-PROF-IT')
    const seen = (await professor.get(`/api/pages/P16?id=${booked.body.record.id}`)).body.data.record
    expect(seen).toMatchObject({ category: 'Class or subject', subcategory: 'Exam or quiz review', details: 'Midterm in CC 104' })
    expect(repo.read().notifications.some((n) => n.recipientId === 'QCU-PROF-IT' && n.kind === 'consultation' && n.title === 'Appointment request updated')).toBe(true)
  })

  it('refuses a missing or wrong choice with a field error and books nothing', async () => {
    const student = await login('QCU-STU-IT-A')
    const before = repo.read().consultations.length
    for (const [choice, path] of [
      [{ category: 'Class or subject' }, 'subcategory'],
      [{ category: otherAppointment }, 'details'],
      [{ category: concernFollowUp.category, subcategory: concernFollowUp.subcategory }, 'category'],
      [{}, 'category'],
    ] as const) {
      const response = await book(student, choice)
      expect([JSON.stringify(choice), response.status, response.body.fields?.[0]?.path]).toEqual([JSON.stringify(choice), 400, path])
    }
    expect(repo.read().consultations).toHaveLength(before)
    expect(repo.read().slots.find((s) => s.id === openSlot())!.state).toBe('open')
  })

  it('still accepts a free purpose from the current booking screen', async () => {
    const booked = await book(await login('QCU-STU-IT-A'), { purpose: 'Go over my project rubric' })
    expect(booked.status).toBe(200)
    expect(booked.body.record).toMatchObject({ purpose: 'Go over my project rubric' })
    expect(booked.body.record.category).toBeUndefined()
  })

  it('files a time booked from a concern under "Concern follow-up"', async () => {
    const student = await login('QCU-STU-IT-A')
    const slot = repo.read().slots.find((s) => s.facultyId === 'QCU-PROF-IT' && s.state === 'open')!
    // RPT-0241 is anonymous; a booking shows the office who asked, so the student shares their name first.
    expect((await student.post('/api/pages/P20/actions').send({ action: 'discloseIdentity', recordId: 'RPT-0241', payload: {} })).status).toBe(200)
    const chosen = await student.post('/api/pages/P20/actions').send({ action: 'chooseTalkMode', payload: { reportId: 'RPT-0241', mode: 'face_to_face', consent: { participate: true }, slotId: slot.id } })
    expect(chosen.status).toBe(200)
    expect(repo.read().consultations.at(-1)).toMatchObject({ reportId: 'RPT-0241', category: 'Concern follow-up', subcategory: 'Talk about a concern', purpose: 'Talk about a concern' })
  })
})

describe('appointment wording', () => {
  it('says "appointment" on the pages, help and notifications', async () => {
    const student = await login('QCU-STU-IT-A')
    expect((await student.get('/api/pages/P14')).body.title).toBe('Appointments')
    expect((await student.get('/api/pages/P03')).body.data.stats.map((s: { label: string }) => s.label)).toContain('Appointments')
    expect((await student.get('/api/pages/P42')).body.data.faq.map((f: { question: string }) => f.question)).toContain('How do I book an appointment?')
    const pages = JSON.stringify([(await student.get('/api/pages/P14')).body, (await student.get('/api/pages/P42')).body, (await student.get('/api/pages/P03')).body])
    expect(pages.match(/"[^"]{0,60}Consultations?[^"]{0,60}"/g)).toBeNull()
  })
})
