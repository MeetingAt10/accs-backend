// Issue #46 (decided 11 November 2026): CCS runs on three campuses. San Bartolome (SB) has 1st to 4th year; Batasan (BAT)
// and San Francisco (SF) have 1st and 2nd year only. A section is named campus + program + year + letter: SBIT1A, BATIT1A,
// SFIT1A, SBCS3B, SFIS2A.
import { beforeEach, describe, expect, it } from 'vitest'

import { createApp } from '../src/app.js'
import { createMemoryAuthStore } from '../src/auth.js'
import { studentRowSchema } from '../src/schemas.js'
import { campusYearProblem, programCode, sectionName } from '../src/sections.js'
import { createMemoryRepository } from '../src/store.js'
import { secretarySession, signIn } from './helpers.js'

let repo: ReturnType<typeof createMemoryRepository>
let app: ReturnType<typeof createApp>
let authStore: ReturnType<typeof createMemoryAuthStore>
beforeEach(() => { repo = createMemoryRepository(); authStore = createMemoryAuthStore(); app = createApp(repo, { authStore }) })
const stored = async (id: string) => (await authStore.load()).users.find((u) => u.id === id)!

const row = (extra: object = {}) => ({ name: 'Ana Cruz', email: 'ana.cruz@gmail.com', studentId: '26-2001', program: 'BSIT', year: 1, section: 'A', ...extra })

describe('section names', () => {
  it('are campus + program + year + letter, for every campus and program', () => {
    expect(['BSIT', 'BSCS', 'BSIS'].map(programCode)).toEqual(['IT', 'CS', 'IS'])
    expect(sectionName({ campus: 'SB', program: 'BSIT', year: 1, section: 'A' })).toBe('SBIT1A')
    expect(sectionName({ campus: 'BAT', program: 'BSIT', year: 1, section: 'A' })).toBe('BATIT1A')
    expect(sectionName({ campus: 'SF', program: 'BSIT', year: 1, section: 'A' })).toBe('SFIT1A')
    expect(sectionName({ campus: 'SB', program: 'BSCS', year: 3, section: 'B' })).toBe('SBCS3B')
    expect(sectionName({ campus: 'SF', program: 'BSIS', year: 2, section: 'A' })).toBe('SFIS2A')
    // A section stored without a campus is at San Bartolome.
    expect(sectionName({ program: 'BSIT', year: 4, section: 'C' })).toBe('SBIT4C')
  })

  it('names the sample section spaces this way and keeps their IDs', () => {
    const titles = Object.fromEntries(repo.read().spaces.filter((s) => s.subject === 'Section group').map((s) => [s.id, s.title]))
    expect(titles).toEqual({ 'SPACE-IT-A': 'SBIT3A', 'SPACE-IT-B': 'SBIT3B', 'SPACE-CS-A': 'SBCS2A' })
    for (const space of repo.read().spaces.filter((s) => s.subject === 'Section group')) expect(space.title).toBe(sectionName({ campus: space.campus, program: space.program, year: space.year!, section: space.section }))
  })

  it('shows a student their campus and section name', async () => {
    const { agent } = await signIn(app, 'QCU-STU-IT-A')
    expect((await agent.get('/api/pages/P39')).body.data.record).toMatchObject({ campus: 'SB', sectionName: 'SBIT3A' })
  })
})

describe('campuses and year levels', () => {
  it('lets San Bartolome have every year, and the satellite campuses 1st and 2nd year only', () => {
    for (const year of [1, 2, 3, 4]) expect(campusYearProblem('SB', year), `SB ${year}`).toBeUndefined()
    for (const campus of ['BAT', 'SF']) {
      for (const year of [1, 2]) expect(campusYearProblem(campus, year), `${campus} ${year}`).toBeUndefined()
      for (const year of [3, 4]) expect(campusYearProblem(campus, year), `${campus} ${year}`).toMatch(/has 1st and 2nd year only\. 3rd and 4th year sections are at San Bartolome\.$/)
    }
    expect(campusYearProblem('QC', 1)).toBe('Choose SB (San Bartolome), BAT (Batasan) or SF (San Francisco).')
  })

  it('checks the campus on student import, and puts a student without one at San Bartolome', () => {
    expect(studentRowSchema.parse(row()).campus).toBe('SB')
    expect(studentRowSchema.parse(row({ campus: 'bat' })).campus).toBe('BAT')
    const third = studentRowSchema.safeParse(row({ campus: 'SF', year: 3 }))
    expect(third.success).toBe(false)
    expect(third.error!.issues.map((i) => [i.path.join('.'), i.message])).toEqual([['campus', 'San Francisco has 1st and 2nd year only. 3rd and 4th year sections are at San Bartolome.']])
    expect(studentRowSchema.safeParse(row({ campus: 'QC' })).error!.issues[0]).toMatchObject({ path: ['campus'] })
    // An invalid year gets its own message only.
    expect(studentRowSchema.safeParse(row({ campus: 'BAT', year: 5 })).error!.issues.map((i) => i.path.join('.'))).toEqual(['year'])
  })
})

describe('importing students into their section', () => {
  it('joins the space of the same campus, program, year and letter, and no other', async () => {
    await repo.transact((unit) => {
      const db = unit.read()
      db.spaces.push(
        { id: 'SPACE-BAT-IT-1A', title: 'BATIT1A', program: 'BSIT', section: 'A', campus: 'BAT', year: 1, subject: 'Section group', professorIds: [], studentIds: [] },
        { id: 'SPACE-SB-IT-1A', title: 'SBIT1A', program: 'BSIT', section: 'A', campus: 'SB', year: 1, subject: 'Section group', professorIds: [], studentIds: [] },
      )
    })
    const secretary = await secretarySession(app)
    const imported = await secretary.post('/api/accounts/students').send({ students: [row({ campus: 'BAT' }), row({ email: 'ben@gmail.com', studentId: '26-2002', name: 'Ben Ramos', year: 3 })] })
    expect(imported.status, JSON.stringify(imported.body)).toBe(200)
    const [bat, sb] = await Promise.all(imported.body.record.results.map((r: { account: { id: string } }) => stored(r.account.id)))
    expect(bat).toMatchObject({ campus: 'BAT', year: 1, section: 'A' })
    expect(bat!.spaceIds).toEqual(['SPACE-BAT-IT-1A'])
    // 3rd year BSIT A at San Bartolome joins SBIT3A, not SBIT1A or BATIT1A.
    expect(sb).toMatchObject({ campus: 'SB', year: 3 })
    expect(sb!.spaceIds).toEqual(expect.arrayContaining(['SPACE-IT-A', 'SUBJECT-IT-DS']))
    expect(sb!.spaceIds).not.toContain('SPACE-SB-IT-1A')
    expect(sb!.spaceIds).not.toContain('SPACE-BAT-IT-1A')
  })

  it('refuses a 3rd year student at a satellite campus and creates nothing for that row', async () => {
    const secretary = await secretarySession(app)
    const imported = await secretary.post('/api/accounts/students').send({ students: [row({ campus: 'BAT', year: 3 })] })
    expect(imported.body.record).toMatchObject({ created: 0, failed: 1 })
    expect(imported.body.record.results[0]).toMatchObject({ status: 'error', fields: [{ path: 'campus', message: 'Batasan has 1st and 2nd year only. 3rd and 4th year sections are at San Bartolome.' }] })
  })
})
