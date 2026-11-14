// Similar-report groups: TF-IDF over normalized tokens, cosine similarity (delta section 6). No external service.
import { BREAK, normalize } from './engine.js'
import { stopwords } from './lexicon.js'

type Vec = Map<string, number>
export type Doc = { id: string; text: string }
export type Group = { reportIds: string[] }

const terms = (text: string) => normalize(text).filter((t) => t !== BREAK && t !== 'hon' && !stopwords.has(t) && t.length > 1)

/** Smoothed IDF, so two identical reports still get non-zero vectors. */
export function vectorize(docs: Doc[]): Map<string, Vec> {
  const tokenized = docs.map((d) => [d.id, terms(d.text)] as const)
  const df = new Map<string, number>()
  for (const [, ts] of tokenized) for (const t of new Set(ts)) df.set(t, (df.get(t) ?? 0) + 1)
  const n = docs.length
  return new Map(tokenized.map(([id, ts]) => {
    const v: Vec = new Map()
    for (const t of ts) v.set(t, (v.get(t) ?? 0) + 1)
    for (const [t, tf] of v) v.set(t, (tf / ts.length) * (Math.log((1 + n) / (1 + df.get(t)!)) + 1))
    return [id, v]
  }))
}

export function cosine(a: Vec, b: Vec) {
  let dot = 0, na = 0, nb = 0
  for (const [t, x] of a) { na += x * x; const y = b.get(t); if (y) dot += x * y }
  for (const y of b.values()) nb += y * y
  return na && nb ? dot / Math.sqrt(na * nb) : 0
}

function centroid(vs: Vec[]): Vec {
  const c: Vec = new Map()
  for (const v of vs) for (const [t, x] of v) c.set(t, (c.get(t) ?? 0) + x / vs.length)
  return c
}

/** Highest-weighted terms shared by every report in the group. */
export function sharedTerms(vs: Vec[], limit = 4) {
  const [first, ...rest] = vs
  if (!first) return []
  return [...first.keys()].filter((t) => rest.every((v) => v.has(t)))
    .sort((a, b) => vs.reduce((s, v) => s + v.get(b)!, 0) - vs.reduce((s, v) => s + v.get(a)!, 0)).slice(0, limit)
}

export type Assignment = { groupIndex?: number; partnerId?: string; similarity: number; phrases: string[] }

/**
 * Where a new report goes: the existing group whose centroid is closest at or above the threshold, else the closest
 * ungrouped report at or above it (a new group of two), else nowhere. A group of one is never shown.
 * ponytail: rebuilds TF-IDF over the program's open reports on each submit; cache vectors if a program passes a few thousand.
 */
export function assign(newDoc: Doc, open: Doc[], groups: Group[], threshold: number): Assignment | undefined {
  const vectors = vectorize([...open.filter((d) => d.id !== newDoc.id), newDoc])
  const mine = vectors.get(newDoc.id)!
  let best: Assignment | undefined
  groups.forEach((g, groupIndex) => {
    const members = g.reportIds.map((id) => vectors.get(id)).filter((v): v is Vec => !!v)
    if (!members.length) return
    const similarity = cosine(mine, centroid(members))
    if (similarity >= threshold && (!best || similarity > best.similarity)) best = { groupIndex, similarity, phrases: sharedTerms([...members, mine]) }
  })
  if (best) return best
  const grouped = new Set(groups.flatMap((g) => g.reportIds))
  for (const d of open) {
    if (d.id === newDoc.id || grouped.has(d.id)) continue
    const similarity = cosine(mine, vectors.get(d.id)!)
    if (similarity >= threshold && (!best || similarity > best.similarity)) best = { partnerId: d.id, similarity, phrases: sharedTerms([vectors.get(d.id)!, mine]) }
  }
  return best
}
