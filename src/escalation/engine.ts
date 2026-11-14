// Rule-based context-aware escalation (docs/deltas/2026-11-09-context-aware-escalation-engine.md, ADR 0006).
// Pure functions, no I/O and no external service: the same report and roster always give the same route.
import type { User } from '../schemas.js'
import type { Space, Stage } from '../store.js'
import { clauseBreaks, complaint, critical, ENGINE_VERSION, escalationConfig, honorifics, LEXICON_VERSION, rolePhrases, scope as scopeWords, stopwords } from './lexicon.js'

export const BREAK = '|'
const hon = new Set(honorifics)
const breaks = new Set(clauseBreaks)

/** Lowercase tokens. Honorifics become `hon`, sentence ends and clause words ("pero") become `|`. Stopwords stay so positions are real. */
export function normalize(text: string): string[] {
  const cleaned = text.toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .replace(/(\p{L})'(\p{L})/gu, '$1$2') // ma'am -> maam, didn't -> didnt
    .replace(/\b(dr|prof|ms|mr|mrs|engr|atty|sta|st)\./g, '$1 ') // "Dr. Ash" is one phrase, not a sentence end
    .replace(/[.!?;:\n]+/g, ` ${BREAK} `)
    .replace(/[^\p{L}\p{N}| ]+/gu, ' ')
    .replace(/(\p{L})\1{2,}/gu, '$1$1') // grabeee -> grabee
  return cleaned.split(/\s+/).filter(Boolean).map((t) => (hon.has(t) ? 'hon' : breaks.has(t) ? BREAK : t))
}

export function jaroWinkler(a: string, b: string): number {
  if (a === b) return 1
  const range = Math.max(0, Math.floor(Math.max(a.length, b.length) / 2) - 1)
  const aHit = new Array<boolean>(a.length).fill(false), bHit = new Array<boolean>(b.length).fill(false)
  let matches = 0
  for (let i = 0; i < a.length; i++) {
    for (let j = Math.max(0, i - range); j < Math.min(b.length, i + range + 1); j++) {
      if (!bHit[j] && a[i] === b[j]) { aHit[i] = bHit[j] = true; matches++; break }
    }
  }
  if (!matches) return 0
  let k = 0, transpositions = 0
  for (let i = 0; i < a.length; i++) {
    if (!aHit[i]) continue
    while (!bHit[k]) k++
    if (a[i] !== b[k++]) transpositions++
  }
  const jaro = (matches / a.length + matches / b.length + (matches - transpositions / 2) / matches) / 3
  let prefix = 0
  while (prefix < 4 && a[prefix] && a[prefix] === b[prefix]) prefix++
  return jaro + prefix * 0.1 * (1 - jaro)
}

const particles = new Set(['de', 'del', 'dela', 'delos', 'los', 'la', 'san', 'sta', 'santa', 'van', 'von', 'di', 'da'])

export type Role = 'adviser' | 'subject' | 'chair' | 'dean'
export type Alias = { tokens: string[]; kind: 'full' | 'surname' | 'first' | 'initials' | 'role' | 'subject'; fuzzy: boolean }
export type Person = { id: string; name: string; role: Role; aliases: Alias[] }

/** Aliases for one faculty member. Bare first names and initials collide with common words, so they need an honorific. */
export function aliasesFor(name: string, role: Role, subjects: string[] = []): Alias[] {
  const parts = normalize(name).filter((t) => t !== 'hon' && t !== BREAK && !/^(phd|mit|msit|mscs|edd|jr|sr|iii?)$/.test(t))
  if (!parts.length) return []
  const p = parts.findIndex((t, i) => i > 0 && particles.has(t))
  const surname = p > 0 ? parts.slice(p) : parts.slice(-1)
  const first = parts.slice(0, parts.length - surname.length)
  const out: Alias[] = [{ tokens: parts, kind: 'full', fuzzy: true }, { tokens: surname, kind: 'surname', fuzzy: true }]
  if (surname.length > 1) out.push({ tokens: [surname.join('')], kind: 'surname', fuzzy: true })
  if (first.length) out.push({ tokens: ['hon', ...first], kind: 'first', fuzzy: false }, { tokens: ['hon', first[0]!], kind: 'first', fuzzy: false })
  const initials = parts.map((t) => t[0]).join('')
  if (initials.length > 1) out.push({ tokens: ['hon', initials], kind: 'initials', fuzzy: false })
  if (role === 'adviser' || role === 'chair' || role === 'dean') for (const phrase of rolePhrases[role]) out.push({ tokens: normalize(phrase), kind: 'role', fuzzy: false })
  for (const subject of subjects) {
    const s = normalize(subject).filter((t) => t !== BREAK)
    if (s.length) out.push({ tokens: ['hon', 'sa', ...s], kind: 'subject', fuzzy: false }, { tokens: [...s, 'hon'], kind: 'subject', fuzzy: false })
  }
  // Initials always need an honorific ("sir jdc"). A one-word surname without one must be 4+ letters and not a
  // stopword, so "Ash" and "Elm" need "sir" and a surname like "Ang" is not read in every sentence.
  return out.map((a) => {
    const [t] = a.tokens
    if (a.tokens.length !== 1 || a.kind !== 'surname') return a
    return t!.length >= 4 && !stopwords.has(t!) ? a : { ...a, tokens: ['hon', t!], fuzzy: false }
  })
}

/** The reporter's own faculty: adviser, the professors of their class spaces, their Program Chair and the Dean. */
export function rosterFor(reporter: User, users: User[], spaces: Space[]): Person[] {
  const people = new Map<string, Person>()
  const subjectsOf = new Map<string, string[]>()
  const add = (u: User | undefined, role: Role, subjects: string[] = []) => {
    if (!u || u.id === reporter.id) return
    const known = people.get(u.id)
    // A professor of several of the reporter's subjects is known by all of them, whatever order the spaces come in.
    if (known) {
      if (known.role !== 'subject' || role !== 'subject') return
      const all = [...new Set([...(subjectsOf.get(u.id) ?? []), ...subjects])]
      subjectsOf.set(u.id, all)
      known.aliases = aliasesFor(u.name, 'subject', all)
      return
    }
    subjectsOf.set(u.id, subjects)
    people.set(u.id, { id: u.id, name: u.name, role, aliases: aliasesFor(u.name, role, subjects) })
  }
  add(users.find((u) => u.id === reporter.adviserId), 'adviser')
  for (const space of spaces.filter((s) => reporter.spaceIds.includes(s.id))) {
    const subjects = [space.subject, space.title].filter((s) => s && s !== 'Section group')
    for (const id of space.professorIds) add(users.find((u) => u.id === id), 'subject', subjects)
  }
  for (const u of users.filter((u) => u.active && u.roles.includes('chair') && u.program === reporter.program)) add(u, 'chair')
  for (const u of users.filter((u) => u.active && u.roles.includes('dean'))) add(u, 'dean')
  return [...people.values()]
}

const pointers = new Set(['hon', 'si', 'ni', 'kay', 'kina', 'sina', 'nina'])
type Hit = { start: number; end: number; score: number; text: string }

function findExact(tokens: string[], phrase: string[]): Hit[] {
  const hits: Hit[] = []
  for (let i = 0; i + phrase.length <= tokens.length; i++) if (phrase.every((t, k) => tokens[i + k] === t)) hits.push({ start: i, end: i + phrase.length - 1, score: 1, text: phrase.join(' ') })
  return hits
}

// Exact match, else Jaro-Winkler over a window of 1 to 3 tokens joined ("dela crus" and "delacrus" both meet "dela cruz").
function findAlias(tokens: string[], alias: Alias): Hit[] {
  const exact = findExact(tokens, alias.tokens)
  if (exact.length || !alias.fuzzy) return exact
  const target = alias.tokens.join('')
  if (target.length < escalationConfig.fuzzyMinLength) return []
  const hits: Hit[] = []
  for (let i = 0; i < tokens.length; i++) {
    for (let w = 1; w <= 3 && i + w <= tokens.length; w++) {
      const window = tokens.slice(i, i + w)
      if (window.includes(BREAK)) break
      const joined = window.join('')
      // A near-miss spelling counts only right after "sir/ma'am" or "si/ni/kay", so "broke" is not read as "Brook".
      if (joined.length < escalationConfig.fuzzyMinLength || !pointers.has(tokens[i - 1] ?? '')) continue
      const score = jaroWinkler(joined, target)
      if (score >= escalationConfig.fuzzyMin) hits.push({ start: i, end: i + w - 1, score: Math.round(score * 100) / 100, text: window.join(' ') })
    }
  }
  return hits
}

const lexicon = (words: string[]) => words.map(normalize)
const complaintTerms = lexicon(complaint), criticalTerms = lexicon(critical)
const scopeTerms = Object.entries(scopeWords).map(([level, words]) => [level, lexicon(words)] as const)
const termHits = (tokens: string[], terms: string[][]) => terms.flatMap((t) => findExact(tokens, t))
// "late ako", "absent ako kahapon", "I was late": the student describing their own lateness is not a complaint.
// But "ko" right after a person means "my" ("adviser ko hindi nagrereply", "prof ko laging absent"): that complaint stays.
const selfWords = new Set(['ako', 'ko', 'i', 'im'])
const personWords = new Set(['hon', 'adviser', 'advisor', 'chair', 'chairperson', 'dean'])
const selfBefore = (tokens: string[], i: number) => selfWords.has(tokens[i] ?? '') && !(tokens[i] === 'ko' && personWords.has(tokens[i - 1] ?? ''))
const complaintsIn = (tokens: string[]) => termHits(tokens, complaintTerms).filter((h) => !selfWords.has(tokens[h.end + 1] ?? '') && !selfBefore(tokens, h.start - 1) && !(tokens[h.start - 1] === 'was' && tokens[h.start - 2] === 'i'))

export type Mention = { personId: string; name: string; role: Role; alias: string; aliasKind: Alias['kind']; matchScore: number; term?: string; distance?: number; proximity: number; conflict: number }

// Tokens between two spans, or Infinity when a clause break sits between them.
function gap(tokens: string[], a: Hit, b: Hit) {
  const [lo, hi] = a.end < b.start ? [a.end, b.start] : [b.end, a.start]
  if (hi <= lo) return 0
  return tokens.slice(lo + 1, hi).includes(BREAK) ? Infinity : hi - lo - 1
}
const proximityOf = (d: number) => (d <= 5 ? 1 : d <= 12 ? 0.5 : 0.2)

/** conflict(F) = match(F) x proximity to the nearest complaint term in the same clause. Best mention per person. */
export function mentionsIn(tokens: string[], people: Person[]): Mention[] {
  const complaints = complaintsIn(tokens).concat(termHits(tokens, criticalTerms))
  const best = new Map<string, Mention>()
  for (const person of people) {
    for (const alias of person.aliases) {
      for (const hit of findAlias(tokens, alias)) {
        let near: Hit | undefined, distance = Infinity
        for (const c of complaints) { const d = gap(tokens, hit, c); if (d < distance) { distance = d; near = c } }
        const proximity = proximityOf(distance)
        const conflict = Math.round(hit.score * proximity * 100) / 100
        const prior = best.get(person.id)
        if (!prior || conflict > prior.conflict) best.set(person.id, { personId: person.id, name: person.name, role: person.role, alias: hit.text, aliasKind: alias.kind, matchScore: hit.score, term: near?.text, distance: Number.isFinite(distance) ? distance : undefined, proximity, conflict })
      }
    }
  }
  return [...best.values()]
}

export type Scope = 'individual' | 'section' | 'program' | 'college'
export function scopeOf(tokens: string[]): Scope {
  let found: Scope = 'individual'
  for (const [level, terms] of scopeTerms) if (termHits(tokens, terms).length) found = level as Scope
  return found
}

export type Signals = { aboutAdvisor: boolean; conflictedAdviser: boolean; involvedUserIds: string[] }
export type Decision = {
  stage: Stage; bypassed: boolean; aboutAdvisor: boolean; possibleConflict: boolean; involvedUserIds: string[]; reason: string
  trace: { engineVersion: string; lexiconVersion: string; rule: string; scope: Scope; severityHint?: 'critical'; criticalTerm?: string; mentions: Mention[]; heldBack: string[]; thresholds: { bypass: number; triage: number } }
}

/**
 * The routing table, first match wins. The engine can add a bypass; it never removes one the student asked for.
 * `chairIds` are the program's active chairs, so a concern is not sent to a chair who is involved in it.
 */
export function route(text: string, people: Person[], signals: Signals, chairIds: string[], config = escalationConfig): Decision {
  const tokens = normalize(text)
  const mentions = mentionsIn(tokens, people)
  const scope = scopeOf(tokens)
  const criticalHit = termHits(tokens, criticalTerms)[0]
  const involved = new Set(signals.involvedUserIds)
  const heldBack: string[] = []
  const adviser = people.find((p) => p.role === 'adviser')
  const over = (m: Mention) => m.conflict >= config.conflictBypass
  const byRole = (role: Role) => mentions.filter((m) => m.role === role)

  // The adviser's full name in the report keeps the adviser out, as before the engine. Safer to send a helper mention to the chair than a complaint to its subject.
  const adviserNamed = byRole('adviser').some((m) => m.aliasKind === 'full' && m.matchScore === 1)
  const explicit = signals.aboutAdvisor || signals.conflictedAdviser || (!!adviser && involved.has(adviser.id)) || adviserNamed
  const adviserConflict = byRole('adviser').some(over)
  // A chair who also teaches the student counts as the chair: the Program Chair stage cannot take a report about itself.
  const subjectConflicts = byRole('subject').filter((m) => over(m) && !chairIds.includes(m.personId))
  const chairConflicts = mentions.filter((m) => over(m) && (m.role === 'chair' || m.role === 'subject' && chairIds.includes(m.personId)))
  const deanConflicts = byRole('dean').filter(over)
  const possible = mentions.filter((m) => !over(m) && m.conflict >= config.conflictTriage && (m.role === 'adviser' || m.role === 'subject' && !chairIds.includes(m.personId)))

  let stage: Stage = 'adviser', rule = 'default', reason = 'Sent to the student\'s adviser.'
  let aboutAdvisor = false

  // A Chair or Dean the concern may be about never reads it, bypass or not: the higher bypass only changes where it goes.
  for (const m of [...subjectConflicts, ...chairConflicts, ...deanConflicts]) involved.add(m.personId)
  if (adviserConflict || explicit) { aboutAdvisor = true; if (adviser) involved.add(adviser.id) }
  if (deanConflicts.length && !config.higherBypass) heldBack.push('The Dean may be involved.')

  if (criticalHit && config.criticalToGuidance) {
    stage = 'guidance'; rule = 'critical'; reason = 'Critical concern. Sent to the Guidance Office.'
  } else if (explicit || adviserConflict || subjectConflicts.length) {
    stage = 'chair'; rule = explicit && !adviserConflict && !subjectConflicts.length ? 'student-or-named-adviser' : adviserConflict ? 'adviser-conflict' : 'subject-professor-conflict'
    reason = rule === 'subject-professor-conflict' ? 'A subject professor may be involved. Sent to the Program Chair for review.' : 'The adviser may be involved. Sent to the Program Chair for review.'
  } else if (possible.length) {
    stage = 'chair'; rule = 'possible-conflict'; reason = 'A faculty member may be involved. Sent to the Program Chair to check.'
  } else if (scope === 'program' || scope === 'college') {
    stage = 'chair'; rule = 'wide-scope'; reason = `The concern affects the whole ${scope}. Sent to the Program Chair.`
  }
  if (criticalHit && !config.criticalToGuidance) heldBack.push('Consider referring this concern to the Guidance Office.')

  // Held-back notes are shown to handlers, so they say what to watch for, not which rule is waiting for approval.
  // A chair conflict moves past the chair only when the higher bypass is on. A chair stage where every chair is involved
  // always moves on, or the concern would have no one to receive it.
  const chairsFree = chairIds.filter((id) => !involved.has(id))
  const noFreeChair = stage === 'chair' && chairIds.length > 0 && !chairsFree.length
  if (chairConflicts.length && !config.higherBypass && !noFreeChair) {
    heldBack.push('The Program Chair may be involved.')
  } else if (stage !== 'guidance' && (config.higherBypass && chairConflicts.length || noFreeChair)) {
    stage = 'dean'; rule = 'chair-conflict'; reason = 'The Program Chair may be involved. Sent to the Dean.'
    // The Dean cannot receive a concern about the Dean either.
    if (deanConflicts.length) { stage = 'guidance'; rule = 'chair-and-dean-conflict'; reason = 'The Program Chair and the Dean may be involved. Sent to the Guidance Office.' }
  }

  return {
    stage, bypassed: stage !== 'adviser', aboutAdvisor, possibleConflict: rule === 'possible-conflict' || heldBack.length > 0,
    involvedUserIds: [...involved], reason,
    trace: { engineVersion: ENGINE_VERSION, lexiconVersion: LEXICON_VERSION, rule, scope, ...(criticalHit ? { severityHint: 'critical' as const, criticalTerm: criticalHit.text } : {}), mentions, heldBack, thresholds: { bypass: config.conflictBypass, triage: config.conflictTriage } },
  }
}
