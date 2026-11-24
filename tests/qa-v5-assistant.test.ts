// QA v5, D1: help questions get their FAQ answer in any casing or punctuation, for every role the FAQ is meant for.
import request from 'supertest'
import { beforeEach, describe, expect, it } from 'vitest'

import { createApp } from '../src/app.js'
import { createMemoryRepository } from '../src/store.js'
import { seedPassword, setUpAuthStore } from './helpers.js'

let app: ReturnType<typeof createApp>
beforeEach(() => { app = createApp(createMemoryRepository(), { authStore: setUpAuthStore() }) })

const accounts = ['QCU-STU-IT-A', 'QCU-PROF-IT', 'QCU-CHAIR-CS', 'QCU-OSAS', 'ACCS-ADMIN']
async function login(id: string) {
  const agent = request.agent(app)
  expect((await agent.post('/api/auth/sign-in').send({ emailOrId: id, password: seedPassword })).status).toBe(200)
  return agent
}
const ask = async (agent: request.Agent, question: string) => {
  const res = await agent.post('/api/pages/P41/actions').send({ action: 'assistantAsk', payload: { question } })
  expect(res.status).toBe(200)
  return res.body.record.reply as string
}

describe('assistant help questions', () => {
  it('answers every FAQ question and chip, any casing or punctuation, for each allowed role', async () => {
    for (const id of accounts) {
      const agent = await login(id)
      const page = (await agent.get('/api/pages/P41')).body.data as { faq: { question: string; answer: string }[]; suggestions: string[] }
      expect(page.faq.length).toBeGreaterThan(0)
      for (const f of page.faq) {
        const base = f.question.replace(/\?$/, '')
        for (const text of [f.question, base, base.toLowerCase(), f.question.toUpperCase()]) expect(await ask(agent, text), `${id}: ${text}`).toBe(f.answer)
      }
      for (const chip of page.suggestions.filter((s) => /^(what|how|where|why|can)\b/i.test(s))) {
        const reply = await ask(agent, chip)
        expect(reply, `${id}: ${chip}`).not.toContain('I cannot answer that one')
      }
    }
  })

  it('answers the exact QA phrasing without a report status', async () => {
    const student = await login('QCU-STU-IT-A')
    for (const text of ['What does anonymous reporting mean', 'what does anonymous reporting mean?', 'WHAT DOES ANONYMOUS REPORTING MEAN?!']) {
      const reply = await ask(student, text)
      expect(reply).toContain('alias')
      expect(reply).not.toContain('filed')
    }
  })

  it('still answers a status question about the person\'s own report with status', async () => {
    const student = await login('QCU-STU-IT-A')
    for (const text of ['Where is my report?', 'What is the status of my report']) {
      const reply = await ask(student, text)
      expect(reply).not.toContain('alias')
      expect(reply).not.toContain('Open Appointments')
    }
  })

  it('answers personal report questions with report status, not the anonymous-reporting FAQ', async () => {
    const student = await login('QCU-STU-IT-A')
    for (const text of ['What reports have I filed?', 'Is report RPT-0241 resolved?']) {
      const reply = await ask(student, text)
      expect(reply, text).not.toContain('alias')
      expect(reply, text).toMatch(/filed|You have not filed|RPT-/)
    }
  })
})
