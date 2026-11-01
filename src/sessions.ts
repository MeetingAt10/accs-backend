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

// Server-side sessions, stored in the app table (accs-architecture adr/0003): PK SESSION#<sha256>, SK META,
// GSI2 SESSIONS#<userId> / <issuedAt> to list a user's sessions, TTL on expiresAt (epoch seconds).
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

// TBD(D-08): retention and timeout values are not approved yet. These are provisional defaults.
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
        UpdateExpression: 'SET #status = :revoked, updatedAt = :now',
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
          entityType: s('SESSION'),
          sessionId: s(session.sessionId),
          userId: s(session.userId),
          GSI2PK: s(`SESSIONS#${session.userId}`),
          GSI2SK: s(session.issuedAt),
          issuedAt: s(session.issuedAt),
          activeRoleId: s(session.activeRoleId),
          expiresAt: { N: String(expiresEpoch) },
          lastSeenAt: s(session.lastSeenAt),
          remember: { BOOL: session.remember },
          ipAddress: s(session.ipAddress),
          userAgent: s(session.userAgent),
          status: s(session.status),
          createdAt: s(session.issuedAt),
          updatedAt: s(session.issuedAt),
        },
      }))
    },
    async get(sessionId) {
      // Strongly consistent, so a sign-out or revocation is seen by the very next request.
      const { Item } = await client.send(new GetItemCommand({ TableName: tableName, Key: keyOf(sessionId), ConsistentRead: true }))
      if (!Item || Item.entityType?.S !== 'SESSION') return undefined
      return {
        sessionId: Item.sessionId?.S ?? sessionId,
        userId: Item.userId?.S ?? '',
        activeRoleId: Item.activeRoleId?.S ?? '',
        issuedAt: Item.issuedAt?.S ?? '',
        expiresAt: new Date(Number(Item.expiresAt?.N ?? 0) * 1000).toISOString(),
        lastSeenAt: Item.lastSeenAt?.S ?? '',
        remember: Item.remember?.BOOL ?? false,
        ipAddress: Item.ipAddress?.S ?? '',
        userAgent: Item.userAgent?.S ?? '',
        status: (Item.status?.S ?? 'revoked') as SessionStatus,
      }
    },
    async touch(sessionId, at) {
      try {
        await client.send(new UpdateItemCommand({
          TableName: tableName,
          Key: keyOf(sessionId),
          UpdateExpression: 'SET lastSeenAt = :at, updatedAt = :at',
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
          KeyConditionExpression: 'GSI2PK = :user',
          ExpressionAttributeValues: { ':user': s(`SESSIONS#${userId}`) },
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
    throw new Error('TABLE_NAME is not configured; server-side sessions need DynamoDB on Lambda.')
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
