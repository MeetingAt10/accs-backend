import { createHash, randomBytes } from 'node:crypto'
import {
  ConditionalCheckFailedException,
  DynamoDBClient,
  GetItemCommand,
  PutItemCommand,
  QueryCommand,
  UpdateItemCommand,
  type AttributeValue,
} from '@aws-sdk/client-dynamodb'

// Server-side sessions: DOC006 item type SESSION in ccs_identity (accs-architecture adr/0004).
// PK SESSION#<session_id>, SK META; GSI2 USER#<user_id> / SESSION#<issued_at> lists a user's sessions;
// TTL on expires_epoch. session_id is the SHA-256 of the cookie token (amendment to DOC006).
// The cookie carries an opaque random token; only its SHA-256 is stored, so a leaked table
// or backup cannot be replayed as live sessions.

export type SessionStatus = 'active' | 'expired' | 'revoked'
export type Session = {
  sessionId: string
  userId: string
  activeRoleId: string
  issuedAt: string
  expiresAt: string
  lastSeenAt: string
  remember: boolean
  ipAddress: string
  userAgent: string
  status: SessionStatus
}

// Session timeouts approved under DOC003 D-08 on 2026-11-10.
export const sessionPolicy = {
  normal: { idleMs: 30 * 60 * 1000, absoluteMs: 12 * 60 * 60 * 1000 },
  remember: { idleMs: 7 * 24 * 60 * 60 * 1000, absoluteMs: 30 * 24 * 60 * 60 * 1000 },
  // lastSeenAt is written at most this often, so a request does not always cost a write.
  touchIntervalMs: 5 * 60 * 1000,
}

export const newSessionToken = () => randomBytes(32).toString('base64url')
export const sessionIdOf = (token: string) => createHash('sha256').update(token).digest('hex')
// 32 random bytes in base64url are always 43 characters.
export const isWellFormedToken = (token: string | undefined): token is string => !!token && /^[A-Za-z0-9_-]{43}$/.test(token)

export function sessionState(session: Session, now = Date.now()): 'live' | SessionStatus {
  if (session.status !== 'active') return session.status
  const { idleMs } = session.remember ? sessionPolicy.remember : sessionPolicy.normal
  if (Date.parse(session.expiresAt) <= now || Date.parse(session.lastSeenAt) + idleMs <= now) return 'expired'
  return 'live'
}

export interface SessionStore {
  create(session: Session): Promise<void>
  get(sessionId: string): Promise<Session | undefined>
  touch(sessionId: string, at: string): Promise<void>
  revoke(sessionId: string): Promise<void>
  /** Revokes every active session of the user, except `keepSessionId` when given. */
  revokeUser(userId: string, keepSessionId?: string): Promise<void>
}

export function createMemorySessionStore(): SessionStore {
  const sessions = new Map<string, Session>()
  return {
    async create(session) {
      if (sessions.has(session.sessionId)) throw new Error('Session already exists')
      sessions.set(session.sessionId, structuredClone(session))
    },
    async get(sessionId) {
      const found = sessions.get(sessionId)
      return found && structuredClone(found)
    },
    async touch(sessionId, at) {
      const found = sessions.get(sessionId)
      if (found?.status === 'active') found.lastSeenAt = at
    },
    async revoke(sessionId) {
      const found = sessions.get(sessionId)
      if (found) found.status = 'revoked'
    },
    async revokeUser(userId, keepSessionId) {
      for (const session of sessions.values()) if (session.userId === userId && session.sessionId !== keepSessionId) session.status = 'revoked'
    },
  }
}

const s = (value: string): AttributeValue => ({ S: value })
const keyOf = (sessionId: string) => ({ PK: s(`SESSION#${sessionId}`), SK: s('META') })
const isConditionFailure = (error: unknown) => error instanceof ConditionalCheckFailedException || (error as { name?: string }).name === 'ConditionalCheckFailedException'

export function createDynamoSessionStore(tableName: string, client = new DynamoDBClient({})): SessionStore {
  const markRevoked = async (sessionId: string) => {
    const now = new Date().toISOString()
    try {
      await client.send(new UpdateItemCommand({
        TableName: tableName,
        Key: keyOf(sessionId),
        UpdateExpression: 'SET #status = :revoked, updated_at = :now',
        ConditionExpression: 'attribute_exists(PK)',
        ExpressionAttributeNames: { '#status': 'status' },
        ExpressionAttributeValues: { ':revoked': s('revoked'), ':now': s(now) },
      }))
    } catch (error) {
      if (!isConditionFailure(error)) throw error
    }
  }

  return {
    async create(session) {
      // TTL deletes the item after the absolute expiry; sessionState still checks it, since TTL can lag.
      const expiresEpoch = Math.floor(Date.parse(session.expiresAt) / 1000)
      await client.send(new PutItemCommand({
        TableName: tableName,
        ConditionExpression: 'attribute_not_exists(PK)',
        Item: {
          ...keyOf(session.sessionId),
          entity_type: s('SESSION'),
          session_id: s(session.sessionId),
          user_id: s(session.userId),
          GSI2PK: s(`USER#${session.userId}`),
          GSI2SK: s(`SESSION#${session.issuedAt}`),
          issued_at: s(session.issuedAt),
          active_role_id: s(session.activeRoleId),
          expires_at: s(session.expiresAt),
          expires_epoch: { N: String(expiresEpoch) },
          last_seen_at: s(session.lastSeenAt),
          remember: { BOOL: session.remember },
          ip_address: s(session.ipAddress),
          user_agent: s(session.userAgent),
          status: s(session.status),
          created_at: s(session.issuedAt),
          updated_at: s(session.issuedAt),
        },
      }))
    },
    async get(sessionId) {
      // Strongly consistent, so a sign-out or revocation is seen by the very next request.
      const { Item } = await client.send(new GetItemCommand({ TableName: tableName, Key: keyOf(sessionId), ConsistentRead: true }))
      if (!Item || Item.entity_type?.S !== 'SESSION') return undefined
      return {
        sessionId: Item.session_id?.S ?? sessionId,
        userId: Item.user_id?.S ?? '',
        activeRoleId: Item.active_role_id?.S ?? '',
        issuedAt: Item.issued_at?.S ?? '',
        // A missing expiry reads as already expired.
        expiresAt: Item.expires_at?.S ?? new Date(0).toISOString(),
        lastSeenAt: Item.last_seen_at?.S ?? '',
        remember: Item.remember?.BOOL ?? false,
        ipAddress: Item.ip_address?.S ?? '',
        userAgent: Item.user_agent?.S ?? '',
        status: (Item.status?.S ?? 'revoked') as SessionStatus,
      }
    },
    async touch(sessionId, at) {
      try {
        await client.send(new UpdateItemCommand({
          TableName: tableName,
          Key: keyOf(sessionId),
          UpdateExpression: 'SET last_seen_at = :at, updated_at = :at',
          ConditionExpression: '#status = :active',
          ExpressionAttributeNames: { '#status': 'status' },
          ExpressionAttributeValues: { ':at': s(at), ':active': s('active') },
        }))
      } catch (error) {
        if (!isConditionFailure(error)) throw error
      }
    },
    revoke: markRevoked,
    async revokeUser(userId, keepSessionId) {
      let ExclusiveStartKey: Record<string, AttributeValue> | undefined
      do {
        const page = await client.send(new QueryCommand({
          TableName: tableName,
          IndexName: 'GSI2',
          // GSI2 also lists role holders under ROLE#…, so the SESSION# prefix keeps this to sessions.
          KeyConditionExpression: 'GSI2PK = :user AND begins_with(GSI2SK, :prefix)',
          ExpressionAttributeValues: { ':user': s(`USER#${userId}`), ':prefix': s('SESSION#') },
          ExclusiveStartKey,
        }))
        for (const item of page.Items ?? []) {
          const sessionId = item.PK?.S?.slice('SESSION#'.length)
          if (sessionId && sessionId !== keepSessionId) await markRevoked(sessionId)
        }
        ExclusiveStartKey = page.LastEvaluatedKey
      } while (ExclusiveStartKey)
    },
  }
}

/** A store that fails on use, so a misconfigured deploy rejects sign-in instead of keeping per-instance sessions. */
function unconfiguredSessionStore(): SessionStore {
  const fail = async (): Promise<never> => {
    throw new Error('TABLE_PREFIX is not configured; server-side sessions need the ccs_identity table on Lambda.')
  }
  return { create: fail, get: fail, touch: fail, revoke: fail, revokeUser: fail }
}

export function createSessionStore(options: { nodeEnv: string; tableName?: string; onLambda: boolean }): SessionStore {
  if (options.nodeEnv === 'test') return createMemorySessionStore()
  if (options.tableName) return createDynamoSessionStore(options.tableName)
  // In-memory sessions on Lambda would only be valid on the instance that issued them.
  if (options.onLambda) return unconfiguredSessionStore()
  return createMemorySessionStore()
}
