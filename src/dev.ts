import express, { type Request, type Response } from 'express'
import { z } from 'zod'

import { send } from './http.js'
import { roleSchema, type User } from './schemas.js'
import { conflict, unavailable } from './services.js'
import type { SessionStore } from './sessions.js'
import type { Repository } from './store.js'

// The dev toolbox: testers on the development stack change to another account without signing out. The session cookie
// is httpOnly, so the API does the swap. Anyone signed in on a stack that has these routes can become any active account,
// the Dean included, so they exist only where no real student data lives.

export type Stack = { tablePrefix?: string; nodeEnv: string }
/** The development stack (table prefix `accs-dev-`) and local runs. Any other deployed stack, and production without a prefix, has no such routes. */
export const devToolboxEnabled = ({ tablePrefix, nodeEnv }: Stack) => (tablePrefix ? tablePrefix.startsWith('accs-dev-') : nodeEnv !== 'production')
/** The two calls the toolbox makes. They stay open while an account still holds temporary sign-in details, so a tester can leave it. */
export const isDevToolboxCall = (method: string, path: string) => (method === 'GET' && path === '/dev/users') || (method === 'POST' && path === '/dev/switch-user')

const devUsersResponseSchema = z.object({ users: z.array(z.object({ id: z.string(), name: z.string(), roles: z.array(roleSchema), active: z.boolean(), username: z.string().optional() })) })
const switchUserSchema = z.object({ userId: z.string().trim().min(1).max(64) }).strict()

export type DevDeps = {
  repository: Repository
  sessions: SessionStore
  /** Starts a session for the account and sets its cookie, as sign-in does. */
  start(req: Request, res: Response, user: User): Promise<void>
  /** Answers with the body sign-in answers with. */
  out(res: Response, user: User): Promise<void>
}

export function devRouter({ repository, sessions, start, out }: DevDeps) {
  const router = express.Router()
  // Accounts from the auth store are already laid over the repository's users on every request, so this list holds them too.
  const accounts = () => repository.view((unit) => unit.read().users, [])

  router.get('/users', async (_req, res) => {
    const users = (await accounts()).map(({ id, name, roles, active, username }) => ({ id, name, roles, active, username })).sort((a, b) => a.name.localeCompare(b.name))
    send(res, devUsersResponseSchema, { users })
  })

  router.post('/switch-user', async (req, res) => {
    const caller = res.locals.user as User
    const { userId } = switchUserSchema.parse(req.body)
    const target = (await accounts()).find((account) => account.id === userId)
    if (!target) throw unavailable()
    if (!target.active) throw conflict('That account is not active.')
    // The switch is recorded first: one that cannot be recorded does not happen. The entry names the actor, the target, and the action.
    await repository.transact((unit) => {
      unit.read().audit.push({ id: unit.nextId('AUDIT'), at: new Date().toISOString(), actorId: caller.id, action: 'Account switched', module: 'identity', reference: target.id, result: 'Recorded' })
    }, ['audit'])
    await sessions.revoke(res.locals.sessionId as string)
    await start(req, res, target)
    await out(res, target)
  })

  return router
}
