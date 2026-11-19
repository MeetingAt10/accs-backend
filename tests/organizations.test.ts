// Organization accounts (decided 19 November 2026): the Secretary and the Dean create an organization and its account,
// with a student as its President; the organization account adds members and names their positions.
import request from 'supertest'
import { beforeEach, describe, expect, it } from 'vitest'

import { createApp } from '../src/app.js'
import { createRecordRepository } from '../src/persist.js'
import { createMemoryRecordStore } from '../src/records.js'
import { createMemoryRepository } from '../src/store.js'
import { secretaryPassword, secretarySession, seedPassword, setUpAuthStore, signIn } from './helpers.js'

let repo: ReturnType<typeof createMemoryRepository>
let app: ReturnType<typeof createApp>
beforeEach(() => { repo = createMemoryRepository(); app = createApp(repo, { authStore: setUpAuthStore() }) })

async function login(id: string) {
  const agent = request.agent(app)
  expect((await agent.post('/api/auth/sign-in').send({ emailOrId: id, password: seedPassword })).status).toBe(200)
  return agent
}
type Agent = Awaited<ReturnType<typeof login>>
const newOrganization = { name: 'CCS Robotics Club', description: 'Robotics for every CCS student.', email: 'robotics.club@example.com', presidentId: 'QCU-STU-IT-B' }
const create = (agent: Agent, body: object = newOrganization) => agent.post('/api/accounts/organizations').send(body)
const act = (agent: Agent, organizationId: string, action: string, payload: object) => agent.post('/api/pages/P10/actions').send({ action, recordId: organizationId, payload })
const members = async (agent: Agent, id: string) => (await agent.get(`/api/pages/P10?id=${id}`)).body.data.record.members as { id: string; organizationRole: string }[]

describe('creating an organization', () => {
  it('lets the Dean create one: an organization account with temporary details, and the student as President', async () => {
    const dean = await login('QCU-FAC-PAULA-DELACRUZ')
    const response = await create(dean)
    expect(response.status).toBe(200)
    const { organization, account, credentials } = response.body.record
    expect(account).toMatchObject({ name: 'CCS Robotics Club', email: 'robotics.club@example.com', roles: ['organization'], mustChangeCredentials: true })
    expect(organization.president).toMatchObject({ id: 'QCU-STU-IT-B' })

    // The organization account signs in with its temporary details and runs the organization.
    const { agent: club, response: signedIn } = await signIn(app, credentials.username, credentials.temporaryPassword)
    expect(signedIn.status).toBe(200)
    expect((await club.post('/api/auth/complete-first-login').send({ currentPassword: credentials.temporaryPassword, username: 'robotics.club', password: secretaryPassword })).status).toBe(200)
    const page = (await club.get(`/api/pages/P10?id=${organization.id}`)).body.data
    expect(page.canPublish).toBe(true)
    expect(page.canManageMembers).toBe(true)
    expect(page.record.members.find((m: { id: string }) => m.id === 'QCU-STU-IT-B')).toMatchObject({ organizationRole: 'President' })
    expect((await dean.get('/api/pages/P09')).body.data.organizations.map((o: { name: string }) => o.name)).toContain('CCS Robotics Club')
  })

  it('lets the Secretary create one too, and offers both a list of students to choose the President from', async () => {
    const secretary = await secretarySession(app)
    const p09 = (await secretary.get('/api/pages/P09')).body.data
    expect(p09.canCreate).toBe(true)
    expect(p09.studentOptions.map((s: { id: string }) => s.id)).toContain('QCU-STU-IT-B')
    expect(JSON.stringify(p09.studentOptions)).not.toContain('@')
    expect((await create(secretary)).status).toBe(200)
  })

  it('refuses everyone else, a President who is not a student, a taken name and a taken email', async () => {
    for (const id of ['QCU-STU-IT-A', 'QCU-PROF-IT', 'QCU-ORG', 'ACCS-ADMIN']) {
      const agent = await login(id)
      expect([id, (await create(agent)).status]).toEqual([id, 403])
      expect((await agent.get('/api/pages/P09')).body.data?.canCreate).toBeUndefined()
    }
    const dean = await login('QCU-FAC-PAULA-DELACRUZ')
    const notStudent = await create(dean, { ...newOrganization, presidentId: 'QCU-PROF-IT' })
    expect([notStudent.status, notStudent.body.fields?.[0]?.path]).toEqual([400, 'presidentId'])
    const takenName = await create(dean, { ...newOrganization, name: 'ccs computing society' })
    expect([takenName.status, takenName.body.fields?.[0]?.path]).toEqual([400, 'name'])
    const takenEmail = await create(dean, { ...newOrganization, email: 'stu.it.a@access-ccs.com' })
    expect([takenEmail.status, takenEmail.body.fields?.[0]?.path]).toEqual([400, 'email'])
    expect(repo.read().organizations).toHaveLength(1)
  })

  it('keeps a new organization in the shared record store, so every instance sees it', async () => {
    const store = createMemoryRecordStore()
    const authStore = setUpAuthStore()
    app = createApp(createRecordRepository(store), { authStore }) // this test only reads through the API
    const dean = await login('QCU-FAC-PAULA-DELACRUZ')
    const made = await create(dean)
    const id = made.body.record.organization.id
    const other = createApp(createRecordRepository(store), { authStore })
    const agent = request.agent(other)
    expect((await agent.post('/api/auth/sign-in').send({ emailOrId: 'QCU-STU-IT-B', password: seedPassword })).status).toBe(200)
    expect((await agent.get(`/api/pages/P10?id=${id}`)).body.data.record.name).toBe('CCS Robotics Club')
  })
})

describe('members and their positions', () => {
  it('lets the organization account add a member with a position, rename it, and remove the member', async () => {
    const org = await login('QCU-ORG')
    const added = await act(org, 'ORG-COMPUTING', 'addOrganizationMember', { studentId: 'QCU-STU-CS', position: 'VP for Information' })
    expect(added.status).toBe(200)
    expect((await members(org, 'ORG-COMPUTING')).find((m) => m.id === 'QCU-STU-CS')).toMatchObject({ organizationRole: 'VP for Information' })
    // The new member is told, and sees the position too.
    expect(repo.read().notifications.some((n) => n.recipientId === 'QCU-STU-CS' && n.recordId === 'ORG-COMPUTING')).toBe(true)
    const student = await login('QCU-STU-CS')
    expect((await members(student, 'ORG-COMPUTING')).find((m) => m.id === 'QCU-STU-CS')).toMatchObject({ organizationRole: 'VP for Information' })

    expect((await act(org, 'ORG-COMPUTING', 'setMemberPosition', { memberId: 'QCU-STU-CS', position: 'Secretary General' })).status).toBe(200)
    expect((await members(org, 'ORG-COMPUTING')).find((m) => m.id === 'QCU-STU-CS')!.organizationRole).toBe('Secretary General')
    expect((await act(org, 'ORG-COMPUTING', 'setMemberPosition', { memberId: 'QCU-STU-CS', position: '' })).status).toBe(200)
    expect((await members(org, 'ORG-COMPUTING')).find((m) => m.id === 'QCU-STU-CS')!.organizationRole).toBe('Member')

    expect((await act(org, 'ORG-COMPUTING', 'removeOrganizationMember', { studentId: 'QCU-STU-CS' })).status).toBe(200)
    expect((await members(org, 'ORG-COMPUTING')).map((m) => m.id)).not.toContain('QCU-STU-CS')
    expect(repo.read().organizations[0]!.positions?.['QCU-STU-CS']).toBeUndefined()
  })

  it('lets no one else change members or positions, and refuses a position for someone who is not a member', async () => {
    for (const id of ['QCU-STU-IT-A', 'QCU-FAC-PAULA-DELACRUZ']) {
      const agent = await login(id)
      expect((await act(agent, 'ORG-COMPUTING', 'setMemberPosition', { memberId: 'QCU-STU-IT-A', position: 'President' })).status).toBeGreaterThanOrEqual(403)
      expect((await act(agent, 'ORG-COMPUTING', 'addOrganizationMember', { studentId: 'QCU-STU-CS' })).status).toBeGreaterThanOrEqual(403)
    }
    const org = await login('QCU-ORG')
    expect((await act(org, 'ORG-COMPUTING', 'setMemberPosition', { memberId: 'QCU-STU-CS', position: 'VP' })).status).toBe(404)
    expect((await act(org, 'ORG-COMPUTING', 'addOrganizationMember', { studentId: 'QCU-PROF-IT' })).status).toBe(404)
    expect((await act(org, 'ORG-COMPUTING', 'setMemberPosition', { memberId: 'QCU-STU-IT-A', position: 'x'.repeat(61) })).status).toBe(400)
    expect((await org.get('/api/pages/P10?id=ORG-COMPUTING')).body.data.studentOptions.map((s: { id: string }) => s.id)).not.toContain('QCU-STU-IT-A')
  })
})
