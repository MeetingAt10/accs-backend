import request from 'supertest'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { canActCase, canCountCase } from '../src/access.js'
import { createApp } from '../src/app.js'
import { createMemoryAuthStore } from '../src/auth.js'
import { consentWording } from '../src/consent.js'
import { createRecordRepository } from '../src/persist.js'
import { createMemoryRecordStore, type RecordStore } from '../src/records.js'
import { createMemorySessionStore } from '../src/sessions.js'
import { createMemoryRepository, seed, type MemoryRepository, type Report, type Repository } from '../src/store.js'
import { concernChoices, secretarySession, signIn } from './helpers.js'

type Agent = ReturnType<typeof request.agent>
type Body = Record<string, any>

const statement = { narrative: 'The lab timetable changed without notice.', category: 'General concern', severity: 'low', identity: 'named' }
const act = (agent: Agent, pageId: string, action: string, payload: object = {}, recordId?: string, reason?: string) => agent.post(`/api/pages/${pageId}/actions`).send({ action, payload, recordId, reason })
const file = (agent: Agent, extra: object = {}) => act(agent, 'P19', 'createReport', { ...statement, ...concernChoices, ...extra })
const choose = (agent: Agent, reportId: string, mode: string, extra: object = {}, consent: object = {}) => act(agent, 'P20', 'chooseTalkMode', { reportId, mode, consent: { participate: true, ...consent }, ...extra })
const setDetails = (agent: Agent, reportId: string, details: object) => act(agent, 'P22', 'setTalkDetails', { reportId, ...details })
const write = (agent: Agent, page: 'P20' | 'P22', id: string, body: string) => act(agent, page, 'sendReportMessage', { body }, id)
const escalate = (agent: Agent, id: string) => act(agent, 'P22', 'caseAction', { type: 'escalate', update: 'Please look at this.' }, id, 'The next office should decide')
const listed = async (agent: Agent) => ((await agent.get('/api/pages/P21')).body.data.cases as { id: string }[]).map((entry) => entry.id)
const open = async (agent: Agent) => ((await agent.get('/api/pages/P25')).body.data.stats as { label: string; value: number }[]).find((stat) => stat.label === 'Open')!.value
const messagesOf = (record: Body) => (record.messages as { body: string }[]).map((message) => message.body)

describe('the concern flow', () => {
  let repo: MemoryRepository
  let app: ReturnType<typeof createApp>
  beforeEach(() => {
    repo = createMemoryRepository()
    app = createApp(repo, { authStore: createMemoryAuthStore() })
  })
  const login = async (id: string) => {
    const { agent, response } = await signIn(app, id)
    expect(response.status).toBe(200)
    return agent
  }
  const stored = (id: string) => repo.read().reports.find((report) => report.id === id)!
  const snapshot = () => JSON.stringify([repo.read().reports, repo.read().notifications, repo.read().audit, repo.read().consultations, repo.read().slots])

  describe('filing', () => {
    it('needs the agreement and all three choices, and stores and sends nothing without them', async () => {
      const student = await login('QCU-STU-CS')
      const before = snapshot()
      for (const missing of [{ consent: undefined }, { consent: {} }, { consent: { readStatement: false } }, { consent: { readStatement: 'yes' } }, { allowChair: undefined }, { allowDean: undefined }, { aboutAdvisor: undefined }, { aboutAdvisor: 'no' }]) {
        const response = await file(student, missing)
        expect([JSON.stringify(missing), response.status, response.body.code]).toEqual([JSON.stringify(missing), 400, 'VALIDATION_ERROR'])
      }
      expect(snapshot()).toBe(before)
      const refused = await file(student, { consent: { readStatement: false } })
      expect(refused.body.fields).toEqual([{ path: 'consent.readStatement', message: 'Read and agree to the statement to send your concern.' }])
    })

    it('stamps the agreement with the time, the student, and the wording they were shown, and audits it without the statement', async () => {
      const student = await login('QCU-STU-CS')
      const filed = await file(student, { allowChair: true })
      expect(filed.status).toBe(200)
      const report = stored(filed.body.record.id)
      expect(report.consent).toEqual({ readStatement: true, at: report.createdAt, userId: 'QCU-STU-CS', version: consentWording.version, wording: consentWording.report })
      expect(report).toMatchObject({ allowChair: true, allowDean: false, aboutAdvisor: false, stage: 'adviser', adviserId: 'QCU-PROF-CS' })
      // The owner reads back the summary and the choices, but not the account behind the agreement.
      expect(filed.body.record).toMatchObject({ allowChair: true, allowDean: false, aboutAdvisor: false, consent: { readStatement: true, at: report.createdAt, version: consentWording.version, wording: consentWording.report } })
      expect(filed.body.record.consent).not.toHaveProperty('userId')
      // The page that opens the form carries the same wording, so what is shown is what is stored.
      expect((await student.get('/api/pages/P19')).body.data.consentWording).toEqual(consentWording)
      expect((await student.get(`/api/pages/P20?id=${report.id}`)).body.data.consentWording).toEqual(consentWording)

      const entries = repo.read().audit.filter((entry) => entry.reference === report.id)
      expect(entries.map((entry) => [entry.actorId, entry.action, entry.module])).toEqual([['QCU-STU-CS', 'Report submitted', 'reports'], ['QCU-STU-CS', 'Report consent recorded', 'reports']])
      const trail = JSON.stringify(repo.read().audit)
      for (const secret of [statement.narrative, consentWording.report, consentWording.report.slice(0, 40)]) expect(trail).not.toContain(secret)
    })

    it('hides who agreed and who wrote from the people who read the audit trail', async () => {
      const student = await login('QCU-STU-CS')
      const id = (await file(student, { identity: 'anonymous' })).body.record.id as string
      await choose(student, id, 'chat')
      await write(student, 'P20', id, 'A first message')
      await write(await login('QCU-PROF-CS'), 'P22', id, 'A reply')
      const trail = (await (await login('QCU-ADMIN')).get('/api/pages/P51')).body.data.audit as Body[]
      const mine = trail.filter((entry) => entry.reference === id)
      expect(mine.map((entry) => entry.action)).toEqual(['Report submitted', 'Report consent recorded', 'Talk consent recorded', 'Reporter message sent', 'Handler message sent'])
      // The reporter stays unnamed; the office that answered is named.
      for (const entry of mine.slice(0, 4)) expect(entry).toMatchObject({ actor: { name: 'Verified student' } })
      expect(mine[4]).toMatchObject({ actor: { name: 'Prof. Sena Brook' } })
      expect(JSON.stringify(mine)).not.toContain('QCU-STU-CS')
    })

    it('shows the office what the student allowed, never the account behind the agreement', async () => {
      const id = (await file(await login('QCU-STU-CS'), { allowDean: true })).body.record.id
      const opened = (await (await login('QCU-PROF-CS')).get(`/api/pages/P22?id=${id}`)).body.data.record
      expect(opened).toMatchObject({ allowChair: false, allowDean: true, aboutAdvisor: false, narrative: statement.narrative, reporter: { name: 'Noa Vale' }, consent: { version: consentWording.version } })
      expect(opened.consent).not.toHaveProperty('userId')
      expect(opened).not.toHaveProperty('talk')
    })

    it('needs an adviser unless the concern is about the adviser', async () => {
      delete repo.read().users.find((user) => user.id === 'QCU-STU-CS')!.adviserId
      const student = await login('QCU-STU-CS')
      const before = snapshot()
      const refused = await file(student)
      expect([refused.status, refused.body.code]).toEqual([409, 'CONFLICT'])
      expect(refused.body.error).toMatch(/adviser/)
      expect(snapshot()).toBe(before)
      const sent = await file(student, { aboutAdvisor: true })
      expect(sent.status).toBe(200)
      expect(stored(sent.body.record.id)).toMatchObject({ stage: 'chair', aboutAdvisor: true })
      expect(stored(sent.body.record.id).adviserId).toBeUndefined()
      expect((await (await login('QCU-CHAIR-CS')).get(`/api/pages/P22?id=${sent.body.record.id}`)).status).toBe(200)
    })
  })

  describe('a concern about the adviser', () => {
    it('goes to the Program Chair and never reaches the adviser in a list, a page, a count, or a notification', async () => {
      const [student, adviser, chair, dean] = await Promise.all(['QCU-STU-CS', 'QCU-PROF-CS', 'QCU-CHAIR-CS', 'QCU-DEAN'].map(login))
      const queueBefore = (await adviser.get('/api/pages/P03')).body.data.stats
      const [chairBefore, deanBefore] = [await open(chair!), await open(dean!)]

      const filed = await file(student!, { aboutAdvisor: true })
      expect(filed.status).toBe(200)
      const id = filed.body.record.id as string
      expect(filed.body.record).toMatchObject({ stage: 'chair', office: 'Program Chair', aboutAdvisor: true, allowChair: false, allowDean: false })

      // The adviser: no list entry, no detail, no action, no notification, no count, no help from the assistant.
      expect(await listed(adviser!)).not.toContain(id)
      expect((await adviser!.get(`/api/pages/P22?id=${id}`)).status).toBe(404)
      for (const [action, payload] of [['sendReportMessage', { body: 'Hello' }], ['addNote', { body: 'A note' }], ['setTalkDetails', { reportId: id, place: 'Room 1' }], ['caseAction', { type: 'resolve', update: 'Done' }]] as const) {
        const response = await act(adviser!, 'P22', action, payload, id, 'A reason')
        expect([action, response.status]).toEqual([action, 404])
      }
      expect(repo.read().notifications.filter((notice) => notice.recipientId === 'QCU-PROF-CS' && notice.recordId === id)).toEqual([])
      expect(((await adviser!.get('/api/pages/P40')).body.data.notifications as Body[]).some((notice) => notice.recordId === id)).toBe(false)
      expect((await adviser!.get('/api/pages/P03')).body.data.stats).toEqual(queueBefore)
      const asked = await act(adviser!, 'P41', 'assistantAsk', { question: `What is the status of ${id}?` })
      expect(asked.body.record.reply).toContain('cannot answer that one')
      expect(JSON.stringify(asked.body)).not.toContain(id)

      // The Program Chair receives it, is notified, and counts it. The Dean was not allowed to read it.
      expect(await listed(chair!)).toContain(id)
      const opened = (await chair!.get(`/api/pages/P22?id=${id}`)).body.data.record
      expect(opened).toMatchObject({ aboutAdvisor: true, narrative: statement.narrative })
      expect(repo.read().notifications.some((notice) => notice.recipientId === 'QCU-CHAIR-CS' && notice.recordId === id && notice.pageId === 'P22')).toBe(true)
      expect([await open(chair!) - chairBefore, await open(dean!) - deanBefore]).toEqual([1, 0])
      expect(await listed(dean!)).not.toContain(id)
      expect((await dean!.get(`/api/pages/P22?id=${id}`)).status).toBe(404)
    })

    it('keeps the adviser out when the concern names the adviser or the student says so with the older flag', async () => {
      const student = await login('QCU-STU-CS')
      const adviser = await login('QCU-PROF-CS')
      for (const extra of [{ narrative: 'Prof. Sena Brook did not tell us about the change.' }, { conflictedAdviser: true }, { involvedUserIds: ['QCU-PROF-CS'] }]) {
        const filed = await file(student, extra)
        expect([JSON.stringify(extra), filed.status, filed.body.record.stage, filed.body.record.aboutAdvisor]).toEqual([JSON.stringify(extra), 200, 'chair', true])
        expect([JSON.stringify(extra), (await adviser.get(`/api/pages/P22?id=${filed.body.record.id}`)).status]).toEqual([JSON.stringify(extra), 404])
        expect(await listed(adviser)).not.toContain(filed.body.record.id)
        expect(repo.read().notifications.some((notice) => notice.recipientId === 'QCU-PROF-CS' && notice.recordId === filed.body.record.id)).toBe(false)
      }
      // The Program Chair can read each one although the student allowed nothing, because it goes around the adviser.
      expect((await listed(await login('QCU-CHAIR-CS'))).length).toBe(1 + 3)
    })

    it('keeps the adviser out of later steps too', async () => {
      const [student, adviser, chair, dean, guidance] = await Promise.all(['QCU-STU-CS', 'QCU-PROF-CS', 'QCU-CHAIR-CS', 'QCU-DEAN', 'QCU-GUIDANCE'].map(login))
      const id = (await file(student!, { aboutAdvisor: true, allowDean: true })).body.record.id as string
      const transfer = (agent: Agent) => act(agent, 'P22', 'caseAction', { type: 'transfer', update: 'Please take this.' }, id, 'The next office should decide')
      // Up to the Dean, who the student allowed, and on to Guidance when the case legitimately gets there.
      expect((await escalate(chair!, id)).status).toBe(200)
      expect((await dean!.get(`/api/pages/P22?id=${id}`)).status).toBe(200)
      expect((await transfer(dean!)).status).toBe(200)
      expect((await guidance!.get(`/api/pages/P22?id=${id}`)).status).toBe(200)
      expect((await choose(student!, id, 'chat')).status).toBe(200)
      expect((await write(student!, 'P20', id, 'Hello')).status).toBe(200)
      // The adviser never had it: no page, no list entry, no notice, whichever office held it.
      expect((await adviser!.get(`/api/pages/P22?id=${id}`)).status).toBe(404)
      expect(await listed(adviser!)).not.toContain(id)
      expect(repo.read().notifications.filter((notice) => notice.recipientId === 'QCU-PROF-CS' && notice.recordId === id)).toEqual([])
    })

    it('is refused with a clear message, storing and sending nothing, when no Program Chair can receive it', async () => {
      repo.read().users.find((user) => user.id === 'QCU-CHAIR-CS')!.active = false
      const student = await login('QCU-STU-CS')
      const before = snapshot()
      const refused = await file(student, { aboutAdvisor: true })
      expect([refused.status, refused.body.code]).toEqual([409, 'CONFLICT'])
      expect(refused.body.error).toContain('Program Chair')
      expect(snapshot()).toBe(before)
    })

    it('does not count an adviser who is also the only chair of the program as someone who can receive it', async () => {
      repo.read().users.find((user) => user.id === 'QCU-STU-IT-A')!.adviserId = 'QCU-CHAIR-IT'
      const before = snapshot()
      const refused = await file(await login('QCU-STU-IT-A'), { aboutAdvisor: true })
      expect([refused.status, refused.body.code]).toEqual([409, 'CONFLICT'])
      expect(snapshot()).toBe(before)
    })

    it('leaves a concern about the viewer out of the similar-report views and the counts', async () => {
      const chair = await login('QCU-CHAIR-IT')
      const about: Report = { ...structuredClone(repo.read().reports.find((report) => report.id === 'RPT-0242')!), id: 'RPT-ABOUT-CHAIR', adviserId: 'QCU-CHAIR-IT', involvedUserIds: ['QCU-CHAIR-IT'] }
      const group = async () => {
        const page = (await chair.get('/api/pages/P23')).body.data.clusters[0]
        const reports = ((await chair.get('/api/pages/P24?id=CLUSTER-0101')).body.data.reports as { id: string }[]).map((entry) => entry.id)
        return { count: page.reportCount, reports, open: await open(chair) }
      }
      const before = await group()
      repo.read().reports.push(about)
      repo.read().clusters[0]!.reportIds.push(about.id)
      expect(await group()).toEqual(before)
      expect(before.reports).not.toContain(about.id)
      expect(before.count).toBe(before.reports.length)
    })
  })

  describe('who may read a concern', () => {
    const users = new Map(seed().users.map((user) => [user.id, user]))
    const adviser = users.get('QCU-PROF-CS')!
    const chair = users.get('QCU-CHAIR-CS')!
    const otherChair = users.get('QCU-CHAIR-IT')!
    const dean = users.get('QCU-DEAN')!
    const owner = users.get('QCU-STU-CS')!
    const concern = (stage: Report['stage'], allowChair: boolean, allowDean: boolean, aboutAdvisor: boolean): Report => ({ ...structuredClone(seed().reports.find((report) => report.id === 'RPT-0248')!), stage, allowChair, allowDean, aboutAdvisor, bypassed: false, involvedUserIds: [] })

    const cases = (['adviser', 'chair', 'dean'] as const).flatMap((stage) => [false, true].flatMap((allowChair) => [false, true].flatMap((allowDean) => [false, true].map((aboutAdvisor) => ({ stage, allowChair, allowDean, aboutAdvisor })))))
    it.each(cases)('stage $stage, chair allowed $allowChair, Dean allowed $allowDean, about the adviser $aboutAdvisor', ({ stage, allowChair, allowDean, aboutAdvisor }) => {
      const report = concern(stage, allowChair, allowDean, aboutAdvisor)
      // The adviser reads it at the first stage, unless it is about them.
      expect(canActCase(adviser, report)).toBe(stage === 'adviser' && !aboutAdvisor)
      // The Program Chair of the program reads it at the chair stage if the student allowed it, or if it came to the chair around the adviser.
      expect(canActCase(chair, report)).toBe(stage === 'chair' && (allowChair || aboutAdvisor))
      expect(canActCase(otherChair, report)).toBe(false)
      // The Dean only if the student allowed it.
      expect(canActCase(dean, report)).toBe(stage === 'dean' && allowDean)
      expect(canActCase(owner, report)).toBe(false)
      // Counts across every stage follow the same choices.
      expect([canCountCase(adviser, report), canCountCase(chair, report), canCountCase(otherChair, report), canCountCase(dean, report), canCountCase(owner, report)]).toEqual([false, allowChair || aboutAdvisor, false, allowDean, false])
    })

    it('treats a report stored before these choices existed as not shared', () => {
      const old = concern('chair', false, false, false) as Partial<Report>
      delete old.allowChair
      delete old.allowDean
      delete old.aboutAdvisor
      expect([canActCase(chair, old as Report), canActCase(dean, { ...old, stage: 'dean' } as Report), canCountCase(chair, old as Report), canCountCase(dean, old as Report)]).toEqual([false, false, false, false])
    })

    it.each([
      { allowChair: false, allowDean: false },
      { allowChair: true, allowDean: false },
      { allowChair: true, allowDean: true },
      { allowChair: false, allowDean: true },
    ])('follows the student when the concern moves up: chair $allowChair, Dean $allowDean', async (choices) => {
      const [student, adviser, chair, dean] = await Promise.all(['QCU-STU-CS', 'QCU-PROF-CS', 'QCU-CHAIR-CS', 'QCU-DEAN'].map(login))
      const [chairBefore, deanBefore] = [await open(chair!), await open(dean!)]
      const id = (await file(student!, choices)).body.record.id as string
      expect([await open(chair!) - chairBefore, await open(dean!) - deanBefore]).toEqual([choices.allowChair ? 1 : 0, choices.allowDean ? 1 : 0])
      expect(await listed(adviser!)).toContain(id)

      const toChair = await escalate(adviser!, id)
      if (!choices.allowChair) {
        expect([toChair.status, toChair.body.code]).toEqual([409, 'CONFLICT'])
        expect(toChair.body.error).toBe('The student has not allowed the Program Chair to read this concern, so it cannot be sent there.')
        expect(stored(id).stage).toBe('adviser')
        expect((await chair!.get(`/api/pages/P22?id=${id}`)).status).toBe(404)
        expect(await listed(chair!)).not.toContain(id)
        return
      }
      expect(toChair.status).toBe(200)
      expect((await chair!.get(`/api/pages/P22?id=${id}`)).status).toBe(200)
      expect(repo.read().notifications.some((notice) => notice.recipientId === 'QCU-CHAIR-CS' && notice.recordId === id)).toBe(true)

      const toDean = await escalate(chair!, id)
      if (!choices.allowDean) {
        expect([toDean.status, toDean.body.code]).toEqual([409, 'CONFLICT'])
        expect(toDean.body.error).toBe('The student has not allowed the Dean to read this concern, so it cannot be sent there.')
        expect(stored(id).stage).toBe('chair')
        expect((await dean!.get(`/api/pages/P22?id=${id}`)).status).toBe(404)
        expect(await listed(dean!)).not.toContain(id)
        return
      }
      expect(toDean.status).toBe(200)
      expect((await dean!.get(`/api/pages/P22?id=${id}`)).status).toBe(200)
      expect(await listed(dean!)).toContain(id)
    })
  })

  describe('how to talk', () => {
    it('appends a consent record for each choice, keeps the earlier ones, and tells the office', async () => {
      const student = await login('QCU-STU-CS')
      const id = (await file(student)).body.record.id as string
      const noticesBefore = () => repo.read().notifications.filter((notice) => notice.recipientId === 'QCU-PROF-CS' && notice.recordId === id).length
      expect(noticesBefore()).toBe(1)

      const chat = await choose(student, id, 'chat', { preferredAt: '2026-11-06T10:00' })
      expect(chat.status).toBe(200)
      expect(chat.body.record.talk).toMatchObject({ mode: 'chat', preferredAt: '2026-11-06T10:00' })
      expect(chat.body.record.talk.consents).toEqual([{ mode: 'chat', participate: true, wording: consentWording.talk.chat, at: expect.any(String) }])
      expect(chat.body.record.talk.consents[0]).not.toHaveProperty('recordCall')

      const video = await choose(student, id, 'video', {}, { recordCall: true })
      const voice = await choose(student, id, 'voice')
      const inPerson = await choose(student, id, 'face_to_face')
      expect([video.status, voice.status, inPerson.status]).toEqual([200, 200, 200])
      const talk = (await student.get(`/api/pages/P20?id=${id}`)).body.data.record.talk
      expect(talk.mode).toBe('face_to_face')
      expect(talk.consents.map((consent: Body) => [consent.mode, consent.participate, consent.recordCall])).toEqual([['chat', true, undefined], ['video', true, true], ['voice', true, false], ['face_to_face', true, undefined]])
      expect(talk.consents.map((consent: Body) => consent.wording)).toEqual([
        consentWording.talk.chat,
        `${consentWording.talk.video} ${consentWording.recording.allow}`,
        `${consentWording.talk.voice} ${consentWording.recording.deny}`,
        consentWording.talk.face_to_face,
      ])
      expect(stored(id).talk).toEqual(talk)
      // The office was told each time, and each consent is audited without its wording.
      expect(noticesBefore()).toBe(1 + 4)
      expect(repo.read().notifications.filter((notice) => notice.recipientId === 'QCU-PROF-CS' && notice.recordId === id).every((notice) => notice.kind === 'report' && notice.pageId === 'P22' && notice.body === 'Open this update to see the details.')).toBe(true)
      expect(repo.read().audit.filter((entry) => entry.reference === id && entry.action === 'Talk consent recorded')).toHaveLength(4)
      expect(JSON.stringify(repo.read().audit)).not.toContain(consentWording.talk.video)
      // The office sees how the student chose to talk in its list.
      const row = ((await (await login('QCU-PROF-CS')).get('/api/pages/P21')).body.data.cases as Body[]).find((entry) => entry.id === id)!
      expect(row).toMatchObject({ category: 'General concern', createdAt: stored(id).createdAt, reporter: { name: 'Noa Vale' }, talk: { mode: 'face_to_face' } })
    })

    it('refuses a choice without agreement, a recording choice for a way that has no recording, and a report that is not theirs', async () => {
      const student = await login('QCU-STU-CS')
      const id = (await file(student)).body.record.id as string
      const before = JSON.stringify(stored(id))
      const bad = [
        act(student, 'P20', 'chooseTalkMode', { reportId: id, mode: 'chat' }),
        act(student, 'P20', 'chooseTalkMode', { reportId: id, mode: 'chat', consent: { participate: false } }),
        act(student, 'P20', 'chooseTalkMode', { reportId: id, mode: 'chat', consent: {} }),
        act(student, 'P20', 'chooseTalkMode', { reportId: id, mode: 'telepathy', consent: { participate: true } }),
        act(student, 'P20', 'chooseTalkMode', { mode: 'chat', consent: { participate: true } }),
        choose(student, id, 'chat', {}, { recordCall: true }),
        choose(student, id, 'face_to_face', {}, { recordCall: true }),
        choose(student, id, 'video', { preferredAt: 'tomorrow' }),
      ]
      expect((await Promise.all(bad)).map((response) => [response.status, response.body.code])).toEqual(Array(8).fill([400, 'VALIDATION_ERROR']))
      expect(JSON.stringify(stored(id))).toBe(before)
      // Another student, the office, and a report that does not exist.
      expect((await choose(await login('QCU-STU-IT-A'), id, 'chat')).status).toBe(404)
      expect((await choose(student, 'RPT-NOPE', 'chat')).status).toBe(404)
      expect((await choose(await login('QCU-PROF-CS'), id, 'chat')).status).toBe(403)
      expect((await act(student, 'P22', 'chooseTalkMode', { reportId: id, mode: 'chat', consent: { participate: true } })).status).toBe(403)
      // A closed concern stays as it is.
      stored(id).status = 'Closed'
      const closed = await choose(student, id, 'chat')
      expect([closed.status, closed.body.error]).toEqual([409, 'This concern is closed.'])
    })

    it('books one of the office times through the consultation rules, linked to the concern', async () => {
      const student = await login('QCU-STU-IT-A')
      const adviser = await login('QCU-PROF-IT')
      const id = (await file(student)).body.record.id as string

      const chosen = await choose(student, id, 'face_to_face', { slotId: 'SLOT-0101', preferredAt: '2026-10-29T10:00:00Z' })
      expect(chosen.status).toBe(200)
      const consultation = repo.read().consultations.find((entry) => entry.reportId === id)!
      expect(consultation).toMatchObject({ studentId: 'QCU-STU-IT-A', facultyId: 'QCU-PROF-IT', slotId: 'SLOT-0101', status: 'Requested', purpose: 'Talk about a concern' })
      expect(repo.read().slots.find((slot) => slot.id === 'SLOT-0101')!.state).toBe('requested')
      expect(chosen.body.record.talk).toMatchObject({ mode: 'face_to_face', slotId: 'SLOT-0101', consultationId: consultation.id, preferredAt: '2026-10-29T10:00:00Z' })
      // The office finds the request among its consultations, and the student sees it too.
      expect((await adviser.get(`/api/pages/P16?id=${consultation.id}`)).body.data.record).toMatchObject({ reportId: id, status: 'Requested', slot: { id: 'SLOT-0101' } })
      expect((await student.get(`/api/pages/P16?id=${consultation.id}`)).body.data.record.reportId).toBe(id)
      expect(repo.read().notifications.some((notice) => notice.recipientId === 'QCU-PROF-IT' && notice.kind === 'consultation' && notice.recordId === consultation.id)).toBe(true)

      // The same rule as any request: one student per time.
      const other = await login('QCU-STU-RESTRICTED')
      const otherId = (await file(other)).body.record.id as string
      const taken = await choose(other, otherId, 'video', { slotId: 'SLOT-0101' })
      expect([taken.status, taken.body.error]).toEqual([409, 'That time was just taken. Pick another time.'])
      // A time that belongs to someone who does not handle the concern is not theirs to book.
      expect((await choose(other, otherId, 'video', { slotId: 'SLOT-0104' })).status).toBe(404)
      expect((await choose(other, otherId, 'video', { slotId: 'SLOT-NOPE' })).status).toBe(404)
      expect(repo.read().consultations.filter((entry) => entry.reportId === otherId)).toEqual([])

      // One live request for a concern at a time. When the office declines it, the time is free and another can be chosen.
      const second = await act(adviser, 'P17', 'saveAvailability', { date: '2026-11-03', start: '09:00', end: '09:30', state: 'open' })
      expect((await choose(student, id, 'voice', { slotId: second.body.record.id })).status).toBe(409)
      expect((await act(adviser, 'P16', 'decideConsultation', { decision: 'Declined', note: 'Not that day' }, consultation.id)).status).toBe(200)
      expect((await choose(student, id, 'voice', { slotId: second.body.record.id })).status).toBe(200)
      expect(repo.read().consultations.filter((entry) => entry.reportId === id).map((entry) => [entry.slotId, entry.status])).toEqual([['SLOT-0101', 'Declined'], [second.body.record.id, 'Requested']])
    })

    it('asks an anonymous student to share their name with the office before a time is booked', async () => {
      const student = await login('QCU-STU-IT-A')
      const id = (await file(student, { identity: 'anonymous' })).body.record.id as string
      const refused = await choose(student, id, 'video', { slotId: 'SLOT-0101' })
      expect([refused.status, refused.body.error]).toEqual([409, 'To book a time, share your name with the office first.'])
      expect(repo.read().consultations.filter((entry) => entry.reportId === id)).toEqual([])
      expect(repo.read().slots.find((slot) => slot.id === 'SLOT-0101')!.state).toBe('open')
      // A video call without a booked time keeps the alias.
      expect((await choose(student, id, 'video')).status).toBe(200)
      expect((await act(student, 'P20', 'discloseIdentity', { office: 'adviser' }, id)).status).toBe(200)
      expect((await choose(student, id, 'video', { slotId: 'SLOT-0101' })).status).toBe(200)
    })

    it('clears the time, link, and place the office set when the student chooses another way, and keeps them when the way stays', async () => {
      const student = await login('QCU-STU-CS')
      const adviser = await login('QCU-PROF-CS')
      const id = (await file(student)).body.record.id as string
      await choose(student, id, 'video')
      expect((await setDetails(adviser, id, { meetingLink: 'https://meet.example.com/abc', scheduledAt: '2026-11-06T10:00:00Z' })).status).toBe(200)
      await choose(student, id, 'video', {}, { recordCall: true })
      expect(stored(id).talk).toMatchObject({ mode: 'video', meetingLink: 'https://meet.example.com/abc', scheduledAt: '2026-11-06T10:00:00Z' })
      await choose(student, id, 'face_to_face')
      expect(stored(id).talk!.meetingLink).toBeUndefined()
      expect(stored(id).talk!.scheduledAt).toBeUndefined()
      expect(stored(id).talk!.consents).toHaveLength(3)
    })
  })

  describe('messages', () => {
    it('open only while chat is the chosen way to talk', async () => {
      const student = await login('QCU-STU-CS')
      const adviser = await login('QCU-PROF-CS')
      const id = (await file(student)).body.record.id as string

      const early = [await write(student, 'P20', id, 'Hello?'), await write(adviser, 'P22', id, 'Hello')]
      expect(early.map((response) => response.status)).toEqual([409, 409])
      expect(early[0]!.body.error).toBe('Messages are open only when you choose chat as the way to talk. Choose chat to write to the office.')
      expect(early[1]!.body.error).toBe('Messages are open only when the student chooses chat as the way to talk.')

      await choose(student, id, 'chat')
      expect((await write(student, 'P20', id, 'My first message')).status).toBe(200)
      expect((await write(adviser, 'P22', id, 'Thank you, I am reading it')).status).toBe(200)
      expect((await write(student, 'P20', id, 'It happened on Monday')).status).toBe(200)
      expect(messagesOf((await adviser.get(`/api/pages/P22?id=${id}`)).body.data.record)).toEqual(['My first message', 'Thank you, I am reading it', 'It happened on Monday'])
      expect(messagesOf((await student.get(`/api/pages/P20?id=${id}`)).body.data.record)).toEqual(['My first message', 'Thank you, I am reading it', 'It happened on Monday'])

      // Another way to talk closes the chat until the student chooses it again. What was said stays.
      await choose(student, id, 'voice')
      expect((await write(student, 'P20', id, 'Still there?')).status).toBe(409)
      expect((await write(adviser, 'P22', id, 'Still here')).status).toBe(409)
      expect(messagesOf(stored(id) as unknown as Body)).toHaveLength(3)
      await choose(student, id, 'chat')
      expect((await write(adviser, 'P22', id, 'Back in the chat')).status).toBe(200)

      stored(id).status = 'Resolved'
      expect((await write(student, 'P20', id, 'One more')).body.error).toBe('This conversation is closed.')
    })

    it('reach the other party as a notice and in the trail without their text, and only the current office and the student may write', async () => {
      const student = await login('QCU-STU-CS')
      const adviser = await login('QCU-PROF-CS')
      const id = (await file(student)).body.record.id as string
      await choose(student, id, 'chat')
      const mine = (recipientId: string) => repo.read().notifications.filter((notice) => notice.recipientId === recipientId && notice.recordId === id).length
      const [adviserNotices, studentNotices] = [mine('QCU-PROF-CS'), mine('QCU-STU-CS')]
      await write(student, 'P20', id, 'A private sentence from the student')
      await write(adviser, 'P22', id, 'A private sentence from the adviser')
      expect([mine('QCU-PROF-CS') - adviserNotices, mine('QCU-STU-CS') - studentNotices]).toEqual([1, 1])

      const sent = repo.read().audit.filter((entry) => entry.reference === id && entry.action.endsWith('message sent'))
      expect(sent.map((entry) => [entry.actorId, entry.action, entry.module])).toEqual([['QCU-STU-CS', 'Reporter message sent', 'reports'], ['QCU-PROF-CS', 'Handler message sent', 'reports']])
      expect(JSON.stringify(repo.read().audit)).not.toContain('private sentence')
      expect(JSON.stringify(repo.read().notifications)).not.toContain('private sentence')

      // Not the chair, not another adviser, not another student.
      expect((await write(await login('QCU-CHAIR-CS'), 'P22', id, 'Hello')).status).toBe(404)
      expect((await write(await login('QCU-PROF-IT'), 'P22', id, 'Hello')).status).toBe(404)
      expect((await write(await login('QCU-STU-IT-A'), 'P20', id, 'Hello')).status).toBe(404)
    })

    it('show the student the role of the office and none of its private notes', async () => {
      const student = await login('QCU-STU-CS')
      const adviser = await login('QCU-PROF-CS')
      const id = (await file(student)).body.record.id as string
      await choose(student, id, 'chat')
      await write(adviser, 'P22', id, 'We are looking into it')
      expect((await act(adviser, 'P22', 'addNote', { body: 'Internal: check the lab log' }, id)).status).toBe(200)
      const mine = (await student.get(`/api/pages/P20?id=${id}`)).body.data.record
      expect(mine.office).toBe('Adviser')
      expect(mine.messages[0].author).toMatchObject({ name: 'Prof. Sena Brook', roles: ['professor'] })
      expect(mine).not.toHaveProperty('notes')
      expect(JSON.stringify(mine)).not.toContain('Internal: check the lab log')
    })
  })

  describe('the details of a call or a meeting', () => {
    const link = 'https://meet.example.com/abc-defg'

    it('are set only by the office handling the concern, once the student has chosen how to talk', async () => {
      const student = await login('QCU-STU-CS')
      const adviser = await login('QCU-PROF-CS')
      const id = (await file(student)).body.record.id as string
      const early = await setDetails(adviser, id, { place: 'Faculty room' })
      expect([early.status, early.body.error]).toEqual([409, 'The student has not chosen how to talk yet.'])

      await choose(student, id, 'video')
      // The student cannot, whether through the office page or their own. The chair and other advisers do not handle it.
      expect((await setDetails(student, id, { meetingLink: link })).status).toBe(403)
      expect((await act(student, 'P20', 'setTalkDetails', { reportId: id, meetingLink: link })).status).toBe(403)
      for (const other of ['QCU-CHAIR-CS', 'QCU-PROF-IT', 'QCU-DEAN']) expect([other, (await setDetails(await login(other), id, { meetingLink: link })).status]).toEqual([other, 404])
      expect(stored(id).talk!.meetingLink).toBeUndefined()

      const noticesBefore = repo.read().notifications.filter((notice) => notice.recipientId === 'QCU-STU-CS' && notice.recordId === id && notice.pageId === 'P20').length
      const set = await setDetails(adviser, id, { meetingLink: link, scheduledAt: '2026-11-06T10:00:00+08:00' })
      expect(set.status).toBe(200)
      expect(set.body.record.talk).toMatchObject({ mode: 'video', meetingLink: link, scheduledAt: '2026-11-06T10:00:00+08:00' })
      // The student reads it, is told, and the trail names the action without the link.
      expect((await student.get(`/api/pages/P20?id=${id}`)).body.data.record.talk).toMatchObject({ meetingLink: link, scheduledAt: '2026-11-06T10:00:00+08:00' })
      expect(repo.read().notifications.filter((notice) => notice.recipientId === 'QCU-STU-CS' && notice.recordId === id && notice.pageId === 'P20')).toHaveLength(noticesBefore + 1)
      expect(repo.read().audit.filter((entry) => entry.reference === id && entry.action === 'Talk details set').map((entry) => entry.actorId)).toEqual(['QCU-PROF-CS'])
      expect(JSON.stringify(repo.read().audit)).not.toContain('meet.example.com')
      // A later change keeps what was not changed.
      await setDetails(adviser, id, { scheduledAt: '2026-11-07T09:00:00Z' })
      expect(stored(id).talk).toMatchObject({ meetingLink: link, scheduledAt: '2026-11-07T09:00:00Z' })
      stored(id).status = 'Closed'
      expect((await setDetails(adviser, id, { place: 'x' })).status).toBe(409)
    })

    it('take only an https link, and only for a video or voice call', async () => {
      const student = await login('QCU-STU-CS')
      const adviser = await login('QCU-PROF-CS')
      const id = (await file(student)).body.record.id as string
      await choose(student, id, 'voice')
      const before = JSON.stringify(stored(id))
      for (const bad of ['http://meet.example.com/abc', 'javascript:alert(1)', 'meet.example.com/abc', 'ftp://meet.example.com/abc', 'https://user:secret@meet.example.com/abc', 'https://', '', 'data:text/html,hi']) {
        const response = await setDetails(adviser, id, { meetingLink: bad })
        expect([bad, response.status, response.body.fields?.[0]?.message]).toEqual([bad, 400, 'Use a link that starts with https://'])
      }
      expect((await setDetails(adviser, id, { meetingLink: link, place: '' })).status).toBe(400)
      expect(JSON.stringify(stored(id))).toBe(before)
      // The link is kept in its normal form.
      expect((await setDetails(adviser, id, { meetingLink: '  https://Meet.Example.com/abc  ' })).body.record.talk.meetingLink).toBe('https://meet.example.com/abc')

      // Nothing to save, and a time that is not a time.
      const empty = await setDetails(adviser, id, {})
      expect([empty.status, empty.body.fields[0].message]).toEqual([400, 'Add a time, a meeting link, or a place.'])
      expect((await setDetails(adviser, id, { scheduledAt: 'next Tuesday' })).status).toBe(400)
      expect((await setDetails(adviser, id, { place: 'Faculty room' })).body.error).toBe('A place only applies to meeting in person.')

      await choose(student, id, 'face_to_face')
      expect((await setDetails(adviser, id, { meetingLink: link })).body.error).toBe('A meeting link only applies to video and voice calls.')
      expect((await setDetails(adviser, id, { place: 'Faculty room', scheduledAt: '2026-11-06T10:00' })).body.record.talk).toMatchObject({ mode: 'face_to_face', place: 'Faculty room', scheduledAt: '2026-11-06T10:00' })

      await choose(student, id, 'chat')
      expect((await setDetails(adviser, id, { meetingLink: link })).status).toBe(409)
      expect((await setDetails(adviser, id, { place: 'Faculty room' })).status).toBe(409)
      expect((await setDetails(adviser, id, { scheduledAt: '2026-11-08T09:00:00Z' })).status).toBe(200)
    })
  })

  it('keeps decision codes, module IDs, and approval notes out of the wording and the messages', async () => {
    const student = await login('QCU-STU-CS')
    const adviser = await login('QCU-PROF-CS')
    const id = (await file(student)).body.record.id as string
    const texts: string[] = [consentWording.report, ...Object.values(consentWording.talk), ...Object.values(consentWording.recording)]
    const keep = (response: request.Response) => { texts.push(String(response.body.error ?? ''), ...((response.body.fields ?? []) as { message: string }[]).map((field) => field.message)) }
    keep(await file(student, { consent: { readStatement: false } }))
    keep(await file(student, { allowChair: undefined }))
    keep(await write(student, 'P20', id, 'Hello'))
    keep(await write(adviser, 'P22', id, 'Hello'))
    keep(await choose(student, id, 'chat', {}, { recordCall: true }))
    keep(await choose(student, id, 'chat', {}, { participate: false }))
    keep(await choose(student, id, 'video', { slotId: 'SLOT-0104' }))
    keep(await setDetails(adviser, id, { place: 'x' }))
    await choose(student, id, 'video')
    keep(await setDetails(adviser, id, { place: 'x' }))
    keep(await setDetails(adviser, id, { meetingLink: 'http://x.example.com' }))
    keep(await setDetails(adviser, id, {}))
    keep(await escalate(adviser, id))
    expect(texts.filter(Boolean).length).toBeGreaterThan(14)
    for (const text of texts) expect(text).not.toMatch(/\bD-\d\d\b|\bDOC\d{3}\b|\bTBD\b|\b[A-Z]{2,4}-\d{2}\b|\bP\d{2}\b/)
  })
})

// The same flows over a record store that several instances share, which is how a deployed stack runs.
describe('over a record store that instances share', () => {
  function instances() {
    const store = createMemoryRecordStore()
    const authStore = createMemoryAuthStore()
    const sessionStore = createMemorySessionStore()
    return { store, instance: () => createApp(createRecordRepository(store), { authStore, sessionStore }) }
  }

  it('shows a message written on one instance to the other party on a second instance and on a new one', async () => {
    const { store, instance } = instances()
    const [first, second] = [instance(), instance()]
    const { agent: student } = await signIn(first, 'QCU-STU-CS')
    const { agent: adviser } = await signIn(second, 'QCU-PROF-CS')
    const filed = await file(student)
    const id = filed.body.record.id as string
    expect((await choose(student, id, 'chat', { preferredAt: '2026-11-06T10:00:00Z' })).status).toBe(200)
    expect((await write(student, 'P20', id, 'From the student on the first instance')).status).toBe(200)

    // The adviser, on another instance, was told, reads it, and answers.
    expect(((await adviser.get('/api/pages/P40')).body.data.notifications as Body[]).filter((notice) => notice.recordId === id && notice.kind === 'report').length).toBeGreaterThanOrEqual(3)
    const seen = (await adviser.get(`/api/pages/P22?id=${id}`)).body.data.record
    expect(messagesOf(seen)).toEqual(['From the student on the first instance'])
    expect(seen.talk).toMatchObject({ mode: 'chat', preferredAt: '2026-11-06T10:00:00Z' })
    expect((await write(adviser, 'P22', id, 'From the adviser on the second instance')).status).toBe(200)

    // A third instance, started cold, sees the whole conversation, the agreement, and the consent record.
    const { agent: back } = await signIn(instance(), 'QCU-STU-CS')
    const mine = (await back.get(`/api/pages/P20?id=${id}`)).body.data.record
    expect(messagesOf(mine)).toEqual(['From the student on the first instance', 'From the adviser on the second instance'])
    expect(mine.consent).toMatchObject({ version: consentWording.version, wording: consentWording.report })
    expect(mine.talk.consents).toHaveLength(1)
    const { agent: adviserAgain } = await signIn(instance(), 'QCU-PROF-CS')
    expect(messagesOf((await adviserAgain.get(`/api/pages/P22?id=${id}`)).body.data.record)).toHaveLength(2)

    // Each record landed in the table of its collection.
    expect(store.all().map((item) => `${item.table}/${item.collection}`).sort()).toEqual(expect.arrayContaining(['ccs_audit/audit', 'ccs_grievance/reports', 'ccs_notification/notifications']))
    const audits = store.all().filter((item) => item.collection === 'audit').map((item) => JSON.parse(item.data!).action as string)
    expect(audits).toEqual(expect.arrayContaining(['Report submitted', 'Report consent recorded', 'Talk consent recorded', 'Reporter message sent', 'Handler message sent']))
    expect(JSON.stringify(store.all().filter((item) => item.collection === 'audit'))).not.toContain('From the student')
  })

  it('keeps both messages when the student and the adviser write at the same moment on two instances', async () => {
    const { instance } = instances()
    const [first, second] = [instance(), instance()]
    const { agent: student } = await signIn(first, 'QCU-STU-CS')
    const { agent: adviser } = await signIn(second, 'QCU-PROF-CS')
    const id = (await file(student)).body.record.id as string
    await choose(student, id, 'chat')
    const sent = await Promise.all([write(student, 'P20', id, 'Together, from the student'), write(adviser, 'P22', id, 'Together, from the adviser')])
    expect(sent.map((response) => response.status)).toEqual([200, 200])
    expect(messagesOf((await student.get(`/api/pages/P20?id=${id}`)).body.data.record).sort()).toEqual(['Together, from the adviser', 'Together, from the student'])
  })

  it('loads only the collections that a route writing to the audit trail names', async () => {
    const store = createMemoryRecordStore()
    const lists: string[] = []
    const watched: RecordStore = { list: (table, collection) => { lists.push(`${table}/${collection}`); return store.list(table, collection) }, write: (writes) => store.write(writes) }
    const app = createApp(createRecordRepository(watched), { authStore: createMemoryAuthStore(), sessionStore: createMemorySessionStore(), stack: { tablePrefix: 'accs-dev-', nodeEnv: 'production' } })
    // Signing in, and reading the session, touch accounts only.
    const { agent: admin } = await signIn(app, 'QCU-ADMIN')
    expect(lists).toEqual([])
    expect((await admin.post('/api/admin/accounts/QCU-STU-IT-A/reset-code').send({})).status).toBe(200)
    expect(lists).toEqual(['ccs_audit/audit'])
    const { agent: dean } = await signIn(app, 'QCU-DEAN')
    expect((await dean.post('/api/dev/switch-user').send({ userId: 'QCU-STU-IT-A' })).status).toBe(200)
    expect(lists).toEqual(['ccs_audit/audit', 'ccs_audit/audit'])
    expect(store.all().map((item) => `${item.table}/${item.collection}`)).toEqual(['ccs_audit/audit', 'ccs_audit/audit'])
  })

  it('writes a booked time to the scheduling table, linked to the concern, and lets one instance take it', async () => {
    const { store, instance } = instances()
    const [first, second] = [instance(), instance()]
    const { agent: student } = await signIn(first, 'QCU-STU-IT-A')
    const { agent: other } = await signIn(second, 'QCU-STU-RESTRICTED')
    const id = (await file(student)).body.record.id as string
    const otherId = (await file(other)).body.record.id as string
    const booked = await choose(student, id, 'face_to_face', { slotId: 'SLOT-0101' })
    expect(booked.status).toBe(200)
    expect((await choose(other, otherId, 'face_to_face', { slotId: 'SLOT-0101' })).status).toBe(409)
    const items = store.all().filter((item) => ['consultations', 'slots'].includes(item.collection))
    expect(items.map((item) => `${item.table}/${item.collection}`).sort()).toEqual(['ccs_scheduling/consultations', 'ccs_scheduling/slots'])
    expect(JSON.parse(items.find((item) => item.collection === 'consultations')!.data!)).toMatchObject({ reportId: id, slotId: 'SLOT-0101', status: 'Requested' })
    const { agent: adviser } = await signIn(instance(), 'QCU-PROF-IT')
    expect((await adviser.get('/api/pages/P14')).body.data.consultations.some((entry: Body) => entry.reportId === id)).toBe(true)
  })
})

// From the Dean activating the secretary to a chat between a student and an adviser the secretary created.
const backends: [string, () => () => Repository][] = [
  ['in memory', () => createMemoryRepository],
  ['over a shared record store', () => { const store = createMemoryRecordStore(); return () => createRecordRepository(store) }],
]
describe.each(backends)('the first concern, start to finish, %s', (name, backend) => {
  beforeEach(() => { vi.spyOn(console, 'log').mockImplementation(() => {}) })
  afterEach(() => vi.restoreAllMocks())

  it('runs from the secretary account to a chat in both directions', async () => {
    const newRepository = backend()
    const authStore = createMemoryAuthStore()
    const sessionStore = createMemorySessionStore()
    const app = createApp(newRepository(), { authStore, sessionStore })

    // The Dean activates the secretary, who replaces the temporary details at the first sign-in.
    const secretary = await secretarySession(app)
    // The secretary creates an adviser and a student, then assigns the adviser to the student's year.
    const created = await secretary.post('/api/accounts/faculty').send({ faculty: [{ name: 'Prof. Ana Adviser', email: 'ana.adviser@qcu.edu.ph', program: 'BSIT' }] })
    const adviserAccount = created.body.record.results[0]
    const imported = await secretary.post('/api/accounts/students').send({ students: [{ name: 'Ben Student', email: 'ben.student@gmail.com', studentId: '26-1001', program: 'BSIT', year: 3, section: 'A' }] })
    const studentAccount = imported.body.record.results[0]
    expect(studentAccount.account.adviserId).toBeUndefined()
    expect((await secretary.put('/api/accounts/advisors/3').send({ facultyIds: [adviserAccount.account.id] })).body.record.studentsUpdated).toBe(1)

    // The student holds temporary details until the first sign-in replaces them, then sees the adviser and the wording.
    const { agent: student, response } = await signIn(app, studentAccount.credentials.username, studentAccount.credentials.temporaryPassword)
    expect(response.body.user.mustChangeCredentials).toBe(true)
    expect((await student.get('/api/pages/P19')).status).toBe(403)
    expect((await student.post('/api/auth/complete-first-login').send({ currentPassword: studentAccount.credentials.temporaryPassword, username: 'ben.student', password: 'Student1!Passw0rd' })).status).toBe(200)
    const form = (await student.get('/api/pages/P19')).body.data
    expect(form.adviser).toMatchObject({ id: adviserAccount.account.id, name: 'Prof. Ana Adviser' })
    expect(form.consentWording.report).toBe(consentWording.report)

    // Without the agreement nothing is filed. With it, the concern goes to the adviser.
    expect((await file(student, { consent: { readStatement: false } })).status).toBe(400)
    const filed = await file(student, { narrative: 'The lab timetable changed on Monday and nobody told us.', allowChair: true })
    expect(filed.status).toBe(200)
    const id = filed.body.record.id as string
    expect(filed.body.record).toMatchObject({ stage: 'adviser', office: 'Adviser', aboutAdvisor: false, allowChair: true, allowDean: false })

    // The adviser signs in for the first time, finds a notice and the concern in the list, and reads the statement.
    const { agent: adviser, response: adviserSignIn } = await signIn(app, adviserAccount.credentials.username, adviserAccount.credentials.temporaryPassword)
    expect(adviserSignIn.body.user.mustChangeCredentials).toBe(true)
    expect((await adviser.post('/api/auth/complete-first-login').send({ currentPassword: adviserAccount.credentials.temporaryPassword, username: 'ana.adviser', password: 'Adviser1!Passw0rd' })).status).toBe(200)
    const notice = ((await adviser.get('/api/pages/P40')).body.data.notifications as Body[]).find((entry) => entry.kind === 'report' && entry.recordId === id)!
    expect(notice).toMatchObject({ pageId: 'P22', title: 'Report update', body: 'Open this update to see the details.', read: false })
    expect(await listed(adviser)).toEqual([id])
    expect((await act(adviser, 'P40', 'openNotification', {}, notice.id)).body.record).toEqual({ pageId: 'P22', recordId: id })
    const opened = (await adviser.get(`/api/pages/P22?id=${id}`)).body.data.record
    expect(opened).toMatchObject({ narrative: 'The lab timetable changed on Monday and nobody told us.', reporter: { name: 'Ben Student' }, category: 'General concern', consent: { version: consentWording.version }, allowChair: true })
    expect(opened).not.toHaveProperty('talk')

    // Messages open when the student chooses chat, and the adviser is told.
    expect((await write(adviser, 'P22', id, 'Hello Ben')).status).toBe(409)
    expect((await write(student, 'P20', id, 'Hello Prof')).status).toBe(409)
    expect((await choose(student, id, 'chat')).status).toBe(200)
    expect(((await adviser.get('/api/pages/P40')).body.data.notifications as Body[]).filter((entry) => entry.recordId === id && !entry.read)).toHaveLength(1)

    // The conversation runs both ways.
    expect((await write(student, 'P20', id, 'Hello Prof, here is what happened.')).status).toBe(200)
    expect(messagesOf((await adviser.get(`/api/pages/P22?id=${id}`)).body.data.record)).toEqual(['Hello Prof, here is what happened.'])
    expect((await write(adviser, 'P22', id, 'Thank you, Ben. I will look into it.')).status).toBe(200)
    expect(messagesOf((await student.get(`/api/pages/P20?id=${id}`)).body.data.record)).toEqual(['Hello Prof, here is what happened.', 'Thank you, Ben. I will look into it.'])
    expect((await write(student, 'P20', id, 'Thank you.')).status).toBe(200)
    const conversation = ['Hello Prof, here is what happened.', 'Thank you, Ben. I will look into it.', 'Thank you.']
    expect(messagesOf((await adviser.get(`/api/pages/P22?id=${id}`)).body.data.record)).toEqual(conversation)

    // The chair, the Dean, and another adviser were never part of it.
    for (const other of ['QCU-CHAIR-IT', 'QCU-DEAN', 'QCU-PROF-IT']) expect([other, (await (await signIn(app, other)).agent.get(`/api/pages/P22?id=${id}`)).status]).toEqual([other, 404])

    if (name === 'over a shared record store') {
      // A cold instance shows the same conversation to both people.
      const cold = createApp(newRepository(), { authStore, sessionStore })
      const { agent: studentCold } = await signIn(cold, 'ben.student', 'Student1!Passw0rd')
      const { agent: adviserCold } = await signIn(cold, 'ana.adviser', 'Adviser1!Passw0rd')
      expect(messagesOf((await studentCold.get(`/api/pages/P20?id=${id}`)).body.data.record)).toEqual(conversation)
      expect(messagesOf((await adviserCold.get(`/api/pages/P22?id=${id}`)).body.data.record)).toEqual(conversation)
      expect((await adviserCold.get(`/api/pages/P22?id=${id}`)).body.data.record.talk.mode).toBe('chat')
    }
  })
})
