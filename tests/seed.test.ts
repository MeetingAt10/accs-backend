// The 58 real CCS personnel seeded as login-only accounts (src/faculty-roster.ts).
import { afterEach, describe, expect, it, vi } from 'vitest'

import { facultyRoster } from '../src/faculty-roster.js'
import { demoUserIds, isSampleAddress, seed } from '../src/store.js'

const base = seed(false)
const withRoster = seed(true)
const rosterIds = new Set(facultyRoster.map((p) => p.id))
const accounts = withRoster.users.filter((u) => rosterIds.has(u.id))

describe('CCS personnel seed', () => {
  it('adds 58 accounts: 50 faculty, 7 staff and the secretary', () => {
    expect(facultyRoster).toHaveLength(58)
    expect(accounts).toHaveLength(58)
    expect(withRoster.users).toHaveLength(base.users.length + 58)
    const count = (role: string) => accounts.filter((u) => u.roles.includes(role as never)).length
    expect([count('professor'), count('staff'), count('secretary')]).toEqual([50, 7, 1])
    expect(accounts.every((u) => u.roles.length === 1)).toBe(true)
    expect(accounts.find((u) => u.roles[0] === 'secretary')).toMatchObject({ id: 'QCU-SECRETARY-MARICRIS-FERNANDEZ', email: 'maricris.fernandez@access-ccs.com', title: 'CCS secretary', office: 'CCS Office' })
    expect(accounts.find((u) => u.id === 'QCU-FAC-PAULA-DELACRUZ')).toMatchObject({ program: 'BSIS', title: 'Faculty (Plantilla), BSIS', office: 'CCS Faculty Room' })
    expect(accounts.find((u) => u.id === 'QCU-FAC-MANUEL-LOSANES')).toMatchObject({ name: 'Manuel L. Los Añes Jr.', email: 'manuel.losanes@access-ccs.com', title: 'Faculty (COS full-time), BSIT' })
    expect(accounts.find((u) => u.id === 'QCU-STAFF-KEVIN-GARCIA')).toMatchObject({ roles: ['staff'], title: 'Administrative personnel', office: 'CCS Office' })
    expect(accounts.find((u) => u.id === 'QCU-FAC-JOHN-GARCIA')?.email).toBe('john.garcia@access-ccs.com')
  })

  it('has unique IDs and emails across every seeded user, all active', () => {
    expect(new Set(withRoster.users.map((u) => u.id)).size).toBe(withRoster.users.length)
    expect(new Set(withRoster.users.map((u) => u.email.toLowerCase())).size).toBe(withRoster.users.length)
    expect(accounts.every((u) => u.active && u.email.endsWith('@access-ccs.com'))).toBe(true)
  })

  it('never emails them, signs them in with the seed password, and gives them no advisees', () => {
    for (const u of accounts) {
      expect(isSampleAddress(u.id, u.email), u.id).toBe(true)
      expect(demoUserIds.has(u.id), u.id).toBe(true)
    }
    expect(withRoster.users.some((u) => u.adviserId && rosterIds.has(u.adviserId))).toBe(false)
    expect(withRoster.spaces.some((s) => s.professorIds.some((id) => rosterIds.has(id)))).toBe(false)
  })

  it('leaves out the roster with includeRoster false (the production stack)', () => {
    expect(base.users.some((u) => rosterIds.has(u.id))).toBe(false)
  })

  it.each([['accs-prod-', false], ['accs-dev-', true], [undefined, true]])('seeds the roster by default for TABLE_PREFIX %s: %s', async (prefix, included) => {
    vi.resetModules()
    if (prefix) vi.stubEnv('TABLE_PREFIX', prefix)
    else vi.stubEnv('TABLE_PREFIX', undefined as never)
    const store = await import('../src/store.js')
    expect(store.seed().users.some((u) => u.id === 'QCU-FAC-PAULA-DELACRUZ')).toBe(included)
    expect(store.demoUserIds.has('QCU-FAC-PAULA-DELACRUZ')).toBe(included)
  })
})
afterEach(() => vi.unstubAllEnvs())
