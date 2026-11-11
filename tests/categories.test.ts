// Concern categories and sub-categories (decided 11 November 2026): the student picks a category and a sub-category, or
// describes an "Other" concern. The old four categories stay accepted until the filing screen switches to the dropdowns.
import request from 'supertest'
import { beforeEach, describe, expect, it } from 'vitest'

import { createApp } from '../src/app.js'
import { createMemoryAuthStore } from '../src/auth.js'
import { categoryProblem, concernCategories, legacyCategories, otherCategory } from '../src/categories.js'
import { createMemoryRepository } from '../src/store.js'
import { concernChoices, seedPassword } from './helpers.js'

let repo: ReturnType<typeof createMemoryRepository>
let app: ReturnType<typeof createApp>
beforeEach(() => { repo = createMemoryRepository(); app = createApp(repo, { authStore: createMemoryAuthStore() }) })

async function login(id: string) {
  const agent = request.agent(app)
  expect((await agent.post('/api/auth/sign-in').send({ emailOrId: id, password: seedPassword })).status).toBe(200)
  return agent
}
type Agent = Awaited<ReturnType<typeof login>>
const statement = { narrative: 'A classmate keeps calling me names in class.', severity: 'high', identity: 'named' }
const file = (student: Agent, choice: object) => student.post('/api/pages/P19/actions').send({ action: 'createReport', payload: { ...statement, ...concernChoices, ...choice } })

describe('the category list', () => {
  it('has ten categories, each with its sub-categories, and "Other" asks for a description instead', () => {
    expect(concernCategories.map((c) => c.label)).toEqual(['Bullying', 'Cyberbullying', 'Harassment', 'Discrimination', 'Threat or violence', 'Faculty or staff conduct', 'Academic concern', 'Personal or emotional concern', 'Facilities', otherCategory])
    for (const c of concernCategories) {
      if (c.label === otherCategory) expect([c.subcategories, c.requiresDetail]).toEqual([[], true])
      else expect(c.subcategories.length, c.label).toBeGreaterThanOrEqual(5)
      expect(new Set(c.subcategories).size, c.label).toBe(c.subcategories.length)
    }
    expect(concernCategories.filter((c) => c.studentOnStudent).map((c) => c.label)).toEqual(['Bullying', 'Cyberbullying', 'Harassment', 'Discrimination', 'Threat or violence'])
  })

  it('sends the full tree for the dropdowns and keeps the old list for the current screen', async () => {
    const page = (await (await login('QCU-STU-CS')).get('/api/pages/P19')).body.data
    expect(page.categoryOptions).toEqual(JSON.parse(JSON.stringify(concernCategories)))
    expect(page.categories).toEqual(legacyCategories)
  })

  it('checks a choice: category, sub-category, and the description for "Other"', () => {
    expect(categoryProblem({ category: 'Bullying', subcategory: 'Spreading rumours' })).toBeUndefined()
    expect(categoryProblem({ category: 'Bullying' })).toEqual({ path: 'subcategory', message: 'Choose a sub-category.' })
    expect(categoryProblem({ category: 'Bullying', subcategory: 'Grades' })).toEqual({ path: 'subcategory', message: 'Choose a sub-category from the list.' })
    expect(categoryProblem({ category: 'Bullying', subcategory: 'Spreading rumours', categoryDetail: 'x' })?.path).toBe('categoryDetail')
    expect(categoryProblem({ category: otherCategory, categoryDetail: 'Lost ID card' })).toBeUndefined()
    expect(categoryProblem({ category: otherCategory })?.path).toBe('categoryDetail')
    expect(categoryProblem({ category: otherCategory, categoryDetail: '   ' })?.path).toBe('categoryDetail')
    expect(categoryProblem({ category: otherCategory, subcategory: 'Grades', categoryDetail: 'x' })?.path).toBe('subcategory')
    expect(categoryProblem({ category: 'Gossip' })?.path).toBe('category')
    // The old categories, without a sub-category, until the screen switches.
    for (const old of legacyCategories) expect(categoryProblem({ category: old }), old).toBeUndefined()
    expect(categoryProblem({ category: 'Communication', subcategory: 'Grades' })?.path).toBe('category')
    expect(categoryProblem({ category: 'Facilities', subcategory: 'Internet or network' })).toBeUndefined()
    expect(categoryProblem({ category: 'Facilities', subcategory: 'Grades' })?.path).toBe('subcategory')
  })
})

describe('filing with a category and sub-category', () => {
  it('stores the sub-category and shows it to the office handling the concern', async () => {
    const student = await login('QCU-STU-CS')
    const filed = await file(student, { category: 'Bullying', subcategory: 'Name-calling or insults' })
    expect(filed.status).toBe(200)
    const id = filed.body.record.id as string
    expect(repo.read().reports.find((r) => r.id === id)).toMatchObject({ category: 'Bullying', subcategory: 'Name-calling or insults' })
    expect(filed.body.record).toMatchObject({ category: 'Bullying', subcategory: 'Name-calling or insults' })
    const opened = (await (await login('QCU-PROF-CS')).get(`/api/pages/P22?id=${id}`)).body.data.record
    expect(opened).toMatchObject({ category: 'Bullying', subcategory: 'Name-calling or insults' })
  })

  it('stores the description of an "Other" concern', async () => {
    const filed = await file(await login('QCU-STU-CS'), { category: otherCategory, categoryDetail: 'Lost student ID card' })
    expect(filed.status).toBe(200)
    expect(filed.body.record).toMatchObject({ category: otherCategory, categoryDetail: 'Lost student ID card' })
  })

  it('refuses a missing or wrong sub-category with a field error and stores nothing', async () => {
    const student = await login('QCU-STU-CS')
    const before = repo.read().reports.length
    for (const [choice, path] of [
      [{ category: 'Bullying' }, 'subcategory'],
      [{ category: 'Bullying', subcategory: 'Grades' }, 'subcategory'],
      [{ category: otherCategory }, 'categoryDetail'],
      [{ category: 'Gossip' }, 'category'],
    ] as const) {
      const response = await file(student, choice)
      expect([JSON.stringify(choice), response.status, response.body.code, response.body.fields?.[0]?.path]).toEqual([JSON.stringify(choice), 400, 'VALIDATION_ERROR', path])
    }
    expect(repo.read().reports).toHaveLength(before)
  })

  it('still accepts the old categories from the current filing screen', async () => {
    const filed = await file(await login('QCU-STU-CS'), { category: 'General concern' })
    expect(filed.status).toBe(200)
    expect(filed.body.record.subcategory).toBeUndefined()
  })

  it('groups analytics by category', async () => {
    const student = await login('QCU-STU-CS')
    for (const sub of ['Name-calling or insults', 'Spreading rumours']) await file(student, { category: 'Bullying', subcategory: sub })
    const dean = await login('CCS-DEAN')
    const rows = (await dean.get('/api/pages/P25')).body.data.byCategory as { label: string; suppressed: boolean }[]
    expect(rows.find((r) => r.label === 'Bullying')).toMatchObject({ suppressed: true })
  })
})
