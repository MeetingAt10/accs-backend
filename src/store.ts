import { consentWording } from './consent.js'
import { env } from './env.js'
import { facultyRoster } from './faculty-roster.js'
import { ulid } from './ids.js'
import type { Decision } from './escalation/engine.js'
import { formerAccountIds } from './renames.js'
import type { ReactionKind, Role, TalkMode, User } from './schemas.js'

// The President's Office stage (`executive`) was restored on 2026-11-24 to match the paper (Chapter 1, Significance): OSAS
// forwards executive-level cases to the Office of the University President, which can return them to OSAS.
export type Stage = 'adviser' | 'chair' | 'dean' | 'guidance' | 'osas' | 'executive'
/** A file sent with a message. It lives in the files bucket under `key`, which only the server knows. */
export type Attachment = { id: string; fileName: string; contentType: string; size: number; key: string }
/** `editedAt` and `deleted`: the author changed or took back the message (decided 19 November 2026). */
export type Message = { id: string; authorId: string; body: string; at: string; attachments?: Attachment[]; editedAt?: string; deleted?: boolean }
export type History = { id: string; at: string; actorId: string; actorRole: string; action: string; reason: string; update: string; public: boolean; stage: Stage }
/** The student's agreement to send a concern, stamped by the server with the exact wording they were shown. */
export type ReportConsent = { readStatement: true; at: string; userId: string; version: string; wording: string }
/** One agreement to talk in one way. A student who changes the way adds another; earlier ones stay. */
export type TalkConsent = { mode: TalkMode; participate: true; recordCall?: boolean; wording: string; at: string }
/** How the student and the office handling the concern talk. `meetingLink` (video, voice) and `place` (face to face) are added by that office. */
export type Talk = { mode: TalkMode; consents: TalkConsent[]; slotId?: string; consultationId?: string; preferredAt?: string; scheduledAt?: string; meetingLink?: string; place?: string; updatedAt: string }
/**
 * `aboutAdvisor` is true when the concern goes around the adviser: the student said so, or the adviser is named in it.
 * Then the adviser never sees it. `allowChair` and `allowDean` are the student's choice under a consent wording older than
 * 2026-11-11: on such a report an office they did not allow cannot read the concern (access.ts `earlierConsent`). Under the
 * current wording the Program Chair and the Dean read every concern in scope.
 */
/**
 * A concern a student filed, or (source 'faculty', decided 12 November 2026) a report a faculty member filed about a student.
 * For a faculty report the owner is the faculty member, the reported student is `reportedStudentId` and is in `involvedUserIds`,
 * and there is no consent or talk mode. Stored reports without `source` are students' concerns.
 * `routing` is the escalation engine's record of why the concern went where it did. Handlers see it; the student does not.
 */
/** `readAt`: when an office handling the report first opened it (the "Read" step the student sees). */
export type Report = { routing?: Decision['trace']; readAt?: string; id: string; ownerId: string; program: string; adviserId?: string; stage: Stage; status: string; narrative: string; category: string; subcategory?: string; categoryDetail?: string; severity: 'low' | 'medium' | 'high'; identity: 'named' | 'anonymous'; alias: string; disclosedTo: string[]; involvedUserIds: string[]; bypassed: boolean; aboutAdvisor: boolean; allowChair?: boolean; allowDean?: boolean; confidential?: boolean; consent?: ReportConsent; source?: 'student' | 'faculty'; reportedStudentId?: string; talk?: Talk; createdAt: string; updatedAt: string; caseFileId?: string; sourcePostId?: string; location?: string; occurredOn?: string; ongoing?: boolean; history: History[]; notes: Message[]; messages: Message[] }
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
  /** People who reacted before there was a choice of reactions (#86); each counts as "like". */
  reactions: string[]
  /** Each person's reaction, by user ID (#86). */
  reactionsBy?: Record<string, ReactionKind>
  comments: (Message & { anonymous: boolean; reactionsBy?: Record<string, ReactionKind> })[]
  /** Pictures and files posted with it. */
  attachments?: Attachment[]
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
/** `positions` holds each member's title in the organization, like President or VP for Information, set by the organization account. */
export type Organization = { id: string; name: string; description: string; representativeId: string; memberIds: string[]; positions?: Record<string, string> }
export type Thread = {
  id: string
  title: string
  memberIds: string[]
  spaceId?: string
  /** A group conversation someone started from Messages, with the name they gave it (decided 16 November 2026). */
  group?: boolean
  messages: Message[]
  mutedBy: string[]
  readMessageCounts: Record<string, number>
}
/** `reason` is set when the faculty member marks the time not available (#32); entries stored before that have none. */
export type Slot = { id: string; facultyId: string; date: string; start: string; end: string; state: 'open' | 'requested' | 'booked' | 'unavailable'; reason?: string }
/** `slotDate`/`slotStart`/`slotEnd` copy the booked time, so the appointment still says when it was if that time is later changed or removed. */
export type Consultation = { id: string; studentId: string; facultyId: string; slotId: string; slotDate?: string; slotStart?: string; slotEnd?: string; /** The concern this time is for, when the student booked it to talk about one. */ reportId?: string; purpose: string; category?: string; subcategory?: string; details?: string; status: 'Requested' | 'Approved' | 'Booked' | 'Completed' | 'Declined' | 'Cancelled'; createdAt: string; updatedAt: string; history: { at: string; status: string; note: string; actorId: string }[] }
export type Question = { id: string; criterion: string; text: string; type: 'rating' | 'text'; required: boolean }
export type Cycle = { id: string; title: string; term: string; opens: string; closes: string; status: 'Draft' | 'In review' | 'Published' | 'Closed'; instructions: string; questions: Question[]; forms: string[]; resultsPublished: boolean; reviews: { userId: string; decision: string; note: string; at: string }[] }
export type Assignment = { id: string; evaluatorId: string; facultyId: string; cycleId: string; relation: string; subject: string; answers?: Record<string, string | number>; comment?: string; submittedAt?: string }
export type Restriction = { id: string; studentId: string; features: string[]; basis: string; decisionReference: string; starts: string; until: string; actorId: string; active: boolean }
/** A change request to a student's restrictions. `handledAt`/`handledBy` are set when the administrator acts on that student's restrictions. */
export type Referral = { id: string; studentId: string; change: string; decisionReference: string; reason: string; actorId: string; at: string; status: string; handledAt?: string; handledBy?: string }
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
export type Notification = { id: string; recipientId: string; kind: string; title: string; body: string; priority: string; pageId: string; recordId?: string; at: string; read: boolean; /** The message a message notification previews. */ itemId?: string }
export type Audit = { id: string; at: string; actorId: string; action: string; module: string; reference: string; result: string; purpose?: string; reason?: string }
export type Moderation = { id: string; itemType: 'post' | 'comment' | 'message'; itemId: string; parentId: string; authorId: string; reporterId?: string; source: 'Filter' | 'User'; reason: string; excerpt: string; status: string; at: string; history: { at: string; actorId: string; decision: string; reason: string }[] }
export type Database = {
  users: User[]; spaces: Space[]; organizations: Organization[]; posts: Post[]; threads: Thread[]; slots: Slot[]; consultations: Consultation[]; reports: Report[]; drafts: Record<string, Record<string, unknown>>; todos: { id: string; ownerId: string; title: string; date: string; done: boolean }[];
  events: Event[]; cycles: Cycle[]; assignments: Assignment[]; restrictions: Restriction[]; referrals: Referral[]; strikes: Strike[]; strikeSettlements: StrikeSettlement[]; materials: Material[]; loadSchedules: LoadEntry[]; offenses: { id: string; studentId: string; level: number; summary: string; decisionReference: string; actorRole: string; at: string; status: string }[]; goodMoral: { studentId: string; status: string; decisionSource: string; notes: string; actorId: string; at: string }[]; clusters: { id: string; program: string; title: string; reportIds: string[]; similarity: number; supporting: string; dissenting: string; phrases: string[]; status: string; history: { at: string; actorId: string; decision: string; reason: string }[] }[]; notifications: Notification[]; audit: Audit[]; moderation: Moderation[]; photos: Record<string, string>; settings: Record<string, { theme: string; density: string; priorities: Record<string, string> }>; permissionOverrides: Record<string, PermissionOverride | boolean>; telemetry: { id: string; at: string; category: string; durationMs: number; success: boolean }[]; followUps: { id: string; facultyId: string; actorId: string; note: string; at: string }[];
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
  fileName?: string; contentType?: string; size?: number; key?: string; status?: 'pending' | 'ready'
  /** Questions and replies from the subject's students and professors. */
  comments?: Message[] }
/**
 * A permission change for one role ("role:permission"), decided 20 November 2026: proposed by someone who manages roles,
 * approved or rejected by the Secretary (or the administrator, for the Secretary's own requests). `approved` is the value
 * in force; a new proposal waits beside it. A bare boolean is a proposal stored before approvals existed.
 */
export type PermissionOverride = {
  approved?: boolean
  proposal?: { allowed: boolean; by: string; at: string; reason?: string }
  decisions: { at: string; by: string; decision: 'Approved' | 'Rejected'; allowed: boolean; reason?: string }[]
}
export type Collection = 'reports' | 'consultations' | 'slots' | 'threads' | 'notifications' | 'audit' | 'posts' | 'moderation' | 'drafts' | 'events' | 'todos' | 'cycles' | 'assignments' | 'followUps' | 'restrictions' | 'referrals' | 'strikes' | 'strikeSettlements' | 'materials' | 'loadSchedules' | 'goodMoral' | 'clusters' | 'settings' | 'photos' | 'permissionOverrides' | 'telemetry' | 'organizations'
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

// Seeded demo accounts get made-up addresses on access-ccs.com, the domain we own and send from (#69). Until 13 November
// 2026 they were on qcu.edu.ph, QCU's real domain, where a made-up address could belong to a real person.
export const seedDomain = 'access-ccs.com'
const seedLocalPart = (id: string) => id.toLowerCase().replaceAll('qcu-', '').replaceAll('-', '.')
function user(id: string, name: string, roles: Role[], extra: Partial<User> = {}): User { return { id, name, email: `${seedLocalPart(id)}@${seedDomain}`, roles, restrictions: [], title: roles.includes('student') ? 'CCS student' : 'CCS personnel', bio: roles.includes('student') ? 'Student, QCU College of Computer Studies.' : 'QCU College of Computer Studies.', education: roles.includes('student') ? 'Quezon City University' : 'Quezon City University, College of Computer Studies', officeHours: 'By appointment. Request a time under Appointments.', spaceIds: [], organizationIds: [], active: true, ...extra } }
/** The account shape with its default profile text, for accounts created after the seed. */
export const newUser = user
const at = '2026-10-20T02:00:00.000Z'
/** Real CCS personnel (src/faculty-roster.ts) are seeded on every stack, production included, unless SEED_ROSTER=false. */
export const seedRoster = env.SEED_ROSTER === 'true'
const deanRosterId = 'QCU-FAC-PAULA-DELACRUZ'
export function seed(includeRoster = seedRoster): Database {
  const users: User[] = [
    user('QCU-STU-IT-A', 'Demo Student Foxtrot', ['student'], { campus: 'SB', program: 'BSIT', section: 'A', year: 3, studentId: '24-0101', adviserId: 'QCU-PROF-IT', spaceIds: ['SPACE-IT-A', 'SUBJECT-IT-DS'], organizationIds: ['ORG-COMPUTING', 'ORG-JPCS'] }),
    user('QCU-STU-IT-B', 'Demo Student Golf', ['student'], { campus: 'SB', program: 'BSIT', section: 'B', year: 3, studentId: '24-0102', adviserId: 'QCU-PROF-OTHER', spaceIds: ['SPACE-IT-B'], organizationIds: ['ORG-LESIT', 'ORG-JPCS'] }),
    user('QCU-STU-CS', 'Demo Student Hotel', ['student'], { campus: 'SB', program: 'BSCS', section: 'A', year: 2, studentId: '25-0201', adviserId: 'QCU-PROF-CS', spaceIds: ['SPACE-CS-A'], organizationIds: ['ORG-MSC', 'ORG-AWS'] }),
    user('QCU-STU-RESTRICTED', 'Demo Student India', ['student'], { campus: 'SB', program: 'BSIT', section: 'A', year: 3, studentId: '24-0103', adviserId: 'QCU-PROF-IT', spaceIds: ['SPACE-IT-A', 'SUBJECT-IT-DS'], restrictions: ['post.create', 'post.comment', 'report.anonymous'] }),
    user('QCU-ORG', 'Demo Organization Rep', ['organization'], { organizationId: 'ORG-COMPUTING', organizationIds: ['ORG-COMPUTING'], office: 'CCS Organizations', title: 'Organization representative' }),
    user('QCU-ORG-LESIT', 'Demo LESIT Rep', ['organization'], { organizationId: 'ORG-LESIT', organizationIds: ['ORG-LESIT'], office: 'CCS Organizations', title: 'Organization representative' }),
    user('QCU-ORG-JPCS', 'Demo JPCS QCU Rep', ['organization'], { organizationId: 'ORG-JPCS', organizationIds: ['ORG-JPCS'], office: 'CCS Organizations', title: 'Organization representative' }),
    user('QCU-ORG-MSC', 'Demo MSC QCU Rep', ['organization'], { organizationId: 'ORG-MSC', organizationIds: ['ORG-MSC'], office: 'CCS Organizations', title: 'Organization representative' }),
    user('QCU-ORG-AWS', 'Demo AWS SBG QCU Rep', ['organization'], { organizationId: 'ORG-AWS', organizationIds: ['ORG-AWS'], office: 'CCS Organizations', title: 'Organization representative' }),
    user('QCU-PROF-IT', 'Demo Professor Charlie', ['professor'], { program: 'BSIT', office: 'CCS Faculty Room', title: 'Faculty, BSIT adviser', bio: 'Teaches Data Structures and advises BSIT 3A.', officeHours: 'Thursdays, 10:00 AM to 12:00 PM, CCS Faculty Room', spaceIds: ['SPACE-IT-A', 'SUBJECT-IT-DS'] }),
    user('QCU-PROF-OTHER', 'Demo Professor Delta', ['professor'], { program: 'BSIT', office: 'CCS Faculty Room', title: 'Faculty, BSIT', bio: 'Advises BSIT 3B.', officeHours: 'Thursdays, 9:00 AM to 11:00 AM, CCS Faculty Room', spaceIds: ['SPACE-IT-B'] }),
    user('QCU-PROF-CS', 'Demo Professor Echo', ['professor'], { program: 'BSCS', office: 'CCS Faculty Room', title: 'Faculty, BSCS', bio: 'Advises BSCS 2A.', officeHours: 'Thursdays, 11:00 AM to 1:00 PM, CCS Faculty Room', spaceIds: ['SPACE-CS-A'] }),
    user('QCU-CHAIR-IT', 'Demo Chair Alpha', ['chair', 'professor'], { program: 'BSIT', office: 'BSIT Program Office', title: 'BSIT Program Chair and faculty', officeHours: 'Fridays, 10:00 AM to 12:00 PM, BSIT Program Office', spaceIds: ['SUBJECT-IT-DS'] }),
    user('QCU-CHAIR-CS', 'Demo Chair Bravo', ['chair'], { program: 'BSCS', office: 'BSCS Program Office', title: 'BSCS Program Chair' }),
    // With the roster seeded, Dr. Paula Joy L. Dela Cruz is the Dean and this demo Dean is inactive (the record stays for seeded history).
    user('CCS-DEAN', 'Demo Dean', ['dean'], { active: !includeRoster, email: `dean@${seedDomain}`, office: 'CCS Dean\'s Office', title: 'Dean, College of Computer Studies', officeHours: 'Weekdays, 9:00 AM to 4:00 PM, Dean\'s Office' }),
    user('ACCS-ADMIN', 'Demo Administrator', ['administrator'], { email: 'admin@access-ccs.com', office: 'ACCS system administration', title: 'ACCS System Administrator' }),
    user('QCU-GUIDANCE', 'Demo Guidance Officer', ['guidance'], { office: 'Guidance Office', title: 'Guidance officer', officeHours: 'Weekdays, 9:00 AM to 4:00 PM' }),
    user('QCU-OSAS', 'Demo OSAS Officer', ['osas'], { office: 'Office of Student Affairs and Services', title: 'OSAS officer', officeHours: 'Weekdays, 9:00 AM to 4:00 PM' }),
    user('QCU-PRESIDENT', 'Demo President’s Office Staff', ['president'], { office: 'Office of the University President', title: 'Staff, Office of the University President' }),
    // Inactive until the Dean activates it. The email is a placeholder: activation can replace it.
    user('QCU-SECRETARY', 'CCS Secretary', ['secretary'], { active: false, email: 'secretary@example.invalid', office: 'CCS Office', title: 'CCS secretary', officeHours: 'Monday to Friday, 8:00 AM to 5:00 PM' }),
  ]
  const spaces: Space[] = [
    { id: 'SPACE-IT-A', title: 'SBIT3A', program: 'BSIT', section: 'A', campus: 'SB', year: 3, subject: 'Section group', professorIds: ['QCU-PROF-IT'], studentIds: ['QCU-STU-IT-A', 'QCU-STU-RESTRICTED'] },
    { id: 'SUBJECT-IT-DS', title: 'Data Structures, SBIT3A', program: 'BSIT', section: 'A', campus: 'SB', year: 3, subject: 'CC 104 Data Structures', professorIds: ['QCU-PROF-IT', 'QCU-CHAIR-IT'], studentIds: ['QCU-STU-IT-A', 'QCU-STU-RESTRICTED'] },
    { id: 'SPACE-IT-B', title: 'SBIT3B', program: 'BSIT', section: 'B', campus: 'SB', year: 3, subject: 'Section group', professorIds: ['QCU-PROF-OTHER'], studentIds: ['QCU-STU-IT-B'] },
    { id: 'SPACE-CS-A', title: 'SBCS2A', program: 'BSCS', section: 'A', campus: 'SB', year: 2, subject: 'Section group', professorIds: ['QCU-PROF-CS'], studentIds: ['QCU-STU-CS'] },
  ]
  // Demo content: the QCU College of Computer Studies, San Bartolome campus, 1st semester AY 2026-2027. The seed was written on 25 November 2026.
  const t = (date: string, time = '02:00') => `${date}T${time}:00.000Z`
  const post = (id: string, authorId: string, title: string, body: string, audience = 'college', anonymous = false, kind: Post['kind'] = 'discussion', when = at, extra: Partial<Post> = {}): Post => ({ id, authorId, title, body, audience, anonymous, kind, label: kind === 'announcement' ? 'Announcement' : 'Discussion', priority: 'general', private: audience.startsWith('organization:'), at: when, reactions: [], comments: [], removed: false, ...extra })
  const orgOpen = (id: string, authorId: string, orgId: string, title: string, body: string, kind: Post['kind'], when: string, extra: Partial<Post> = {}) => post(id, authorId, title, body, `organization:${orgId}`, false, kind, when, { private: false, ...extra })
  const posts = [
    post('POST-0101', 'CCS-DEAN', 'Appointment week starts October 29', 'Faculty appointment times open October 29 at the CCS Faculty Room. Request a time under Appointments and wait for your professor to confirm.', 'college', false, 'announcement', t('2026-10-20')),
    post('POST-0102', 'QCU-STU-IT-A', 'Is IC 301 open for our group activity?', 'The lab timetable changed on Monday. Which IC 301 slots are free next week? Our group needs two hours for the Data Structures activity.', 'program:BSIT', true, 'discussion', t('2026-10-14', '08:30')),
    post('POST-0103', 'QCU-PROF-IT', 'Data Structures practice set', 'The practice set on linked lists, stacks and queues is posted. Bring your questions to our next meeting in IC 301. Expect a short quiz on stacks and queues.', 'space:SUBJECT-IT-DS', false, 'announcement', t('2026-10-12', '03:00')),
    post('POST-0104', 'QCU-ORG', 'Workshop agenda draft', 'Members, please read the draft agenda for the Intro to Git workshop and send corrections before Friday.', 'organization:ORG-COMPUTING', false, 'discussion', t('2026-10-26', '06:00')),
    orgOpen('POST-0105', 'QCU-ORG', 'ORG-COMPUTING', 'Intro to Git workshop', 'Open to all CCS students. November 5, 1:00 PM to 3:00 PM at IC 305. Bring your laptop. We cover commits, branches and pull requests.', 'discussion', t('2026-10-27', '04:00'), { eventDate: '2026-11-05', eventTime: '13:00', eventPlace: 'IC 305', eventContact: 'QCU-ORG' }),
    post('POST-0106', 'QCU-PROF-IT', 'Faculty meeting items', 'Add items for the semester coordination meeting before Monday: midterm grade submission, faculty evaluation, and defense panel schedules.', 'faculty', false, 'discussion', t('2026-11-02', '05:00')),
    post('POST-0107', 'CCS-DEAN', 'Foundation Course on Intellectual Property for 3rd-year students', 'All 3rd-year CCS students are to attend the Foundation Course on Intellectual Property, organized by the QCU Innovation and Technology Support Office (QCU-ITSO). It covers patents, trademarks and copyright, and how they apply to software and capstone projects. The schedule is under Events.', 'college', false, 'announcement', t('2026-11-03', '01:30'), { eventDate: '2026-12-03', eventTime: '09:00', eventPlace: 'San Bartolome campus, venue to be posted', eventContact: 'CCS-DEAN', notifyMembers: true, priority: 'important' }),
    post('POST-0108', 'CCS-DEAN', 'Faculty evaluation is open until November 30', 'Students: rate your professors under Evaluations. It takes about five minutes per class and your answers are anonymous to the professor.', 'college', false, 'announcement', t('2026-10-01', '01:00')),
    post('POST-0109', 'QCU-ORG-AWS', 'SANDBOX 2026: a two-day buildathon', 'AWS Student Builder Group QCU invites you to SANDBOX 2026. Over two days you pick a real-world problem, build a working solution and pitch it to judges. Pick one track and one format and that is your build. Top 5 teams get plaques and certificates, and the 4th and 5th place teams also win cash prizes. Open to all universities, limited slots. Register as solo, duo or trio; fees are paid per person.', 'college', false, 'announcement', t('2026-11-09', '02:00'), { eventDate: '2026-12-05', eventTime: '08:00', eventPlace: 'San Bartolome campus', eventContact: 'QCU-ORG-AWS', priority: 'important' }),
    post('POST-0110', 'QCU-ORG-AWS', 'SANDBOX 2026 FAQs', 'Who can join? Undergraduates from any university, program and year. You do not need to be advanced. Teams have up to 5 members. Register solo, duo or trio and we match you with teammates by Saturday, November 21. What to build: pick a track (Education and Digital Inclusion, Health and Well-being, Civic Innovation and Public Safety, Sustainability and Environment, Economic Empowerment and Livelihood) and a format (web and mobile apps, AI-powered solutions, cloud platforms, analytics, or workflow automation). Deliver a working prototype and a live pitch. Questions? Comment below.', 'college', false, 'discussion', t('2026-11-16', '03:00')),
    post('POST-0111', 'QCU-ORG-AWS', 'Teams are matched for SANDBOX 2026', 'Matching is done. Check your email for your team. Kickoff is December 5 at 8:00 AM. Bring a laptop, a charger and an idea you care about.', 'college', false, 'announcement', t('2026-11-23', '07:00')),
    orgOpen('POST-0112', 'QCU-ORG-LESIT', 'ORG-LESIT', 'Information Assurance review session', 'LESIT is holding a free review session for the Information Assurance finals on November 28, 1:00 PM to 4:00 PM at IC 301. Bring your notes. BSIT students first, other programs welcome.', 'announcement', t('2026-11-18', '04:00'), { eventDate: '2026-11-28', eventTime: '13:00', eventPlace: 'IC 301', eventContact: 'QCU-ORG-LESIT' }),
    orgOpen('POST-0113', 'QCU-ORG-JPCS', 'ORG-JPCS', 'Tech talk: from prompt to product', 'JPCS QCU Chapter hosts a tech talk on building software with AI tools, with a practitioner from the industry. December 1, 2:00 PM. Our industry visit is on December 11; sign-up opens after the talk.', 'announcement', t('2026-11-17', '05:00'), { eventDate: '2026-12-01', eventTime: '14:00', eventPlace: 'IC 305', eventContact: 'QCU-ORG-JPCS' }),
    orgOpen('POST-0114', 'QCU-ORG-MSC', 'ORG-MSC', 'Azure and Power Platform study jam', 'Microsoft Student Community QCU runs a study jam on November 27, 1:00 PM to 4:00 PM at IC 305: deploy a small .NET API to Azure, then automate approvals with Power Automate. Bring your laptop.', 'announcement', t('2026-11-19', '06:00'), { eventDate: '2026-11-27', eventTime: '13:00', eventPlace: 'IC 305', eventContact: 'QCU-ORG-MSC' }),
    post('POST-0115', 'QCU-PROF-CS', 'Web Systems: milestone 2 is due December 4', 'Milestone 2 covers the REST API and authentication. Submit the repository link in our class group before 11:59 PM on December 4. Lab time is Wednesdays in IC 305.', 'space:SPACE-CS-A', false, 'announcement', t('2026-11-20', '03:00')),
    post('POST-0116', 'QCU-PROF-OTHER', 'Capstone Project 1: title defense schedule posted', 'The title defense schedule for SBIT3B is on the board outside the Faculty Room. Defenses run December 7 to 9. Send your revised title and abstract to your adviser by December 1.', 'space:SPACE-IT-B', false, 'announcement', t('2026-11-21', '04:00')),
    post('POST-0117', 'QCU-CHAIR-IT', 'OJT requirements for 3rd-year BSIT students', 'Prepare your OJT requirements now: endorsement letter request, medical certificate and parent consent. Endorsement letters are requested at the BSIT Program Office starting December 7. Bring a printed copy of your grades.', 'program:BSIT', false, 'announcement', t('2026-11-10', '02:30')),
    post('POST-0118', 'CCS-DEAN', 'Final exams, clearance and grades', 'Final examinations run December 14 to 19. Clearance signing starts December 7 at the CCS Office. Grades can be viewed in the student portal after faculty submit them, expected by December 22.', 'college', false, 'announcement', t('2026-11-23', '01:00'), { priority: 'important' }),
    post('POST-0119', 'QCU-STU-CS', 'Where do we get the BSCS clearance form?', 'Is the clearance form downloaded from the portal or picked up at the CCS Office? Also, does the library clearance come first?', 'program:BSCS', false, 'discussion', t('2026-11-22', '09:00')),
    post('POST-0120', 'QCU-STU-IT-B', 'Looking for teammates for SANDBOX 2026', 'I will register as a solo and I am okay with any track. I can do the backend in Node. Anyone from BSIS or BSCS who wants to team up?', 'college', false, 'discussion', t('2026-11-17', '12:00')),
    post('POST-0121', 'CCS-DEAN', 'Online meeting for 4th-year students with remaining subjects', 'To all 4th-year CCS students with 1 to 4 subjects remaining or left behind, besides the 2nd-semester capstone and practicum subjects: attend the online meeting on Tuesday, August 18, 1:00 PM via Google Meet. Attendance is highly encouraged. Please be guided accordingly.', 'college', false, 'announcement', t('2026-08-17', '01:00')),
    post('POST-0122', 'CCS-DEAN', 'Schedule for the adjustment period', 'The adjustment period for the College of Computer Studies is on Tuesday, August 25, 2026. Bring your registration form and your list of dropped or added subjects.', 'college', false, 'announcement', t('2026-08-24', '02:00')),
    post('POST-0123', 'CCS-DEAN', 'Freshman orientation, AY 2026-2027', 'Freshman orientation is from 8:00 AM to 12:00 NN. San Bartolome campus: September 1 to 3. The College of Computer Studies and the College of Education are on September 2. Dates and venues differ per campus, so check the posters.', 'college', false, 'announcement', t('2026-08-27', '02:00')),
    post('POST-0124', 'CCS-DEAN', 'Patent and Claim Drafting Workshop for 4th-year students', 'Attention CCS 4th-year students: a workshop on intellectual property, patent preparation and claim drafting is on September 15 and 16, 2026, at Bautista Building, Room 603. Send 2 representatives per capstone group and register through the Google Form.', 'college', false, 'announcement', t('2026-09-07', '02:00'), { eventDate: '2026-09-15', eventTime: '09:00', eventPlace: 'Bautista Building, Room 603', eventContact: 'CCS-DEAN' }),
    post('POST-0125', 'QCU-CHAIR-IT', 'Claim workshop: participants list and slots', 'The list of registered participants is posted at the BSIT Program Office. Slots are now full. The program for each day is shared in the group chat of each capstone group.', 'program:BSIT', false, 'announcement', t('2026-09-11', '03:00')),
    post('POST-0126', 'QCU-CHAIR-IT', 'Capstone groups: resubmit your soft copy', 'Some capstone groups did not submit the soft copy through the designated Google Drive link, or the USB file could not be opened. Action required: visit the CCS Faculty Office to resubmit or verify your files. The office is open from 8:00 AM to 3:00 PM only.', 'program:BSIT', false, 'announcement', t('2026-09-18', '02:00')),
    post('POST-0127', 'CCS-DEAN', 'Graduating students: capstone manuscript and clearance', 'Attention graduating students: when submitting the capstone manuscript and graduation clearance requirements, bring the capstone clearance, a copy of the checklist, and the signed forms. Submit at the CCS Office during office hours.', 'college', false, 'announcement', t('2026-09-18', '03:00')),
    post('POST-0128', 'QCU-CHAIR-CS', 'Lost ID found: BSCS', 'A lost student ID of a BSCS student was found. Claim it at IK603, Bautista Building, and bring another valid ID.', 'program:BSCS', false, 'announcement', t('2026-10-05', '02:00')),
    post('POST-0129', 'QCU-OSAS', 'Request to visit OSAS', 'Demo Student Hotel, 2nd-year BSCS, is requested to visit the Office of Student Affairs and Services today. Anyone in contact with the student, please let them know.', 'college', false, 'announcement', t('2026-10-14', '02:00')),
    post('POST-0130', 'QCU-OSAS', 'Request to proceed to OSAS as soon as possible', 'Demo Student Golf, BSIT, is requested to proceed to the Office of Student Affairs and Services as soon as possible. Anyone in contact with the student, please inform them.', 'college', false, 'announcement', t('2026-11-10', '02:00')),
    orgOpen('POST-0131', 'QCU-ORG-AWS', 'ORG-AWS', 'No full team? No problem', 'Register solo or duo and we team you up. Teams have up to 5 members and we name your team for you. Team reveal is on November 21. A full team of 5 pays one fee: 250 pesos for AWS SBG QCU members, 375 pesos for all QCU students, 500 pesos for other universities.', 'announcement', t('2026-11-14', '00:00')),
    orgOpen('POST-0132', 'QCU-ORG-AWS', 'ORG-AWS', 'Build more with Kiro, on us', 'Our major sponsor Kiro, built by AWS, gives 1,000 Kiro credits free to every registered participant, a 20 dollar value. We fully support AI-driven development. Register now and start building.', 'announcement', t('2026-11-14', '09:00')),
  ]
  posts[1]!.comments.push({ id: 'COMMENT-0101', authorId: 'QCU-STU-IT-B', body: 'Same problem in BSIT 3B. A posted lab schedule would help us plan.', anonymous: false, at: t('2026-10-14', '10:00') })
  posts[18]!.comments.push({ id: 'COMMENT-0103', authorId: 'QCU-STU-IT-A', body: 'Download it from the portal, then get the signatures. Library comes first.', anonymous: false, at: t('2026-11-22', '11:00') })
  posts[24]!.comments.push({ id: 'COMMENT-0105', authorId: 'QCU-STU-IT-A', body: 'What time does the workshop start tomorrow?', anonymous: false, at: t('2026-09-11', '09:00') }, { id: 'COMMENT-0106', authorId: 'QCU-CHAIR-IT', body: 'It starts at 9:00 AM. Please arrive by 8:30 for attendance.', anonymous: false, at: t('2026-09-11', '10:00') })
  posts[19]!.comments.push({ id: 'COMMENT-0104', authorId: 'QCU-STU-CS', body: 'I am BSCS 2nd year and registering as a solo too. Let us team up, I can do the UI.', anonymous: false, at: t('2026-11-18', '01:00') })
  const stageRoles: Record<Stage, string> = { adviser: 'professor', chair: 'chair', dean: 'dean', guidance: 'guidance', osas: 'osas', executive: 'president' }
  const actorIds: Record<Stage, string> = { adviser: 'QCU-PROF-IT', chair: 'QCU-CHAIR-IT', dean: 'CCS-DEAN', guidance: 'QCU-GUIDANCE', osas: 'QCU-OSAS', executive: 'QCU-PRESIDENT' }
  const stages: Stage[] = ['adviser', 'chair', 'dean', 'guidance', 'osas', 'executive']
  type ReportExtra = { when?: string; narrative?: string; category?: string; subcategory?: string; severity?: Report['severity']; identity?: Report['identity']; status?: string; note?: string; reply?: string; location?: string; occurredOn?: string }
  function report(id: string, ownerId: string, stage: Stage, bypassed = false, converted = false, x: ReportExtra = {}): Report {
    const owner = users.find(u => u.id === ownerId)!
    const when = x.when ?? at
    const entries = stages.slice(0, stages.indexOf(stage) + 1).filter(s => !bypassed || s !== 'adviser')
    const history = entries.map((s, index): History => ({ id: `H-${id}-${index}`, at: new Date(Date.parse(when) + index * 864e5).toISOString(), actorId: s === 'adviser' ? owner.adviserId! : s === 'chair' && owner.program === 'BSCS' ? 'QCU-CHAIR-CS' : actorIds[s], actorRole: stageRoles[s], action: index === 0 ? 'Submitted' : 'Transferred', reason: 'Routine routing', update: 'The office is reviewing your report.', public: true, stage: s }))
    const last = history[history.length - 1]!.at
    return { id, ownerId, program: owner.program!, adviserId: owner.adviserId!, stage, status: x.status ?? (stage === 'guidance' && converted ? 'Case File at Guidance' : `With ${stage}`), narrative: x.narrative ?? 'The IC 301 lab timetable changed on Monday and nobody told us. Our group missed a scheduled activity. Please look into how lab schedule changes are announced.', category: x.category ?? 'General concern', ...(x.subcategory ? { subcategory: x.subcategory } : {}), severity: x.severity ?? 'medium', identity: x.identity ?? 'anonymous', alias: `Reporter A-${id.slice(-2)}`, disclosedTo: [], involvedUserIds: bypassed ? [owner.adviserId!] : [], bypassed, aboutAdvisor: bypassed, allowChair: true, allowDean: true, consent: { readStatement: true, at: when, userId: ownerId, version: consentWording.version, wording: consentWording.report }, talk: { mode: 'chat', consents: [{ mode: 'chat', participate: true, wording: consentWording.talk.chat, at: when }], updatedAt: when }, createdAt: when, updatedAt: last, ...(x.location ? { location: x.location } : {}), ...(x.occurredOn ? { occurredOn: x.occurredOn } : {}), ...(converted ? { caseFileId: `CF-${id.slice(-4)}` } : {}), history, notes: [{ id: `NOTE-${id}`, authorId: actorIds[stage], body: x.note ?? 'Asked the lab coordinator about the Monday timetable change. Waiting for a reply.', at: last }], messages: [{ id: `MSG-${id}`, authorId: actorIds[stage], body: x.reply ?? 'We received your report. Reply here if you have more details.', at: last }] }
  }
  const reports = [
    report('RPT-0241', 'QCU-STU-IT-A', 'adviser', false, false, { when: t('2026-10-19'), category: 'Facilities', subcategory: 'Classroom or laboratory', location: 'IC 301', occurredOn: '2026-10-19' }),
    report('RPT-0242', 'QCU-STU-IT-A', 'chair', true, false, { when: t('2026-10-16'), category: 'Academic concern', subcategory: 'Class schedule or section', narrative: 'My adviser has not answered two messages about a Data Structures lab that was moved without notice, and I missed the make-up session. I would like the Program Chair to look at how lab changes are communicated.', note: 'Checked the lab timetable with the coordinator. Meeting the adviser this week.', reply: 'The Program Chair received your report and is checking the lab schedule.' }),
    report('RPT-0243', 'QCU-STU-IT-B', 'dean', false, false, { when: t('2026-10-12'), category: 'Facilities', subcategory: 'Classroom or laboratory', severity: 'high', narrative: 'Two BSIT 3B laboratory sessions were cancelled in a row after the IC 301 timetable changed, and no make-up was announced. Several classmates cannot finish the lab requirements before the exams.', note: 'Chair and adviser agreed on make-up sessions. Dean to confirm the room allocation.', reply: 'The Dean is confirming the lab room allocation. We will tell you the make-up dates.' }),
    report('RPT-0244', 'QCU-STU-RESTRICTED', 'guidance', false, false, { when: t('2026-10-05'), category: 'Personal or emotional concern', subcategory: 'Stress or anxiety', severity: 'medium', narrative: 'I have been overwhelmed with deadlines and the restriction on my account. I am not sleeping well and I have trouble focusing in class. I would like to talk to someone.', note: 'Initial check-in done. Weekly sessions offered.', reply: 'The Guidance Office can see you on Tuesday at 10:00 AM. Reply here to confirm.' }),
    report('RPT-0245', 'QCU-STU-IT-A', 'guidance', false, true, { when: t('2026-09-28'), category: 'Faculty or staff conduct', subcategory: 'Unfair grading or treatment', severity: 'medium', narrative: 'My project score in a major subject is lower than posted classmates with the same submission. I asked for the rubric twice and was told to wait. I would like an explanation of how the project was graded.', note: 'Rubric and the graded sheets were requested from the professor for the case file.', reply: 'A case file was opened. Guidance will contact you for an interview.' }),
    report('RPT-0246', 'QCU-STU-IT-A', 'osas', false, true, { when: t('2026-09-14'), category: 'Cyberbullying', subcategory: 'Exclusion from online groups', severity: 'high', narrative: 'A classmate removed me from our group chat for a major project and keeps sharing mocking messages about me in the batch group. This has gone on for three weeks and I do not want to attend the group meetings.', note: 'Screenshots kept in the case file. Both sides are to be interviewed by OSAS.', reply: 'OSAS has the case. You will be called for an interview. Keep copies of the messages.' }),
    report('RPT-0247', 'QCU-STU-IT-B', 'executive', false, true, { when: t('2026-08-31'), category: 'Facilities', subcategory: 'Internet or network', severity: 'high', narrative: 'The network in the BSIT laboratories has been down on and off for a month. Online exams and laboratory activities are failing. Earlier reports to the college did not fix it, and we ask that the university look at it.', note: 'Network upgrade request forwarded with the outage log. Awaiting the Office of the University President.', reply: 'Your concern was forwarded to the Office of the University President with the outage log.' }),
    report('RPT-0248', 'QCU-STU-CS', 'chair', false, false, { when: t('2026-11-04'), category: 'Facilities', subcategory: 'Classroom or laboratory', narrative: 'The IC 305 lab schedule for BSCS 2A changed twice this month and we were told after class had started. Our group missed a graded laboratory activity.' }),
    report('RPT-0251', 'QCU-STU-IT-B', 'adviser', false, false, { when: t('2026-11-16'), category: 'Academic concern', subcategory: 'Grades', severity: 'low', identity: 'named', narrative: 'My Information Assurance midterm score looks lower than the answer key posted in the class group. I would like to request a review of my paper.', note: 'Asked the student to bring the exam paper to the Faculty Room on Thursday.', reply: 'Please bring your midterm paper on Thursday. I will check it against the key with you.' }),
    report('RPT-0252', 'QCU-STU-CS', 'chair', false, false, { when: t('2026-11-09'), category: 'Academic concern', subcategory: 'Class schedule or section', severity: 'low', identity: 'named', narrative: 'My Web Systems laboratory and Discrete Mathematics overlap on Wednesday afternoons, so I miss one of them every week. Can my section assignment be adjusted?', note: 'Checked the section loads. Asked the CCS Office for an open section.', reply: 'The Program Chair is checking whether the other Web Systems section has room.' }),
    report('RPT-0253', 'QCU-STU-IT-A', 'dean', false, false, { when: t('2026-11-02'), category: 'Cyberbullying', subcategory: 'Hurtful messages or comments', severity: 'medium', narrative: 'Members of our capstone group chat keep making sarcastic comments about my work and I was left out of the last two meeting calls. It affects how the group submits our requirements.', note: 'Reviewed the screenshots. Both the adviser and Program Chair advised a group meeting facilitated by Guidance.', reply: 'The Dean is reviewing your report with the screenshots you sent.' }),
    report('RPT-0254', 'QCU-STU-IT-A', 'adviser', false, false, { when: t('2026-10-07'), category: 'Facilities', subcategory: 'Equipment or computers', severity: 'low', status: 'Resolved', narrative: 'The projector in IC 301 does not turn on, so our Data Structures lecture was moved to a different room twice.', note: 'Maintenance replaced the projector cable on October 9.', reply: 'The projector was fixed. Thank you for reporting.' }),
  ]
  reports[0]!.sourcePostId = 'POST-0102'
  // A faculty report (decided 12 November 2026): the professor reports a student, and the case is with the Dean.
  const faculty = Object.assign(report('RPT-0255', 'QCU-CHAIR-IT', 'dean', true, false, { when: t('2026-11-10'), category: 'Other (please specify)', severity: 'medium', identity: 'named', location: 'IC 301', occurredOn: '2026-11-09', note: 'Chair reviewed the lab log. Passed to the Dean with a recommendation to hold a hearing.', reply: 'Filed by a faculty member.' }), { source: 'faculty' as const, reportedStudentId: 'QCU-STU-RESTRICTED', involvedUserIds: ['QCU-STU-RESTRICTED'], bypassed: false, aboutAdvisor: false, alias: 'Faculty report', categoryDetail: 'Unauthorized use of lab computers', narrative: 'During the Data Structures laboratory on November 9, the student used a lab workstation with another student\'s account and installed software that is not allowed in IC 301. This was after the earlier warning on record.' })
  delete faculty.consent; delete faculty.talk; delete faculty.adviserId
  faculty.history[0]!.actorId = 'QCU-CHAIR-IT'; faculty.history[0]!.actorRole = 'chair'; faculty.history[0]!.reason = 'Filed by a faculty member.'
  reports.push(faculty)
  // For testers (QA 17 November 2026): a BSCS report that skipped the adviser because the adviser may be involved, so the
  // Program Chair sees the conflict notice, and a second BSCS report so the BSCS chair has a group of similar reports.
  const conflicted = report('RPT-0249', 'QCU-STU-CS', 'chair', true, false, { when: t('2026-11-10', '04:00'), category: 'Faculty or staff conduct', subcategory: 'Absence or lateness', narrative: 'Our adviser keeps cancelling consultations at the last minute and then marks us absent. Please check how absences are recorded.' })
  conflicted.routing = { engineVersion: 'escalation-0.2.0', lexiconVersion: 'lexicon-2026-11-11', rule: 'adviser-conflict', scope: 'individual', mentions: [], heldBack: ['The adviser was not sent this report because the report may be about them.'], thresholds: { bypass: 0.75, triage: 0.45 } }
  const similar = report('RPT-0250', 'QCU-STU-CS', 'chair', true, false, { when: t('2026-11-13', '04:00'), category: 'Facilities', subcategory: 'Classroom or laboratory', narrative: 'The BSCS lab schedule changed again this week and the notice came after our class had started.' })
  reports.push(conflicted, similar)
  const questions: Question[] = [{ id: 'Q1', criterion: 'Clarity', text: 'Explains concepts and requirements clearly.', type: 'rating', required: true }, { id: 'Q2', criterion: 'Support', text: 'Helps students who ask for support.', type: 'rating', required: true }, { id: 'Q3', criterion: 'Fairness', text: 'Explains how work will be graded and grades it the same way each time.', type: 'rating', required: true }]
  const cycles: Cycle[] = [{ id: 'CYCLE-2026-1', title: '1st Semester AY 2026-2027', term: '1st Semester', opens: '2026-10-01', closes: '2026-11-30', status: 'Published', instructions: 'Rate each statement from 1 to 5 based on this semester.', questions, forms: ['student', 'peer', 'upward-chair', 'upward-dean'], resultsPublished: true, reviews: [{ userId: 'QCU-PROF-IT', decision: 'reviewed', note: 'Questions fit the listed duties.', at }] }, { id: 'CYCLE-2026-2', title: '2nd Semester AY 2026-2027 draft', term: '2nd Semester', opens: '2027-01-10', closes: '2027-03-30', status: 'In review', instructions: 'Read the proposed questions. Tell the Dean\'s Office if any do not fit your duties.', questions: structuredClone(questions), forms: ['student'], resultsPublished: false, reviews: [] }]
  const assignments: Assignment[] = [
    { id: 'EVAL-STU-IT-1', evaluatorId: 'QCU-STU-IT-A', facultyId: 'QCU-PROF-IT', cycleId: 'CYCLE-2026-1', relation: 'Student to faculty', subject: 'Data Structures · BSIT 3A' },
    { id: 'EVAL-STU-IT-2', evaluatorId: 'QCU-STU-RESTRICTED', facultyId: 'QCU-PROF-IT', cycleId: 'CYCLE-2026-1', relation: 'Student to faculty', subject: 'Data Structures · BSIT 3A' },
    { id: 'EVAL-STU-B-1', evaluatorId: 'QCU-STU-IT-B', facultyId: 'QCU-PROF-OTHER', cycleId: 'CYCLE-2026-1', relation: 'Student to faculty', subject: 'BSIT 3B class' },
    { id: 'EVAL-STU-CS-1', evaluatorId: 'QCU-STU-CS', facultyId: 'QCU-PROF-CS', cycleId: 'CYCLE-2026-1', relation: 'Student to faculty', subject: 'BSCS 2A class' },
    { id: 'EVAL-PEER-1', evaluatorId: 'QCU-PROF-IT', facultyId: 'QCU-PROF-OTHER', cycleId: 'CYCLE-2026-1', relation: 'Peer', subject: 'Faculty peer review' },
    { id: 'EVAL-UPWARD-1', evaluatorId: 'QCU-PROF-IT', facultyId: 'QCU-CHAIR-IT', cycleId: 'CYCLE-2026-1', relation: 'Upward: Program Chair', subject: 'Program leadership' },
    { id: 'EVAL-UPWARD-2', evaluatorId: 'QCU-PROF-IT', facultyId: 'CCS-DEAN', cycleId: 'CYCLE-2026-1', relation: 'Upward: Dean', subject: 'College leadership' },
  ]
  assignments.push({ id: 'EVAL-REVIEW-IT', evaluatorId: 'QCU-STU-IT-A', facultyId: 'QCU-PROF-IT', cycleId: 'CYCLE-2026-2', relation: 'Student to faculty', subject: 'Draft form for 2nd Semester' }, { id: 'EVAL-REVIEW-OTHER', evaluatorId: 'QCU-STU-IT-B', facultyId: 'QCU-PROF-OTHER', cycleId: 'CYCLE-2026-2', relation: 'Student to faculty', subject: 'Draft form for 2nd Semester' })
  for (const faculty of users.filter(u => u.roles.some(r => ['professor', 'chair', 'dean'].includes(r)))) for (let n = 0; n < 5; n++) assignments.push({ id: `EVAL-SAMPLE-${faculty.id}-${n}`, evaluatorId: `SAMPLE-EVALUATOR-${n}`, facultyId: faculty.id, cycleId: 'CYCLE-2026-1', relation: 'Student to faculty', subject: 'Course evaluation', answers: { Q1: n % 2 ? 4 : 5, Q2: 4, Q3: n % 2 ? 5 : 4 }, submittedAt: t(`2026-11-${String(10 + n * 3).padStart(2, '0')}`, '04:00'), comment: ['', 'Clear lectures and the laboratory activities match the exams.', '', 'Please post lab schedule changes earlier.', ''][n]! })
  const restrictions: Restriction[] = [{ id: 'RST-0101', studentId: 'QCU-STU-RESTRICTED', features: ['post.create', 'post.comment', 'report.anonymous'], basis: 'OSAS decision on file', decisionReference: 'QCU-DEC-001', starts: at, until: '2026-12-01', actorId: 'QCU-ADMIN', active: true }]
  // After the evaluation and notification loops, so the roster gets no sample evaluations or notifications.
  const roster = includeRoster ? facultyRoster.map(({ id, name, email, roles, program, title }) => id === deanRosterId
    ? user(id, `Dr. ${name}`, ['dean', 'professor'], { email, title: 'Dean, College of Computer Studies', office: 'CCS Dean\'s Office' })
    : user(id, name, roles, { email, title, office: roles[0] === 'professor' ? 'CCS Faculty Room' : 'CCS Office', ...(program ? { program } : {}) })) : []
  return {
    users: [...users, ...roster], spaces, organizations: [{ id: 'ORG-COMPUTING', name: 'CCS Computing Society', description: 'Student organization of the College of Computer Studies. Runs workshops and peer tutoring.', representativeId: 'QCU-ORG', memberIds: ['QCU-STU-IT-A'] },
      { id: 'ORG-LESIT', name: 'League of Excellent Students in Information Technology', description: 'QCU CCS organization for BSIT students. Holds study sessions, IT seminars and competitions.', representativeId: 'QCU-ORG-LESIT', memberIds: ['QCU-STU-IT-B'] },
      { id: 'ORG-JPCS', name: 'Junior Philippine Computer Society – QCU Chapter', description: 'QCU chapter of the national computing student society. Runs tech talks, hackathons and industry visits.', representativeId: 'QCU-ORG-JPCS', memberIds: ['QCU-STU-IT-A', 'QCU-STU-IT-B'] },
      { id: 'ORG-MSC', name: 'Microsoft Student Community QCU', description: 'Student community on Microsoft technologies: Azure, .NET and Power Platform workshops and study jams.', representativeId: 'QCU-ORG-MSC', memberIds: ['QCU-STU-CS'] },
      { id: 'ORG-AWS', name: 'AWS Student Builder Group QCU', description: 'Student builders learning cloud on AWS through hands-on labs and build days.', representativeId: 'QCU-ORG-AWS', memberIds: ['QCU-STU-CS'] }], posts, reports, drafts: {},
    threads: [
      {
        id: 'THREAD-IT-A',
        title: 'BSIT 3A class group',
        memberIds: ['QCU-STU-IT-A', 'QCU-STU-RESTRICTED', 'QCU-PROF-IT'],
        spaceId: 'SPACE-IT-A',
        messages: [{ id: 'MESSAGE-0101', authorId: 'QCU-PROF-IT', body: 'Use this group for room changes and class reminders. Message me directly for anything personal.', at: t('2026-08-18', '01:00') }],
        mutedBy: [],
        readMessageCounts: { 'QCU-PROF-IT': 1 },
      },
      {
        id: 'THREAD-DIRECT-1',
        title: 'Academic consultation',
        memberIds: ['QCU-STU-IT-A', 'QCU-PROF-IT'],
        messages: [{ id: 'MESSAGE-0102', authorId: 'QCU-STU-IT-A', body: 'Good afternoon, Prof. Is there an appointment slot this week? I want to go over the project rubric.', at: t('2026-10-19', '07:00') }],
        mutedBy: [],
        readMessageCounts: { 'QCU-STU-IT-A': 1 },
      },
      {
        id: 'THREAD-FACULTY-1',
        title: 'Faculty coordination',
        memberIds: ['QCU-CHAIR-IT', 'QCU-PROF-IT'],
        messages: [{ id: 'MESSAGE-0103', authorId: 'QCU-CHAIR-IT', body: 'Please read the consultation week announcement before Thursday.', at: t('2026-10-20', '02:00') }, { id: 'MESSAGE-0106', authorId: 'QCU-PROF-IT', body: 'Noted. I will also bring the midterm grade sheets for the Dean\'s Office on the 9th.', at: t('2026-10-20', '04:00') }],
        mutedBy: [],
        readMessageCounts: { 'QCU-CHAIR-IT': 1, 'QCU-PROF-IT': 2 },
      },
      {
        id: 'THREAD-IT-B',
        title: 'BSIT 3B class group',
        memberIds: ['QCU-STU-IT-B', 'QCU-PROF-OTHER'],
        spaceId: 'SPACE-IT-B',
        messages: [{ id: 'MESSAGE-0107', authorId: 'QCU-PROF-OTHER', body: 'Capstone Project 1 title defense is December 7 to 9. Slots are posted outside the Faculty Room.', at: t('2026-11-21', '04:00') }, { id: 'MESSAGE-0108', authorId: 'QCU-STU-IT-B', body: 'Thank you, Prof. Is the manuscript draft required before the defense or after?', at: t('2026-11-21', '09:00') }],
        mutedBy: [],
        readMessageCounts: { 'QCU-PROF-OTHER': 2, 'QCU-STU-IT-B': 2 },
      },
      {
        id: 'THREAD-CS-A',
        title: 'BSCS 2A class group',
        memberIds: ['QCU-STU-CS', 'QCU-PROF-CS'],
        spaceId: 'SPACE-CS-A',
        messages: [{ id: 'MESSAGE-0109', authorId: 'QCU-PROF-CS', body: 'Web Systems milestone 2 is due December 4. Lab on Wednesday is for consultation on the authentication part.', at: t('2026-11-20', '03:00') }],
        mutedBy: [],
        readMessageCounts: { 'QCU-PROF-CS': 1 },
      },
      {
        id: 'THREAD-GROUP-SANDBOX',
        title: 'SANDBOX 2026 team',
        group: true,
        memberIds: ['QCU-STU-IT-A', 'QCU-STU-IT-B', 'QCU-STU-CS'],
        messages: [{ id: 'MESSAGE-0110', authorId: 'QCU-STU-CS', body: 'Hi team! I matched us under Education and Digital Inclusion. Idea: a reviewer app for senior high school tutors.', at: t('2026-11-22', '10:00') }, { id: 'MESSAGE-0111', authorId: 'QCU-STU-IT-B', body: 'Works for me. I can set up the Node API and the database tonight.', at: t('2026-11-22', '12:00') }, { id: 'MESSAGE-0112', authorId: 'QCU-STU-IT-A', body: 'I will draft the pitch outline and register our Kiro credits.', at: t('2026-11-23', '01:00') }],
        mutedBy: [],
        readMessageCounts: { 'QCU-STU-CS': 3, 'QCU-STU-IT-B': 2, 'QCU-STU-IT-A': 3 },
      },
    ],
    slots: [{ id: 'SLOT-0101', facultyId: 'QCU-PROF-IT', date: '2026-10-29', start: '10:00', end: '10:30', state: 'open' }, { id: 'SLOT-0102', facultyId: 'QCU-PROF-IT', date: '2026-10-29', start: '10:30', end: '11:00', state: 'requested' }, { id: 'SLOT-0103', facultyId: 'QCU-PROF-IT', date: '2026-10-30', start: '13:00', end: '14:00', state: 'unavailable', reason: 'Faculty meeting.' }, { id: 'SLOT-0104', facultyId: 'QCU-PROF-OTHER', date: '2026-10-29', start: '09:00', end: '09:30', state: 'open' }, { id: 'SLOT-0105', facultyId: 'QCU-PROF-CS', date: '2026-10-29', start: '11:00', end: '11:30', state: 'open' }, { id: 'SLOT-0106', facultyId: 'QCU-CHAIR-IT', date: '2026-10-30', start: '10:00', end: '10:30', state: 'open' },
      { id: 'SLOT-0107', facultyId: 'QCU-PROF-IT', date: '2026-11-26', start: '10:00', end: '10:30', state: 'booked' }, { id: 'SLOT-0108', facultyId: 'QCU-PROF-CS', date: '2026-11-26', start: '11:00', end: '11:30', state: 'requested' }, { id: 'SLOT-0109', facultyId: 'QCU-PROF-OTHER', date: '2026-11-12', start: '09:00', end: '09:30', state: 'open' }, { id: 'SLOT-0110', facultyId: 'QCU-PROF-IT', date: '2026-11-05', start: '10:00', end: '10:30', state: 'open' }, { id: 'SLOT-0111', facultyId: 'QCU-PROF-OTHER', date: '2026-11-27', start: '09:00', end: '09:30', state: 'requested' }, { id: 'SLOT-0112', facultyId: 'QCU-PROF-IT', date: '2026-11-19', start: '10:00', end: '10:30', state: 'open' },
      { id: 'SLOT-0113', facultyId: 'QCU-PROF-IT', date: '2026-12-03', start: '10:00', end: '10:30', state: 'open' }, { id: 'SLOT-0114', facultyId: 'QCU-PROF-IT', date: '2026-12-03', start: '10:30', end: '11:00', state: 'open' }, { id: 'SLOT-0115', facultyId: 'QCU-PROF-CS', date: '2026-12-03', start: '11:00', end: '11:30', state: 'open' }, { id: 'SLOT-0116', facultyId: 'QCU-PROF-OTHER', date: '2026-12-03', start: '09:00', end: '09:30', state: 'open' }, { id: 'SLOT-0117', facultyId: 'QCU-CHAIR-IT', date: '2026-12-04', start: '10:00', end: '10:30', state: 'open' }, { id: 'SLOT-0118', facultyId: 'QCU-CHAIR-IT', date: '2026-12-04', start: '10:30', end: '11:00', state: 'open' }],
    consultations: [
      { id: 'CONSULT-0101', studentId: 'QCU-STU-IT-A', facultyId: 'QCU-PROF-IT', slotId: 'SLOT-0102', purpose: 'Clarify the Data Structures project rubric', status: 'Requested', createdAt: t('2026-10-19', '07:30'), updatedAt: t('2026-10-19', '07:30'), history: [{ at: t('2026-10-19', '07:30'), status: 'Requested', note: 'Request received', actorId: 'QCU-STU-IT-A' }] },
      { id: 'CONSULT-0102', studentId: 'QCU-STU-IT-A', facultyId: 'QCU-PROF-IT', slotId: 'SLOT-0107', slotDate: '2026-11-26', slotStart: '10:00', slotEnd: '10:30', purpose: 'Capstone Project 1: prepare for the title defense', status: 'Booked', createdAt: t('2026-11-20', '03:00'), updatedAt: t('2026-11-21', '02:00'), history: [{ at: t('2026-11-20', '03:00'), status: 'Requested', note: 'Request received', actorId: 'QCU-STU-IT-A' }, { at: t('2026-11-20', '06:00'), status: 'Approved', note: 'Bring your draft title and abstract.', actorId: 'QCU-PROF-IT' }, { at: t('2026-11-21', '02:00'), status: 'Booked', note: 'Confirmed', actorId: 'QCU-PROF-IT' }] },
      { id: 'CONSULT-0103', studentId: 'QCU-STU-CS', facultyId: 'QCU-PROF-CS', slotId: 'SLOT-0108', purpose: 'Review the Web Systems milestone 2 authentication design', status: 'Approved', createdAt: t('2026-11-22', '05:00'), updatedAt: t('2026-11-23', '01:00'), history: [{ at: t('2026-11-22', '05:00'), status: 'Requested', note: 'Request received', actorId: 'QCU-STU-CS' }, { at: t('2026-11-23', '01:00'), status: 'Approved', note: 'See you then.', actorId: 'QCU-PROF-CS' }] },
      { id: 'CONSULT-0104', studentId: 'QCU-STU-IT-B', facultyId: 'QCU-PROF-OTHER', slotId: 'SLOT-0109', slotDate: '2026-11-12', slotStart: '09:00', slotEnd: '09:30', purpose: 'Go over the OJT requirements checklist', status: 'Completed', createdAt: t('2026-11-09', '02:00'), updatedAt: t('2026-11-12', '02:00'), history: [{ at: t('2026-11-09', '02:00'), status: 'Requested', note: 'Request received', actorId: 'QCU-STU-IT-B' }, { at: t('2026-11-09', '05:00'), status: 'Approved', note: 'Approved', actorId: 'QCU-PROF-OTHER' }, { at: t('2026-11-10', '01:00'), status: 'Booked', note: 'Confirmed', actorId: 'QCU-PROF-OTHER' }, { at: t('2026-11-12', '02:00'), status: 'Completed', note: 'Checklist reviewed.', actorId: 'QCU-PROF-OTHER' }] },
      { id: 'CONSULT-0105', studentId: 'QCU-STU-RESTRICTED', facultyId: 'QCU-PROF-IT', slotId: 'SLOT-0110', slotDate: '2026-11-05', slotStart: '10:00', slotEnd: '10:30', purpose: 'Ask about the Data Structures midterm score', status: 'Declined', createdAt: t('2026-11-03', '02:00'), updatedAt: t('2026-11-04', '02:00'), history: [{ at: t('2026-11-03', '02:00'), status: 'Requested', note: 'Request received', actorId: 'QCU-STU-RESTRICTED' }, { at: t('2026-11-04', '02:00'), status: 'Declined', note: 'This time overlaps a class. Please request another time.', actorId: 'QCU-PROF-IT' }] },
      { id: 'CONSULT-0106', studentId: 'QCU-STU-IT-B', facultyId: 'QCU-PROF-OTHER', slotId: 'SLOT-0111', purpose: 'Discuss the capstone manuscript outline', status: 'Requested', createdAt: t('2026-11-23', '04:00'), updatedAt: t('2026-11-23', '04:00'), history: [{ at: t('2026-11-23', '04:00'), status: 'Requested', note: 'Request received', actorId: 'QCU-STU-IT-B' }] },
      { id: 'CONSULT-0107', studentId: 'QCU-STU-IT-A', facultyId: 'QCU-PROF-IT', slotId: 'SLOT-0112', slotDate: '2026-11-19', slotStart: '10:00', slotEnd: '10:30', purpose: 'Sign the clearance form', status: 'Cancelled', createdAt: t('2026-11-16', '02:00'), updatedAt: t('2026-11-17', '02:00'), history: [{ at: t('2026-11-16', '02:00'), status: 'Requested', note: 'Request received', actorId: 'QCU-STU-IT-A' }, { at: t('2026-11-17', '02:00'), status: 'Cancelled', note: 'Clearance signing starts in December.', actorId: 'QCU-STU-IT-A' }] },
    ],
    todos: [{ id: 'TODO-0101', ownerId: 'QCU-STU-IT-A', title: 'Prepare appointment questions', date: '2026-10-29', done: false }, { id: 'TODO-0105', ownerId: 'QCU-STU-CS', title: 'Web Systems milestone 2 repository link', date: '2026-12-04', done: false }, { id: 'TODO-0106', ownerId: 'QCU-STU-CS', title: 'Get clearance signatures', date: '2026-12-07', done: false }, { id: 'TODO-0107', ownerId: 'QCU-PROF-IT', title: 'Submit midterm grades to the Dean\'s Office', date: '2026-11-09', done: true }, { id: 'TODO-0108', ownerId: 'QCU-PROF-IT', title: 'Post Data Structures final exam coverage', date: '2026-11-30', done: false }, { id: 'TODO-0109', ownerId: 'QCU-CHAIR-IT', title: 'Finalize capstone title defense panels', date: '2026-12-04', done: false }],
    events: [
      { id: 'EVENT-0101', title: 'CCS appointment week', date: '2026-10-29', start: '08:00', end: '17:00', type: 'CCS', description: 'Faculty hold open appointment times. Request a time under Appointments.', contactId: 'QCU-SECRETARY' },
      { id: 'EVENT-0102', title: 'Intro to Git workshop', date: '2026-11-05', start: '13:00', end: '15:00', type: 'Organization', description: 'Open to all CCS students. Bring your laptop.', contactId: 'QCU-ORG', organizationId: 'ORG-COMPUTING', place: 'IC 305' },
      { id: 'EVENT-0103', title: 'Midterm grade submission', date: '2026-11-09', start: '08:00', end: '09:00', type: 'Academic year', description: 'Faculty submit midterm grades to the Dean\'s Office.', contactId: 'CCS-DEAN' },
      { id: 'EVENT-0104', title: 'Start of classes, 1st Semester AY 2026-2027', date: '2026-08-17', start: '07:30', type: 'Academic year', description: 'Classes begin for all CCS programs at the San Bartolome campus.', contactId: 'CCS-DEAN' },
      { id: 'EVENT-0105', title: 'Midterm examinations', date: '2026-10-12', start: '07:30', end: '17:00', type: 'Academic year', description: 'Midterm exam week for all programs. Check your class group for room assignments.', contactId: 'CCS-DEAN' },
      { id: 'EVENT-0106', title: 'Faculty evaluation closes', date: '2026-11-30', start: '17:00', type: 'Academic year', description: 'Last day for students to submit faculty evaluations.', contactId: 'CCS-DEAN' },
      { id: 'EVENT-0107', title: 'Information Assurance review session', date: '2026-11-28', start: '13:00', end: '16:00', type: 'Organization', description: 'Free review for the Information Assurance finals, by LESIT.', contactId: 'QCU-ORG-LESIT', organizationId: 'ORG-LESIT', place: 'IC 301', postId: 'POST-0112' },
      { id: 'EVENT-0108', title: 'Azure and Power Platform study jam', date: '2026-11-27', start: '13:00', end: '16:00', type: 'Organization', description: 'Deploy a .NET API to Azure and automate approvals with Power Automate.', contactId: 'QCU-ORG-MSC', organizationId: 'ORG-MSC', place: 'IC 305', postId: 'POST-0114' },
      { id: 'EVENT-0109', title: 'JPCS tech talk: from prompt to product', date: '2026-12-01', start: '14:00', end: '16:00', type: 'Organization', description: 'A talk on building software with AI tools.', contactId: 'QCU-ORG-JPCS', organizationId: 'ORG-JPCS', place: 'IC 305', postId: 'POST-0113' },
      { id: 'EVENT-0110', title: 'Foundation Course on Intellectual Property', date: '2026-12-03', start: '09:00', end: '16:00', type: 'CCS', description: 'Required for 3rd-year CCS students. By QCU-ITSO: patents, trademarks, copyright.', contactId: 'CCS-DEAN', postId: 'POST-0107', place: 'San Bartolome campus, venue to be posted' },
      { id: 'EVENT-0111', title: 'SANDBOX 2026, day 1', date: '2026-12-05', start: '08:00', end: '18:00', type: 'Organization', description: 'Kickoff, build time and mentoring. A two-day buildathon by AWS Student Builder Group QCU.', contactId: 'QCU-ORG-AWS', organizationId: 'ORG-AWS', place: 'San Bartolome campus', postId: 'POST-0109' },
      { id: 'EVENT-0112', title: 'SANDBOX 2026, day 2 and pitches', date: '2026-12-06', start: '08:00', end: '17:00', type: 'Organization', description: 'Final build, pitch to the judges and awarding.', contactId: 'QCU-ORG-AWS', organizationId: 'ORG-AWS', place: 'San Bartolome campus', postId: 'POST-0109' },
      { id: 'EVENT-0113', title: 'Capstone Project 1 title defense', date: '2026-12-07', start: '08:00', end: '17:00', type: 'CCS', description: 'Title defenses run December 7 to 9. Panel schedules are posted at the Faculty Room.', contactId: 'QCU-CHAIR-IT' },
      { id: 'EVENT-0114', title: 'Clearance signing opens', date: '2026-12-07', start: '08:00', end: '16:00', type: 'Academic year', description: 'Get your clearance signed at the CCS Office.', contactId: 'CCS-DEAN' },
      { id: 'EVENT-0115', title: 'JPCS industry visit', date: '2026-12-11', start: '08:00', end: '16:00', type: 'Organization', description: 'Visit to a software company. Sign-up opens after the tech talk.', contactId: 'QCU-ORG-JPCS', organizationId: 'ORG-JPCS', place: 'Meet at the San Bartolome campus gate' },
      { id: 'EVENT-0116', title: 'Final examinations', date: '2026-12-14', start: '07:30', end: '17:00', type: 'Academic year', description: 'Final exam week, December 14 to 19.', contactId: 'CCS-DEAN' },
      { id: 'EVENT-0117', title: 'Online meeting for 4th-year students', date: '2026-08-18', start: '13:00', end: '14:00', type: 'CCS', description: 'For 4th-year students with remaining subjects, on Google Meet.', contactId: 'CCS-DEAN' },
      { id: 'EVENT-0118', title: 'Adjustment period', date: '2026-08-25', start: '08:00', end: '16:00', type: 'Academic year', description: 'Adjustment of subjects for the College of Computer Studies.', contactId: 'CCS-DEAN' },
      { id: 'EVENT-0119', title: 'Freshman orientation', date: '2026-09-02', start: '08:00', end: '12:00', type: 'CCS', description: 'Orientation for first-year CCS and College of Education students, San Bartolome campus.', contactId: 'CCS-DEAN', place: 'San Bartolome campus' },
      { id: 'EVENT-0120', title: 'Patent and Claim Drafting Workshop, day 1', date: '2026-09-15', start: '09:00', end: '16:00', type: 'CCS', description: 'For 4th-year students, 2 representatives per capstone group.', contactId: 'CCS-DEAN', place: 'Bautista Building, Room 603', postId: 'POST-0124' },
      { id: 'EVENT-0121', title: 'Patent and Claim Drafting Workshop, day 2', date: '2026-09-16', start: '09:00', end: '16:00', type: 'CCS', description: 'Claim drafting practice.', contactId: 'CCS-DEAN', place: 'Bautista Building, Room 603', postId: 'POST-0124' },
    ],
    cycles, assignments, restrictions,
    referrals: [],
    offenses: [{ id: 'OFF-0101', studentId: 'QCU-STU-RESTRICTED', level: 1, summary: 'Unauthorized use of a lab computer. First offense, decision recorded by OSAS.', decisionReference: 'QCU-DEC-001', actorRole: 'osas', at, status: 'Recorded' }],
    strikes: [],
    strikeSettlements: [],
    materials: [],
    loadSchedules: [], goodMoral: [],
    clusters: [{ id: 'CLUSTER-0101', program: 'BSIT', title: 'Lab schedule changes', reportIds: ['RPT-0241', 'RPT-0242', 'RPT-0243'], similarity: 86, supporting: 'Reports say students could not plan their lab work after the timetable changed.', dissenting: 'One report says a corrected notice was posted later.', phrases: ['lab timetable', 'schedule changes'], status: 'To review', history: [] }, { id: 'CLUSTER-0102', program: 'BSCS', title: 'BSCS lab schedule notices', reportIds: ['RPT-0248', 'RPT-0250'], similarity: 81, supporting: 'Both reports say lab schedule changes were announced late.', dissenting: 'The reports are about different weeks.', phrases: ['lab schedule', 'notice'], status: 'To review', history: [] }],
    notifications: [...users.map((u, index) => ({ id: `NOTIF-${index + 1}`, recipientId: u.id, kind: 'announcement', title: 'New college announcement', body: 'Final exams, clearance and grades. Open the feed to read it.', priority: 'normal', pageId: 'P04', at: t('2026-11-23', '01:00'), read: false })),
      { id: 'NOTIF-0101', recipientId: 'QCU-STU-IT-A', kind: 'consultation', title: 'Appointment confirmed', body: 'Prof. Charlie confirmed your Capstone Project 1 consultation on November 26.', priority: 'normal', pageId: 'P16', recordId: 'CONSULT-0102', at: t('2026-11-21', '02:00'), read: true },
      { id: 'NOTIF-0102', recipientId: 'QCU-PROF-IT', kind: 'consultation', title: 'New appointment request', body: 'A student asked for time to clarify the project rubric.', priority: 'normal', pageId: 'P16', recordId: 'CONSULT-0101', at: t('2026-10-19', '07:30'), read: false },
      { id: 'NOTIF-0103', recipientId: 'QCU-STU-CS', kind: 'consultation', title: 'Appointment approved', body: 'Prof. Echo approved your Web Systems consultation on November 26.', priority: 'normal', pageId: 'P16', recordId: 'CONSULT-0103', at: t('2026-11-23', '01:00'), read: false },
      { id: 'NOTIF-0104', recipientId: 'QCU-PROF-OTHER', kind: 'consultation', title: 'New appointment request', body: 'A student asked for time to discuss the capstone manuscript outline.', priority: 'normal', pageId: 'P16', recordId: 'CONSULT-0106', at: t('2026-11-23', '04:00'), read: false },
      { id: 'NOTIF-0105', recipientId: 'QCU-STU-IT-B', kind: 'case', title: 'Case update', body: 'The Dean is confirming the lab room allocation for your concern.', priority: 'high', pageId: 'P20', recordId: 'RPT-0243', at: t('2026-10-14', '02:00'), read: false },
      { id: 'NOTIF-0106', recipientId: 'QCU-CHAIR-CS', kind: 'case', title: 'New concern for review', body: 'A BSCS student filed a concern about overlapping class schedules.', priority: 'normal', pageId: 'P22', recordId: 'RPT-0252', at: t('2026-11-09', '02:00'), read: false },
      { id: 'NOTIF-0107', recipientId: 'QCU-PROF-OTHER', kind: 'case', title: 'New concern for review', body: 'A BSIT 3B student asked for a review of an exam score.', priority: 'normal', pageId: 'P22', recordId: 'RPT-0251', at: t('2026-11-16', '02:00'), read: false },
      { id: 'NOTIF-0108', recipientId: 'CCS-DEAN', kind: 'case', title: 'Case with the Dean', body: 'Two concerns and a faculty report are waiting for the Dean.', priority: 'high', pageId: 'P22', recordId: 'RPT-0255', at: t('2026-11-11', '02:00'), read: false },
      { id: 'NOTIF-0109', recipientId: 'QCU-GUIDANCE', kind: 'case', title: 'New case file', body: 'A case file was opened for a grading concern.', priority: 'normal', pageId: 'P22', recordId: 'RPT-0245', at: t('2026-10-01', '02:00'), read: true },
      { id: 'NOTIF-0110', recipientId: 'QCU-OSAS', kind: 'case', title: 'Case with OSAS', body: 'A cyberbullying case file reached OSAS for interviews.', priority: 'high', pageId: 'P22', recordId: 'RPT-0246', at: t('2026-09-18', '02:00'), read: true },
      { id: 'NOTIF-0112', recipientId: 'QCU-STU-IT-A', kind: 'announcement', title: 'Foundation Course on Intellectual Property', body: 'Required for 3rd-year CCS students on December 3. See Events.', priority: 'high', pageId: 'P04', recordId: 'POST-0107', at: t('2026-11-03', '01:30'), read: true },
      { id: 'NOTIF-0113', recipientId: 'QCU-STU-IT-B', kind: 'announcement', title: 'Request to proceed to OSAS', body: 'OSAS posted a request for you to proceed to their office as soon as possible.', priority: 'high', pageId: 'P04', recordId: 'POST-0130', at: t('2026-11-10', '02:00'), read: false },
      { id: 'NOTIF-0114', recipientId: 'QCU-STU-CS', kind: 'announcement', title: 'Request to visit OSAS', body: 'OSAS posted a request for you to visit their office.', priority: 'high', pageId: 'P04', recordId: 'POST-0129', at: t('2026-10-14', '02:00'), read: true },
      { id: 'NOTIF-0115', recipientId: 'QCU-STU-IT-A', kind: 'announcement', title: 'SANDBOX 2026 registration', body: 'AWS Student Builder Group QCU opened registration. Teams are revealed on November 21.', priority: 'normal', pageId: 'P04', recordId: 'POST-0109', at: t('2026-11-09', '02:00'), read: true },
      { id: 'NOTIF-0116', recipientId: 'QCU-STU-IT-A', kind: 'announcement', title: 'Resubmit your capstone soft copy', body: 'Visit the CCS Faculty Office, 8:00 AM to 3:00 PM, to resubmit or verify your files.', priority: 'high', pageId: 'P04', recordId: 'POST-0126', at: t('2026-09-18', '02:00'), read: true }],
    audit: [{ id: 'AUDIT-QCU-1', at, actorId: 'ACCS-ADMIN', action: 'Accounts loaded', module: 'identity', reference: 'QCU-ACCOUNTS', result: 'Recorded' }],
    moderation: [{ id: 'MOD-0101', itemType: 'comment', itemId: 'COMMENT-0101', parentId: 'POST-0102', authorId: 'QCU-STU-IT-B', reporterId: 'QCU-STU-IT-A', source: 'User', reason: 'Reported by a classmate as off-topic', excerpt: 'Same problem in BSIT 3B. A posted lab schedule would help us plan.', status: 'Pending', at: t('2026-10-15', '02:00'), history: [] }], settings: {}, photos: {}, permissionOverrides: {}, telemetry: [],
    followUps: [],
  }
}
/** The real CCS personnel (src/faculty-roster.ts). Their accounts belong to real people. */
export const rosterUserIds: ReadonlySet<string> = new Set(facultyRoster.map(person => person.id))
/**
 * The made-up demo accounts that sign in with the shared seed password until they set their own. Inactive ones (the
 * secretary) never do, and neither does any real person on the roster: anyone who guessed a name could otherwise sign in
 * as them with the shared password. A roster account signs in only with credentials set up for it (the Dean through the
 * administrator's setup, everyone else through an invite or an issued reset code).
 */
export const demoUserIds: ReadonlySet<string> = new Set(seed().users.filter(u => u.active && !rosterUserIds.has(u.id)).map(u => u.id))
const sampleEmails = new Map(seed().users.map(u => [u.id, u.email.toLowerCase()]))
/**
 * The qcu.edu.ph addresses a seeded account had before #69, under its current ID and any former one (QCU-DEAN was
 * dean@qcu.edu.ph, QCU-ADMIN admin@qcu.edu.ph). Stored accounts that still carry one are read with the new address.
 */
export function formerSeedEmails(userId: string): string[] {
  if (!sampleEmails.has(userId)) return []
  const ids = [userId, ...formerAccountIds(userId)]
  return [...new Set(ids.map(id => `${id === 'QCU-DEAN' || id === 'CCS-DEAN' ? 'dean' : seedLocalPart(id)}@qcu.edu.ph`))]
}
/** The address a seeded account has now, or undefined for an account that was not seeded. */
export const seedEmail = (userId: string) => sampleEmails.get(userId)
/**
 * A seeded account that still has its made-up address. Such an account is never emailed, because the address may belong to
 * someone else. Once a real address is set (the Dean through the System Administrator, the Secretary through the Dean), the
 * account gets email like any other.
 */
export const isSampleAddress = (userId: string, email: string) => sampleEmails.get(userId) === email.toLowerCase() || formerSeedEmails(userId).includes(email.toLowerCase())
