import { z } from 'zod'

import { campusCodes, campusYearProblem, mainCampus } from './sections.js'

import { passwordProblem } from './auth.js'

// The CCS Staff role was removed on 11 November 2026 (#45); stored accounts with only that role are deactivated.
export const roles = ['student', 'organization', 'professor', 'chair', 'dean', 'administrator', 'guidance', 'osas', 'secretary'] as const
export const roleSchema = z.enum(roles)
export type Role = z.infer<typeof roleSchema>
export const roleLabels: Record<Role, string> = { student: 'Student', organization: 'CCS Student Organization', professor: 'Professor', chair: 'Program Chair', dean: 'Dean', administrator: 'System Administrator', guidance: 'Guidance', osas: 'OSAS', secretary: 'CCS Secretary' }
export const programs = ['BSIT', 'BSCS', 'BSIS'] as const
/** The ways a student can choose to talk about a concern. */
export const talkModes = ['chat', 'video', 'voice', 'face_to_face'] as const
export type TalkMode = (typeof talkModes)[number]
export const userSchema = z.object({ id: z.string(), name: z.string(), email: z.email(), roles: z.array(roleSchema), program: z.string().optional(), section: z.string().optional(), campus: z.string().optional(), office: z.string().optional(), organizationId: z.string().optional(), restrictions: z.array(z.string()), title: z.string(), bio: z.string(), education: z.string(), photo: z.string().optional(), officeHours: z.string(), year: z.number().optional(), studentId: z.string().optional(), spaceIds: z.array(z.string()), organizationIds: z.array(z.string()), adviserId: z.string().optional(), active: z.boolean(), username: z.string().optional(), mustChangeCredentials: z.boolean().optional() })
export type User = z.infer<typeof userSchema>
export const pageIdSchema = z.string().regex(/^P(0[1-9]|[1-4][0-9]|5[0-4])$/)
export const pageQuerySchema = z.object({ id: z.string().max(100).optional(), q: z.string().max(200).optional(), tab: z.string().max(50).optional(), status: z.string().max(50).optional(), program: z.string().max(20).optional(), year: z.string().max(4).optional(), section: z.string().max(20).optional(), clearance: z.enum(['clear','on_hold']).optional(), category: z.string().max(80).optional(), stage: z.string().max(40).optional(), period: z.string().max(40).optional(), from: z.string().max(40).optional(), to: z.string().max(40).optional(), severity: z.enum(['low','medium','high']).optional(), cycle: z.string().max(100).optional(), label: z.string().max(80).optional(), scope: z.string().max(100).optional(), space: z.string().max(100).optional(), priority: z.string().max(30).optional(), type: z.string().max(40).optional(), source: z.string().max(30).optional(), role: roleSchema.optional(), office: z.string().max(100).optional(), view: z.enum(['month','week','list']).optional(), date: z.string().max(40).optional(), layers: z.string().max(200).optional(), sort: z.string().max(40).optional(), received: z.string().max(40).optional(), unread: z.enum(['true','false']).optional(), standing: z.string().max(60).optional(), recipient: z.string().max(100).optional(), hasRestriction: z.enum(['true','false']).optional(), purpose: z.enum(['Case handling', 'Good Moral review', 'Restriction review', 'Program oversight']).optional(), page: z.coerce.number().int().min(1).max(10000).optional() }).strict()
export type PageQuery = z.infer<typeof pageQuerySchema>
export const jsonObjectSchema = z.record(z.string(), z.json())
export const pageResponseSchema = z.object({ pageId: pageIdSchema, title: z.string(), scope: z.string(), data: jsonObjectSchema })
export const sessionResponseSchema = z.object({ user: userSchema, permissions: z.array(z.string()), allowedPages: z.array(z.string()), roleLabels: z.record(z.string(), z.string()) })
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
  // SB, BAT or SF (src/sections.ts). Left out, the student is at San Bartolome, so the current import screen keeps working.
  campus: z.string().trim().toUpperCase().pipe(z.enum(campusCodes, { error: 'Choose SB (San Bartolome), BAT (Batasan) or SF (San Francisco).' })).default(mainCampus),
}).superRefine((row, ctx) => {
  // Only once the year itself is valid; an invalid year already has its own message.
  if (!Number.isInteger(row.year) || row.year < 1 || row.year > 4) return
  const problem = campusYearProblem(row.campus, row.year)
  if (problem) ctx.addIssue({ code: 'custom', path: ['campus'], message: problem })
})
export const createFacultySchema = z.object({ faculty: z.array(z.unknown()).min(1).max(batchLimit).optional() }).catchall(z.unknown())
export const importStudentsSchema = z.object({ students: z.array(z.unknown()).min(1).max(batchLimit) }).strict()
export const accountIdParamsSchema = z.object({ id: z.string().trim().min(1).max(64) }).strict()
export const setActiveSchema = z.object({ active: z.boolean() }).strict()
export const activateSecretarySchema = z.object({ name: fullName.optional(), email: accountEmail.optional() }).strict()
/** The real Dean's name and email; both are required, so the account stops being a sample one. */
export const setupDeanSchema = z.object({ name: fullName, email: accountEmail }).strict()
export const yearLevelParamsSchema = z.object({ yearLevel: z.coerce.number().int().min(1).max(4) }).strict()
export const setAdvisorsSchema = z.object({ facultyIds: z.array(z.string().trim().min(1).max(64)).max(50) }).strict()
export const programParamsSchema = z.object({ program: z.enum(programs) }).strict()
export const setChairSchema = z.object({ facultyId: z.string().trim().min(1).max(64) }).strict()
export const accountsQuerySchema = z.object({ role: roleSchema.optional(), q: z.string().max(200).optional() }).strict()
export const facultyQuerySchema = z.object({ q: z.string().max(200).optional(), program: z.enum(programs).optional() }).strict()
const accountSummarySchema = z.object({ id: z.string(), name: z.string(), email: z.string(), roles: z.array(roleSchema), program: z.string().optional(), section: z.string().optional(), campus: z.string().optional(), year: z.number().optional(), studentId: z.string().optional(), adviserId: z.string().optional(), active: z.boolean(), mustChangeCredentials: z.boolean().optional() })
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
const weekdayNames: Record<string, string> = { mon: 'Mon', monday: 'Mon', tue: 'Tue', tues: 'Tue', tuesday: 'Tue', wed: 'Wed', wednesday: 'Wed', thu: 'Thu', thur: 'Thu', thurs: 'Thu', thursday: 'Thu', fri: 'Fri', friday: 'Fri', sat: 'Sat', saturday: 'Sat' }
/** One row of a faculty load file (#39). The columns are assumed until a sample file is provided. */
export const loadRowSchema = z.object({
  facultyEmail: z.string({ error: 'Enter the faculty email.' }).trim().toLowerCase().pipe(z.email('Enter a valid email address.')),
  day: z.string({ error: 'Enter the day, like Mon.' }).trim().toLowerCase().transform((day) => weekdayNames[day] ?? day).pipe(z.enum(['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'], { error: 'Use a day from Mon to Sat.' })),
  start: z.string({ error: 'Enter the start time, like 07:30.' }).trim().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Use 24-hour time, like 07:30.'),
  end: z.string({ error: 'Enter the end time, like 09:00.' }).trim().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Use 24-hour time, like 09:00.'),
  subject: z.string({ error: 'Enter the subject.' }).trim().min(1, 'Enter the subject.').max(120, 'Use at most 120 characters.'),
  section: z.string().trim().max(20, 'Use at most 20 characters.').optional(),
  room: z.string().trim().max(40, 'Use at most 40 characters.').optional(),
}).refine((row) => row.end > row.start, { path: ['end'], message: 'The end time must be later than the start time.' })
const materialUrl = z.string().trim().max(2000).pipe(z.url({ protocol: /^https?$/, error: 'Use a link that starts with http:// or https://.' }))
export const materialUploadSchema = z.object({ spaceId: z.string().min(1), title: z.string().trim().min(1, 'Enter a title.').max(160, 'Use at most 160 characters.'), note: z.string().trim().max(1000, 'Use at most 1000 characters.').optional(), fileName: z.string().trim().min(1, 'Choose a file.').max(200, 'Use a shorter file name.'), contentType: z.string().trim().toLowerCase().max(120), size: z.number().int().positive('The file is empty.') }).strict()
/** The reactions a post or comment can get (#86). */
export const reactionKinds = ['like', 'love', 'laugh', 'wow', 'sad', 'support'] as const
export type ReactionKind = typeof reactionKinds[number]
export const actionPayloads = {
  // A faculty member reports a student (decided 12 November 2026). Same categories as a concern.
  reportStudent: z.object({ studentId: z.string().min(1), narrative: z.string().trim().min(1).max(4000), category: z.string().trim().min(1).max(80), subcategory: z.string().trim().min(1).max(80).optional(), categoryDetail: z.string().trim().max(120).optional(), severity: z.enum(['low', 'medium', 'high']), location: z.string().trim().max(200).optional(), occurredOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional() }).strict(),
  addMaterial: z.object({ spaceId: z.string().min(1), title: z.string().trim().min(1, 'Enter a title.').max(160, 'Use at most 160 characters.'), url: materialUrl, note: z.string().trim().max(1000, 'Use at most 1000 characters.').optional() }).strict(),
  // A link may change its address; a file keeps its file and changes only its title and note.
  updateMaterial: z.object({ title: z.string().trim().min(1, 'Enter a title.').max(160, 'Use at most 160 characters.'), url: materialUrl.optional(), note: z.string().trim().max(1000, 'Use at most 1000 characters.').optional() }).strict(),
  removeMaterial: z.object({}).strict(),
  uploadLoadSchedule: z.object({ term: z.string().trim().min(1).max(60), startsOn: date, endsOn: date, rows: z.array(z.unknown()).min(1).max(500) }).strict(),
  createPost: createPostSchema,
  updatePost: z.object(postContent).strict(),
  deletePost: z.object({}).strict(),
  comment: z.object({ body: text, anonymous: z.boolean().default(false) }).strict(),
  // A choice of reactions (#86). Without one it is "like", as the single reaction was before.
  react: z.object({ reaction: z.enum(reactionKinds).default('like') }).strict(),
  reactComment: z.object({ commentId: z.string().min(1), reaction: z.enum(reactionKinds).default('like') }).strict(),
  flag: z.object({ reason, itemType: z.enum(['post', 'comment', 'message']).default('post'), itemId: z.string().optional() }).strict(),
  // The agreement and the three choices have no defaults: a concern is never sent on a guess about what the student allowed.
  createReport: z.object({ narrative: text, category: text.max(80), subcategory: z.string().trim().min(1).max(80).optional(), categoryDetail: z.string().trim().max(120).optional(), severity: z.enum(['low', 'medium', 'high']), identity: z.enum(['named', 'anonymous']), involvedUserIds: z.array(z.string()).default([]), conflictedAdviser: z.boolean().default(false), sourcePostId: z.string().optional(), location: z.string().max(200).optional(), occurredOn: date.optional(), consent: z.object({ readStatement: z.literal(true, { error: agree }) }, { error: agree }).strict(), // The Program Chair and the Dean have access without the student's permission (baseline of 10 November 2026). The two
  // answers are still accepted from clients that send them, and ignored.
  allowChair: z.boolean().optional(), allowDean: z.boolean().optional(), aboutAdvisor: z.boolean({ error: yesOrNo }) }).strict(),
  saveDraft: z.object({ narrative: z.string().max(4000), category: z.string().max(80).optional(), subcategory: z.string().max(80).optional(), categoryDetail: z.string().max(120).optional(), severity: z.enum(['low', 'medium', 'high']).optional(), identity: z.enum(['named', 'anonymous']).optional() }).strict(),
  sendReportMessage: z.object({ body: text }).strict(),
  setConfidential: z.object({ confidential: z.boolean() }).strict(),
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
  // An appointment (called a consultation in the API). The current screen sends a free `purpose`; the new one sends
  // `category` and `subcategory` (src/appointments.ts), with `details` required for "Other" and optional otherwise.
  createConsultation: z.object({ slotId: z.string().min(1), purpose: z.string().trim().min(1).max(300).optional(), category: z.string().trim().min(1).max(80).optional(), subcategory: z.string().trim().min(1).max(80).optional(), details: z.string().trim().max(300).optional() }).strict(),
  decideConsultation: z.object({ decision: z.enum(['Approved', 'Booked', 'Completed', 'Declined', 'Cancelled']), note: z.string().max(2000).optional() }).strict(),
  // A time marked not available needs a reason (#32); an open time takes none.
  saveAvailability: z.object({ date, start: time, end: time, state: z.enum(['open', 'unavailable']).default('open'), reason: z.string().trim().max(300, 'Use at most 300 characters.').optional() }).strict().superRefine((p, ctx) => {
    if (p.state === 'unavailable' && !p.reason) ctx.addIssue({ code: 'custom', path: ['reason'], message: 'Give a reason for marking this time not available.' })
    if (p.state === 'open' && p.reason) ctx.addIssue({ code: 'custom', path: ['reason'], message: 'Only a time marked not available takes a reason.' })
  }),
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
  saveCycle: z.object({ title: text.max(160), instructions: text, opens: date, closes: date, questions: z.array(questionSchema).min(1), forms: z.array(z.literal('student', { error: 'Evaluation cycles use the student form only.' })).min(1).optional() }).strict(),
  cycleAction: z.object({ status: z.enum(['In review', 'Published', 'Closed']), publishResults: z.boolean().default(false) }).strict(),
  reviewQuestions: z.object({ decision: z.enum(['reviewed', 'changes']), note: z.string().max(2000).default('') }).strict(),
  saveFollowUp: z.object({ note: text }).strict(),
  openRecord: z.object({ purpose: z.enum(['Case handling', 'Good Moral review', 'Restriction review', 'Program oversight']), note: z.string().max(500).optional() }).strict(),
  reviewGoodMoral: z.object({ status: z.enum(['Pending QCU review', 'Prerequisites reviewed', 'Further review needed']), decisionSource: text.max(200), notes: z.string().max(2000).default('') }).strict(),
  applyRestriction: z.object({ studentId: z.string(), features: z.array(z.enum(['post.create', 'post.comment', 'report.anonymous'])).min(1), basis: text.max(500), until: date, decisionReference: text.max(100) }).strict(),
  liftRestriction: z.object({}).strict(),
  // The Dean recommends a strike on a case with the Dean; OSAS confirms or rejects it on the case at OSAS.
  recommendStrike: z.object({ studentId: z.string().min(1), reportId: z.string().min(1), note: text.max(1000) }).strict(),
  decideStrike: z.object({ strikeId: z.string().min(1), decision: z.enum(['confirm', 'reject']), note: z.string().trim().max(1000).default('') }).strict(),
  settleStrikes: z.object({ studentId: z.string().min(1), kind: z.enum(['letter', 'reprimand']), reference: text.max(100), note: z.string().max(1000).default('') }).strict(),
  referRestriction: z.object({ studentId: z.string(), change: z.enum(['Lift', 'Shorten', 'Extend', 'Review']), decisionReference: z.string().max(100).optional() }).strict(),
  // A profile photo (#85): a square JPEG, PNG or WebP the browser has already resized, sent as a data URL. null removes it.
  setProfilePhoto: z.object({ photo: z.string().max(110_000, 'Use a smaller image (at most 80 KB).').regex(/^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/]+={0,2}$/, 'Use a JPEG, PNG or WebP image.').nullable() }).strict(),
  saveProfile: z.object({ title: z.string().max(100), bio: z.string().max(1000), education: z.string().max(500), officeHours: z.string().max(200) }).strict(),
  saveSettings: z.object({ theme: z.enum(['system', 'light', 'dark']), density: z.enum(['comfortable', 'compact']) }).strict(),
  saveNotificationPreferences: z.object({ priorities: z.record(z.string(), z.enum(['high', 'normal', 'muted'])) }).strict(),
  updateRoles: z.object({ roles: z.array(roleSchema).min(1), program: z.enum(programs).optional(), section: z.string().max(50).optional(), active: z.boolean().optional() }).strict(),
  updatePermission: z.object({ role: roleSchema, permission: z.string().min(1), allowed: z.boolean() }).strict(),
  moderate: z.object({ decision: z.enum(['keep', 'remove', 'warn', 'refer']), notifyAuthor: z.boolean().default(true) }).strict(),
} satisfies Record<string, z.ZodType>
export type ActionName = keyof typeof actionPayloads
