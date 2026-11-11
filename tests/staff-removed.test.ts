// Issue #45: the CCS Staff role is out of scope in the baseline and is removed (11 November 2026). Stored accounts keep
// their other roles; an account left with no role is deactivated and cannot sign in.
import request from 'supertest'
import { beforeEach, describe, expect, it } from 'vitest'

import { applyAccounts } from '../src/accounts.js'
import { createApp } from '../src/app.js'
import { createMemoryAuthStore } from '../src/auth.js'
import { permissionRoles } from '../src/access.js'
import { roles, type User } from '../src/schemas.js'
import { createMemoryRepository } from '../src/store.js'
import { seedPassword } from './helpers.js'

let repo: ReturnType<typeof createMemoryRepository>
let app: ReturnType<typeof createApp>
beforeEach(() => { repo = createMemoryRepository(); app = createApp(repo, { authStore: createMemoryAuthStore() }) })

describe('the CCS Staff role is gone (issue #45)', () => {
  it('has no staff role, label, permission or sample account', async () => {
    expect(roles).not.toContain('staff')
    expect(Object.values(permissionRoles).flat()).not.toContain('staff')
    expect(repo.read().users.some((u) => u.id === 'QCU-STAFF')).toBe(false)
    expect(repo.read().events.map((e) => e.contactId)).not.toContain('QCU-STAFF')
    const agent = request.agent(app)
    expect((await agent.post('/api/auth/sign-in').send({ emailOrId: 'CCS-DEAN', password: seedPassword })).status).toBe(200)
    expect(Object.keys((await agent.get('/api/session')).body.roleLabels)).not.toContain('staff')
    expect((await request(app).post('/api/auth/sign-in').send({ emailOrId: 'QCU-STAFF', password: seedPassword })).status).toBe(401)
  })

  it('drops a stored staff role, and deactivates an account left with no role', () => {
    const db = repo.read()
    const base = db.users.find((u) => u.id === 'QCU-OSAS')!
    const staffOnly = { ...structuredClone(base), id: 'OLD-STAFF', email: 'old.staff@example.com', roles: ['staff'], active: true } as unknown as User
    const both = { ...structuredClone(base), id: 'OLD-STAFF-GUIDANCE', email: 'old.both@example.com', roles: ['staff', 'guidance'], active: true } as unknown as User
    applyAccounts(db, [staffOnly, both])
    expect(db.users.find((u) => u.id === 'OLD-STAFF')).toMatchObject({ roles: [], active: false })
    expect(db.users.find((u) => u.id === 'OLD-STAFF-GUIDANCE')).toMatchObject({ roles: ['guidance'], active: true })
  })

  it('refuses to give anyone the staff role', async () => {
    const admin = request.agent(app)
    expect((await admin.post('/api/auth/sign-in').send({ emailOrId: 'QCU-ADMIN', password: seedPassword })).status).toBe(200)
    const refused = await admin.post('/api/pages/P47/actions').send({ action: 'updateRoles', recordId: 'QCU-STU-IT-B', reason: 'Office work', payload: { roles: ['staff'] } })
    expect(refused.status).toBe(400)
  })
})
