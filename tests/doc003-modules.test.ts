import { readFileSync } from 'node:fs'
import request from 'supertest'
import { describe, expect, it } from 'vitest'

import { createApp } from '../src/app.js'
import { createMemoryRepository } from '../src/store.js'

// DOC003_MODULE-INVENTORY.xlsm (Module Inventory sheet), with each module's pages taken from the docs/pages Modules rows.
type Module = { id: string; role: string; name: string; pages: string[] }
const { modules } = JSON.parse(readFileSync(new URL('./fixtures/doc003-modules.json', import.meta.url), 'utf8')) as { modules: Module[] }

const accounts: Record<string, string> = { student: 'QCU-STU-IT-A', organization: 'QCU-ORG', professor: 'QCU-PROF-IT', staff: 'QCU-STAFF', chair: 'QCU-CHAIR-IT', dean: 'QCU-DEAN', administrator: 'QCU-ADMIN', guidance: 'QCU-GUIDANCE', osas: 'QCU-OSAS', president: 'QCU-PRESIDENT' }

describe('DOC003 module inventory', () => {
  it('has the 58 modules per role group in the inventory', () => {
    const counts: Record<string, number> = {}
    for (const m of modules) counts[m.id.split('-')[0]] = (counts[m.id.split('-')[0]] ?? 0) + 1
    expect(modules).toHaveLength(58)
    expect(counts).toEqual({ ALL: 5, STU: 12, ORG: 2, PRO: 8, STF: 1, CHR: 7, DEAN: 6, ADM: 6, GUD: 5, OSAS: 4, PRES: 2 })
  })

  for (const module of modules) {
    const roles = module.role === 'all' ? Object.keys(accounts) : [module.role]
    it(`${module.id} ${module.name}: owning role reaches at least one module page`, async () => {
      expect(module.pages.length).toBeGreaterThan(0)
      const app = createApp(createMemoryRepository())
      for (const role of roles) {
        const agent = request.agent(app)
        expect((await agent.post('/api/auth/sign-in').send({ emailOrId: accounts[role], password: 'Accs@Qcu2026!' })).status).toBe(200)
        const { allowedPages } = (await agent.get('/api/session')).body as { allowedPages: string[] }
        const reachable = module.pages.filter((page) => allowedPages.includes(page))
        expect(reachable, `${role} has no page for ${module.id}`).not.toHaveLength(0)
      }
    })
  }
})
