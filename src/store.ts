import { consentWording } from './consent.js'
import { ulid } from './ids.js'
import type { Role, TalkMode, User } from './schemas.js'

// The President's Office stage was removed on 2026-11-10; a record stored with `executive` is read as `osas` (persist.ts).
export type Stage = 'adviser' | 'chair' | 'dean' | 'guidance' | 'osas'
export type Message = { id: string; authorId: string; body: string; at: string }
export type History = { id: string; at: string; actorId: string; actorRole: string; action: string; reason: string; update: string; public: boolean; stage: Stage }
/** The student's agreement to send a concern, stamped by the server with the exact wording they were shown. */
export type ReportConsent = { readStatement: true; at: string; userId: string; version: string; wording: string }
/** One agreement to talk in one way. A student who changes the way adds another; earlier ones stay. */
export type TalkConsent = { mode: TalkMode; participate: true; recordCall?: boolean; wording: string; at: string }
/** How the student and the office handling the concern talk. `meetingLink` (video, voice) and `place` (face to face) are added by that office. */
export type Talk = { mode: TalkMode; consents: TalkConsent[]; slotId?: string; consultationId?: string; preferredAt?: string; scheduledAt?: string; meetingLink?: string; place?: string; updatedAt: string }
/**
 * `aboutAdvisor` is true when the concern goes around the adviser: the student said so, or the adviser is named in it.
 * Then the adviser never sees it. `allowChair` and `allowDean` are the student's choice; an office they did not allow
 * cannot read the concern. A report stored before these fields existed has none of them, which reads as "not allowed".
 */
/**
 * A concern a student filed, or (source 'faculty', decided 12 November 2026) a report a faculty member filed about a student.
 * For a faculty report the owner is the faculty member, the reported student is `reportedStudentId` and is in `involvedUserIds`,
 * and there is no consent or talk mode. Stored reports without `source` are students' concerns.
 */
export type Report = { id: string; ownerId: string; program: string; adviserId?: string; stage: Stage; status: string; narrative: string; category: string; subcategory?: string; categoryDetail?: string; severity: 'low' | 'medium' | 'high'; identity: 'named' | 'anonymous'; alias: string; disclosedTo: string[]; involvedUserIds: string[]; bypassed: boolean; aboutAdvisor: boolean; allowChair?: boolean; allowDean?: boolean; confidential?: boolean; consent?: ReportConsent; source?: 'student' | 'faculty'; reportedStudentId?: string; talk?: Talk; createdAt: string; updatedAt: string; caseFileId?: string; sourcePostId?: string; location?: string; occurredOn?: string; history: History[]; notes: Message[]; messages: Message[] }
export type Post = {
  id: string
  authorId: string
  title: string
  body: string
  audience: string
  kind: 'discussion' | 'announcement'
  label: string
  anonymous: boolean
  priority: string
  private: boolean
  at: string
  updatedAt?: string
  eventDate?: string
  eventTime?: string
  eventPlace?: string
  eventContact?: string
  notifyMembers?: boolean
  reactions: string[]
  comments: (Message & { anonymous: boolean })[]
  removed: boolean
}
export type Event = {
  id: string
  title: string
  date: string
  start: string
  end?: string
  type: string
  description: string
  contactId: string
  organizationId?: string
  audience?: string
  private?: boolean
  postId?: string
  place?: string
  contact?: string
}
/** A section space carries its campus and year (#46); its title is the section name, like SBIT3A. Subject spaces may too. */
export type Space = { id: string; title: string; program: string; section: string; campus?: string; year?: number; subject: string; professorIds: string[]; studentIds: string[] }
export type Organization = { id: string; name: string; description: string; representativeId: string; memberIds: string[] }
export type Thread = {
  id: string
  title: string
  memberIds: string[]
  spaceId?: string
  messages: Message[]
  mutedBy: string[]
  readMessageCounts: Record<string, number>
}
/** `reason` is set when the faculty member marks the time not available (#32); entries stored before that have none. */
export type Slot = { id: string; facultyId: string; date: string; start: string; end: string; state: 'open' | 'requested' | 'booked' | 'unavailable'; reason?: string }
export type Consultation = { id: string; studentId: string; facultyId: string; slotId: string; /** The concern this time is for, when the student booked it to talk about one. */ reportId?: string; purpose: string; category?: string; subcategory?: string; details?: string; status: 'Requested' | 'Approved' | 'Booked' | 'Completed' | 'Declined' | 'Cancelled'; createdAt: string; updatedAt: string; history: { at: string; status: string; note: string; actorId: string }[] }
export type Question = { id: string; criterion: string; text: string; type: 'rating' | 'text'; required: boolean }
export type Cycle = { id: string; title: string; term: string; opens: string; closes: string; status: 'Draft' | 'In review' | 'Published' | 'Closed'; instructions: string; questions: Question[]; forms: string[]; resultsPublished: boolean; reviews: { userId: string; decision: string; note: string; at: string }[] }
export type Assignment = { id: string; evaluatorId: string; facultyId: string; cycleId: string; relation: string; subject: string; answers?: Record<string, string | number>; comment?: string; submittedAt?: string }
export type Restriction = { id: string; studentId: string; features: string[]; basis: string; decisionReference: string; starts: string; until: string; actorId: string; active: boolean }
export type Referral = { id: string; studentId: string; change: string; decisionReference: string; reason: string; actorId: string; at: string; status: string }
/**
 * A strike against a reported student (#34, decided 11 November 2026). The Dean recommends it while the case is with the
 * Dean (`actorId`, `at`, `note`); OSAS confirms or rejects it once the case reaches OSAS. Only a confirmed strike counts.
 * Records stored before this rule have no `status` and were recorded by OSAS, so they count as confirmed. `kind` stays for
 * those records; no-show strikes are no longer recorded.
 */
export type StrikeStatus = 'recommended' | 'confirmed' | 'rejected'
export type Strike = { id: string; studentId: string; reportId: string; kind: 'report' | 'no-show'; note: string; actorId: string; at: string; status?: StrikeStatus; decidedBy?: string; decidedAt?: string; decisionNote?: string }
/** OSAS settles a clearance hold with a letter or reprimand. The strikes it covers stay on the record; only the hold lifts. */
export type StrikeSettlement = { id: string; studentId: string; kind: 'letter' | 'reprimand'; reference: string; note: string; strikeIds: string[]; actorId: string; at: string }
export type Notification = { id: string; recipientId: string; kind: string; title: string; body: string; priority: string; pageId: string; recordId?: string; at: string; read: boolean }
export type Audit = { id: string; at: string; actorId: string; action: string; module: string; reference: string; result: string; purpose?: string; reason?: string }
export type Moderation = { id: string; itemType: 'post' | 'comment' | 'message'; itemId: string; parentId: string; authorId: string; reporterId?: string; source: 'Filter' | 'User'; reason: string; excerpt: string; status: string; at: string; history: { at: string; actorId: string; decision: string; reason: string }[] }
export type Database = {
  users: User[]; spaces: Space[]; organizations: Organization[]; posts: Post[]; threads: Thread[]; slots: Slot[]; consultations: Consultation[]; reports: Report[]; drafts: Record<string, Record<string, unknown>>; todos: { id: string; ownerId: string; title: string; date: string; done: boolean }[];
  events: Event[]; cycles: Cycle[]; assignments: Assignment[]; restrictions: Restriction[]; referrals: Referral[]; strikes: Strike[]; strikeSettlements: StrikeSettlement[]; materials: Material[]; loadSchedules: LoadEntry[]; offenses: { id: string; studentId: string; level: number; summary: string; decisionReference: string; actorRole: string; at: string; status: string }[]; goodMoral: { studentId: string; status: string; decisionSource: string; notes: string; actorId: string; at: string }[]; clusters: { id: string; program: string; title: string; reportIds: string[]; similarity: number; supporting: string; dissenting: string; phrases: string[]; status: string; history: { at: string; actorId: string; decision: string; reason: string }[] }[]; notifications: Notification[]; audit: Audit[]; moderation: Moderation[]; settings: Record<string, { theme: string; density: string; priorities: Record<string, string> }>; permissionOverrides: Record<string, boolean>; telemetry: { id: string; at: string; category: string; durationMs: number; success: boolean }[]; followUps: { id: string; facultyId: string; actorId: string; note: string; at: string }[];
}
/** What domain rules see while they run. They stay synchronous, so one unit of work is never interleaved with another. */
export interface UnitOfWork { read(): Database; nextId(prefix: string): string }
/** The collections a shared backend keeps in its record store. `users`, `spaces`, `organizations`, and `offenses` stay per instance (`persist.ts`). */
/**
 * One class in a faculty member's load for a term (#39), uploaded by the CCS Secretary. `startsOn` and `endsOn` bound the
 * term, so an open consultation time on that weekday inside the term may not overlap the class.
 */
export type Weekday = 'Mon' | 'Tue' | 'Wed' | 'Thu' | 'Fri' | 'Sat'
export type LoadEntry = { id: string; facultyId: string; term: string; startsOn: string; endsOn: string; day: Weekday; start: string; end: string; subject: string; section?: string; room?: string; uploadedBy: string; at: string }
/**
 * A class material in a subject space (#44): the subject's professor shares it with the section's students. Links for now;
 * uploaded files come with the storage bucket (kind 'file').
 */
export type Material = { id: string; spaceId: string; kind: 'link' | 'file'; title: string; note?: string; authorId: string; at: string; updatedAt: string
  /** A link's address. */
  url?: string
  /** A file's original name, type, size, storage key, and whether its upload was confirmed (src/material-storage.ts). */
  fileName?: string; contentType?: string; size?: number; key?: string; status?: 'pending' | 'ready' }
export type Collection = 'reports' | 'consultations' | 'slots' | 'threads' | 'notifications' | 'audit' | 'posts' | 'moderation' | 'drafts' | 'events' | 'todos' | 'cycles' | 'assignments' | 'followUps' | 'restrictions' | 'referrals' | 'strikes' | 'strikeSettlements' | 'materials' | 'loadSchedules' | 'goodMoral' | 'clusters' | 'settings' | 'permissionOverrides' | 'telemetry'
/**
 * The storage boundary. A backend does its I/O around the work: it loads, runs the work, then commits.
 * - `view`: read-only. Anything the work changes is discarded, and what it returns is detached from the store.
 * - `transact`: all or nothing. If the work throws, nothing it changed is kept.
 * `collections` names the stored collections the work touches (default: all). A backend that loads on demand skips the
 * others, and the work throws if it reads one that was not named. Memory ignores it.
 */
export interface Repository {
  view<T>(work: (unit: UnitOfWork) => T, collections?: readonly Collection[]): Promise<T>
  transact<T>(work: (unit: UnitOfWork) => T, collections?: readonly Collection[]): Promise<T>
}
/** Adds direct access to the live state, for tests and seeding. Application code goes through `view` and `transact`. */
export interface MemoryRepository extends Repository { read(): Database }
// One process owns this in-memory state, so it is per instance and lost on a restart. Deployed stacks use the record repository (`persist.ts`).
export function createMemoryRepository(): MemoryRepository {
  const data = seed()
  const nextId = (prefix: string) => `${prefix}-${ulid()}`
  return {
    read: () => data,
    view: async (work) => {
      const copy = structuredClone(data)
      return work({ read: () => copy, nextId: () => { throw new Error('A read-only view cannot allocate IDs.') } })
    },
    transact: async (work) => {
      const before = structuredClone(data)
      try {
        return structuredClone(work({ read: () => data, nextId }))
      } catch (error) {
        Object.assign(data, before)
        throw error
      }
    },
  }
}

function user(id: string, name: string, roles: Role[], extra: Partial<User> = {}): User { return { id, name, email: `${id.toLowerCase().replaceAll('qcu-', '').replaceAll('-', '.')}@qcu.edu.ph`, roles, restrictions: [], title: roles.includes('student') ? 'CCS student' : 'CCS personnel', bio: roles.includes('student') ? 'Student, QCU College of Computer Studies.' : 'QCU College of Computer Studies.', education: roles.includes('student') ? 'Quezon City University' : 'Quezon City University, College of Computer Studies', officeHours: 'By appointment. Request a time under Appointments.', spaceIds: [], organizationIds: [], active: true, ...extra } }
/** The account shape with its default profile text, for accounts created after the seed. */
export const newUser = user
const at = '2026-10-20T02:00:00.000Z'
export function seed(): Database {
  const users: User[] = [
    user('QCU-STU-IT-A', 'Mira Solis', ['student'], { campus: 'SB', program: 'BSIT', section: 'A', year: 3, studentId: 'QCU-2024-0101', adviserId: 'QCU-PROF-IT', spaceIds: ['SPACE-IT-A', 'SUBJECT-IT-DS'], organizationIds: ['ORG-COMPUTING'] }),
    user('QCU-STU-IT-B', 'Luca Reed', ['student'], { campus: 'SB', program: 'BSIT', section: 'B', year: 3, studentId: 'QCU-2024-0102', adviserId: 'QCU-PROF-OTHER', spaceIds: ['SPACE-IT-B'] }),
    user('QCU-STU-CS', 'Noa Vale', ['student'], { campus: 'SB', program: 'BSCS', section: 'A', year: 2, studentId: 'QCU-2025-0201', adviserId: 'QCU-PROF-CS', spaceIds: ['SPACE-CS-A'] }),
    user('QCU-STU-RESTRICTED', 'Tess Finch', ['student'], { campus: 'SB', program: 'BSIT', section: 'A', year: 3, studentId: 'QCU-2024-0103', adviserId: 'QCU-PROF-IT', spaceIds: ['SPACE-IT-A', 'SUBJECT-IT-DS'], restrictions: ['post.create', 'post.comment', 'report.anonymous'] }),
    user('QCU-ORG', 'Computing Society Representative', ['organization'], { organizationId: 'ORG-COMPUTING', organizationIds: ['ORG-COMPUTING'], office: 'CCS Organizations', title: 'Organization representative' }),
    user('QCU-PROF-IT', 'Prof. Robin Elm', ['professor'], { program: 'BSIT', office: 'CCS Faculty Room', title: 'Faculty, BSIT adviser', bio: 'Teaches Data Structures and advises BSIT 3A.', officeHours: 'Thursdays, 10:00 AM to 12:00 PM, CCS Faculty Room', spaceIds: ['SPACE-IT-A', 'SUBJECT-IT-DS'] }),
    user('QCU-PROF-OTHER', 'Prof. Rowan Quill', ['professor'], { program: 'BSIT', office: 'CCS Faculty Room', title: 'Faculty, BSIT', bio: 'Advises BSIT 3B.', officeHours: 'Thursdays, 9:00 AM to 11:00 AM, CCS Faculty Room', spaceIds: ['SPACE-IT-B'] }),
    user('QCU-PROF-CS', 'Prof. Sena Brook', ['professor'], { program: 'BSCS', office: 'CCS Faculty Room', title: 'Faculty, BSCS', bio: 'Advises BSCS 2A.', officeHours: 'Thursdays, 11:00 AM to 1:00 PM, CCS Faculty Room', spaceIds: ['SPACE-CS-A'] }),
    user('QCU-CHAIR-IT', 'Dr. Morgan Ash', ['chair', 'professor'], { program: 'BSIT', office: 'BSIT Program Office', title: 'BSIT Program Chair and faculty', officeHours: 'Fridays, 10:00 AM to 12:00 PM, BSIT Program Office', spaceIds: ['SUBJECT-IT-DS'] }),
    user('QCU-CHAIR-CS', 'Dr. Ellis Wren', ['chair'], { program: 'BSCS', office: 'BSCS Program Office', title: 'BSCS Program Chair' }),
    user('CCS-DEAN', 'Dr. Sage Linden', ['dean'], { email: 'dean@qcu.edu.ph', office: 'CCS Dean\'s Office', title: 'Dean, College of Computer Studies', officeHours: 'Weekdays, 9:00 AM to 4:00 PM, Dean\'s Office' }),
    user('ACCS-ADMIN', 'Casey Hart', ['administrator'], { email: 'admin@access-ccs.com', office: 'ACCS system administration', title: 'ACCS System Administrator' }),
    user('QCU-GUIDANCE', 'Alex Fern', ['guidance'], { office: 'Guidance Office', title: 'Guidance officer', officeHours: 'Weekdays, 9:00 AM to 4:00 PM' }),
    user('QCU-OSAS', 'Jamie Alder', ['osas'], { office: 'Office of Student Affairs and Services', title: 'OSAS officer', officeHours: 'Weekdays, 9:00 AM to 4:00 PM' }),
    // Inactive until the Dean activates it. The email is a placeholder: activation can replace it.
    user('QCU-SECRETARY', 'CCS Secretary', ['secretary'], { active: false, email: 'secretary@example.invalid', office: 'CCS Office', title: 'CCS secretary', officeHours: 'Monday to Friday, 8:00 AM to 5:00 PM' }),
  ]
  const spaces: Space[] = [
    { id: 'SPACE-IT-A', title: 'SBIT3A', program: 'BSIT', section: 'A', campus: 'SB', year: 3, subject: 'Section group', professorIds: ['QCU-PROF-IT'], studentIds: ['QCU-STU-IT-A', 'QCU-STU-RESTRICTED'] },
    { id: 'SUBJECT-IT-DS', title: 'Data Structures, SBIT3A', program: 'BSIT', section: 'A', campus: 'SB', year: 3, subject: 'CC 104 Data Structures', professorIds: ['QCU-PROF-IT', 'QCU-CHAIR-IT'], studentIds: ['QCU-STU-IT-A', 'QCU-STU-RESTRICTED'] },
    { id: 'SPACE-IT-B', title: 'SBIT3B', program: 'BSIT', section: 'B', campus: 'SB', year: 3, subject: 'Section group', professorIds: ['QCU-PROF-OTHER'], studentIds: ['QCU-STU-IT-B'] },
    { id: 'SPACE-CS-A', title: 'SBCS2A', program: 'BSCS', section: 'A', campus: 'SB', year: 2, subject: 'Section group', professorIds: ['QCU-PROF-CS'], studentIds: ['QCU-STU-CS'] },
  ]
  const post = (id: string, authorId: string, title: string, body: string, audience = 'college', anonymous = false, kind: Post['kind'] = 'discussion'): Post => ({ id, authorId, title, body, audience, anonymous, kind, label: kind === 'announcement' ? 'Announcement' : 'Discussion', priority: 'general', private: audience.startsWith('organization:'), at, reactions: [], comments: [], removed: false })
  const posts = [post('POST-0101', 'CCS-DEAN', 'Appointment week starts October 29', 'Faculty appointment times open October 29 at the CCS Faculty Room. Request a time under Appointments and wait for your professor to confirm.', 'college', false, 'announcement'), post('POST-0102', 'QCU-STU-IT-A', 'Is IC 301 open for our group activity?', 'The lab timetable changed on Monday. Which IC 301 slots are free next week? Our group needs two hours for the Data Structures activity.', 'program:BSIT', true), post('POST-0103', 'QCU-PROF-IT', 'Data Structures practice set', 'The practice set on linked lists and stacks is posted. Bring your questions to our next meeting in IC 301.', 'space:SUBJECT-IT-DS', false, 'announcement'), post('POST-0104', 'QCU-ORG', 'Workshop agenda draft', 'Members, please read the draft agenda for the Intro to Git workshop and send corrections before Friday.', 'organization:ORG-COMPUTING'), post('POST-0105', 'QCU-ORG', 'Intro to Git workshop', 'Open to all CCS students. November 5, 1:00 PM to 3:00 PM at IC 305. Bring your laptop.')]
  posts[4]!.audience = 'organization:ORG-COMPUTING'
  posts[4]!.private = false
  posts.push(post('POST-0106', 'QCU-PROF-IT', 'Faculty meeting items', 'Add items for the semester coordination meeting before Monday.', 'faculty'))
  posts[1]!.comments.push({ id: 'COMMENT-0101', authorId: 'QCU-STU-IT-B', body: 'Same problem in BSIT 3B. A posted lab schedule would help us plan.', anonymous: false, at })
  const stageRoles: Record<Stage, string> = { adviser: 'professor', chair: 'chair', dean: 'dean', guidance: 'guidance', osas: 'osas' }
  const actorIds: Record<Stage, string> = { adviser: 'QCU-PROF-IT', chair: 'QCU-CHAIR-IT', dean: 'CCS-DEAN', guidance: 'QCU-GUIDANCE', osas: 'QCU-OSAS' }
  const stages: Stage[] = ['adviser', 'chair', 'dean', 'guidance', 'osas']
  function report(id: string, ownerId: string, stage: Stage, bypassed = false, converted = false): Report {
    const owner = users.find(u => u.id === ownerId)!
    const history = stages.slice(0, stages.indexOf(stage) + 1).filter(s => !bypassed || s !== 'adviser').map((s, index): History => ({ id: `H-${id}-${index}`, at, actorId: s === 'adviser' ? owner.adviserId! : s === 'chair' && owner.program === 'BSCS' ? 'QCU-CHAIR-CS' : actorIds[s], actorRole: stageRoles[s], action: index === 0 ? 'Submitted' : 'Transferred', reason: 'Routine routing', update: 'The office is reviewing your report.', public: true, stage: s }))
    return { id, ownerId, program: owner.program!, adviserId: owner.adviserId!, stage, status: stage === 'guidance' && converted ? 'Case File at Guidance' : `With ${stage}`, narrative: 'The IC 301 lab timetable changed on Monday and nobody told us. Our group missed a scheduled activity. Please look into how lab schedule changes are announced.', category: 'General concern', severity: 'medium', identity: 'anonymous', alias: `Reporter A-${id.slice(-2)}`, disclosedTo: [], involvedUserIds: bypassed ? [owner.adviserId!] : [], bypassed, aboutAdvisor: bypassed, allowChair: true, allowDean: true, consent: { readStatement: true, at, userId: ownerId, version: consentWording.version, wording: consentWording.report }, talk: { mode: 'chat', consents: [{ mode: 'chat', participate: true, wording: consentWording.talk.chat, at }], updatedAt: at }, createdAt: at, updatedAt: at, ...(converted ? { caseFileId: `CF-${id.slice(-4)}` } : {}), history, notes: [{ id: `NOTE-${id}`, authorId: actorIds[stage], body: 'Asked the lab coordinator about the Monday timetable change. Waiting for a reply.', at }], messages: [{ id: `MSG-${id}`, authorId: actorIds[stage], body: 'We received your report. Reply here if you have more details.', at }] }
  }
  const reports = [report('RPT-0241', 'QCU-STU-IT-A', 'adviser'), report('RPT-0242', 'QCU-STU-IT-A', 'chair', true), report('RPT-0243', 'QCU-STU-IT-B', 'dean'), report('RPT-0244', 'QCU-STU-RESTRICTED', 'guidance'), report('RPT-0245', 'QCU-STU-IT-A', 'guidance', false, true), report('RPT-0246', 'QCU-STU-IT-A', 'osas', false, true), report('RPT-0247', 'QCU-STU-IT-B', 'osas', false, true), report('RPT-0248', 'QCU-STU-CS', 'chair')]
  reports[0]!.sourcePostId = 'POST-0102'
  const questions: Question[] = [{ id: 'Q1', criterion: 'Clarity', text: 'Explains concepts and requirements clearly.', type: 'rating', required: true }, { id: 'Q2', criterion: 'Support', text: 'Helps students who ask for support.', type: 'rating', required: true }, { id: 'Q3', criterion: 'Fairness', text: 'Explains how work will be graded and grades it the same way each time.', type: 'rating', required: true }]
  const cycles: Cycle[] = [{ id: 'CYCLE-2026-1', title: '1st Semester AY 2026-2027', term: '1st Semester', opens: '2026-10-01', closes: '2026-11-30', status: 'Published', instructions: 'Rate each statement from 1 to 5 based on this semester.', questions, forms: ['student'], resultsPublished: true, reviews: [{ userId: 'QCU-PROF-IT', decision: 'reviewed', note: 'Questions fit the listed duties.', at }] }, { id: 'CYCLE-2026-2', title: '2nd Semester AY 2026-2027 draft', term: '2nd Semester', opens: '2027-01-10', closes: '2027-03-30', status: 'In review', instructions: 'Read the proposed questions. Tell the Dean\'s Office if any do not fit your duties.', questions: structuredClone(questions), forms: ['student'], resultsPublished: false, reviews: [] }]
  const assignments: Assignment[] = [
    { id: 'EVAL-STU-IT-1', evaluatorId: 'QCU-STU-IT-A', facultyId: 'QCU-PROF-IT', cycleId: 'CYCLE-2026-1', relation: 'Student to faculty', subject: 'Data Structures · BSIT 3A' },
    { id: 'EVAL-STU-IT-2', evaluatorId: 'QCU-STU-RESTRICTED', facultyId: 'QCU-PROF-IT', cycleId: 'CYCLE-2026-1', relation: 'Student to faculty', subject: 'Data Structures · BSIT 3A' },
    { id: 'EVAL-STU-B-1', evaluatorId: 'QCU-STU-IT-B', facultyId: 'QCU-PROF-OTHER', cycleId: 'CYCLE-2026-1', relation: 'Student to faculty', subject: 'BSIT 3B class' },
    { id: 'EVAL-STU-CS-1', evaluatorId: 'QCU-STU-CS', facultyId: 'QCU-PROF-CS', cycleId: 'CYCLE-2026-1', relation: 'Student to faculty', subject: 'BSCS 2A class' },
  ]
  assignments.push({ id: 'EVAL-REVIEW-IT', evaluatorId: 'QCU-STU-IT-A', facultyId: 'QCU-PROF-IT', cycleId: 'CYCLE-2026-2', relation: 'Student to faculty', subject: 'Draft form for 2nd Semester' }, { id: 'EVAL-REVIEW-OTHER', evaluatorId: 'QCU-STU-IT-B', facultyId: 'QCU-PROF-OTHER', cycleId: 'CYCLE-2026-2', relation: 'Student to faculty', subject: 'Draft form for 2nd Semester' })
  for (const faculty of users.filter(u => u.roles.some(r => ['professor', 'chair', 'dean'].includes(r)))) for (let n = 0; n < 5; n++) assignments.push({ id: `EVAL-SAMPLE-${faculty.id}-${n}`, evaluatorId: `SAMPLE-EVALUATOR-${n}`, facultyId: faculty.id, cycleId: 'CYCLE-2026-1', relation: 'Student to faculty', subject: 'Course evaluation', answers: { Q1: n % 2 ? 4 : 5, Q2: 4, Q3: n % 2 ? 5 : 4 }, submittedAt: at, comment: '' })
  const restrictions: Restriction[] = [{ id: 'RST-0101', studentId: 'QCU-STU-RESTRICTED', features: ['post.create', 'post.comment', 'report.anonymous'], basis: 'OSAS decision on file', decisionReference: 'QCU-DEC-001', starts: at, until: '2026-12-01', actorId: 'QCU-ADMIN', active: true }]
  return {
    users, spaces, organizations: [{ id: 'ORG-COMPUTING', name: 'CCS Computing Society', description: 'Student organization of the College of Computer Studies. Runs workshops and peer tutoring.', representativeId: 'QCU-ORG', memberIds: ['QCU-STU-IT-A'] }], posts, reports, drafts: {},
    threads: [
      {
        id: 'THREAD-IT-A',
        title: 'BSIT 3A class group',
        memberIds: ['QCU-STU-IT-A', 'QCU-STU-RESTRICTED', 'QCU-PROF-IT'],
        spaceId: 'SPACE-IT-A',
        messages: [{ id: 'MESSAGE-0101', authorId: 'QCU-PROF-IT', body: 'Use this group for room changes and class reminders. Message me directly for anything personal.', at }],
        mutedBy: [],
        readMessageCounts: { 'QCU-PROF-IT': 1 },
      },
      {
        id: 'THREAD-DIRECT-1',
        title: 'Academic consultation',
        memberIds: ['QCU-STU-IT-A', 'QCU-PROF-IT'],
        messages: [{ id: 'MESSAGE-0102', authorId: 'QCU-STU-IT-A', body: 'Good afternoon, Prof. Is there an appointment slot this week? I want to go over the project rubric.', at }],
        mutedBy: [],
        readMessageCounts: { 'QCU-STU-IT-A': 1 },
      },
      {
        id: 'THREAD-FACULTY-1',
        title: 'Faculty coordination',
        memberIds: ['QCU-CHAIR-IT', 'QCU-PROF-IT'],
        messages: [{ id: 'MESSAGE-0103', authorId: 'QCU-CHAIR-IT', body: 'Please read the consultation week announcement before Thursday.', at }],
        mutedBy: [],
        readMessageCounts: { 'QCU-CHAIR-IT': 1 },
      },
    ],
    slots: [{ id: 'SLOT-0101', facultyId: 'QCU-PROF-IT', date: '2026-10-29', start: '10:00', end: '10:30', state: 'open' }, { id: 'SLOT-0102', facultyId: 'QCU-PROF-IT', date: '2026-10-29', start: '10:30', end: '11:00', state: 'requested' }, { id: 'SLOT-0103', facultyId: 'QCU-PROF-IT', date: '2026-10-30', start: '13:00', end: '14:00', state: 'unavailable' }, { id: 'SLOT-0104', facultyId: 'QCU-PROF-OTHER', date: '2026-10-29', start: '09:00', end: '09:30', state: 'open' }, { id: 'SLOT-0105', facultyId: 'QCU-PROF-CS', date: '2026-10-29', start: '11:00', end: '11:30', state: 'open' }, { id: 'SLOT-0106', facultyId: 'QCU-CHAIR-IT', date: '2026-10-30', start: '10:00', end: '10:30', state: 'open' }],
    consultations: [{ id: 'CONSULT-0101', studentId: 'QCU-STU-IT-A', facultyId: 'QCU-PROF-IT', slotId: 'SLOT-0102', purpose: 'Clarify the Data Structures project rubric', status: 'Requested', createdAt: at, updatedAt: at, history: [{ at, status: 'Requested', note: 'Request received', actorId: 'QCU-STU-IT-A' }] }],
    todos: [{ id: 'TODO-0101', ownerId: 'QCU-STU-IT-A', title: 'Prepare appointment questions', date: '2026-10-29', done: false }], events: [{ id: 'EVENT-0101', title: 'CCS appointment week', date: '2026-10-29', start: '08:00', end: '17:00', type: 'CCS', description: 'Faculty hold open appointment times. Request a time under Appointments.', contactId: 'QCU-SECRETARY' }, { id: 'EVENT-0102', title: 'Intro to Git workshop', date: '2026-11-05', start: '13:00', end: '15:00', type: 'Organization', description: 'Open to all CCS students. Bring your laptop.', contactId: 'QCU-ORG', organizationId: 'ORG-COMPUTING', place: 'IC 305' }, { id: 'EVENT-0103', title: 'Midterm grade submission', date: '2026-11-09', start: '08:00', end: '09:00', type: 'Academic year', description: 'Faculty submit midterm grades to the Dean\'s Office.', contactId: 'CCS-DEAN' }], cycles, assignments, restrictions, referrals: [], offenses: [{ id: 'OFF-0101', studentId: 'QCU-STU-RESTRICTED', level: 1, summary: 'Unauthorized use of a lab computer. First offense, decision recorded by OSAS.', decisionReference: 'QCU-DEC-001', actorRole: 'osas', at, status: 'Recorded' }], strikes: [], strikeSettlements: [], materials: [], loadSchedules: [], goodMoral: [],
    clusters: [{ id: 'CLUSTER-0101', program: 'BSIT', title: 'Lab schedule changes', reportIds: ['RPT-0241', 'RPT-0242', 'RPT-0243'], similarity: 86, supporting: 'Reports say students could not plan their lab work after the timetable changed.', dissenting: 'One report says a corrected notice was posted later.', phrases: ['lab timetable', 'schedule changes'], status: 'To review', history: [] }],
    notifications: users.map((u, index) => ({ id: `NOTIF-${index + 1}`, recipientId: u.id, kind: 'announcement', title: 'New college announcement', body: 'Open the feed to read it.', priority: 'normal', pageId: 'P04', at, read: false })),
    audit: [{ id: 'AUDIT-QCU-1', at, actorId: 'ACCS-ADMIN', action: 'Accounts loaded', module: 'identity', reference: 'QCU-ACCOUNTS', result: 'Recorded' }],
    moderation: [{ id: 'MOD-0101', itemType: 'comment', itemId: 'COMMENT-0101', parentId: 'POST-0102', authorId: 'QCU-STU-IT-B', reporterId: 'QCU-STU-IT-A', source: 'User', reason: 'Reported by a classmate as off-topic', excerpt: 'Same problem in BSIT 3B. A posted lab schedule would help us plan.', status: 'Pending', at, history: [] }], settings: {}, permissionOverrides: {}, telemetry: [], followUps: [],
  }
}
/** The seeded accounts that sign in with the shared seed password until they set their own. Inactive ones (the secretary) never do. */
export const demoUserIds: ReadonlySet<string> = new Set(seed().users.filter(u => u.active).map(u => u.id))
const sampleEmails = new Map(seed().users.map(u => [u.id, u.email.toLowerCase()]))
/**
 * A seeded account that still has its made-up address. Such an account is never emailed, because the address may belong to
 * someone else. Once a real address is set (the Dean through the System Administrator, the Secretary through the Dean), the
 * account gets email like any other.
 */
export const isSampleAddress = (userId: string, email: string) => sampleEmails.get(userId) === email.toLowerCase()
