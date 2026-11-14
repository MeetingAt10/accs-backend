// Issue #44 (baseline 6.3): the section space lists the section's subjects with their professors, and each subject's
// professor shares class materials with the section's students. Links for now; file uploads follow with the storage
// bucket. Nobody outside the subject (other students, other offices) opens the materials.
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
type Agent = Awaited<ReturnType<typeof login>>
// SPACE-IT-A is the section SBIT3A; SUBJECT-IT-DS is its Data Structures subject (QCU-PROF-IT and QCU-CHAIR-IT teach it).
const link = { spaceId: 'SUBJECT-IT-DS', title: 'Week 5 slides', url: 'https://drive.google.com/file/d/abc', note: 'Linked lists and stacks.' }
const add = (agent: Agent, extra: object = {}) => agent.post('/api/pages/P08/actions').send({ action: 'addMaterial', payload: { ...link, ...extra } })
const space = async (agent: Agent, id: string) => (await agent.get(`/api/pages/P08?id=${id}`))

describe('the section space', () => {
  it('lists its subjects with their professors', async () => {
    // Subjects of other sections: another letter, another campus, another year, another program.
    await repo.transact((unit) => {
      const base = unit.read().spaces.find((x) => x.id === 'SUBJECT-IT-DS')!
      unit.read().spaces.push(
        { ...structuredClone(base), id: 'SUBJECT-IT-3B', title: 'Data Structures, SBIT3B', section: 'B' },
        { ...structuredClone(base), id: 'SUBJECT-BAT-1A', title: 'Programming, BATIT1A', campus: 'BAT', year: 1 },
        { ...structuredClone(base), id: 'SUBJECT-IT-1A', title: 'Programming, SBIT1A', year: 1 },
        { ...structuredClone(base), id: 'SUBJECT-CS-3A', title: 'Algorithms, SBCS3A', program: 'BSCS' },
        { ...structuredClone(unit.read().spaces.find((x) => x.id === 'SPACE-IT-A')!), id: 'SPACE-BAT-1A', title: 'BATIT1A', campus: 'BAT', year: 1 },
      )
    })
    // BATIT1A gets the Batasan 1st-year subject, not San Bartolome's SBIT1A one.
    expect((await space(await login('QCU-FAC-PAULA-DELACRUZ'), 'SPACE-BAT-1A')).body.data.record.subjects.map((x: { id: string }) => x.id)).toEqual(['SUBJECT-BAT-1A'])
    const record = (await space(await login('QCU-STU-IT-A'), 'SPACE-IT-A')).body.data.record
    expect(record.subjects).toEqual([expect.objectContaining({ id: 'SUBJECT-IT-DS', subject: 'CC 104 Data Structures', professors: [expect.objectContaining({ id: 'QCU-PROF-IT' }), expect.objectContaining({ id: 'QCU-CHAIR-IT' })] })])
    // A subject space lists no subjects of its own.
    expect((await space(await login('QCU-STU-IT-A'), 'SUBJECT-IT-DS')).body.data.record.subjects).toBeUndefined()
  })
})

describe('class materials', () => {
  it('lets the subject\'s professor share a link that the section\'s students open', async () => {
    const professor = await login('QCU-PROF-IT')
    const added = await add(professor)
    expect(added.status, JSON.stringify(added.body)).toBe(200)
    expect(added.body.record).toMatchObject({ kind: 'link', title: 'Week 5 slides', url: link.url, note: link.note, authorId: 'QCU-PROF-IT' })
    const student = await login('QCU-STU-IT-A')
    expect((await space(student, 'SUBJECT-IT-DS')).body.data.record.materials).toEqual([expect.objectContaining({ title: 'Week 5 slides', author: expect.objectContaining({ id: 'QCU-PROF-IT' }) })])
    // The section space shows each subject's materials too.
    expect((await space(student, 'SPACE-IT-A')).body.data.record.subjects[0].materials).toHaveLength(1)
    expect((await space(professor, 'SUBJECT-IT-DS')).body.data.record.canManageMaterials).toBe(true)
    expect((await space(student, 'SUBJECT-IT-DS')).body.data.record.canManageMaterials).toBe(false)
    expect(repo.read().audit.some((a) => a.action === 'Class material added')).toBe(true)
  })

  it('keeps materials from everyone outside the subject', async () => {
    await add(await login('QCU-PROF-IT'))
    // Another section's student and another professor cannot open the subject at all.
    expect((await space(await login('QCU-STU-IT-B'), 'SUBJECT-IT-DS')).status).toBe(404)
    expect((await space(await login('QCU-PROF-OTHER'), 'SUBJECT-IT-DS')).status).toBe(404)
    // The Dean can open the space, but not its materials.
    const fromDean = (await space(await login('QCU-FAC-PAULA-DELACRUZ'), 'SUBJECT-IT-DS')).body.data.record
    expect(fromDean.materials).toBeUndefined()
    expect((await space(await login('QCU-FAC-PAULA-DELACRUZ'), 'SPACE-IT-A')).body.data.record.subjects[0].materials).toBeUndefined()
  })

  it('lets only the subject\'s professors add, change or remove materials', async () => {
    const professor = await login('QCU-PROF-IT')
    const id = (await add(professor)).body.record.id as string
    expect((await add(await login('QCU-STU-IT-A'))).status).toBe(403)
    expect((await add(await login('QCU-FAC-PAULA-DELACRUZ'))).status).toBe(403)
    expect((await add(await login('QCU-PROF-OTHER'))).status).toBe(404)
    // Materials belong to a subject, not to the section space.
    expect((await add(professor, { spaceId: 'SPACE-IT-A' })).status).toBe(404)
    const student = await login('QCU-STU-IT-A')
    expect((await student.post('/api/pages/P08/actions').send({ action: 'removeMaterial', recordId: id, payload: {} })).status).toBe(403)
    // The other professor of the subject (the Program Chair here) may change it.
    const changed = await (await login('QCU-CHAIR-IT')).post('/api/pages/P08/actions').send({ action: 'updateMaterial', recordId: id, payload: { title: 'Week 5 slides (updated)', url: 'https://example.edu/slides.pdf' } })
    expect(changed.status, JSON.stringify(changed.body)).toBe(200)
    expect(changed.body.record).toMatchObject({ title: 'Week 5 slides (updated)', url: 'https://example.edu/slides.pdf' })
    expect(changed.body.record.note).toBeUndefined()
    expect((await professor.post('/api/pages/P08/actions').send({ action: 'removeMaterial', recordId: id, payload: {} })).status).toBe(200)
    expect(repo.read().materials).toEqual([])
    expect(repo.read().audit.filter((a) => a.module === 'academic').map((a) => a.action)).toEqual(['Class material added', 'Class material changed', 'Class material removed'])
  })

  it('accepts only web links and checks the title and note', async () => {
    const professor = await login('QCU-PROF-IT')
    for (const url of ['javascript:alert(1)', 'ftp://files.example.edu/a.pdf', 'not a link', 'data:text/html,hi']) {
      const refused = await add(professor, { url })
      expect([url, refused.status, refused.body.fields?.[0]?.path]).toEqual([url, 400, 'url'])
    }
    expect((await add(professor, { title: '  ' })).status).toBe(400)
    expect((await add(professor, { note: 'x'.repeat(1001) })).status).toBe(400)
    expect((await add(professor, { url: 'http://example.edu/notes' })).status).toBe(200)
  })
})
