// CCS Staff came back (it was removed in #45) as a limited role for CCS administrative personnel: the feed, the personnel
// directory and their own profile, and nothing else.
import request from 'supertest'
import { beforeEach, describe, expect, it } from 'vitest'

import { permissionRoles, permissions } from '../src/access.js'
import { createApp } from '../src/app.js'
import { createMemoryAuthStore } from '../src/auth.js'
import { roles } from '../src/schemas.js'
import { createMemoryRepository } from '../src/store.js'
import { seedPassword } from './helpers.js'

const staffId = 'QCU-STAFF-KEVIN-GARCIA'
let repo: ReturnType<typeof createMemoryRepository>
let app: ReturnType<typeof createApp>
beforeEach(() => { repo = createMemoryRepository(); app = createApp(repo, { authStore: createMemoryAuthStore() }) })

describe('the limited CCS Staff role', () => {
  it('has exactly the feed, directory and own-profile permissions', () => {
    expect(roles).toContain('staff')
    const user = repo.read().users.find((u) => u.id === staffId)!
    expect(permissions(user).sort()).toEqual(['directory.view', 'feed.read', 'self.manage'])
    expect(Object.entries(permissionRoles).filter(([, who]) => who.includes('staff')).map(([key]) => key).sort()).toEqual(['directory.view', 'feed.read', 'self.manage'])
  })

  it('signs in and opens the home, feed and directory, but not posting, cases, reports, evaluations or provisioning', async () => {
    const agent = request.agent(app)
    expect((await agent.post('/api/auth/sign-in').send({ emailOrId: 'kevin.garcia@access-ccs.com', password: seedPassword })).status).toBe(200)
    const session = (await agent.get('/api/session')).body
    expect(session.user.roles).toEqual(['staff'])
    for (const page of ['P03', 'P04', 'P37']) expect((await agent.get(`/api/pages/${page}`)).status, page).toBe(200)
    for (const page of ['P05', 'P07', 'P11', 'P19', 'P20', 'P21', 'P26', 'P30', 'P45']) expect((await agent.get(`/api/pages/${page}`)).status, page).toBe(403)
    expect((await agent.get('/api/accounts/types')).status).toBe(403)
  })
})
