import { randomInt } from 'node:crypto'
import express, { type Request, type Response } from 'express'
import type { ZodError, ZodType } from 'zod'

import { hasPermission } from './access.js'
import { hashPassword, passwordProblem, type AuthData, type AuthStore } from './auth.js'
import { env } from './env.js'
import { send } from './http.js'
import { ulid } from './ids.js'
import { renameAccountIds, renamedAccountIds } from './renames.js'
import {
  accountIdParamsSchema, accountListResponseSchema, accountsQuerySchema, accountTypesResponseSchema, actionResponseSchema, activateSecretarySchema,
  advisorsResponseSchema, createFacultySchema, facultyListResponseSchema, facultyQuerySchema, facultyRowSchema, importStudentsSchema, programParamsSchema,
  roles, setActiveSchema, setAdvisorsSchema, setChairSchema, studentRowSchema, yearLevelParamsSchema, type Role, type User,
} from './schemas.js'
import { ApiError, deny, unavailable, type AccountChange, type ProfileChange } from './services.js'
import type { SessionStore } from './sessions.js'
import { demoUserIds, newUser, type Database, type Repository } from './store.js'

// Account provisioning. The Dean activates the secretary; the secretary creates faculty and students, assigns advisers
// and program chairs, and switches accounts on and off. All account state lives in the auth store (S3), which every
// Lambda instance reads: a stored record replaces the seeded user with the same ID. Temporary credentials are returned
// once and only their hash is stored. Nothing here writes a username or password to the audit trail or to a log.

const secretaryId = 'QCU-SECRETARY'
// The accounts the secretary may switch on and off. The Dean, administrators, and the offices are not theirs.
const secretaryScope: Role[] = ['student', 'professor', 'chair']

// --- invites ---------------------------------------------------------------------------------------------------------

export type Invite = { accountId: string; to: string; name: string; signInUrl: string; username: string; temporaryPassword: string }
/** Delivers an invite. SES will implement this; until then nothing is sent and the UI shows a copyable invite. */
export interface InviteMailer { send(invite: Invite): Promise<{ sent: boolean }> }
export const unsentMailer: InviteMailer = {
  async send(invite) {
    // The invite holds the credentials; only the account ID is logged.
    console.log(`[accs] invite for ${invite.accountId} not sent: no email service is configured`)
    return { sent: false }
  },
}
export const sendInvite = (invite: Invite, mailer: InviteMailer = unsentMailer) => mailer.send(invite)

// --- temporary credentials -------------------------------------------------------------------------------------------

// No look-alike characters (0/O, 1/l/I), because these are read off a screen and typed.
const lower = 'abcdefghijkmnopqrstuvwxyz'
const upper = 'ABCDEFGHJKLMNPQRSTUVWXYZ'
const digits = '23456789'
const symbols = '!@#$%&*?-_=+'
const pick = (chars: string) => chars[randomInt(chars.length)]!

/**
 * 14 random characters with at least one lower case letter, capital, digit, and symbol, so it passes `passwordProblem`.
 * The first is a letter or digit: the secretary downloads the credentials as CSV, and a spreadsheet reads a cell that
 * starts with = + - or @ as a formula.
 */
export function temporaryPassword() {
  for (;;) {
    const chars = [pick(lower), pick(upper), pick(digits), pick(symbols), ...Array.from({ length: 9 }, () => pick(lower + upper + digits + symbols))]
    for (let i = chars.length - 1; i > 0; i--) {
      const j = randomInt(i + 1)
      ;[chars[i], chars[j]] = [chars[j]!, chars[i]!]
    }
    const password = pick(lower + upper + digits) + chars.join('')
    if (!passwordProblem(password)) return password
  }
}

/** The name in lower case, then a random suffix, like `ana.reyes.k7f3`. `taken` holds the identifiers already in use. */
export function temporaryUsername(name: string, taken: ReadonlySet<string>) {
  const slug = name.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '.').replace(/^\.+/, '').slice(0, 20).replace(/\.+$/, '') || 'user'
  for (;;) {
    const username = `${slug}.${Array.from({ length: 4 }, () => pick('abcdefghijklmnopqrstuvwxyz0123456789')).join('')}`
    if (!taken.has(username)) return username
  }
}

// --- accounts across the repository and the auth store ---------------------------------------------------------------

/** What a person can sign in with. Each must belong to one account, or a sign-in could reach the wrong one. */
const identifiersOf = (account: User) => [account.id, account.email, account.studentId, account.username].filter((value): value is string => !!value).map((value) => value.toLowerCase())
// Old account IDs (QCU-DEAN) still sign in as the renamed account, so nobody else may take them as a username.
export const takenBy = (accounts: Iterable<User>, exceptId?: string) => new Set([...[...accounts].filter((account) => account.id !== exceptId).flatMap(identifiersOf), ...Object.keys(renamedAccountIds).map((id) => id.toLowerCase())])
/** The repository's accounts with the auth store's records on top. */
export const merged = (users: User[], data: AuthData) => new Map([...users, ...data.users].map((account) => [account.id, account] as const))

/** The auth-store record of an account, created from its current state when only the seed has it. Changes to it persist. */
function edit(data: AuthData, accounts: Map<string, User>, id: string) {
  let record = data.users.find((account) => account.id === id)
  if (!record) {
    record = structuredClone(accounts.get(id)!)
    data.users.push(record)
    accounts.set(id, record)
  }
  return record
}

/**
 * Applies the auth store's accounts to a repository: a stored record replaces the user with the same ID, which makes
 * role, active, and username changes reach seeded users too, and an unknown one is added. Profile text people edit
 * themselves stays as it is on this instance. Students join the class spaces named in their record.
 */
export function applyAccounts(db: Database, accounts: User[]) {
  const index = new Map(db.users.map((user, position) => [user.id, position]))
  const members = new Map(db.spaces.map((space) => [space.id, new Set(space.studentIds)]))
  for (const original of accounts) {
    const stored = renameAccountIds(original)
    // A role that no longer exists (the President's Office, removed on 2026-11-10) is dropped; an account left with no
    // role cannot sign in.
    const knownRoles = stored.roles.filter((role) => (roles as readonly string[]).includes(role))
    const account = knownRoles.length === stored.roles.length ? stored : { ...stored, roles: knownRoles, active: stored.active && knownRoles.length > 0 }
    const position = index.get(account.id)
    if (position === undefined) index.set(account.id, db.users.push(structuredClone(account)) - 1)
    // Stored profile text wins; a stored account without any keeps what this instance has.
    else {
      const { title, bio, education, officeHours } = db.users[position]!
      db.users[position] = { ...structuredClone(account), title: account.title ?? title, bio: account.bio ?? bio, education: account.education ?? education, officeHours: account.officeHours ?? officeHours }
    }
    for (const space of db.spaces) {
      if (!account.spaceIds.includes(space.id) || members.get(space.id)!.has(account.id)) continue
      space.studentIds.push(account.id)
      members.get(space.id)!.add(account.id)
    }
  }
}

// --- advisers --------------------------------------------------------------------------------------------------------

/** The faculty assigned to the student's year: one from the student's program if there is one, otherwise the first assigned. */
export function resolveAdviser(student: User, assignments: AuthData['advisorAssignments'], accounts: Map<string, User>) {
  const faculty = (assignments[String(student.year)] ?? []).map((id) => accounts.get(id)).filter((account): account is User => !!account?.roles.includes('professor'))
  return (faculty.find((account) => account.program === student.program) ?? faculty[0])?.id
}

/** Recomputes the adviser of every stored student. The seeded demo students keep the adviser they were seeded with. Returns how many changed. */
function refreshAdvisers(data: AuthData, accounts: Map<string, User>) {
  let changed = 0
  for (const student of data.users) {
    if (!student.roles.includes('student') || demoUserIds.has(student.id)) continue
    const adviserId = resolveAdviser(student, data.advisorAssignments, accounts)
    if (student.adviserId === adviserId) continue
    if (adviserId) student.adviserId = adviserId
    else delete student.adviserId
    changed++
  }
  return changed
}

// --- first sign-in ---------------------------------------------------------------------------------------------------

/** Saves the username and password a person chose for the first time and clears the flag that forces the change. */
export async function setOwnCredentials(authStore: AuthStore, users: User[], user: User, username: string, hash: string) {
  await authStore.update((data) => {
    const accounts = merged(users, data)
    if (takenBy(accounts.values(), user.id).has(username)) throw new ApiError(409, "That username isn't available.", 'CONFLICT')
    const record = edit(data, accounts, user.id)
    record.username = username
    record.mustChangeCredentials = false
    data.credentials[user.id] = hash
  })
}

/** Saves a role, program, section, or active change made on the administrator's pages, so every instance applies it. */
export async function saveAccountChange(authStore: AuthStore, users: User[], { id, roles, active, program, section }: AccountChange) {
  await authStore.update((data) => {
    Object.assign(edit(data, merged(users, data), id), { roles, active, ...(program ? { program } : {}), ...(section ? { section } : {}) })
  })
}

/** Saves the profile text a person edits themselves, so every instance shows it. */
export async function saveProfileChange(authStore: AuthStore, users: User[], id: string, change: ProfileChange) {
  await authStore.update((data) => {
    Object.assign(edit(data, merged(users, data), id), change)
  })
}

/**
 * Adds identity entries to the audit trail. The change they describe is already stored, so a failed write is logged
 * instead of failing a request whose credentials are shown only once. Entries never carry credentials.
 */
export async function recordAudit(repository: Repository, by: User, entries: { action: string; reference: string }[]) {
  if (!entries.length) return
  try {
    await repository.transact((unit) => {
      for (const entry of entries) unit.read().audit.push({ id: unit.nextId('AUDIT'), at: new Date().toISOString(), actorId: by.id, module: 'identity', result: 'Recorded', ...entry })
    }, ['audit'])
  } catch (error) {
    const { name, message } = error as Error
    console.error(JSON.stringify({ level: 'error', msg: 'Audit entry not recorded', actions: entries.map((entry) => entry.action), error: { name, message } }))
  }
}

// --- routes ----------------------------------------------------------------------------------------------------------

export type AccountDeps = { repository: Repository; authStore: AuthStore; sessions: SessionStore; mailer: InviteMailer }

const summary = (account: User) => ({
  id: account.id, name: account.name, email: account.email, roles: account.roles, program: account.program, section: account.section, year: account.year,
  studentId: account.studentId, adviserId: account.adviserId, active: account.active, mustChangeCredentials: account.mustChangeCredentials,
})
const byName = (a: User, b: User) => a.name.localeCompare(b.name)
const matches = (account: User, q?: string) => !q || [account.name, account.email, account.id, account.studentId ?? ''].join(' ').toLowerCase().includes(q.toLowerCase())
const years = [1, 2, 3, 4]
const invalidRow = (error: ZodError) => ({ error: 'Check the required fields.', code: 'INVALID_ROW', fields: error.issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message })) })
const plural = (count: number, noun: string) => `${count} ${noun}${count === 1 ? '' : 's'}`

/** The sign-in page of the site that made the request, if it is one of ours. */
function signInUrl(req: Request) {
  const origin = req.get('origin')
  return `${origin && env.CORS_ORIGIN.includes(origin) ? origin : env.CORS_ORIGIN[0]}/sign-in`
}

export function accountRouter({ repository, authStore, sessions, mailer }: AccountDeps) {
  const router = express.Router()
  const actor = (res: Response) => res.locals.user as User
  const need = (user: User, permission: string) => {
    if (!hasPermission(user, permission)) throw deny()
  }
  const users = () => repository.view((unit) => unit.read().users, [])
  const done = (res: Response, message: string, record: unknown) => send(res, actionResponseSchema, JSON.parse(JSON.stringify({ ok: true, message, record })))

  const audit = (by: User, entries: { action: string; reference: string }[]) => recordAudit(repository, by, entries)

  router.get('/types', async (_req, res) => {
    const user = actor(res)
    const dean = hasPermission(user, 'account.activateSecretary')
    const secretary = hasPermission(user, 'account.provision')
    if (!dean && !secretary) throw deny()
    const [all, data] = await Promise.all([users(), authStore.load()])
    const count = (match: (account: User) => boolean) => ({ active: all.filter((account) => match(account) && account.active).length, inactive: all.filter((account) => match(account) && !account.active).length })
    const advisers = new Set(Object.values(data.advisorAssignments).flat())
    const has = (role: Role) => (account: User) => account.roles.includes(role)
    const secretaryAccount = all.find((account) => account.id === secretaryId)
    send(res, accountTypesResponseSchema, {
      types: [
        { type: 'secretary', label: 'Secretary', ...count(has('secretary')), canManage: dean },
        { type: 'faculty', label: 'Faculty', ...count(has('professor')), canManage: secretary },
        { type: 'advisor', label: 'Advisor', ...count((account) => advisers.has(account.id)), canManage: secretary },
        { type: 'chair', label: 'Program chair', ...count(has('chair')), canManage: secretary },
        { type: 'student', label: 'Student', ...count(has('student')), canManage: secretary },
      ],
      secretary: secretaryAccount && summary(secretaryAccount),
    })
  })

  router.post('/secretary/activate', async (req, res) => {
    const user = actor(res)
    need(user, 'account.activateSecretary')
    const { name, email } = activateSecretarySchema.parse(req.body ?? {})
    const all = await users()
    if (!all.some((account) => account.id === secretaryId)) throw unavailable()
    // Hashed once, before the store update, which may run again if another instance writes first.
    const password = temporaryPassword()
    const hash = hashPassword(password)
    let account!: User
    let username = ''
    await authStore.update((data) => {
      const accounts = merged(all, data)
      const taken = takenBy(accounts.values(), secretaryId)
      if (email && taken.has(email)) throw new ApiError(409, 'An account with this email already exists.', 'CONFLICT')
      account = edit(data, accounts, secretaryId)
      username = temporaryUsername(name ?? account.name, taken)
      Object.assign(account, { active: true, mustChangeCredentials: true, username, ...(name ? { name } : {}), ...(email ? { email } : {}) })
      data.credentials[secretaryId] = hash
    })
    // New credentials end any session still open under the old ones.
    await sessions.revokeUser(secretaryId)
    await audit(user, [{ action: 'Secretary account activated', reference: secretaryId }])
    const url = signInUrl(req)
    const { sent } = await sendInvite({ accountId: secretaryId, to: account.email, name: account.name, signInUrl: url, username, temporaryPassword: password }, mailer)
    done(res, 'The secretary account is active. Give the secretary the sign-in details; they are not shown again.', {
      account: summary(account), credentials: { username, temporaryPassword: password }, invite: { sent, signInUrl: url },
    })
  })

  router.get('/', async (req, res) => {
    need(actor(res), 'account.provision')
    const { role, q } = accountsQuerySchema.parse(req.query)
    const found = (await users()).filter((account) => (!role || account.roles.includes(role)) && matches(account, q)).sort(byName)
    // ponytail: the first 200 matches, no paging. Add a page parameter if the secretary has to browse past a search.
    send(res, accountListResponseSchema, { accounts: found.slice(0, 200).map(summary), total: found.length })
  })

  router.get('/faculty', async (req, res) => {
    need(actor(res), 'account.provision')
    const { q, program } = facultyQuerySchema.parse(req.query)
    const [all, data] = await Promise.all([users(), authStore.load()])
    const faculty = all.filter((account) => account.roles.includes('professor') && (!program || account.program === program) && matches(account, q)).sort(byName)
    send(res, facultyListResponseSchema, {
      faculty: faculty.map((account) => ({
        ...summary(account),
        advisorYears: years.filter((year) => data.advisorAssignments[year]?.includes(account.id)),
        chairProgram: account.roles.includes('chair') ? account.program ?? null : null,
      })),
    })
  })

  /** Creates one account per valid row and answers with a result per row, in the order sent. */
  async function create(req: Request, res: Response, kind: 'faculty' | 'student', rows: unknown[]) {
    type Row = { name: string; email: string; program: string; studentId?: string; section?: string; year?: number }
    type Failure = { index: number; status: 'error'; code: string; error: string; fields?: { path: string; message: string }[] }
    const student = kind === 'student'
    const schema: ZodType<Row> = student ? studentRowSchema : facultyRowSchema
    const { all, spaces } = await repository.view((unit) => ({ all: unit.read().users, spaces: unit.read().spaces.map(({ id, program, section }) => ({ id, program, section })) }), [])
    // Marks the row's email and student ID as used, or says which one already is.
    const claim = (row: Row, taken: Set<string>) => {
      const code = taken.has(row.email) ? 'DUPLICATE_EMAIL' : row.studentId && taken.has(row.studentId.toLowerCase()) ? 'DUPLICATE_ID' : undefined
      if (code) return { code, error: code === 'DUPLICATE_EMAIL' ? 'An account with this email already exists.' : 'An account with this student ID already exists.' }
      taken.add(row.email)
      if (row.studentId) taken.add(row.studentId.toLowerCase())
    }
    // Cheap checks first, so sending the same list twice does not cost a password hash per row.
    const failures: Failure[] = []
    const accepted: { index: number; row: Row; password: string; hash: string }[] = []
    const known = takenBy(merged(all, await authStore.load()).values())
    for (const [index, raw] of rows.entries()) {
      const parsed = schema.safeParse(raw)
      if (!parsed.success) {
        failures.push({ index, status: 'error', ...invalidRow(parsed.error) })
        continue
      }
      const clash = claim(parsed.data, known)
      if (clash) {
        failures.push({ index, status: 'error', ...clash })
        continue
      }
      const password = temporaryPassword()
      accepted.push({ index, row: parsed.data, password, hash: hashPassword(password) })
    }
    // The store may run this again if another instance writes first, so it rechecks against the data it is given.
    let created: { index: number; account: User; username: string; password: string }[] = []
    let raced: Failure[] = []
    if (accepted.length) {
      await authStore.update((data) => {
        created = []
        raced = []
        const accounts = merged(all, data)
        const taken = takenBy(accounts.values())
        for (const { index, row, password, hash } of accepted) {
          const clash = claim(row, taken)
          if (clash) {
            raced.push({ index, status: 'error', ...clash })
            continue
          }
          const username = temporaryUsername(row.name, taken)
          taken.add(username)
          const account = newUser(`USR-${ulid()}`, row.name, [student ? 'student' : 'professor'], {
            email: row.email, program: row.program, active: true, username, mustChangeCredentials: true,
            ...(student ? { section: row.section, year: row.year, studentId: row.studentId, spaceIds: spaces.filter((space) => space.program === row.program && space.section === row.section).map((space) => space.id) } : {}),
          })
          const adviserId = student ? resolveAdviser(account, data.advisorAssignments, accounts) : undefined
          if (adviserId) account.adviserId = adviserId
          data.users.push(account)
          accounts.set(account.id, account)
          data.credentials[account.id] = hash
          created.push({ index, account, username, password })
        }
      })
    }
    await audit(actor(res), created.map(({ account }) => ({ action: student ? 'Student account created' : 'Faculty account created', reference: account.id })))
    const url = signInUrl(req)
    const results = [
      ...failures,
      ...raced,
      ...(await Promise.all(created.map(async ({ index, account, username, password }) => {
        const { sent } = await sendInvite({ accountId: account.id, to: account.email, name: account.name, signInUrl: url, username, temporaryPassword: password }, mailer)
        return { index, status: 'created', account: summary(account), credentials: { username, temporaryPassword: password }, invite: { sent, signInUrl: url } }
      }))),
    ].sort((a, b) => a.index - b.index)
    const failed = results.length - created.length
    done(res, `${plural(created.length, 'account')} created${failed ? `, ${failed} not created` : ''}. Give each person their sign-in details; they are not shown again.`, { created: created.length, failed, results })
  }

  router.post('/faculty', async (req, res) => {
    need(actor(res), 'account.provision')
    const body = createFacultySchema.parse(req.body ?? {})
    await create(req, res, 'faculty', body.faculty ?? [req.body ?? {}])
  })

  router.post('/students', async (req, res) => {
    need(actor(res), 'account.provision')
    await create(req, res, 'student', importStudentsSchema.parse(req.body).students)
  })

  router.get('/advisors', async (_req, res) => {
    need(actor(res), 'account.provision')
    const [all, data] = await Promise.all([users(), authStore.load()])
    const byId = new Map(all.map((account) => [account.id, account]))
    send(res, advisorsResponseSchema, {
      advisors: years.map((yearLevel) => ({ yearLevel, faculty: (data.advisorAssignments[yearLevel] ?? []).flatMap((id) => byId.get(id) ?? []).map(summary) })),
    })
  })

  router.put('/advisors/:yearLevel', async (req, res) => {
    const user = actor(res)
    need(user, 'account.provision')
    const { yearLevel } = yearLevelParamsSchema.parse(req.params)
    const facultyIds = [...new Set(setAdvisorsSchema.parse(req.body).facultyIds)]
    const all = await users()
    let studentsUpdated = 0
    await authStore.update((data) => {
      const accounts = merged(all, data)
      if (facultyIds.some((id) => !accounts.get(id)?.roles.includes('professor'))) throw new ApiError(400, 'Choose advisers from the faculty list.', 'VALIDATION_ERROR')
      if (facultyIds.length) data.advisorAssignments[yearLevel] = facultyIds
      else delete data.advisorAssignments[yearLevel]
      studentsUpdated = refreshAdvisers(data, accounts)
    })
    await audit(user, [{ action: `Year ${yearLevel} advisers changed`, reference: `year-${yearLevel}` }])
    done(res, `Advisers for year ${yearLevel} saved. ${plural(studentsUpdated, 'student')} got a new adviser.`, { yearLevel, facultyIds, studentsUpdated })
  })

  router.put('/chairs/:program', async (req, res) => {
    const user = actor(res)
    need(user, 'account.provision')
    const { program } = programParamsSchema.parse(req.params)
    const { facultyId } = setChairSchema.parse(req.body)
    const all = await users()
    let previousChairIds: string[] = []
    await authStore.update((data) => {
      const accounts = merged(all, data)
      const chosen = accounts.get(facultyId)
      if (!chosen?.roles.includes('professor') || chosen.program !== program) throw new ApiError(400, 'Choose a faculty member from that program.', 'VALIDATION_ERROR')
      previousChairIds = [...accounts.values()].filter((account) => account.id !== facultyId && account.roles.includes('chair') && account.program === program).map((account) => account.id)
      for (const id of previousChairIds) {
        const holder = edit(data, accounts, id)
        // A chair who was only a chair stays faculty.
        holder.roles = holder.roles.filter((role) => role !== 'chair')
        if (!holder.roles.length) holder.roles = ['professor']
      }
      const record = edit(data, accounts, facultyId)
      if (!record.roles.includes('chair')) record.roles = [...record.roles, 'chair']
    })
    await audit(user, [{ action: 'Program chair changed', reference: program }])
    done(res, `The ${program} program chair is saved.`, { program, chairId: facultyId, previousChairIds })
  })

  router.post('/:id/active', async (req, res) => {
    const user = actor(res)
    if (!hasPermission(user, 'account.provision') && !hasPermission(user, 'account.activateSecretary')) throw deny()
    const { id } = accountIdParamsSchema.parse(req.params)
    const { active } = setActiveSchema.parse(req.body)
    if (!active && id === user.id) throw new ApiError(403, "You can't deactivate your own account.", 'FORBIDDEN')
    const all = await users()
    const target = all.find((account) => account.id === id)
    if (!target) throw unavailable()
    if (target.roles.includes('secretary')) need(user, 'account.activateSecretary')
    else if (!hasPermission(user, 'account.provision') || !target.roles.every((role) => secretaryScope.includes(role))) throw deny()
    await authStore.update((data) => {
      edit(data, merged(all, data), id).active = active
    })
    // A deactivated account is also signed out everywhere at once.
    if (!active) await sessions.revokeUser(id)
    await audit(user, [{ action: active ? 'Account activated' : 'Account deactivated', reference: id }])
    done(res, active ? 'Account activated.' : 'Account deactivated.', { id, active })
  })

  return router
}
