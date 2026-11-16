// Fixes from the QA report of 15 November 2026 (QA_andrew_11_15), batch C: wording and display.
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
const ask = async (agent: Awaited<ReturnType<typeof login>>, question: string) => (await agent.post('/api/pages/P41/actions').send({ action: 'assistantAsk', payload: { question } })).body.record.reply as string

describe('"Help me write this"', () => {
  it('gives writing guidance, not report status or IDs, though the request says "report"', async () => {
    const student = await login('QCU-STU-IT-A')
    const reply = await ask(student, 'Help me write and organize my report draft.')
    expect(reply).toContain('Say what happened, when, and where')
    expect(reply).not.toMatch(/RPT-/)
  })

  it('answers report status by category and date, and uses an ID only when the question gave one', async () => {
    const student = await login('QCU-STU-IT-A')
    const status = await ask(student, 'What is the status of my report?')
    expect(status).not.toMatch(/RPT-/)
    expect(status).toMatch(/General concern, filed \d{4}-\d{2}-\d{2}: /)
    expect(await ask(student, 'What is the status of report RPT-0241?')).toContain('RPT-0241')
  })

  it('tells a student with no report how to file one', async () => {
    await repo.transact((unit) => { const db = unit.read(); db.reports = db.reports.filter((report) => report.ownerId !== 'QCU-STU-CS') })
    const student = await login('QCU-STU-CS')
    expect(await ask(student, 'Where is my report?')).toBe('You have not filed a report yet. File one from My reports.')
  })
})

describe('case queue categories', () => {
  it('sends every handler the full category list for the filters', async () => {
    const dean = await login('QCU-FAC-PAULA-DELACRUZ')
    const options = (await dean.get('/api/pages/P21')).body.data.categoryOptions as { label: string; subcategories?: string[] }[]
    expect(options.length).toBeGreaterThan(5)
    expect(options.some((option) => option.label === 'Cyberbullying' && option.subcategories?.length)).toBe(true)
  })
})
