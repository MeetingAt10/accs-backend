// API checks for DOC005 black-box cases that had no backend test. Each title starts with the case IDs from accs-docs/pages.
// Only what the API decides is tested here; alerts, empty-state copy and layout are frontend cases.
import request from 'supertest'
import { beforeEach, describe, expect, it } from 'vitest'

import { allowedPages as pagesFor } from '../src/access.js'
import { createApp } from '../src/app.js'
import { createMemoryRepository } from '../src/store.js'
import { seedPassword } from './helpers.js'

let repo: ReturnType<typeof createMemoryRepository>
let app: ReturnType<typeof createApp>
beforeEach(() => { repo = createMemoryRepository(); app = createApp(repo) })

const signIn = (emailOrId: string, password = seedPassword, extra: object = {}) => request(app).post('/api/auth/sign-in').send({ emailOrId, password, ...extra })
async function login(id: string) {
  const agent = request.agent(app)
  expect((await agent.post('/api/auth/sign-in').send({ emailOrId: id, password: seedPassword })).status).toBe(200)
  return agent
}
const cookieOf = (response: { headers: Record<string, unknown> }) => String((response.headers['set-cookie'] as string[])[0])

describe('ALL-01 sign-in', () => {
  it('ALL-01-A / ALL-01-H signs each role in to its own view: the session lists exactly the pages that role may open', async () => {
    for (const id of ['QCU-STU-IT-A', 'QCU-PROF-IT', 'QCU-CHAIR-IT', 'CCS-DEAN', 'QCU-GUIDANCE', 'QCU-OSAS', 'QCU-ORG', 'QCU-ADMIN']) {
      const response = await signIn(id)
      expect(response.status, id).toBe(200)
      const { user, allowedPages } = response.body
      expect(user.id).toBe(id)
      expect(allowedPages, id).toEqual(pagesFor(repo.read().users.find((u) => u.id === id)!))
      expect(allowedPages.length, id).toBeGreaterThan(0)
    }
  })

  it('ALL-01-D refuses empty fields with field errors and starts no session', async () => {
    const response = await request(app).post('/api/auth/sign-in').send({ emailOrId: '', password: '' })
    expect(response.status).toBe(400)
    expect(response.body.code).toBe('VALIDATION_ERROR')
    expect(response.body.fields.map((f: { path: string }) => f.path).sort()).toEqual(['emailOrId', 'password'])
    expect(response.headers['set-cookie']).toBeUndefined()
  })

  it('ALL-01-F accepts the QCU email, the account ID, or the student number as the identifier', async () => {
    const user = repo.read().users.find((u) => u.id === 'QCU-STU-IT-A')!
    for (const identifier of [user.email, user.id, user.studentId!]) expect((await signIn(identifier)).status, identifier).toBe(200)
  })

  it('ALL-01-K ignores surrounding spaces and letter case in the identifier', async () => {
    const user = repo.read().users.find((u) => u.id === 'QCU-STU-IT-A')!
    for (const identifier of [`  ${user.email.toUpperCase()}  `, ` ${user.id.toLowerCase()} `]) expect((await signIn(identifier)).status, identifier).toBe(200)
  })

  it('ALL-01-L gives an inactive account the same answer as a wrong password, so it does not reveal the account', async () => {
    repo.read().users.find((u) => u.id === 'QCU-STU-IT-B')!.active = false
    const inactive = await signIn('QCU-STU-IT-B')
    const wrong = await signIn('QCU-STU-IT-A', 'Wrong!Passw0rd1')
    expect(inactive.status).toBe(401)
    expect(inactive.body).toEqual(wrong.body)
  })

  it('ALL-01-G keeps a session only for the browser session unless "keep me signed in" is chosen, and sign-out ends it', async () => {
    expect(cookieOf(await signIn('QCU-STU-IT-A'))).not.toMatch(/Max-Age|Expires/i)
    const remembered = cookieOf(await signIn('QCU-STU-IT-A', seedPassword, { remember: true }))
    expect(remembered).toMatch(/Max-Age=\d+/i)

    const agent = await login('QCU-STU-IT-A')
    expect((await agent.get('/api/session')).status).toBe(200)
    expect((await agent.post('/api/auth/sign-out').send({})).status).toBe(200)
    expect((await agent.get('/api/session')).status).toBe(401)
  })
})

describe('PRO-01 teaching roster', () => {
  it('PRO-01-V / PRO-01-I lists the professor\'s current spaces and follows an assignment change', async () => {
    const professor = await login('QCU-PROF-IT')
    const listed = async () => ((await professor.get('/api/pages/P07')).body.data.spaces as { id: string }[]).map((s) => s.id)
    const assigned = repo.read().spaces.filter((s) => s.professorIds.includes('QCU-PROF-IT')).map((s) => s.id)
    expect((await listed()).sort()).toEqual(assigned.sort())

    repo.read().spaces.find((s) => s.id === 'SPACE-IT-A')!.professorIds = []
    expect(await listed()).not.toContain('SPACE-IT-A')
  })

  it('PRO-01-B gives an unassigned professor the same answer as a missing space', async () => {
    const professor = await login('QCU-PROF-IT')
    const other = await professor.get('/api/pages/P08?id=SPACE-CS-A')
    const missing = await professor.get('/api/pages/P08?id=SPACE-MISSING')
    expect(other.status).toBe(404)
    expect(other.body).toEqual(missing.body)
  })
})

describe('CHR-01 / DEAN-01 dashboards', () => {
  it('CHR-01-V matches the home stat to the open cases in the queue it links to', async () => {
    const chair = await login('QCU-CHAIR-IT')
    const stat = (await chair.get('/api/pages/P03')).body.data.stats.find((s: { label: string }) => s.label === 'Reports in your queue').value
    const queue = (await chair.get('/api/pages/P21')).body.data.cases as { status: string }[]
    expect(stat).toBe(queue.filter((c) => !['Resolved', 'Closed'].includes(c.status)).length)
  })

  it('CHR-01-B keeps a chair to their own program on the dashboard and in analytics', async () => {
    const chair = await login('QCU-CHAIR-CS')
    const queue = (await chair.get('/api/pages/P21')).body.data.cases as { program?: string; id: string }[]
    const programs = new Set(queue.map((c) => repo.read().reports.find((r) => r.id === c.id)!.program))
    expect([...programs]).toEqual(['BSCS'])
    expect((await chair.get('/api/pages/P25?program=BSIT')).status).toBe(404)
  })

  it('DEAN-01-I shows zeros for a period with no reports, never another period\'s data', async () => {
    const dean = await login('CCS-DEAN')
    const empty = (await dean.get('/api/pages/P25?from=2030-01-01&to=2030-01-31')).body.data
    expect(empty.stats.slice(0, 3).map((s: { value: number }) => s.value)).toEqual([0, 0, 0])
    expect(empty.cases).toEqual([])
  })
})

describe('DEAN-04 college evaluation results', () => {
  it('DEAN-04-V / DEAN-04-I / DEAN-04-B shows the Dean published results only, without individual answers or evaluators', async () => {
    const dean = await login('CCS-DEAN')
    const published = (await dean.get('/api/pages/P28?cycle=CYCLE-2026-1')).body.data
    expect(published.results.some((r: { average: number }) => r.average > 0)).toBe(true)
    expect(JSON.stringify(published)).not.toMatch(/evaluatorId|SAMPLE-EVALUATOR|"answers"/)
    const unpublished = (await dean.get('/api/pages/P28?cycle=CYCLE-2026-2')).body.data
    expect(unpublished.results.every((r: { responses?: number; average: number }) => r.average === 0)).toBe(true)
  })
})

describe('GUD-03 offense and Good Moral support', () => {
  it('GUD-03-V opens a student in scope after a purpose, logs the opening, and shows the offense history', async () => {
    const guidance = await login('QCU-GUIDANCE')
    const before = repo.read().audit.length
    const record = (await guidance.get('/api/pages/P34?id=QCU-STU-RESTRICTED&purpose=Case%20handling')).body.data.record
    expect(record.offenses.map((o: { id: string }) => o.id)).toEqual(['OFF-0101'])
    expect(repo.read().audit.slice(before)).toEqual([expect.objectContaining({ actorId: 'QCU-GUIDANCE', action: 'Record opened', purpose: 'Case handling' })])
  })

  it('GUD-03-I shows no offenses and no Good Moral status for a student who has none', async () => {
    const guidance = await login('QCU-GUIDANCE')
    const record = (await guidance.get('/api/pages/P34?id=QCU-STU-IT-A&purpose=Case%20handling')).body.data.record
    expect(record.offenses).toEqual([])
    expect(record.goodMoral).toBeUndefined()
  })

  it('GUD-03-B does not let Guidance apply a restriction or open a student outside its cases', async () => {
    const guidance = await login('QCU-GUIDANCE')
    const apply = await guidance.post('/api/pages/P35/actions').send({ action: 'applyRestriction', reason: 'Test', payload: { studentId: 'QCU-STU-IT-A', features: ['post.create'], basis: 'Test basis', decisionReference: 'QCU-DEC-T', starts: '2026-11-10', ends: '2026-12-10' } })
    expect(apply.status).toBe(403)
    expect((await guidance.get('/api/pages/P34?id=QCU-STU-CS&purpose=Case%20handling')).status).toBe(404)
  })
})

describe('DEAN-06 / GUD-05 / OSAS-04 communication', () => {
  it('DEAN-06-I / GUD-05-I refuses a post to a space outside the author\'s membership and creates nothing', async () => {
    for (const id of ['CCS-DEAN', 'QCU-GUIDANCE']) {
      const agent = await login(id)
      const before = repo.read().posts.length
      const response = await agent.post('/api/pages/P05/actions').send({ action: 'createPost', payload: { title: 'Outside', body: 'Should not post.', audience: 'space:SPACE-CS-A', kind: 'discussion', label: 'Question' } })
      expect(response.status, id).toBeGreaterThanOrEqual(400)
      expect(repo.read().posts, id).toHaveLength(before)
    }
  })

  it('GUD-05-I / OSAS-04-I refuses a message to someone outside scope and creates nothing', async () => {
    for (const id of ['QCU-GUIDANCE', 'QCU-OSAS']) {
      const agent = await login(id)
      const before = repo.read().threads.length
      const response = await agent.post('/api/pages/P11/actions').send({ action: 'createThread', payload: { recipientId: 'QCU-STU-CS', body: 'Hello' } })
      expect(response.status, id).toBeGreaterThanOrEqual(400)
      expect(repo.read().threads, id).toHaveLength(before)
    }
  })
})
