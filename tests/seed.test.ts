// The 58 real CCS personnel seeded as login-only accounts (src/faculty-roster.ts).
import { afterEach, describe, expect, it, vi } from 'vitest'

import { facultyRoster } from '../src/faculty-roster.js'
import { demoUserIds, forumStudents, isSampleAddress, seed } from '../src/store.js'

const base = seed(false)
const withRoster = seed(true)
const rosterIds = new Set(facultyRoster.map((p) => p.id))
const accounts = withRoster.users.filter((u) => rosterIds.has(u.id))
const realPeople = new Set([...rosterIds, ...forumStudents.map((u) => u.id)])

describe('CCS personnel seed', () => {
  it('adds 58 accounts: 50 faculty, 7 staff and the secretary', () => {
    expect(facultyRoster).toHaveLength(58)
    expect(accounts).toHaveLength(58)
    expect(withRoster.users).toHaveLength(base.users.length + 58)
    const count = (role: string) => accounts.filter((u) => u.roles.includes(role as never)).length
    expect([count('professor'), count('staff'), count('secretary')]).toEqual([50, 7, 1])
    expect(accounts.filter((u) => u.roles.length !== 1).map((u) => u.id)).toEqual(['QCU-FAC-PAULA-DELACRUZ'])
    expect(accounts.find((u) => u.roles[0] === 'secretary')).toMatchObject({ id: 'QCU-SECRETARY-MARICRIS-FERNANDEZ', email: 'maricris.fernandez@access-ccs.com', title: 'CCS secretary', office: 'CCS Office' })
    expect(accounts.find((u) => u.id === 'QCU-FAC-PAULA-DELACRUZ')).toMatchObject({ name: 'Dr. Paula Joy L. Dela Cruz', roles: ['dean', 'professor'], title: 'Dean, College of Computer Studies', office: 'CCS Dean\'s Office' })
    expect(accounts.find((u) => u.id === 'QCU-FAC-MANUEL-LOSANES')).toMatchObject({ name: 'Manuel L. Los Añes Jr.', email: 'manuel.losanes@access-ccs.com', title: 'Faculty (COS full-time), BSIT' })
    expect(accounts.find((u) => u.id === 'QCU-STAFF-KEVIN-GARCIA')).toMatchObject({ roles: ['staff'], title: 'Administrative personnel', office: 'CCS Office' })
    expect(accounts.find((u) => u.id === 'QCU-FAC-JOHN-GARCIA')?.email).toBe('john.garcia@access-ccs.com')
  })

  it('has unique IDs and emails across every seeded user, all active', () => {
    expect(new Set(withRoster.users.map((u) => u.id)).size).toBe(withRoster.users.length)
    expect(new Set(withRoster.users.map((u) => u.email.toLowerCase())).size).toBe(withRoster.users.length)
    expect(accounts.every((u) => u.active && u.email.endsWith('@access-ccs.com'))).toBe(true)
  })

  // Real people: anyone who guessed a name could sign in as them with the shared password (reported 17 November 2026).
  it('never emails them, never signs them in with the seed password, and gives them no advisees', () => {
    for (const u of accounts) {
      expect(isSampleAddress(u.id, u.email), u.id).toBe(true)
      expect(demoUserIds.has(u.id), u.id).toBe(false)
    }
    expect(withRoster.users.some((u) => u.adviserId && rosterIds.has(u.adviserId))).toBe(false)
    // Only John Kenny Reyes's four 4th-year subjects are taught by roster faculty.
    expect(withRoster.spaces.filter((s) => s.professorIds.some((id) => rosterIds.has(id))).map((s) => s.id)).toEqual(['SUBJECT-IT4-AL102', 'SUBJECT-IT4-CAP101', 'SUBJECT-IT4-IAS102', 'SUBJECT-IT4-PRC101'])
  })

  it('has no demo account under its old name and only generic Demo names, besides the Dean and the organizations', () => {
    const old = ['Mira Solis', 'Luca Reed', 'Noa Vale', 'Tess Finch', 'Rina Cole', 'Robin Elm', 'Rowan Quill', 'Sena Brook', 'Morgan Ash', 'Ellis Wren', 'Sage Linden', 'Casey Hart', 'Alex Fern', 'Jamie Alder']
    const named = ['QCU-SECRETARY', 'CCS-DEAN', 'QCU-ORG', 'QCU-ORG-LESIT', 'QCU-ORG-JPCS', 'QCU-ORG-MSC', 'QCU-ORG-AWS']
    for (const db of [base, withRoster]) {
      const demo = db.users.filter((u) => !realPeople.has(u.id))
      expect(demo.filter((u) => old.some((n) => u.name.includes(n)))).toEqual([])
      expect(demo.filter((u) => !named.includes(u.id) && !u.name.startsWith('Demo ')).map((u) => u.id)).toEqual([])
    }
    expect(base.users.find((u) => u.id === 'CCS-DEAN')?.name).toBe('Dr. Paula Joy L. Dela Cruz')
    expect(base.users.find((u) => u.id === 'QCU-ORG-AWS')?.name).toBe('AWS Student Builder Group QCU')
  })

  // Forum posts and comments are never by a "Demo" account: the Dean, roster faculty, real students, offices and organizations.
  it('has no forum content by a Demo account and no Demo name in it, with the roster', () => {
    const names = new Map(withRoster.users.map((u) => [u.id, u.name]))
    const named = (x: { anonymous: boolean, authorId: string }) => (x.anonymous ? [] : [x.authorId])
    const authors = withRoster.posts.flatMap((p) => [...named(p), ...p.comments.flatMap(named)])
    expect(authors.filter((id) => !names.has(id) || names.get(id)!.startsWith('Demo '))).toEqual([])
    expect(JSON.stringify(withRoster.posts)).not.toContain('Demo ')
    expect(withRoster.posts.filter((p) => p.authorId === 'QCU-FAC-PAULA-DELACRUZ').length).toBeGreaterThan(0)
    for (const u of forumStudents) expect([demoUserIds.has(u.id), base.users.some((b) => b.id === u.id)], u.id).toEqual([false, true])
  })

  it('has Dr. Paula as the one active Dean with the roster, and the demo Dean on production', () => {
    const active = (db: typeof base) => db.users.filter((u) => u.active && u.roles.includes('dean')).map((u) => u.id)
    expect(active(withRoster)).toEqual(['QCU-FAC-PAULA-DELACRUZ'])
    expect(withRoster.users.find((u) => u.id === 'CCS-DEAN')).toMatchObject({ active: false, roles: ['dean'] })
    expect(active(base)).toEqual(['CCS-DEAN'])
  })

  it('leaves out the roster with includeRoster false', () => {
    expect(base.users.some((u) => rosterIds.has(u.id))).toBe(false)
  })

  it.each([['accs-prod-', undefined, true], ['accs-dev-', undefined, true], [undefined, undefined, true], ['accs-prod-', 'false', false]])('seeds the roster by default for TABLE_PREFIX %s, SEED_ROSTER %s: %s', async (prefix, seedRoster, included) => {
    vi.resetModules()
    vi.stubEnv('TABLE_PREFIX', prefix as never)
    vi.stubEnv('SEED_ROSTER', seedRoster as never)
    const store = await import('../src/store.js')
    expect(store.seed().users.some((u) => u.id === 'QCU-FAC-PAULA-DELACRUZ')).toBe(included)
    // Seeded or not, the real Dean never signs in with the shared seed password.
    expect(store.demoUserIds.has('QCU-FAC-PAULA-DELACRUZ')).toBe(false)
  })
})
afterEach(() => vi.unstubAllEnvs())
