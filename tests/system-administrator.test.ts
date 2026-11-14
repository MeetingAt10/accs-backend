// Issue #40: the administrator is the System Administrator (baseline chapters 1 and 11): its own account, separate from
// the Dean and not a QCU account, holding all audit logs and system tools. The old sample ID QCU-ADMIN still signs in.
import request from 'supertest'
import { beforeEach, describe, expect, it } from 'vitest'

import { permissionRoles } from '../src/access.js'
import { createApp } from '../src/app.js'
import { createMemoryAuthStore } from '../src/auth.js'
import { roleLabels } from '../src/schemas.js'
import { createMemoryRepository } from '../src/store.js'
import { seedPassword } from './helpers.js'

let repo: ReturnType<typeof createMemoryRepository>
let app: ReturnType<typeof createApp>
beforeEach(() => { repo = createMemoryRepository(); app = createApp(repo, { authStore: createMemoryAuthStore() }) })

async function login(id: string) {
  const agent = request.agent(app)
  const response = await agent.post('/api/auth/sign-in').send({ emailOrId: id, password: seedPassword })
  expect(response.status).toBe(200)
  return { agent, user: response.body.user as { id: string; roles: string[] } }
}

describe('the System Administrator (issue #40)', () => {
  it('is labelled System Administrator wherever the API gives role labels', async () => {
    expect(roleLabels.administrator).toBe('System Administrator')
    const { agent } = await login('ACCS-ADMIN')
    expect((await agent.get('/api/session')).body.roleLabels.administrator).toBe('System Administrator')
  })

  it('is its own system account, not a QCU one, and the old ID still signs in to it', async () => {
    const admin = repo.read().users.find((u) => u.roles.includes('administrator'))!
    expect(admin).toMatchObject({ id: 'ACCS-ADMIN', email: 'admin@access-ccs.com', roles: ['administrator'] })
    expect(repo.read().users.some((u) => u.id === 'QCU-ADMIN')).toBe(false)
    expect((await login('QCU-ADMIN')).user.id).toBe('ACCS-ADMIN')
    expect((await login('admin@access-ccs.com')).user.id).toBe('ACCS-ADMIN')
  })

  it('alone holds the audit logs, monitoring and system tools; the Dean holds none of them', async () => {
    for (const permission of ['audit.view', 'role.manage', 'moderation.review']) expect(permissionRoles[permission], permission).toEqual(['administrator'])
    expect(permissionRoles['restriction.manage']).not.toContain('dean')
    const { agent: dean } = await login('QCU-FAC-PAULA-DELACRUZ')
    const { agent: admin } = await login('ACCS-ADMIN')
    for (const page of ['P45', 'P46', 'P48', 'P51', 'P52']) {
      expect([page, (await dean.get(`/api/pages/${page}`)).status]).toEqual([page, 403])
      expect([page, (await admin.get(`/api/pages/${page}`)).status]).toEqual([page, 200])
    }
    // The Dean and the System Administrator are different accounts.
    expect(repo.read().users.filter((u) => u.roles.includes('dean') && u.roles.includes('administrator'))).toEqual([])
  })
})
