import { z } from 'zod'

import { passwordProblem } from './auth.js'

export const roles = ['student', 'organization', 'professor', 'staff', 'chair', 'dean', 'administrator', 'guidance', 'osas', 'secretary'] as const
export const roleSchema = z.enum(roles)
export type Role = z.infer<typeof roleSchema>
export const roleLabels: Record<Role, string> = { student: 'Student', organization: 'CCS Student Organization', professor: 'Professor', staff: 'CCS Staff', chair: 'Program Chair', dean: 'Dean', administrator: 'Administrator / Moderator', guidance: 'Guidance', osas: 'OSAS', secretary: 'CCS Secretary' }
export const programs = ['BSIT', 'BSCS', 'BSIS'] as const
/** The ways a student can choose to talk about a concern. */
export const talkModes = ['chat', 'video', 'voice', 'face_to_face'] as const
export type TalkMode = (typeof talkModes)[number]
export const userSchema = z.object({ id: z.string(), name: z.string(), email: z.email(), roles: z.array(roleSchema), program: z.string().optional(), section: z.string().optional(), office: z.string().optional(), organizationId: z.string().optional(), restrictions: z.array(z.string()), title: z.string(), bio: z.string(), education: z.string(), officeHours: z.string(), year: z.number().optional(), studentId: z.string().optional(), spaceIds: z.array(z.string()), organizationIds: z.array(z.string()), adviserId: z.string().optional(), active: z.boolean(), username: z.string().optional(), mustChangeCredentials: z.boolean().optional() })
export type User = z.infer<typeof userSchema>
export const pageIdSchema = z.string().regex(/^P(0[1-9]|[1-4][0-9]|5[0-2])$/)
export const pageQuerySchema = z.object({ id: z.string().max(100).optional(), q: z.string().max(200).optional(), tab: z.string().max(50).optional(), status: z.string().max(50).optional(), program: z.string().max(20).optional(), category: z.string().max(80).optional(), stage: z.string().max(40).optional(), period: z.string().max(40).optional(), from: z.string().max(40).optional(), to: z.string().max(40).optional(), severity: z.enum(['low','medium','high']).optional(), cycle: z.string().max(100).optional(), label: z.string().max(80).optional(), scope: z.string().max(100).optional(), space: z.string().max(100).optional(), priority: z.string().max(30).optional(), type: z.string().max(40).optional(), source: z.string().max(30).optional(), role: roleSchema.optional(), office: z.string().max(100).optional(), view: z.enum(['month','week','list']).optional(), date: z.string().max(40).optional(), layers: z.string().max(200).optional(), sort: z.string().max(40).optional(), received: z.string().max(40).optional(), unread: z.enum(['true','false']).optional(), standing: z.string().max(60).optional(), recipient: z.string().max(100).optional(), hasRestriction: z.enum(['true','false']).optional(), purpose: z.enum(['Case handling', 'Good Moral review', 'Restriction review', 'Program oversight']).optional(), page: z.coerce.number().int().min(1).max(10000).optional() }).strict()
export type PageQuery = z.infer<typeof pageQuerySchema>
export const jsonObjectSchema = z.record(z.string(), z.json())
export const pageResponseSchema = z.object({ pageId: pageIdSchema, title: z.string(), scope: z.string(), sampleData: z.literal(true), data: jsonObjectSchema })
export const sessionResponseSchema = z.object({ user: userSchema, permissions: z.array(z.string()), allowedPages: z.array(z.string()), roleLabels: z.record(z.string(), z.string()), sampleData: z.literal(true) })
export const actionRequestSchema = z.object({ action: z.string().min(1).max(60), recordId: z.string().max(100).optional(), payload: z.record(z.string(), z.unknown()).default({}), reason: z.string().max(2000).optional() }).strict()
export type ActionRequest = z.infer<typeof actionRequestSchema>
export const actionResponseSchema = z.object({ ok: z.literal(true), message: z.string(), record: z.json().optional() })
export const errorResponseSchema = z.object({ error: z.string(), code: z.string(), fields: z.array(z.object({ path: z.string(), message: z.string() })).optional() })
const password = z.string().max(200).superRefine((value, context) => {
  const problem = passwordProblem(value)
  if (problem) context.addIssue({ code: 'custom', message: problem })
})
const emailOrId = z.string().trim().min(1).max(200)
export const signInSchema = z.object({ emailOrId, password: z.string().min(1).max(200), remember: z.boolean().optional() }).strict()
export const forgotPasswordSchema = z.object({ emailOrId }).strict()
export const resetPasswordSchema = z.object({ emailOrId, code: z.string().trim().regex(/^\d{6}$/, 'Enter the 6-digit code.'), password }).strict()
export const changePasswordSchema = z.object({ currentPassword: z.string().min(1).max(200), password }).strict()
// The first sign-in replaces the temporary username and password. A username is lower case and unique.
export const usernameSchema = z.string().trim().toLowerCase().min(3, 'Use at least 3 characters.').max(32, 'Use at most 32 characters.').regex(/^[a-z0-9][a-z0-9._-]*$/, 'Use letters, numbers, dots, dashes, or underscores.')
export const completeFirstLoginSchema = z.object({ currentPassword: z.string().min(1).max(200), username: usernameSchema, password }).strict()
export const emptyBodySchema = z.object({}).strict()
export const idParamsSchema = z.object({ pageId: pageIdSchema }).strict()
export const healthResponseSchema = z.object({ status: z.literal('ok') })

// Account provisioning. Rows of a batch are checked one by one (a bad row does not fail the others), so the envelopes
// only bound the batch. A request creates at most 25 accounts: hashing a password is slow and a Lambda call lasts 10 s.
export const batchLimit = 25
const fullName = z.string({ error: 'Enter the full name.' }).trim().min(2, 'Enter the full name.').max(100, 'Use at most 100 characters.')
const accountEmail = z.string({ error: 'Enter an email address.' }).trim().toLowerCase().max(200, 'Use at most 200 characters.').pipe(z.email('Enter a valid email address.'))
const accountProgram = z.enum(programs, { error: 'Choose BSIT, BSCS, or BSIS.' })
export const facultyRowSchema = z.object({ name: fullName, email: accountEmail, program: accountProgram })
export const studentRowSchema = z.object({
  name: fullName,
  email: accountEmail,
  studentId: z.string({ error: 'Enter the student ID.' }).trim().regex(/^[A-Za-z0-9][A-Za-z0-9-]{2,39}$/, 'Use letters, numbers, and dashes, like 24-1234.'),
  program: accountProgram,
  year: z.coerce.number({ error: 'Choose a year level from 1 to 4.' }).int('Choose a year level from 1 to 4.').min(1, 'Choose a year level from 1 to 4.').max(4, 'Choose a year level from 1 to 4.'),
  section: z.string({ error: 'Enter the section.' }).trim().toUpperCase().regex(/^[A-Z0-9]{1,10}$/, 'Use the section letter, like A.'),
})
export const createFacultySchema = z.object({ faculty: z.array(z.unknown()).min(1).max(batchLimit).optional() }).catchall(z.unknown())
export const importStudentsSchema = z.object({ students: z.array(z.unknown()).min(1).max(batchLimit) }).strict()
export const accountIdParamsSchema = z.object({ id: z.string().trim().min(1).max(64) }).strict()
export const setActiveSchema = z.object({ active: z.boolean() }).strict()
export const activateSecretarySchema = z.object({ name: fullName.optional(), email: accountEmail.optional() }).strict()
export const yearLevelParamsSchema = z.object({ yearLevel: z.coerce.number().int().min(1).max(4) }).strict()
export const setAdvisorsSchema = z.object({ facultyIds: z.array(z.string().trim().min(1).max(64)).max(50) }).strict()
export const programParamsSchema = z.object({ program: z.enum(programs) }).strict()
export const setChairSchema = z.object({ facultyId: z.string().trim().min(1).max(64) }).strict()
export const accountsQuerySchema = z.object({ role: roleSchema.optional(), q: z.string().max(200).optional() }).strict()
export const facultyQuerySchema = z.object({ q: z.string().max(200).optional(), program: z.enum(programs).optional() }).strict()
const accountSummarySchema = z.object({ id: z.string(), name: z.string(), email: z.string(), roles: z.array(roleSchema), program: z.string().optional(), section: z.string().optional(), year: z.number().optional(), studentId: z.string().optional(), adviserId: z.string().optional(), active: z.boolean(), mustChangeCredentials: z.boolean().optional() })
export const accountTypesResponseSchema = z.object({
  types: z.array(z.object({ type: z.enum(['secretary', 'faculty', 'advisor', 'chair', 'student']), label: z.string(), active: z.number(), inactive: z.number(), canManage: z.boolean() })),
  secretary: accountSummarySchema.optional(),
})
export const accountListResponseSchema = z.object({ accounts: z.array(accountSummarySchema), total: z.number() })
export const facultyListResponseSchema = z.object({ faculty: z.array(accountSummarySchema.extend({ advisorYears: z.array(z.number()), chairProgram: z.string().nullable() })) })
export const advisorsResponseSchema = z.object({ advisors: z.array(z.object({ yearLevel: z.number(), faculty: z.array(accountSummarySchema) })) })

const text = z.string().trim().min(1).max(4000)
const reason = z.string().trim().min(1).max(2000)
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/)
const time = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/)
// A date and time as a browser gives it, with or without a time zone: 2026-11-06T10:00 or 2026-11-06T02:00:00Z.
const when = z.iso.datetime({ offset: true, local: true })
// People open a meeting link from the page, so only https is accepted. The link is kept in its normal form.
const meetingLink = z.string().trim().max(500).transform((value, context) => {
  try {
    const url = new URL(value)
    if (url.protocol === 'https:' && url.hostname && !url.username && !url.password) return url.href
  } catch {
    // Not a link at all: reported below with the same message.
  }
  context.addIssue({ code: 'custom', message: 'Use a link that starts with https://' })
  return z.NEVER
})
const agree = 'Read and agree to the statement to send your concern.'
const yesOrNo = 'Choose yes or no.'
export const postLabels = ['Discussion', 'Rant', 'Assistance', 'Support'] as const
export const announcementPriorities = ['general', 'important', 'urgent'] as const
const postContent = {
  title: text.max(160),
  body: z.string().trim().min(1).max(5000),
  label: z.string().trim().max(80).optional(),
  priority: z.enum(announcementPriorities).default('general'),
}
const createPostSchema = z.object({
  ...postContent,
  audience: z.string().trim().min(1).max(100),
  kind: z.enum(['discussion', 'announcement']).default('discussion'),
  anonymous: z.boolean().default(false),
  private: z.boolean().default(false),
  eventDate: date.optional(),
  eventTime: time.optional(),
  eventPlace: z.string().trim().max(200).optional(),
  eventContact: z.string().trim().max(200).optional(),
  notifyMembers: z.boolean().default(false),
}).strict().superRefine((post, context) => {
  if (post.kind === 'discussion' && !postLabels.includes(post.label as typeof postLabels[number])) {
    context.addIssue({ code: 'custom', path: ['label'], message: 'Choose a post label.' })
  }
  const eventRequired = post.kind === 'announcement'
    && (post.audience.startsWith('space:') || post.audience.startsWith('organization:'))
  if (eventRequired) {
    for (const field of ['eventDate', 'eventTime', 'eventPlace', 'eventContact'] as const) {
      if (!post[field]) {
        context.addIssue({ code: 'custom', path: [field], message: 'Complete the event details.' })
      }
    }
  }
})
export const questionSchema = z.object({ id: z.string(), criterion: text, text, type: z.enum(['rating', 'text']), required: z.boolean() })
export const actionPayloads = {
  createPost: createPostSchema,
  updatePost: z.object(postContent).strict(),
  deletePost: z.object({}).strict(),
  comment: z.object({ body: text, anonymous: z.boolean().default(false) }).strict(),
  react: z.object({}).strict(),
  flag: z.object({ reason, itemType: z.enum(['post', 'comment', 'message']).default('post'), itemId: z.string().optional() }).strict(),
  // The agreement and the three choices have no defaults: a concern is never sent on a guess about what the student allowed.
  createReport: z.object({ narrative: text, category: text.max(80), severity: z.enum(['low', 'medium', 'high']), identity: z.enum(['named', 'anonymous']), involvedUserIds: z.array(z.string()).default([]), conflictedAdviser: z.boolean().default(false), sourcePostId: z.string().optional(), location: z.string().max(200).optional(), occurredOn: date.optional(), consent: z.object({ readStatement: z.literal(true, { error: agree }) }, { error: agree }).strict(), allowChair: z.boolean({ error: yesOrNo }), allowDean: z.boolean({ error: yesOrNo }), aboutAdvisor: z.boolean({ error: yesOrNo }) }).strict(),
  saveDraft: z.object({ narrative: z.string().max(4000), category: z.string().max(80).optional(), severity: z.enum(['low', 'medium', 'high']).optional(), identity: z.enum(['named', 'anonymous']).optional() }).strict(),
  sendReportMessage: z.object({ body: text }).strict(),
  chooseTalkMode: z.object({
    reportId: z.string().min(1).max(100),
    mode: z.enum(talkModes),
    // `recordCall` only means something for a video or voice call; the action says so.
    consent: z.object({ participate: z.literal(true, { error: 'Agree to take part to choose this way to talk.' }), recordCall: z.boolean().optional() }, { error: 'Agree to take part to choose this way to talk.' }).strict(),
    slotId: z.string().min(1).max(100).optional(),
    preferredAt: when.optional(),
  }).strict(),
  setTalkDetails: z.object({
    reportId: z.string().min(1).max(100),
    scheduledAt: when.optional(),
    meetingLink: meetingLink.optional(),
    place: z.string().trim().min(1).max(200).optional(),
  }).strict().refine(details => details.scheduledAt || details.meetingLink || details.place, { message: 'Add a time, a meeting link, or a place.' }),
  discloseIdentity: z.object({ office: z.string().min(1).optional() }).strict(),
  caseAction: z.object({ type: z.enum(['respond', 'recordAction', 'escalate', 'transfer', 'resolve', 'close', 'convert', 'milestone']), update: text, nextStage: z.enum(['adviser', 'chair', 'dean', 'guidance', 'osas']).optional() }).strict(),
  addNote: z.object({ body: text }).strict(),
  reviewCluster: z.object({ decision: z.enum(['confirmed', 'dismissed']) }).strict(),
  createConsultation: z.object({ slotId: z.string().min(1), purpose: z.string().trim().min(1).max(300) }).strict(),
  decideConsultation: z.object({ decision: z.enum(['Approved', 'Booked', 'Completed', 'Declined', 'Cancelled']), note: z.string().max(2000).optional() }).strict(),
  saveAvailability: z.object({ date, start: time, end: time, state: z.enum(['open', 'unavailable']).default('open') }).strict(),
  deleteAvailability: z.object({}).strict(),
  createTodo: z.object({ title: text.max(200), date }).strict(),
  toggleTodo: z.object({ done: z.boolean() }).strict(),
  deleteTodo: z.object({}).strict(),
  createThread: z.object({ recipientId: z.string().min(1), body: text }).strict(),
  sendMessage: z.object({ body: text }).strict(),
  muteThread: z.object({ muted: z.boolean() }).strict(),
  markThreadRead: z.object({}).strict(),
  markNotification: z.object({ read: z.boolean().default(true) }).strict(),
  markAllNotifications: z.object({}).strict(),
  openNotification: z.object({}).strict(),
  assistantAsk: z.object({ question: text.max(2000) }).strict(),
  submitEvaluation: z.object({ answers: z.record(z.string(), z.union([z.number().int().min(1).max(5), z.string().max(1000)])), comment: z.string().max(1000).default('') }).strict(),
  createCycle: z.object({ title: text.max(160), term: text.max(100), opens: date, closes: date }).strict(),
  saveCycle: z.object({ title: text.max(160), instructions: text, opens: date, closes: date, questions: z.array(questionSchema).min(1), forms: z.array(z.enum(['student', 'peer', 'upward-chair', 'upward-dean'])).min(1) }).strict(),
  cycleAction: z.object({ status: z.enum(['In review', 'Published', 'Closed']), publishResults: z.boolean().default(false) }).strict(),
  reviewQuestions: z.object({ decision: z.enum(['reviewed', 'changes']), note: z.string().max(2000).default('') }).strict(),
  saveFollowUp: z.object({ note: text }).strict(),
  openRecord: z.object({ purpose: z.enum(['Case handling', 'Good Moral review', 'Restriction review', 'Program oversight']), note: z.string().max(500).optional() }).strict(),
  reviewGoodMoral: z.object({ status: z.enum(['Pending QCU review', 'Prerequisites reviewed', 'Further review needed']), decisionSource: text.max(200), notes: z.string().max(2000).default('') }).strict(),
  applyRestriction: z.object({ studentId: z.string(), features: z.array(z.enum(['post.create', 'post.comment', 'report.anonymous'])).min(1), basis: text.max(500), until: date, decisionReference: text.max(100) }).strict(),
  liftRestriction: z.object({}).strict(),
  referRestriction: z.object({ studentId: z.string(), change: z.enum(['Lift', 'Shorten', 'Extend', 'Review']), decisionReference: z.string().max(100).optional() }).strict(),
  saveProfile: z.object({ title: z.string().max(100), bio: z.string().max(1000), education: z.string().max(500), officeHours: z.string().max(200) }).strict(),
  saveSettings: z.object({ theme: z.enum(['system', 'light', 'dark']), density: z.enum(['comfortable', 'compact']) }).strict(),
  saveNotificationPreferences: z.object({ priorities: z.record(z.string(), z.enum(['high', 'normal', 'muted'])) }).strict(),
  updateRoles: z.object({ roles: z.array(roleSchema).min(1), program: z.enum(programs).optional(), section: z.string().max(50).optional(), active: z.boolean().optional() }).strict(),
  updatePermission: z.object({ role: roleSchema, permission: z.string().min(1), allowed: z.boolean() }).strict(),
  moderate: z.object({ decision: z.enum(['keep', 'remove', 'warn', 'refer']), notifyAuthor: z.boolean().default(true) }).strict(),
} satisfies Record<string, z.ZodType>
export type ActionName = keyof typeof actionPayloads
