// QA v5, batch A: roles, accounts and enrollment (decision D1: a student is a student, optionally also a CCS student
// organization representative; faculty are professors, optionally also the Dean or a Program Chair; the Secretary, OSAS,
// Guidance and the System Administrator hold their role alone).
import request from 'supertest'
import { beforeEach, describe, expect, it } from 'vitest'

import { createApp } from '../src/app.js'
import { roles } from '../src/schemas.js'
import { rolesProblem } from '../src/services.js'
import { createMemoryRepository } from '../src/store.js'
import { secretarySession, seedPassword, setUpAuthStore, signIn } from './helpers.js'

let repo: ReturnType<typeof createMemoryRepository>
let authStore: ReturnType<typeof setUpAuthStore>
let app: ReturnType<typeof createApp>
beforeEach(() => { repo = createMemoryRepository(); authStore = setUpAuthStore(); app = createApp(repo, { authStore }) })

async function login(id: string) {
  const agent = request.agent(app)
  expect((await agent.post('/api/auth/sign-in').send({ emailOrId: id, password: seedPassword })).status).toBe(200)
  return agent
}
type Agent = Awaited<ReturnType<typeof login>>
const setRoles = (agent: Agent, id: string, payload: object, reason = 'QA v5 check') => agent.post('/api/pages/P47/actions').send({ action: 'updateRoles', recordId: id, reason, payload })
const rolesOf = (id: string) => repo.read().users.find((u) => u.id === id)!.roles
const problem = (response: { status: number; body: { code?: string; error?: string } }) => [response.status, response.body.code]

/** An account in the auth store, like every account the Secretary creates. */
async function importStudent(secretary: Agent, extra: object = {}) {
  const response = await secretary.post('/api/accounts/students').send({ students: [{ name: 'Student Number1', email: 'student.1@gmail.com', studentId: '26-1001', program: 'BSIT', year: 1, section: 'A', ...extra }] })
  expect(response.status).toBe(200)
  return response.body.record.results[0] as { status: string; account: { id: string; adviserId?: string }; fields?: { path: string; message: string }[] }
}

describe('A1: the role sets of D1', () => {
  it('accepts exactly the D1 sets, whatever the order, and nothing else of one or two roles', () => {
    const key = (set: string[]) => [...set].sort().join('+')
    const sets = roles.flatMap((role, at) => [[role], ...roles.slice(at + 1).map((other) => [role, other])])
    const accepted = sets.filter((set) => !rolesProblem(set) && !rolesProblem([...set].reverse())).map(key).sort()
    expect(accepted).toEqual(['administrator', 'chair+professor', 'dean+professor', 'guidance', 'organization', 'osas', 'professor', 'secretary', 'student', 'organization+student'].sort())
  })

  it('names the reason in words', () => {
    expect(rolesProblem(['dean', 'secretary'])).toBe("CCS Secretary is a single-role account: it can't be combined with another role.")
    expect(rolesProblem(['dean', 'osas'])).toBe("OSAS is a single-role account: it can't be combined with another role.")
    expect(rolesProblem(['dean', 'administrator'])).toBe("System Administrator is a single-role account: it can't be combined with another role.")
    expect(rolesProblem(['dean', 'chair'])).toMatch(/also a Professor/)
    expect(rolesProblem(['chair'])).toMatch(/also a Professor/)
    expect(rolesProblem(['staff'])).toBe('CCS Staff is no longer assigned.')
  })

  it('keeps a single role the account already holds, so the Dean, a chair and CCS Staff accounts that exist can be saved', () => {
    for (const role of ['dean', 'chair', 'staff']) expect(rolesProblem([role], undefined, [role])).toBeUndefined()
    expect(rolesProblem(['dean'], undefined, ['professor'])).toMatch(/also a Professor/)
    expect(rolesProblem(['staff'], undefined, ['professor'])).toBe('CCS Staff is no longer assigned.')
    // A pair outside D1 is never kept, even when the account holds it today.
    expect(rolesProblem(['dean', 'secretary'], undefined, ['dean', 'secretary'])).toMatch(/single-role account/)
  })

  it('refuses the sets the tester saved (QA v5: Dean with Secretary, OSAS or System Administrator)', async () => {
    const admin = await login('ACCS-ADMIN')
    for (const set of [['dean', 'secretary'], ['dean', 'osas'], ['dean', 'administrator'], ['professor', 'guidance'], ['professor', 'staff'], ['dean', 'chair']]) {
      const response = await setRoles(admin, 'QCU-PROF-IT', { roles: set, program: 'BSIT' })
      expect([set.join('+'), ...problem(response)]).toEqual([set.join('+'), 400, 'VALIDATION_ERROR'])
    }
    expect(rolesOf('QCU-PROF-IT')).toEqual(['professor'])
  })

  it('keeps a student a student, also when Student is unticked first (QA v5: a student became Program Chair, Dean and System Administrator)', async () => {
    const admin = await login('ACCS-ADMIN')
    for (const set of [['administrator'], ['dean', 'professor'], ['professor'], ['professor', 'chair'], ['guidance'], ['organization']]) {
      const response = await setRoles(admin, 'QCU-STU-IT-A', { roles: set, program: 'BSIT' })
      expect([set.join('+'), ...problem(response)]).toEqual([set.join('+'), 400, 'VALIDATION_ERROR'])
    }
    expect((await setRoles(admin, 'QCU-STU-IT-A', { roles: ['administrator'] })).body.error).toMatch(/A student stays a student/)
    expect(rolesOf('QCU-STU-IT-A')).toEqual(['student'])
    // And nobody else becomes a student through a role change.
    expect((await setRoles(admin, 'QCU-PROF-IT', { roles: ['student'] })).body.error).toMatch(/Secretary creates student accounts/)
    expect((await setRoles(admin, 'QCU-ORG', { roles: ['student', 'organization'], program: 'BSIT' })).body.error).toMatch(/Secretary creates student accounts/)
    expect(rolesOf('QCU-PROF-IT')).toEqual(['professor'])
  })

  it('applies the same sets on the Secretary route', async () => {
    const secretary = await secretarySession(app)
    for (const set of [['professor', 'guidance'], ['professor', 'staff'], ['student']]) expect([set.join('+'), (await setRoles(secretary, 'QCU-PROF-IT', { roles: set, program: 'BSIT' })).status]).toEqual([set.join('+'), 400])
    // Only the System Administrator touches the Dean and System Administrator roles, as before.
    expect((await setRoles(secretary, 'QCU-PROF-IT', { roles: ['professor', 'dean'] })).status).toBe(403)
    expect(rolesOf('QCU-PROF-IT')).toEqual(['professor'])
    expect((await setRoles(secretary, 'QCU-STU-IT-A', { roles: ['administrator'] })).status).toBe(403)
    expect((await setRoles(secretary, 'QCU-STU-IT-A', { roles: ['professor', 'chair'], program: 'BSIT' })).status).toBe(400)
    expect(rolesOf('QCU-STU-IT-A')).toEqual(['student'])
  })

  it('does not let the chair route build a third role (it added Program Chair to a Dean who is also a professor)', async () => {
    const secretary = await secretarySession(app)
    expect((await setRoles(await login('ACCS-ADMIN'), 'QCU-PROF-OTHER', { roles: ['professor', 'dean'] })).status).toBe(200)
    const response = await secretary.put('/api/accounts/chairs/BSIT').send({ facultyId: 'QCU-PROF-OTHER' })
    expect([response.status, response.body.code]).toEqual([400, 'VALIDATION_ERROR'])
    expect(response.body.error).toMatch(/at most two roles/)
    expect(rolesOf('QCU-PROF-OTHER')).toEqual(['professor', 'dean'])
    // A professor with one role is still named chair, as before.
    expect((await secretary.put('/api/accounts/chairs/BSCS').send({ facultyId: 'QCU-PROF-CS' })).status).toBe(200)
  })

  it('still saves the Program Chair and CCS Staff accounts that hold one role (seeded like that)', async () => {
    const admin = await login('ACCS-ADMIN')
    expect((await setRoles(admin, 'QCU-CHAIR-CS', { roles: ['chair'], program: 'BSCS' })).status).toBe(200)
    expect((await setRoles(admin, 'QCU-STAFF-KEVIN-GARCIA', { roles: ['staff'] })).status).toBe(200)
    // But no one else gets either role alone, and CCS Staff is not assigned any more (A3).
    expect((await setRoles(admin, 'QCU-PROF-IT', { roles: ['staff'] })).body.error).toBe('CCS Staff is no longer assigned.')
    expect((await setRoles(admin, 'QCU-PROF-IT', { roles: ['chair'], program: 'BSIT' })).status).toBe(400)
  })
})

describe('A2: one Program Chair per program', () => {
  it('refuses a second chair and names the one in place', async () => {
    const admin = await login('ACCS-ADMIN')
    const response = await setRoles(admin, 'QCU-PROF-OTHER', { roles: ['professor', 'chair'], program: 'BSIT' })
    expect(problem(response)).toEqual([409, 'CONFLICT'])
    expect(response.body.error).toBe('BSIT already has a Program Chair, Demo Chair Alpha. Replace them under Accounts, Program chairs, or take that role from them first.')
    expect(rolesOf('QCU-PROF-OTHER')).toEqual(['professor'])
    expect(rolesOf('QCU-CHAIR-IT')).toEqual(['chair', 'professor'])
  })

  it('takes the program the account already has when none is sent, and counts a chair who is switched off', async () => {
    const admin = await login('ACCS-ADMIN')
    expect(problem(await setRoles(admin, 'QCU-PROF-OTHER', { roles: ['professor', 'chair'] }))).toEqual([409, 'CONFLICT'])
    repo.read().users.find((u) => u.id === 'QCU-CHAIR-IT')!.active = false
    expect(problem(await setRoles(admin, 'QCU-PROF-OTHER', { roles: ['professor', 'chair'] }))).toEqual([409, 'CONFLICT'])
  })

  it('lets legacy duplicate chairs be repaired, but still refuses a new second chair', async () => {
    const admin = await login('ACCS-ADMIN')
    const legacy = repo.read().users.find((u) => u.id === 'QCU-PROF-OTHER')!
    legacy.roles = ['professor', 'chair']; legacy.program = 'BSIT'
    expect((await setRoles(admin, 'QCU-CHAIR-IT', { roles: ['chair', 'professor'], program: 'BSIT' })).status).toBe(200)
    expect((await setRoles(admin, 'QCU-PROF-OTHER', { roles: ['professor'] })).status).toBe(200)
    expect(problem(await setRoles(admin, 'QCU-PROF-OTHER', { roles: ['professor', 'chair'], program: 'BSIT' }))).toEqual([409, 'CONFLICT'])
  })

  it('refuses moving a chair to a program that has one', async () => {
    const admin = await login('ACCS-ADMIN')
    expect(problem(await setRoles(admin, 'QCU-CHAIR-IT', { roles: ['professor', 'chair'], program: 'BSCS' }))).toEqual([409, 'CONFLICT'])
    expect(repo.read().users.find((u) => u.id === 'QCU-CHAIR-IT')!.program).toBe('BSIT')
  })

  it('names the next chair once the sitting one has stepped down, and keeps saving the sitting one', async () => {
    const admin = await login('ACCS-ADMIN')
    expect((await setRoles(admin, 'QCU-CHAIR-IT', { roles: ['chair', 'professor'], program: 'BSIT' })).status).toBe(200)
    expect((await setRoles(admin, 'QCU-CHAIR-IT', { roles: ['professor'] })).status).toBe(200)
    expect((await setRoles(admin, 'QCU-PROF-OTHER', { roles: ['professor', 'chair'], program: 'BSIT' })).status).toBe(200)
    expect(rolesOf('QCU-PROF-OTHER')).toEqual(['professor', 'chair'])
  })

  it('cannot be avoided by the Secretary', async () => {
    const secretary = await secretarySession(app)
    expect(problem(await setRoles(secretary, 'QCU-PROF-OTHER', { roles: ['professor', 'chair'], program: 'BSIT' }))).toEqual([409, 'CONFLICT'])
    // The chair route replaces the chair, so there is still one.
    const replaced = await secretary.put('/api/accounts/chairs/BSIT').send({ facultyId: 'QCU-PROF-OTHER' })
    expect(replaced.body.record).toEqual({ program: 'BSIT', chairId: 'QCU-PROF-OTHER', previousChairIds: ['QCU-CHAIR-IT'] })
    const chairs = (await secretary.get('/api/accounts').query({ role: 'chair' })).body.accounts as { id: string; program?: string }[]
    expect(chairs.filter((chair) => chair.program === 'BSIT').map((chair) => chair.id)).toEqual(['QCU-PROF-OTHER'])
  })
})

describe('A4: a section is one letter', () => {
  it('refuses two and three letters on a role change, and keeps a capital letter', async () => {
    const admin = await login('ACCS-ADMIN')
    for (const section of ['AB', 'ABC', 'a1', '200']) {
      const response = await setRoles(admin, 'QCU-STU-IT-A', { roles: ['student'], section })
      expect([section, response.status, response.body.error]).toEqual([section, 400, 'Use the section letter, like A.'])
    }
    expect(repo.read().users.find((u) => u.id === 'QCU-STU-IT-A')!.section).toBe('A')
    expect((await setRoles(admin, 'QCU-STU-IT-A', { roles: ['student'], section: 'c' })).status).toBe(200)
    expect(repo.read().users.find((u) => u.id === 'QCU-STU-IT-A')!.section).toBe('C')
  })

  it('refuses it when a student is added (the import and the form share the rule)', async () => {
    const secretary = await secretarySession(app)
    for (const section of ['AB', 'SBIT4ABC']) {
      const row = await importStudent(secretary, { section })
      expect([row.status, row.fields?.map((f) => f.path)]).toEqual(['error', ['section']])
      expect(row.fields![0]!.message).toBe('Use the section letter, like A.')
    }
    expect((await importStudent(secretary, { section: 'b' })).status).toBe('created')
  })
})

describe('A8: sections and year levels belong to students', () => {
  it('refuses a section or a year level on faculty, on both routes', async () => {
    const admin = await login('ACCS-ADMIN')
    const secretary = await secretarySession(app)
    for (const agent of [admin, secretary]) {
      expect((await setRoles(agent, 'QCU-PROF-IT', { roles: ['professor'], section: 'A' })).body.error).toBe('Only students have a section.')
      expect((await setRoles(agent, 'QCU-PROF-IT', { roles: ['professor'], year: 2 })).body.error).toBe('Only students have a year level.')
    }
    const user = repo.read().users.find((u) => u.id === 'QCU-PROF-IT')!
    expect([user.section, user.year]).toEqual([undefined, undefined])
    const record = (await admin.get('/api/pages/P47?id=QCU-PROF-IT')).body.data.record
    expect([record.id, record.section, record.year]).toEqual(['QCU-PROF-IT', undefined, undefined])
  })

  it('shows no section or year level on anyone but a student, whatever an account still holds', async () => {
    const stale = repo.read().users.find((u) => u.id === 'QCU-PROF-IT')!
    Object.assign(stale, { section: 'A', year: 2 })
    const admin = await login('ACCS-ADMIN')
    const record = (await admin.get('/api/pages/P47?id=QCU-PROF-IT')).body.data.record
    expect([record.section, record.year, record.sectionName]).toEqual([undefined, undefined, undefined])
    const listed = (await admin.get('/api/pages/P46')).body.data.users as { id: string; section?: string; year?: number }[]
    expect(listed.find((u) => u.id === 'QCU-PROF-IT')).not.toHaveProperty('section')
    expect(listed.find((u) => u.id === 'QCU-STU-IT-A')).toMatchObject({ section: 'A', year: 3 })
  })

  it('does not let a student carry the section over to a faculty account', async () => {
    const admin = await login('ACCS-ADMIN')
    expect((await setRoles(admin, 'QCU-STU-IT-A', { roles: ['professor'], program: 'BSIT' })).status).toBe(400)
    expect(repo.read().users.find((u) => u.id === 'QCU-STU-IT-A')).toMatchObject({ roles: ['student'], section: 'A', year: 3 })
  })
})

describe('A5: year level and section of students, in bulk', () => {
  it('keeps a new year level after the next request, and the adviser of that year goes with it', async () => {
    const secretary = await secretarySession(app)
    const student = await importStudent(secretary)
    const id = student.account.id
    expect((await secretary.put('/api/accounts/advisors/1').send({ facultyIds: ['QCU-PROF-IT'] })).status).toBe(200)
    expect((await secretary.put('/api/accounts/advisors/2').send({ facultyIds: ['QCU-PROF-OTHER'] })).status).toBe(200)
    const listed = async (agent: Agent) => (await agent.get('/api/accounts').query({ role: 'student', q: '26-1001' })).body.accounts[0]
    expect(await listed(secretary)).toMatchObject({ year: 1, section: 'A', adviserId: 'QCU-PROF-IT' })

    // What the bulk action sends for each student: the roles the student holds, the year, the section.
    const moved = await setRoles(secretary, id, { roles: ['student'], program: 'BSIT', year: 2, section: 'B' }, 'Year level and section set for the new term')
    expect(moved.status, JSON.stringify(moved.body)).toBe(200)
    expect(await listed(secretary)).toMatchObject({ year: 2, section: 'B', adviserId: 'QCU-PROF-OTHER' })
    expect((await secretary.get(`/api/pages/P47?id=${id}`)).body.data.record).toMatchObject({ year: 2, section: 'B' })

    // Another instance, started cold over the same accounts, sees the same.
    const cold = createApp(createMemoryRepository(), { authStore })
    const { agent } = await signIn(cold, 'ACCS-ADMIN')
    expect((await agent.get(`/api/pages/P47?id=${id}`)).body.data.record).toMatchObject({ year: 2, section: 'B' })
  })

  it('keeps the organization role of a student whose year is changed in bulk, and refuses a year the campus does not teach', async () => {
    const secretary = await secretarySession(app)
    const id = (await importStudent(secretary)).account.id
    expect((await setRoles(secretary, id, { roles: ['student', 'organization'], program: 'BSIT', year: 2 })).status).toBe(200)
    expect(rolesOf(id)).toEqual(['student', 'organization'])
    expect((await setRoles(secretary, id, { roles: ['student', 'organization'], program: 'BSIT', year: 5 })).status).toBe(400)
  })
})

describe('A6: irregular students', () => {
  it('is set by the Secretary and shown on the account, the account list and the record, not on the profile', async () => {
    const secretary = await secretarySession(app)
    const id = (await importStudent(secretary)).account.id
    expect((await setRoles(secretary, id, { roles: ['student'], program: 'BSIT', irregular: true })).status).toBe(200)
    expect((await secretary.get(`/api/pages/P47?id=${id}`)).body.data.record.irregular).toBe(true)
    expect((await secretary.get('/api/accounts').query({ role: 'student', q: '26-1001' })).body.accounts[0].irregular).toBe(true)

    const dean = await login('QCU-FAC-PAULA-DELACRUZ')
    const students = (await dean.get('/api/pages/P33')).body.data.students as { id: string; irregular?: boolean }[]
    expect(students.find((s) => s.id === id)?.irregular).toBe(true)
    expect(students.find((s) => s.id === 'QCU-STU-IT-A')?.irregular).toBeUndefined()
    expect((await dean.get('/api/pages/P34').query({ id, purpose: 'Program oversight' })).body.data.record.irregular).toBe(true)
    // A profile does not carry it.
    expect((await dean.get(`/api/pages/P38?id=${id}`)).body.data.record).not.toHaveProperty('irregular')

    // It stays after the next request and on another instance, and can be taken off.
    const { agent: cold } = await signIn(createApp(createMemoryRepository(), { authStore }), 'ACCS-ADMIN')
    expect((await cold.get(`/api/pages/P47?id=${id}`)).body.data.record.irregular).toBe(true)
    expect((await setRoles(secretary, id, { roles: ['student'], program: 'BSIT', irregular: false })).status).toBe(200)
    expect((await secretary.get(`/api/pages/P47?id=${id}`)).body.data.record).not.toHaveProperty('irregular')
  })

  it('is for students only', async () => {
    const admin = await login('ACCS-ADMIN')
    const response = await setRoles(admin, 'QCU-PROF-IT', { roles: ['professor'], irregular: true })
    expect([response.status, response.body.error]).toEqual([400, 'Only students can be irregular.'])
    expect(repo.read().users.find((u) => u.id === 'QCU-PROF-IT')).not.toHaveProperty('irregular')
  })
})

describe('A9: the activity of an account, newest first', () => {
  it('lists the latest change first', async () => {
    const admin = await login('ACCS-ADMIN')
    expect((await setRoles(admin, 'QCU-PROF-IT', { roles: ['professor', 'dean'] }, 'First change')).status).toBe(200)
    expect((await setRoles(admin, 'QCU-PROF-IT', { roles: ['professor'] }, 'Second change')).status).toBe(200)
    const audit = (await admin.get('/api/pages/P47?id=QCU-PROF-IT')).body.data.audit as { action: string; reason?: string; at: string }[]
    expect(audit.filter((entry) => entry.action === 'Role assignment changed').map((entry) => entry.reason)).toEqual(['Second change', 'First change'])
    expect(audit.map((entry) => entry.at)).toEqual(audit.map((entry) => entry.at).sort().reverse())
  })
})

describe('A5: year level and section for many students at once', () => {
  const studentOf = (id: string) => repo.read().users.find((u) => u.id === id)!
  const members = (spaceId: string) => repo.read().spaces.find((space) => space.id === spaceId)!.studentIds
  it('moves a student from the old section space to the new one', async () => {
    const admin = await login('ACCS-ADMIN')
    expect((await admin.post('/api/accounts/students/enroll').send({ ids: ['QCU-STU-IT-A'], section: 'b' })).status).toBe(200)
    await admin.get('/api/pages/P47?id=QCU-STU-IT-A')
    expect(members('SPACE-IT-B')).toContain('QCU-STU-IT-A')
    expect(members('SPACE-IT-A')).not.toContain('QCU-STU-IT-A')
    expect(studentOf('QCU-STU-IT-A').spaceIds).toEqual(['SPACE-IT-B'])
  })
  it('updateRoles with a new section moves the student too', async () => {
    const admin = await login('ACCS-ADMIN')
    expect((await setRoles(admin, 'QCU-STU-IT-B', { roles: ['student'], section: 'a' })).status).toBe(200)
    await admin.get('/api/pages/P47?id=QCU-STU-IT-B')
    expect(members('SPACE-IT-A')).toContain('QCU-STU-IT-B')
    expect(members('SPACE-IT-B')).not.toContain('QCU-STU-IT-B')
  })
  it('sets all of them, or none when one fails', async () => {
    const admin = await login('ACCS-ADMIN')
    const ids = ['QCU-STU-IT-A', 'QCU-STU-IT-B']
    const bad = await admin.post('/api/accounts/students/enroll').send({ ids, year: 2, section: 'AB' })
    expect([bad.status, bad.body.code]).toEqual([400, 'VALIDATION_ERROR'])
    expect(ids.map((id) => studentOf(id).year)).not.toEqual([2, 2])
    const ok = await admin.post('/api/accounts/students/enroll').send({ ids, year: 2, section: 'c' })
    expect(ok.status, JSON.stringify(ok.body)).toBe(200)
    await admin.get('/api/pages/P47?id=QCU-STU-IT-A') // the next request applies the stored accounts
    expect(ids.map((id) => [studentOf(id).year, studentOf(id).section])).toEqual([[2, 'C'], [2, 'C']])
    expect((await admin.post('/api/accounts/students/enroll').send({ ids: ['QCU-PROF-IT'], year: 2 })).status).toBe(404)
    const audit = (await admin.get('/api/pages/P47?id=QCU-STU-IT-A')).body.data.audit as { action: string }[]
    expect(audit.some((entry) => entry.action === 'Year level or section changed')).toBe(true)
  })
})
