// Account IDs that were renamed. Records stored under an old ID are read under the new one, and the old ID still signs in.
// QCU-DEAN became CCS-DEAN on 11 November 2026 (team baseline: college office accounts use the CCS prefix).
export const renamedAccountIds: Readonly<Record<string, string>> = { 'QCU-DEAN': 'CCS-DEAN' }

/** The current ID for an ID that may be an old one. */
export const currentAccountId = (id: string) => renamedAccountIds[id] ?? id

/** Old IDs that now point to `id`. */
export const formerAccountIds = (id: string) => Object.keys(renamedAccountIds).filter((old) => renamedAccountIds[old] === id)

/** A copy of a stored value with every string that is exactly an old account ID replaced by the new one. */
export function renameAccountIds<T>(value: T): T {
  if (typeof value === 'string') return currentAccountId(value) as T
  if (Array.isArray(value)) return value.map(renameAccountIds) as T
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) out[currentAccountId(key)] = renameAccountIds(item)
    return out as T
  }
  return value
}
