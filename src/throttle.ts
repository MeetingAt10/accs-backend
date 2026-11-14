import { createHash } from 'node:crypto'
import {
  ConditionalCheckFailedException,
  DeleteItemCommand,
  DynamoDBClient,
  PutItemCommand,
  UpdateItemCommand,
  type AttributeValue,
} from '@aws-sdk/client-dynamodb'

// Failed-attempt counters for sign-in, reset, first-login and change-password: item type THROTTLE in ccs_identity
// (a new item type, to be added to accs-architecture adr/0004 and DOC006 like RESET).
// PK THROTTLE#<sha256 of the key>, SK THROTTLE; TTL on expires_epoch at the end of the window.
// The counter lives in the table, so every Lambda instance enforces the same limit. Only the SHA-256 of the key is
// stored, so the table holds no typed identifiers or client addresses.

export const throttlePolicy = {
  maxAttempts: 5,
  windowMs: 15 * 60 * 1000,
}

export interface ThrottleStore {
  /**
   * Counts one attempt for the key before it is checked, so parallel requests cannot exceed the limit.
   * Returns false, without counting, when the key has used its attempts in the current window.
   */
  claim(key: string, now: number): Promise<boolean>
  /** Forgets the key's attempts, after a success. */
  clear(key: string): Promise<void>
}

export function createMemoryThrottleStore(): ThrottleStore {
  const counters = new Map<string, { attempts: number; windowStart: number }>()
  return {
    async claim(key, now) {
      const counter = counters.get(key)
      if (counter && now - counter.windowStart < throttlePolicy.windowMs) {
        if (counter.attempts >= throttlePolicy.maxAttempts) return false
        counter.attempts++
        return true
      }
      // Keep the map bounded: drop finished windows before it grows large.
      if (counters.size > 5000) for (const [k, v] of counters) if (now - v.windowStart >= throttlePolicy.windowMs) counters.delete(k)
      counters.set(key, { attempts: 1, windowStart: now })
      return true
    },
    async clear(key) {
      counters.delete(key)
    },
  }
}

const s = (value: string): AttributeValue => ({ S: value })
const n = (value: number): AttributeValue => ({ N: String(value) })
const iso = (ms: number) => new Date(ms).toISOString()
export const throttleKeyOf = (key: string) => ({ PK: s(`THROTTLE#${createHash('sha256').update(key).digest('hex')}`), SK: s('THROTTLE') })
const isConditionFailure = (error: unknown) => error instanceof ConditionalCheckFailedException || (error as { name?: string }).name === 'ConditionalCheckFailedException'

export function createDynamoThrottleStore(tableName: string, client = new DynamoDBClient({})): ThrottleStore {
  return {
    async claim(key, now) {
      const Key = throttleKeyOf(key)
      const nowIso = iso(now)
      // ISO-8601 UTC strings of the same format compare in time order. TTL deletes items late, so every
      // condition checks the window itself instead of trusting that an expired item is gone.
      const cutoff = iso(now - throttlePolicy.windowMs)
      // Two rounds at most: a lost race to start a new window means another request just started it.
      for (let round = 0; round < 2; round++) {
        try {
          await client.send(new UpdateItemCommand({
            TableName: tableName,
            Key,
            UpdateExpression: 'ADD attempts :one SET updated_at = :nowIso',
            ConditionExpression: 'entity_type = :type AND window_start > :cutoff AND attempts < :max',
            ExpressionAttributeValues: { ':one': n(1), ':nowIso': s(nowIso), ':type': s('THROTTLE'), ':cutoff': s(cutoff), ':max': n(throttlePolicy.maxAttempts) },
            ReturnValuesOnConditionCheckFailure: 'ALL_OLD',
          }))
          return true
        } catch (error) {
          if (!isConditionFailure(error)) throw error
          const old = (error as { Item?: Record<string, AttributeValue> }).Item
          // A live window with no attempts left: refuse.
          if (old?.entity_type?.S === 'THROTTLE' && (old.window_start?.S ?? '') > cutoff) return false
        }
        try {
          // No counter, or its window is over: start a new window with this attempt.
          await client.send(new PutItemCommand({
            TableName: tableName,
            Item: {
              ...Key,
              entity_type: s('THROTTLE'),
              attempts: n(1),
              window_start: s(nowIso),
              updated_at: s(nowIso),
              expires_epoch: n(Math.ceil((now + throttlePolicy.windowMs) / 1000)),
            },
            ConditionExpression: 'attribute_not_exists(PK) OR window_start <= :cutoff',
            ExpressionAttributeValues: { ':cutoff': s(cutoff) },
          }))
          return true
        } catch (error) {
          if (!isConditionFailure(error)) throw error
        }
      }
      // Still contended after two rounds: fail closed rather than let an attempt through uncounted.
      return false
    },
    async clear(key) {
      await client.send(new DeleteItemCommand({ TableName: tableName, Key: throttleKeyOf(key) }))
    },
  }
}

function unconfiguredThrottleStore(): ThrottleStore {
  const fail = async (): Promise<never> => {
    throw new Error('TABLE_PREFIX is not configured; attempt limits need the ccs_identity table on Lambda.')
  }
  return { claim: fail, clear: fail }
}

export function createThrottleStore(options: { nodeEnv: string; tableName?: string; onLambda: boolean }): ThrottleStore {
  if (options.nodeEnv === 'test') return createMemoryThrottleStore()
  if (options.tableName) return createDynamoThrottleStore(options.tableName)
  // Counters in memory on Lambda would give each instance its own limit.
  if (options.onLambda) return unconfiguredThrottleStore()
  return createMemoryThrottleStore()
}
