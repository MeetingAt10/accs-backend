import { z } from 'zod'

import { passwordProblem } from './auth.js'

export const roles = ['student', 'organization', 'professor', 'staff', 'chair', 'dean', 'administrator', 'guidance', 'osas', 'president'] as const
export const roleSchema = z.enum(roles)
export type Role = z.infer<typeof roleSchema>
export const roleLabels: Record<Role, string> = { student: 'Student', organization: 'CCS Student Organization', professor: 'Professor', staff: 'CCS Staff', chair: 'Program Chair', dean: 'Dean', administrator: 'Administrator / Moderator', guidance: 'Guidance', osas: 'OSAS', president: "President’s Office" }
export const programs = ['BSIT', 'BSCS', 'BSIS'] as const
export const userSchema = z.object({ id: z.string(), name: z.string(), email: z.email(), roles: z.array(roleSchema), program: z.string().optional(), section: z.string().optional(), office: z.string().optional(), organizationId: z.string().optional(), restrictions: z.array(z.string()), title: z.string(), bio: z.string(), education: z.string(), officeHours: z.string(), year: z.number().optional(), studentId: z.string().optional(), spaceIds: z.array(z.string()), organizationIds: z.array(z.string()), adviserId: z.string().optional(), active: z.boolean() })
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
export const emptyBodySchema = z.object({}).strict()
export const idParamsSchema = z.object({ pageId: pageIdSchema }).strict()
export const healthResponseSchema = z.object({ status: z.literal('ok') })

const text = z.string().trim().min(1).max(4000)
const reason = z.string().trim().min(1).max(2000)
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/)
const time = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/)
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
  createReport: z.object({ narrative: text, category: text.max(80), severity: z.enum(['low', 'medium', 'high']), identity: z.enum(['named', 'anonymous']), involvedUserIds: z.array(z.string()).default([]), conflictedAdviser: z.boolean().default(false), sourcePostId: z.string().optional(), location: z.string().max(200).optional(), occurredOn: date.optional() }).strict(),
  saveDraft: z.object({ narrative: z.string().max(4000), category: z.string().max(80).optional(), severity: z.enum(['low', 'medium', 'high']).optional(), identity: z.enum(['named', 'anonymous']).optional() }).strict(),
  sendReportMessage: z.object({ body: text }).strict(),
  discloseIdentity: z.object({ office: z.string().min(1).optional() }).strict(),
  caseAction: z.object({ type: z.enum(['respond', 'recordAction', 'escalate', 'transfer', 'resolve', 'close', 'convert', 'milestone', 'return']), update: text, nextStage: z.enum(['adviser', 'chair', 'dean', 'guidance', 'osas', 'executive']).optional() }).strict(),
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
