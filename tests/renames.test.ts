// Issue #41: the Dean's account is CCS-DEAN (it was QCU-DEAN). Records stored under the old ID are read under the new one,
// a password, profile or session saved under the old ID carries over, and the old ID still signs in.
import request from 'supertest'
import { describe, expect, it } from 'vitest'

import { createApp } from '../src/app.js'
import { createMemoryAuthStore, hashPassword } from '../src/auth.js'
import { createRecordRepository } from '../src/persist.js'
import { createMemoryRecordStore } from '../src/records.js'
import { currentAccountId, formerAccountIds, renameAccountIds } from '../src/renames.js'
import { createMemorySessionStore, newSessionToken, sessionIdOf } from '../src/sessions.js'
import { createMemoryRepository, seed } from '../src/store.js'
import { seedPassword } from './helpers.js'

const signIn = (app: ReturnType<typeof createApp>, emailOrId: string, password = seedPassword) => request(app).post('/api/auth/sign-in').send({ emailOrId, password })

describe('the renamed Dean account (issue #41)', () => {
  it('is CCS-DEAN in the seed, has dean@access-ccs.com, and no QCU-DEAN remains', () => {
    const users = seed().users
    expect(users.find((u) => u.id === 'CCS-DEAN')).toMatchObject({ name: 'Dr. Sage Linden', roles: ['dean'], email: 'dean@access-ccs.com' })
    expect(JSON.stringify(seed())).not.toContain('QCU-DEAN')
  })

  it('maps the old ID to the new one, and nothing else', () => {
    expect([currentAccountId('QCU-DEAN'), currentAccountId('CCS-DEAN'), currentAccountId('QCU-OSAS')]).toEqual(['CCS-DEAN', 'CCS-DEAN', 'QCU-OSAS'])
    expect(formerAccountIds('CCS-DEAN')).toEqual(['QCU-DEAN'])
    expect(renameAccountIds({ actorId: 'QCU-DEAN', note: 'QCU-DEAN reviewed it', list: ['QCU-DEAN', 'QCU-OSAS'], byUser: { 'QCU-DEAN': 3 } }))
      .toEqual({ actorId: 'CCS-DEAN', note: 'QCU-DEAN reviewed it', list: ['CCS-DEAN', 'QCU-OSAS'], byUser: { 'CCS-DEAN': 3 } })
  })

  it('signs in with CCS-DEAN, the old QCU-DEAN in any case, or the email', async () => {
    const app = createApp(createMemoryRepository(), { authStore: createMemoryAuthStore() })
    for (const id of ['CCS-DEAN', 'QCU-DEAN', 'qcu-dean', 'dean@access-ccs.com']) {
      const response = await signIn(app, id)
      expect([id, response.status, response.body.user?.id]).toEqual([id, 200, 'CCS-DEAN'])
    }
  })

  it('reads records stored under QCU-DEAN as CCS-DEAN, and prefers a record stored under the new ID', async () => {
    const store = createMemoryRecordStore()
    // Records written before the rename: a notification for the Dean, a case step by the Dean, and settings under both IDs.
    await createRecordRepository(store).transact((unit) => {
      const db = unit.read()
      db.notifications.push({ id: 'NOTIF-OLD', recipientId: 'QCU-DEAN', kind: 'case', title: 'Case update', body: 'Open this update to see the details.', priority: 'high', pageId: 'P22', recordId: 'RPT-0243', at: '2026-11-01T00:00:00.000Z', read: false })
      const r = db.reports.find((item) => item.id === 'RPT-0243')!
      r.history.push({ ...r.history.at(-1)!, id: 'H-OLD-DEAN', actorId: 'QCU-DEAN' })
      db.settings['QCU-DEAN'] = { theme: 'dark', density: 'compact', priorities: {} } as never
    })
    await createRecordRepository(store).transact((unit) => { unit.read().settings['CCS-DEAN'] = { theme: 'light', density: 'compact', priorities: {} } as never })

    const read = await createRecordRepository(store).view((unit) => {
      const db = unit.read()
      return {
        notice: db.notifications.find((n) => n.id === 'NOTIF-OLD')!.recipientId,
        actor: db.reports.find((r) => r.id === 'RPT-0243')!.history.find((h) => h.id === 'H-OLD-DEAN')!.actorId,
        settings: Object.keys(db.settings).filter((key) => key.endsWith('DEAN')),
        theme: (db.settings['CCS-DEAN'] as { theme: string }).theme,
      }
    }, ['notifications', 'reports', 'settings'])
    expect(read).toEqual({ notice: 'CCS-DEAN', actor: 'CCS-DEAN', settings: ['CCS-DEAN'], theme: 'light' })

    // The Dean sees the old notification after signing in.
    const app = createApp(createRecordRepository(store), { authStore: createMemoryAuthStore() })
    const agent = request.agent(app)
    expect((await agent.post('/api/auth/sign-in').send({ emailOrId: 'CCS-DEAN', password: seedPassword })).status).toBe(200)
    expect(((await agent.get('/api/pages/P40')).body.data.notifications as { id: string }[]).map((n) => n.id)).toContain('NOTIF-OLD')
  })

  it('keeps a password and profile saved under QCU-DEAN in the account store', async () => {
    const authStore = createMemoryAuthStore()
    const dean = seed().users.find((u) => u.id === 'CCS-DEAN')!
    await authStore.update((data) => {
      data.users.push({ ...dean, id: 'QCU-DEAN', bio: 'Saved before the rename.' })
      data.credentials['QCU-DEAN'] = hashPassword('Dean#Own-Passw0rd')
    })
    const app = createApp(createMemoryRepository(), { authStore })
    expect((await signIn(app, 'CCS-DEAN')).status).toBe(401)
    const own = await signIn(app, 'CCS-DEAN', 'Dean#Own-Passw0rd')
    expect([own.status, own.body.user.id, own.body.user.bio]).toEqual([200, 'CCS-DEAN', 'Saved before the rename.'])
  })

  it('keeps a session started under QCU-DEAN signed in', async () => {
    const sessionStore = createMemorySessionStore()
    const token = newSessionToken()
    const at = new Date().toISOString()
    await sessionStore.create({ sessionId: sessionIdOf(token), userId: 'QCU-DEAN', activeRoleId: 'dean', issuedAt: at, expiresAt: new Date(Date.now() + 3600_000).toISOString(), lastSeenAt: at, remember: false, ipAddress: '', userAgent: '', status: 'active' })
    const app = createApp(createMemoryRepository(), { authStore: createMemoryAuthStore(), sessionStore })
    const session = await request(app).get('/api/session').set('Cookie', `accs_session=${token}`)
    expect([session.status, session.body.user?.id]).toEqual([200, 'CCS-DEAN'])
  })
})
