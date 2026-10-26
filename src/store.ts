import type { Role, User } from './schemas.js'

export type Stage = 'adviser' | 'chair' | 'dean' | 'guidance' | 'osas' | 'executive'
export type Message = { id: string; authorId: string; body: string; at: string }
export type History = { id: string; at: string; actorId: string; actorRole: string; action: string; reason: string; update: string; public: boolean; stage: Stage }
export type Report = { id: string; ownerId: string; program: string; adviserId: string; stage: Stage; status: string; narrative: string; category: string; severity: 'low' | 'medium' | 'high'; identity: 'named' | 'anonymous'; alias: string; disclosedTo: string[]; involvedUserIds: string[]; bypassed: boolean; createdAt: string; updatedAt: string; caseFileId?: string; sourcePostId?: string; location?: string; occurredOn?: string; history: History[]; notes: Message[]; messages: Message[] }
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
export type Space = { id: string; title: string; program: string; section: string; subject: string; professorIds: string[]; studentIds: string[] }
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
export type Slot = { id: string; facultyId: string; date: string; start: string; end: string; state: 'open' | 'requested' | 'booked' | 'unavailable' }
export type Consultation = { id: string; studentId: string; facultyId: string; slotId: string; purpose: string; status: 'Requested' | 'Approved' | 'Booked' | 'Completed' | 'Declined' | 'Cancelled'; createdAt: string; updatedAt: string; history: { at: string; status: string; note: string; actorId: string }[] }
export type Question = { id: string; criterion: string; text: string; type: 'rating' | 'text'; required: boolean }
export type Cycle = { id: string; title: string; term: string; opens: string; closes: string; status: 'Draft' | 'In review' | 'Published' | 'Closed'; instructions: string; questions: Question[]; forms: string[]; resultsPublished: boolean; reviews: { userId: string; decision: string; note: string; at: string }[] }
export type Assignment = { id: string; evaluatorId: string; facultyId: string; cycleId: string; relation: string; subject: string; answers?: Record<string, string | number>; comment?: string; submittedAt?: string }
export type Restriction = { id: string; studentId: string; features: string[]; basis: string; decisionReference: string; starts: string; until: string; actorId: string; active: boolean }
export type Referral = { id: string; studentId: string; change: string; decisionReference: string; reason: string; actorId: string; at: string; status: string }
export type Notification = { id: string; recipientId: string; kind: string; title: string; body: string; priority: string; pageId: string; recordId?: string; at: string; read: boolean }
export type Audit = { id: string; at: string; actorId: string; action: string; module: string; reference: string; result: string; purpose?: string; reason?: string }
export type Moderation = { id: string; itemType: 'post' | 'comment' | 'message'; itemId: string; parentId: string; authorId: string; reporterId?: string; source: 'Filter' | 'User'; reason: string; excerpt: string; status: string; at: string; history: { at: string; actorId: string; decision: string; reason: string }[] }
export type Database = {
  sequence: number; users: User[]; spaces: Space[]; organizations: Organization[]; posts: Post[]; threads: Thread[]; slots: Slot[]; consultations: Consultation[]; reports: Report[]; drafts: Record<string, Record<string, unknown>>; todos: { id: string; ownerId: string; title: string; date: string; done: boolean }[];
  events: Event[]; cycles: Cycle[]; assignments: Assignment[]; restrictions: Restriction[]; referrals: Referral[]; offenses: { id: string; studentId: string; level: number; summary: string; decisionReference: string; actorRole: string; at: string; status: string }[]; goodMoral: { studentId: string; status: string; decisionSource: string; notes: string; actorId: string; at: string }[]; clusters: { id: string; program: string; title: string; reportIds: string[]; similarity: number; supporting: string; dissenting: string; phrases: string[]; status: string; history: { at: string; actorId: string; decision: string; reason: string }[] }[]; notifications: Notification[]; audit: Audit[]; moderation: Moderation[]; settings: Record<string, { theme: string; density: string; priorities: Record<string, string> }>; permissionOverrides: Record<string, boolean>; telemetry: { at: string; category: string; durationMs: number; success: boolean }[]; followUps: { facultyId: string; actorId: string; note: string; at: string }[];
}
export interface Repository { read(): Database; nextId(prefix: string): string }
// one process owns this prototype state; replace this repository when persistent storage is chosen.
export function createMemoryRepository(): Repository { const data = seed(); return { read: () => data, nextId: (prefix) => `${prefix}-${String(++data.sequence).padStart(4, '0')}` } }

function user(id: string, name: string, roles: Role[], extra: Partial<User> = {}): User { return { id, name, email: `${id.toLowerCase().replaceAll('demo-', '').replaceAll('-', '.')}@qcu.edu.ph`, roles, restrictions: [], title: roles.includes('student') ? 'CCS undergraduate' : 'College personnel', bio: 'Synthetic ACCS pilot account for College of Computer Studies workflows.', education: 'Demo profile information', officeHours: 'By appointment through ACCS', spaceIds: [], organizationIds: [], active: true, ...extra } }
const at = '2026-10-20T02:00:00.000Z'
function seed(): Database {
  const users: User[] = [
    user('DEMO-STU-IT-A', 'Mira Solis', ['student'], { program: 'BSIT', section: 'A', year: 3, studentId: 'DEMO-2024-0101', adviserId: 'DEMO-PROF-IT', spaceIds: ['SPACE-IT-A', 'SUBJECT-IT-DS'], organizationIds: ['ORG-COMPUTING'] }),
    user('DEMO-STU-IT-B', 'Luca Reed', ['student'], { program: 'BSIT', section: 'B', year: 3, studentId: 'DEMO-2024-0102', adviserId: 'DEMO-PROF-OTHER', spaceIds: ['SPACE-IT-B'] }),
    user('DEMO-STU-CS', 'Noa Vale', ['student'], { program: 'BSCS', section: 'A', year: 2, studentId: 'DEMO-2025-0201', adviserId: 'DEMO-PROF-CS', spaceIds: ['SPACE-CS-A'] }),
    user('DEMO-STU-RESTRICTED', 'Tess Finch', ['student'], { program: 'BSIT', section: 'A', year: 3, studentId: 'DEMO-2024-0103', adviserId: 'DEMO-PROF-IT', spaceIds: ['SPACE-IT-A', 'SUBJECT-IT-DS'], restrictions: ['post.create', 'post.comment', 'report.anonymous'] }),
    user('DEMO-ORG', 'Computing Society Representative', ['organization'], { organizationId: 'ORG-COMPUTING', organizationIds: ['ORG-COMPUTING'], office: 'CCS Organizations', title: 'Organization representative' }),
    user('DEMO-PROF-IT', 'Prof. Robin Elm', ['professor'], { program: 'BSIT', office: 'CCS Faculty Room', title: 'Faculty · BSIT adviser', spaceIds: ['SPACE-IT-A', 'SUBJECT-IT-DS'] }),
    user('DEMO-PROF-OTHER', 'Prof. Rowan Quill', ['professor'], { program: 'BSIT', office: 'CCS Faculty Room', title: 'Faculty · BSIT', spaceIds: ['SPACE-IT-B'] }),
    user('DEMO-PROF-CS', 'Prof. Sena Brook', ['professor'], { program: 'BSCS', office: 'CCS Faculty Room', title: 'Faculty · BSCS', spaceIds: ['SPACE-CS-A'] }),
    user('DEMO-STAFF', 'Avery Moss', ['staff'], { office: 'CCS Office', title: 'CCS office staff' }),
    user('DEMO-CHAIR-IT', 'Dr. Morgan Ash', ['chair', 'professor'], { program: 'BSIT', office: 'BSIT Program Office', title: 'BSIT Program Chair · Faculty', spaceIds: ['SUBJECT-IT-DS'] }),
    user('DEMO-CHAIR-CS', 'Dr. Ellis Wren', ['chair'], { program: 'BSCS', office: 'BSCS Program Office', title: 'BSCS Program Chair' }),
    user('DEMO-DEAN', 'Dr. Sage Linden', ['dean'], { office: 'CCS Dean’s Office', title: 'Dean · College of Computer Studies' }),
    user('DEMO-ADMIN', 'Casey Hart', ['administrator'], { office: 'Platform Administration', title: 'Platform administrator and moderator' }),
    user('DEMO-GUIDANCE', 'Alex Fern', ['guidance'], { office: 'Guidance Office', title: 'Guidance officer' }),
    user('DEMO-OSAS', 'Jamie Alder', ['osas'], { office: 'Office of Student Affairs and Services', title: 'OSAS officer' }),
    user('DEMO-PRESIDENT', 'Taylor Rowan', ['president'], { office: 'Office of the University President', title: 'Authorized executive office user' }),
  ]
  const spaces: Space[] = [
    { id: 'SPACE-IT-A', title: 'BSIT 3A', program: 'BSIT', section: 'A', subject: 'Section space', professorIds: ['DEMO-PROF-IT'], studentIds: ['DEMO-STU-IT-A', 'DEMO-STU-RESTRICTED'] },
    { id: 'SUBJECT-IT-DS', title: 'Data Structures · BSIT 3A', program: 'BSIT', section: 'A', subject: 'CC 104 · Data Structures', professorIds: ['DEMO-PROF-IT', 'DEMO-CHAIR-IT'], studentIds: ['DEMO-STU-IT-A', 'DEMO-STU-RESTRICTED'] },
    { id: 'SPACE-IT-B', title: 'BSIT 3B', program: 'BSIT', section: 'B', subject: 'Section space', professorIds: ['DEMO-PROF-OTHER'], studentIds: ['DEMO-STU-IT-B'] },
    { id: 'SPACE-CS-A', title: 'BSCS 2A', program: 'BSCS', section: 'A', subject: 'Section space', professorIds: ['DEMO-PROF-CS'], studentIds: ['DEMO-STU-CS'] },
  ]
  const post = (id: string, authorId: string, title: string, body: string, audience = 'college', anonymous = false, kind: Post['kind'] = 'discussion'): Post => ({ id, authorId, title, body, audience, anonymous, kind, label: kind === 'announcement' ? 'Announcement' : 'Discussion', priority: 'general', private: audience.startsWith('organization:'), at, reactions: [], comments: [], removed: false })
  const posts = [post('POST-0101', 'DEMO-DEAN', 'CCS academic consultation week', 'Faculty consultation times are available in the calendar. Request a time and wait for confirmation.', 'college', false, 'announcement'), post('POST-0102', 'DEMO-STU-IT-A', 'Lab schedule changes', 'Could we confirm which lab times are open for the upcoming group activity?', 'program:BSIT', true), post('POST-0103', 'DEMO-PROF-IT', 'Data Structures review materials', 'The practice set is ready. Bring your questions to the next class.', 'space:SUBJECT-IT-DS', false, 'announcement'), post('POST-0104', 'DEMO-ORG', 'Computing Society planning notes', 'Members can review the draft workshop agenda here.', 'organization:ORG-COMPUTING'), post('POST-0105', 'DEMO-ORG', 'Open coding workshop', 'All CCS students are welcome to the introductory workshop. Check the event calendar for details.')]
  posts[4]!.audience = 'organization:ORG-COMPUTING'
  posts[4]!.private = false
  posts.push(post('POST-0106', 'DEMO-PROF-IT', 'Faculty coordination notes', 'Faculty can review the proposed teaching coordination agenda here.', 'faculty'))
  posts[1]!.comments.push({ id: 'COMMENT-0101', authorId: 'DEMO-STU-IT-B', body: 'A calendar update would help us plan.', anonymous: false, at })
  const stageRoles: Record<Stage, string> = { adviser: 'professor', chair: 'chair', dean: 'dean', guidance: 'guidance', osas: 'osas', executive: 'president' }
  const actorIds: Record<Stage, string> = { adviser: 'DEMO-PROF-IT', chair: 'DEMO-CHAIR-IT', dean: 'DEMO-DEAN', guidance: 'DEMO-GUIDANCE', osas: 'DEMO-OSAS', executive: 'DEMO-PRESIDENT' }
  const stages: Stage[] = ['adviser', 'chair', 'dean', 'guidance', 'osas', 'executive']
  function report(id: string, ownerId: string, stage: Stage, bypassed = false, converted = false): Report {
    const owner = users.find(u => u.id === ownerId)!
    const history = stages.slice(0, stages.indexOf(stage) + 1).filter(s => !bypassed || s !== 'adviser').map((s, index): History => ({ id: `H-${id}-${index}`, at, actorId: s === 'adviser' ? owner.adviserId! : s === 'chair' && owner.program === 'BSCS' ? 'DEMO-CHAIR-CS' : actorIds[s], actorRole: stageRoles[s], action: index === 0 ? 'Submitted' : 'Transferred', reason: 'Demo workflow review', update: 'Your report is with the responsible office for review.', public: true, stage: s }))
    return { id, ownerId, program: owner.program!, adviserId: owner.adviserId!, stage, status: stage === 'guidance' && converted ? 'Case File at Guidance' : `With ${stage}`, narrative: 'The published laboratory timetable changed during the activity period. Please review how schedule updates are communicated.', category: 'General concern', severity: 'medium', identity: 'anonymous', alias: `Reporter A-${id.slice(-2)}`, disclosedTo: [], involvedUserIds: bypassed ? [owner.adviserId!] : [], bypassed, createdAt: at, updatedAt: at, ...(converted ? { caseFileId: `CF-${id.slice(-4)}` } : {}), history, notes: [{ id: `NOTE-${id}`, authorId: actorIds[stage], body: 'Internal coordination note for the responsible office.', at }], messages: [{ id: `MSG-${id}`, authorId: actorIds[stage], body: 'Your report has been received. You can add information in this conversation.', at }] }
  }
  const reports = [report('RPT-0241', 'DEMO-STU-IT-A', 'adviser'), report('RPT-0242', 'DEMO-STU-IT-A', 'chair', true), report('RPT-0243', 'DEMO-STU-IT-B', 'dean'), report('RPT-0244', 'DEMO-STU-RESTRICTED', 'guidance'), report('RPT-0245', 'DEMO-STU-IT-A', 'guidance', false, true), report('RPT-0246', 'DEMO-STU-IT-A', 'osas', false, true), report('RPT-0247', 'DEMO-STU-IT-A', 'executive', false, true), report('RPT-0248', 'DEMO-STU-CS', 'chair')]
  reports[0]!.sourcePostId = 'POST-0102'
  const questions: Question[] = [{ id: 'Q1', criterion: 'Clarity', text: 'Explains concepts and requirements clearly.', type: 'rating', required: true }, { id: 'Q2', criterion: 'Support', text: 'Provides useful support for learning.', type: 'rating', required: true }, { id: 'Q3', criterion: 'Fairness', text: 'Communicates assessment expectations consistently.', type: 'rating', required: true }]
  const cycles: Cycle[] = [{ id: 'CYCLE-2026-1', title: '1st semester 2026–2027', term: '1st semester', opens: '2026-10-01', closes: '2026-11-30', status: 'Published', instructions: 'Reflect on the teaching and support you experienced. Choose a rating for each statement.', questions, forms: ['student', 'peer', 'upward-chair', 'upward-dean'], resultsPublished: true, reviews: [{ userId: 'DEMO-PROF-IT', decision: 'reviewed', note: 'Questions fit the listed duties.', at }] }, { id: 'CYCLE-2026-2', title: '2nd semester draft', term: '2nd semester', opens: '2027-01-10', closes: '2027-03-30', status: 'In review', instructions: 'Please review the proposed questions.', questions: structuredClone(questions), forms: ['student', 'peer'], resultsPublished: false, reviews: [] }]
  const assignments: Assignment[] = [
    { id: 'EVAL-STU-IT-1', evaluatorId: 'DEMO-STU-IT-A', facultyId: 'DEMO-PROF-IT', cycleId: 'CYCLE-2026-1', relation: 'Student to faculty', subject: 'Data Structures · BSIT 3A' },
    { id: 'EVAL-STU-IT-2', evaluatorId: 'DEMO-STU-RESTRICTED', facultyId: 'DEMO-PROF-IT', cycleId: 'CYCLE-2026-1', relation: 'Student to faculty', subject: 'Data Structures · BSIT 3A' },
    { id: 'EVAL-STU-B-1', evaluatorId: 'DEMO-STU-IT-B', facultyId: 'DEMO-PROF-OTHER', cycleId: 'CYCLE-2026-1', relation: 'Student to faculty', subject: 'BSIT 3B' },
    { id: 'EVAL-STU-CS-1', evaluatorId: 'DEMO-STU-CS', facultyId: 'DEMO-PROF-CS', cycleId: 'CYCLE-2026-1', relation: 'Student to faculty', subject: 'BSCS 2A' },
    { id: 'EVAL-PEER-1', evaluatorId: 'DEMO-PROF-IT', facultyId: 'DEMO-PROF-OTHER', cycleId: 'CYCLE-2026-1', relation: 'Peer', subject: 'Faculty peer review' },
    { id: 'EVAL-UPWARD-1', evaluatorId: 'DEMO-PROF-IT', facultyId: 'DEMO-CHAIR-IT', cycleId: 'CYCLE-2026-1', relation: 'Upward: Program Chair', subject: 'Program leadership' },
    { id: 'EVAL-UPWARD-2', evaluatorId: 'DEMO-PROF-IT', facultyId: 'DEMO-DEAN', cycleId: 'CYCLE-2026-1', relation: 'Upward: Dean', subject: 'College leadership' },
    { id: 'EVAL-CHAIR-1', evaluatorId: 'DEMO-CHAIR-IT', facultyId: 'DEMO-PROF-IT', cycleId: 'CYCLE-2026-1', relation: 'Peer', subject: 'Faculty peer review' },
  ]
  assignments.push({ id: 'EVAL-REVIEW-IT', evaluatorId: 'DEMO-STU-IT-A', facultyId: 'DEMO-PROF-IT', cycleId: 'CYCLE-2026-2', relation: 'Student to faculty', subject: 'Proposed next-cycle form' }, { id: 'EVAL-REVIEW-OTHER', evaluatorId: 'DEMO-STU-IT-B', facultyId: 'DEMO-PROF-OTHER', cycleId: 'CYCLE-2026-2', relation: 'Student to faculty', subject: 'Proposed next-cycle form' })
  for (const faculty of users.filter(u => u.roles.some(r => ['professor', 'chair', 'dean'].includes(r)))) for (let n = 0; n < 5; n++) assignments.push({ id: `EVAL-SAMPLE-${faculty.id}-${n}`, evaluatorId: `SAMPLE-EVALUATOR-${n}`, facultyId: faculty.id, cycleId: 'CYCLE-2026-1', relation: 'Sample aggregate response', subject: 'Synthetic pilot sample', answers: { Q1: n % 2 ? 4 : 5, Q2: 4, Q3: n % 2 ? 5 : 4 }, submittedAt: at, comment: '' })
  const restrictions: Restriction[] = [{ id: 'RST-0101', studentId: 'DEMO-STU-RESTRICTED', features: ['post.create', 'post.comment', 'report.anonymous'], basis: 'Approved demo decision reference only', decisionReference: 'DEMO-DEC-001', starts: at, until: '2026-12-01', actorId: 'DEMO-ADMIN', active: true }]
  return {
    sequence: 1000, users, spaces, organizations: [{ id: 'ORG-COMPUTING', name: 'CCS Computing Society', description: 'A sample CCS student organization for computing workshops and peer activities.', representativeId: 'DEMO-ORG', memberIds: ['DEMO-STU-IT-A'] }], posts, reports, drafts: {},
    threads: [
      {
        id: 'THREAD-IT-A',
        title: 'BSIT 3A class group',
        memberIds: ['DEMO-STU-IT-A', 'DEMO-STU-RESTRICTED', 'DEMO-PROF-IT'],
        spaceId: 'SPACE-IT-A',
        messages: [{ id: 'MESSAGE-0101', authorId: 'DEMO-PROF-IT', body: 'Please use this group for class coordination.', at }],
        mutedBy: [],
        readMessageCounts: { 'DEMO-PROF-IT': 1 },
      },
      {
        id: 'THREAD-DIRECT-1',
        title: 'Academic consultation',
        memberIds: ['DEMO-STU-IT-A', 'DEMO-PROF-IT'],
        messages: [{ id: 'MESSAGE-0102', authorId: 'DEMO-STU-IT-A', body: 'May I ask about the next consultation time?', at }],
        mutedBy: [],
        readMessageCounts: { 'DEMO-STU-IT-A': 1 },
      },
      {
        id: 'THREAD-FACULTY-1',
        title: 'Faculty coordination',
        memberIds: ['DEMO-CHAIR-IT', 'DEMO-PROF-IT'],
        messages: [{ id: 'MESSAGE-0103', authorId: 'DEMO-CHAIR-IT', body: 'Please review the program announcement.', at }],
        mutedBy: [],
        readMessageCounts: { 'DEMO-CHAIR-IT': 1 },
      },
    ],
    slots: [{ id: 'SLOT-0101', facultyId: 'DEMO-PROF-IT', date: '2026-10-29', start: '10:00', end: '10:30', state: 'open' }, { id: 'SLOT-0102', facultyId: 'DEMO-PROF-IT', date: '2026-10-29', start: '10:30', end: '11:00', state: 'requested' }, { id: 'SLOT-0103', facultyId: 'DEMO-PROF-IT', date: '2026-10-30', start: '13:00', end: '14:00', state: 'unavailable' }, { id: 'SLOT-0104', facultyId: 'DEMO-PROF-OTHER', date: '2026-10-29', start: '09:00', end: '09:30', state: 'open' }, { id: 'SLOT-0105', facultyId: 'DEMO-PROF-CS', date: '2026-10-29', start: '11:00', end: '11:30', state: 'open' }, { id: 'SLOT-0106', facultyId: 'DEMO-CHAIR-IT', date: '2026-10-30', start: '10:00', end: '10:30', state: 'open' }],
    consultations: [{ id: 'CONSULT-0101', studentId: 'DEMO-STU-IT-A', facultyId: 'DEMO-PROF-IT', slotId: 'SLOT-0102', purpose: 'Clarify the project rubric', status: 'Requested', createdAt: at, updatedAt: at, history: [{ at, status: 'Requested', note: 'Request received', actorId: 'DEMO-STU-IT-A' }] }],
    todos: [{ id: 'TODO-0101', ownerId: 'DEMO-STU-IT-A', title: 'Prepare consultation questions', date: '2026-10-29', done: false }], events: [{ id: 'EVENT-0101', title: 'CCS consultation week', date: '2026-10-29', start: '08:00', end: '17:00', type: 'CCS', description: 'Review faculty availability and request a time through ACCS.', contactId: 'DEMO-STAFF' }, { id: 'EVENT-0102', title: 'Computing workshop', date: '2026-11-05', start: '13:00', end: '15:00', type: 'Organization', description: 'Introductory workshop open to CCS students.', contactId: 'DEMO-ORG', organizationId: 'ORG-COMPUTING' }, { id: 'EVENT-0103', title: 'Academic term checkpoint', date: '2026-11-09', start: '08:00', end: '09:00', type: 'Academic year', description: 'Review course requirements with your faculty.', contactId: 'DEMO-STAFF' }], cycles, assignments, restrictions, referrals: [], offenses: [{ id: 'OFF-0101', studentId: 'DEMO-STU-RESTRICTED', level: 1, summary: 'Synthetic recorded decision for a prototype workflow.', decisionReference: 'DEMO-DEC-001', actorRole: 'osas', at, status: 'Recorded' }], goodMoral: [],
    clusters: [{ id: 'CLUSTER-0101', program: 'BSIT', title: 'Laboratory schedule updates', reportIds: ['RPT-0241', 'RPT-0242', 'RPT-0243'], similarity: 86, supporting: 'Reports describe difficulty planning after timetable changes.', dissenting: 'One report notes that an updated notice was later provided.', phrases: ['laboratory timetable', 'schedule updates'], status: 'To review', history: [] }],
    notifications: users.map((u, index) => ({ id: `NOTIF-${index + 1}`, recipientId: u.id, kind: 'announcement', title: 'College announcement available', body: 'An update is available in your feed.', priority: 'normal', pageId: 'P04', at, read: false })),
    audit: [{ id: 'AUDIT-DEMO-1', at, actorId: 'DEMO-ADMIN', action: 'Prototype initialized', module: 'identity', reference: 'DEMO-SEED', result: 'Recorded' }],
    moderation: [{ id: 'MOD-0101', itemType: 'comment', itemId: 'COMMENT-0101', parentId: 'POST-0102', authorId: 'DEMO-STU-IT-B', reporterId: 'DEMO-STU-IT-A', source: 'User', reason: 'Please review the context', excerpt: 'A calendar update would help us plan.', status: 'Pending', at, history: [] }], settings: {}, permissionOverrides: {}, telemetry: [], followUps: [],
  }
}
