import { randomBytes } from 'node:crypto'

const alphabet = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'

/**
 * ULIDs (DOC006 conventions, rule 1): 48 bits of time then 80 random bits, in 26 Crockford base32 characters.
 * Instances need no coordination, and IDs sort by creation time. Within one instance they also strictly increase:
 * in the same millisecond, or if the clock moves back, the next ID is the last one plus one.
 */
export function createUlidFactory(now: () => number = Date.now, random: (size: number) => Buffer = randomBytes) {
  let last = 0n
  return () => {
    const fresh = (BigInt(now()) << 80n) | BigInt(`0x${random(10).toString('hex')}`)
    last = fresh >> 80n > last >> 80n ? fresh : last + 1n
    let value = last
    let encoded = ''
    for (let index = 0; index < 26; index++) {
      encoded = alphabet[Number(value & 31n)] + encoded
      value >>= 5n
    }
    return encoded
  }
}

export const ulid = createUlidFactory()
