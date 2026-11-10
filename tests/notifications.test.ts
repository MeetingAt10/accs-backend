import request from 'supertest'
import { beforeEach, describe, expect, it } from 'vitest'

import { createApp } from '../src/app.js'
import { createMemoryRepository } from '../src/store.js'
import { seedPassword } from './helpers.js'

let repo: ReturnType<typeof createMemoryRepository>
let app: ReturnType<typeof createApp>
beforeEach(() => { repo = createMemoryRepository(); app = createApp(repo) })

async function login(id: string) {
  const agent = request.agent(app)
  expect((await agent.post('/api/auth/sign-in').send({ emailOrId: id, password: seedPassword })).status).toBe(200)
  return agent
}

const member = 'QCU-STU-IT-A'
const noticesFor = (id: string, kind: string) => repo.read().notifications.filter((n) => n.recipientId === id && n.kind === kind)

/** The Computing Society announces to its members (QCU-ORG and QCU-STU-IT-A) and notifies them. */
async function announce(priority: 'general' | 'important' | 'urgent', title: string) {
  const organization = await login('QCU-ORG')
  const response = await organization.post('/api/pages/P05/actions').send({
    action: 'createPost',
    payload: {
      title, body: 'Details for members.', audience: 'organization:ORG-COMPUTING', kind: 'announcement', priority, notifyMembers: true,
      eventDate: '2027-01-15', eventTime: '13:00', eventPlace: 'IC 305', eventContact: 'Computing Society office',
    },
  })
  expect(response.status, JSON.stringify(response.body)).toBe(200)
  return response.body.record.id as string
}

describe('urgent announcements', () => {
  it('reach a member who muted announcements, as high priority, while general and important ones stay muted', async () => {
    const student = await login(member)
    expect((await student.post('/api/pages/P44/actions').send({ action: 'saveNotificationPreferences', payload: { priorities: { announcement: 'muted' } } })).status).toBe(200)
    const before = noticesFor(member, 'announcement').length

    await announce('general', 'A general notice')
    await announce('important', 'An important notice')
    expect(noticesFor(member, 'announcement')).toHaveLength(before)

    const urgent = await announce('urgent', 'An urgent notice')
    const notices = noticesFor(member, 'announcement')
    expect(notices).toHaveLength(before + 1)
    expect(notices.at(-1)).toMatchObject({ recordId: urgent, priority: 'high' })
  })

  it('are high priority even for a member who set announcements to normal', async () => {
    const student = await login(member)
    expect((await student.post('/api/pages/P44/actions').send({ action: 'saveNotificationPreferences', payload: { priorities: { announcement: 'normal' } } })).status).toBe(200)
    await announce('general', 'A general notice')
    expect(noticesFor(member, 'announcement').at(-1)!.priority).toBe('normal')
    await announce('urgent', 'An urgent notice')
    expect(noticesFor(member, 'announcement').at(-1)!.priority).toBe('high')
  })

  it('still respect the author: an urgent announcement without notifyMembers notifies nobody', async () => {
    const organization = await login('QCU-ORG')
    const before = repo.read().notifications.length
    const response = await organization.post('/api/pages/P05/actions').send({
      action: 'createPost',
      payload: {
        title: 'Quiet urgent notice', body: 'Details.', audience: 'organization:ORG-COMPUTING', kind: 'announcement', priority: 'urgent',
        eventDate: '2027-01-15', eventTime: '13:00', eventPlace: 'IC 305', eventContact: 'Computing Society office',
      },
    })
    expect(response.status).toBe(200)
    expect(repo.read().notifications).toHaveLength(before)
  })
})

describe('report updates are required', () => {
  it('lists report as required on the settings page and refuses to mute it, keeping the old preferences', async () => {
    const student = await login(member)
    const page = await student.get('/api/pages/P44')
    expect(page.body.data.requiredCategories).toEqual(['report'])
    expect(page.body.data.categories).toContain('report')

    expect((await student.post('/api/pages/P44/actions').send({ action: 'saveNotificationPreferences', payload: { priorities: { announcement: 'muted' } } })).status).toBe(200)
    const refused = await student.post('/api/pages/P44/actions').send({ action: 'saveNotificationPreferences', payload: { priorities: { report: 'muted', announcement: 'high' } } })
    expect(refused.status).toBe(400)
    expect(refused.body.code).toBe('VALIDATION_ERROR')
    // Nothing from the refused request was saved.
    expect(repo.read().settings[member]!.priorities).toEqual({ announcement: 'muted' })
  })

  it('delivers report updates even when a mute was saved before reports became required', async () => {
    const student = await login(member)
    // A preference stored by the earlier version, which allowed muting reports.
    repo.read().settings[member] = { theme: 'system', density: 'comfortable', priorities: { report: 'muted' } }
    const before = noticesFor(member, 'report').length
    const professor = await login('QCU-PROF-IT')
    expect((await professor.post('/api/pages/P22/actions').send({ action: 'sendReportMessage', recordId: 'RPT-0241', payload: { body: 'An update for you.' } })).status).toBe(200)
    const notices = noticesFor(member, 'report')
    expect(notices).toHaveLength(before + 1)
    expect(notices.at(-1)!.priority).toBe('high')
    expect((await student.get('/api/pages/P20?id=RPT-0241')).status).toBe(200)
  })

  it('shows no required category to an account without report updates', async () => {
    const organization = await login('QCU-ORG')
    const page = await organization.get('/api/pages/P44')
    expect(page.body.data.categories).not.toContain('report')
    expect(page.body.data.requiredCategories).toEqual([])
  })
})
