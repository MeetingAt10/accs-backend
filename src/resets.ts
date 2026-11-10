import {
  ConditionalCheckFailedException,
  DeleteItemCommand,
  DynamoDBClient,
  GetItemCommand,
  PutItemCommand,
  UpdateItemCommand,
  type AttributeValue,
} from '@aws-sdk/client-dynamodb'

// Password reset codes: item type RESET in ccs_identity (accs-architecture adr/0004, an amendment to DOC006).
// PK USER#<user_id>, SK RESET; timestamps ISO-8601 like the rest of DOC006; TTL on expires_epoch.
// Limits live on the item, so every Lambda instance enforces them.

// Approved under DOC003 D-08 on 2026-11-10.
export const resetPolicy = {
  codeTtlMs: 15 * 60 * 1000,
  // Wrong guesses allowed per code. A guess is counted before the code is checked, so parallel guesses cannot exceed it.
  maxAttempts: 5,
  // Codes per account per window; issuing a new code keeps the count, so cycling codes does not reset it.
  maxPerWindow: 5,
  windowMs: 60 * 60 * 1000,
  cooldownMs: 60 * 1000,
}

export type ResetRecord = {
  userId: string
  codeHash: string
  codeExpiresAt: number
  attempts: number
  issuedCount: number
  windowStart: number
  createdAt: number
  issuedBy?: string
}

export type IssueResult = 'issued' | 'cooldown' | 'limit'

/** Pure rule for issuing a code; `privileged` (an administrator) skips the cooldown and the hourly cap. */
export function nextReset(previous: ResetRecord | undefined, input: { userId: string; codeHash: string; now: number; issuedBy?: string }): ResetRecord | Exclude<IssueResult, 'issued'> {
  const { now } = input
  const privileged = !!input.issuedBy
  const sameWindow = !!previous && now - previous.windowStart < resetPolicy.windowMs
  if (!privileged && previous && now - previous.createdAt < resetPolicy.cooldownMs) return 'cooldown'
  if (!privileged && sameWindow && previous!.issuedCount >= resetPolicy.maxPerWindow) return 'limit'
  return {
    userId: input.userId,
    codeHash: input.codeHash,
    codeExpiresAt: now + resetPolicy.codeTtlMs,
    attempts: 0,
    issuedCount: sameWindow ? previous!.issuedCount + 1 : 1,
    windowStart: sameWindow ? previous!.windowStart : now,
    createdAt: now,
    ...(input.issuedBy ? { issuedBy: input.issuedBy } : {}),
  }
}

// Keep the item until both the code and the hourly window are over, so the cap survives the code's expiry.
const ttlOf = (record: ResetRecord) => Math.ceil(Math.max(record.codeExpiresAt, record.windowStart + resetPolicy.windowMs) / 1000)

export interface ResetStore {
  issue(input: { userId: string; codeHash: string; now: number; issuedBy?: string }): Promise<IssueResult>
  /** Counts one guess and returns the record, or undefined if there is no live code or no guesses left. */
  claimAttempt(userId: string, now: number): Promise<ResetRecord | undefined>
  /** Deletes the code if it is still the one checked; false if it was already used or replaced. */
  consume(userId: string, codeHash: string): Promise<boolean>
}

export function createMemoryResetStore(): ResetStore {
  const records = new Map<string, ResetRecord>()
  return {
    async issue(input) {
      const next = nextReset(records.get(input.userId), input)
      if (typeof next === 'string') return next
      records.set(input.userId, next)
      return 'issued'
    },
    async claimAttempt(userId, now) {
      const record = records.get(userId)
      if (!record || record.codeExpiresAt <= now || record.attempts >= resetPolicy.maxAttempts) return undefined
      record.attempts++
      return { ...record }
    },
    async consume(userId, codeHash) {
      if (records.get(userId)?.codeHash !== codeHash) return false
      records.delete(userId)
      return true
    },
  }
}

const s = (value: string): AttributeValue => ({ S: value })
const n = (value: number): AttributeValue => ({ N: String(value) })
const iso = (ms: number) => new Date(ms).toISOString()
const ms = (value: AttributeValue | undefined) => (value?.S ? Date.parse(value.S) : 0)
const keyOf = (userId: string) => ({ PK: s(`USER#${userId}`), SK: s('RESET') })
const isConditionFailure = (error: unknown) => error instanceof ConditionalCheckFailedException || (error as { name?: string }).name === 'ConditionalCheckFailedException'

function fromItem(item: Record<string, AttributeValue>): ResetRecord {
  return {
    userId: item.user_id?.S ?? '',
    codeHash: item.code_hash?.S ?? '',
    codeExpiresAt: ms(item.code_expires_at),
    attempts: Number(item.attempts?.N ?? 0),
    issuedCount: Number(item.issued_count?.N ?? 0),
    windowStart: ms(item.window_start),
    createdAt: ms(item.created_at),
    ...(item.issued_by?.S ? { issuedBy: item.issued_by.S } : {}),
  }
}

export function createDynamoResetStore(tableName: string, client = new DynamoDBClient({})): ResetStore {
  return {
    async issue(input) {
      const { Item } = await client.send(new GetItemCommand({ TableName: tableName, Key: keyOf(input.userId), ConsistentRead: true }))
      const previous = Item && Item.entity_type?.S === 'RESET' ? fromItem(Item) : undefined
      const next = nextReset(previous, input)
      if (typeof next === 'string') return next
      try {
        await client.send(new PutItemCommand({
          TableName: tableName,
          Item: {
            ...keyOf(input.userId),
            entity_type: s('RESET'),
            user_id: s(next.userId),
            code_hash: s(next.codeHash),
            code_expires_at: s(iso(next.codeExpiresAt)),
            attempts: n(0),
            issued_count: n(next.issuedCount),
            window_start: s(iso(next.windowStart)),
            created_at: s(iso(next.createdAt)),
            updated_at: s(iso(next.createdAt)),
            expires_epoch: n(ttlOf(next)),
            ...(next.issuedBy ? { issued_by: s(next.issuedBy) } : {}),
          },
          // Optimistic write: fails if another request issued a code since the read above.
          ...(previous
            ? { ConditionExpression: 'created_at = :previous', ExpressionAttributeValues: { ':previous': s(iso(previous.createdAt)) } }
            : { ConditionExpression: 'attribute_not_exists(PK)' }),
        }))
        return 'issued'
      } catch (error) {
        if (isConditionFailure(error)) return 'cooldown'
        throw error
      }
    },
    async claimAttempt(userId, now) {
      try {
        // ISO-8601 UTC strings of the same format compare in time order.
        const { Attributes } = await client.send(new UpdateItemCommand({
          TableName: tableName,
          Key: keyOf(userId),
          UpdateExpression: 'ADD attempts :one SET updated_at = :nowIso',
          ConditionExpression: 'entity_type = :type AND attempts < :max AND code_expires_at > :nowIso',
          ExpressionAttributeValues: { ':one': n(1), ':type': s('RESET'), ':max': n(resetPolicy.maxAttempts), ':nowIso': s(iso(now)) },
          ReturnValues: 'ALL_NEW',
        }))
        return Attributes ? fromItem(Attributes) : undefined
      } catch (error) {
        if (isConditionFailure(error)) return undefined
        throw error
      }
    },
    async consume(userId, codeHash) {
      try {
        await client.send(new DeleteItemCommand({ TableName: tableName, Key: keyOf(userId), ConditionExpression: 'code_hash = :hash', ExpressionAttributeValues: { ':hash': s(codeHash) } }))
        return true
      } catch (error) {
        if (isConditionFailure(error)) return false
        throw error
      }
    },
  }
}

function unconfiguredResetStore(): ResetStore {
  const fail = async (): Promise<never> => {
    throw new Error('TABLE_PREFIX is not configured; reset codes need the ccs_identity table on Lambda.')
  }
  return { issue: fail, claimAttempt: fail, consume: fail }
}

export function createResetStore(options: { nodeEnv: string; tableName?: string; onLambda: boolean }): ResetStore {
  if (options.nodeEnv === 'test') return createMemoryResetStore()
  if (options.tableName) return createDynamoResetStore(options.tableName)
  if (options.onLambda) return unconfiguredResetStore()
  return createMemoryResetStore()
}
