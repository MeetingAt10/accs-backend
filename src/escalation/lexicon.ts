// Word lists for the rule-based escalation engine (docs/deltas/2026-11-09-context-aware-escalation-engine.md).
// Program Chairs and Guidance review these each semester. Bump LEXICON_VERSION on every change, because each
// routing decision stores the version it used. Entries are written plainly; they go through the same normalize()
// as report text, so "ma'am" and "maam" are the same entry.

export const ENGINE_VERSION = 'escalation-0.2.0'
export const LEXICON_VERSION = 'lexicon-2026-11-11'

/** Thresholds and switches. The higher-office bypass stays off until escalation authority is approved. */
export const escalationConfig = {
  conflictBypass: 0.6,
  conflictTriage: 0.3,
  fuzzyMin: 0.85,
  fuzzyMinLength: 5,
  similarityThreshold: 0.8,
  // A Program Chair conflict sends the concern to the Dean; a Dean conflict keeps the Dean out of the report.
  higherBypass: process.env.ESCALATION_HIGHER_BYPASS === 'true',
  // A critical concern (harassment, threat, self-harm) starts at the Guidance Office. On unless ESCALATION_CRITICAL_TO_GUIDANCE=false.
  criticalToGuidance: process.env.ESCALATION_CRITICAL_TO_GUIDANCE !== 'false',
}

export const honorifics = ['sir', 'maam', 'mam', 'miss', 'ms', 'mr', 'mrs', 'prof', 'professor', 'propesor', 'dr', 'doc', 'teacher', 'titser']

// Words that end a clause: a complaint term after one of these is not about a name before it.
export const clauseBreaks = ['pero', 'kaso', 'but', 'however', 'although', 'though', 'samantalang']

export const complaint = [
  'absent', 'laging absent', 'late', 'laging late', 'hindi pumapasok', 'di pumapasok', 'hindi nagtuturo', 'di nagtuturo', 'walang turo', 'hindi naturuan',
  'unfair', 'bias', 'biased', 'favoritism', 'may favorite', 'sinigawan', 'sumigaw', 'minura', 'nagmura', 'bastos', 'pinahiya', 'napahiya', 'insulto', 'ininsulto',
  'threat', 'tinakot', 'hindi nagrereply', 'hindi nagre reply', 'di nagrereply', 'walang reply', 'no reply', 'walang feedback', 'no feedback', 'bagsak lahat', 'binagsak',
  'did not tell', 'didnt tell', 'never told', 'hindi sinabi', 'walang abiso', 'no notice', 'without notice', 'hindi inannounce',
  'rude', 'yelled', 'shouted', 'humiliated', 'insulted', 'ignored', 'ignores', 'cancelled', 'canceled', 'nagcancel', 'never shows', 'does not teach', 'doesnt teach',
  'mahirap kausap', 'masungit', 'galit', 'nanlait', 'pinagalitan', 'pabaya', 'iresponsable', 'irresponsible', 'unprofessional', 'complaint', 'reklamo',
]

// Any of these forces the critical hint. It is kept in the routing record; the student's own severity stays as chosen.
export const critical = [
  'harass', 'harassment', 'harassed', 'hinipuan', 'hinahipuan', 'sexual', 'manyak', 'threat to kill', 'papatayin', 'pinagbantaan', 'sinaktan', 'sinampal', 'violence',
  'suicide', 'magpapakamatay', 'self harm', 'saktan ang sarili', 'stalking', 'stalker', 'sinusundan', 'abuse', 'inabuso',
]

export const scope: Record<'section' | 'program' | 'college', string[]> = {
  section: ['kami', 'namin', 'natin', 'buong section', 'lahat kami', 'klase namin', 'our class', 'whole class', 'our section', 'buong klase'],
  program: ['buong it', 'buong bsit', 'buong cs', 'buong bscs', 'buong is', 'buong bsis', 'lahat ng bsit', 'lahat ng bscs', 'lahat ng bsis', 'buong program', 'whole program', 'all bsit', 'all bscs', 'all bsis', 'every section'],
  college: ['buong ccs', 'lahat ng ccs', 'buong college', 'whole college', 'all ccs', 'buong department', 'whole department'],
}

// Role phrases resolve to a person without a name.
export const rolePhrases = {
  adviser: ['adviser namin', 'adviser ko', 'aming adviser', 'adviser natin', 'our adviser', 'my adviser', 'class adviser namin', 'advisor namin', 'advisor ko', 'our advisor', 'my advisor'],
  chair: ['program chair', 'chairperson', 'chair namin', 'our chair', 'hon chair'],
  dean: ['dean', 'dean namin', 'our dean'],
}

export const stopwords = new Set([
  'the', 'a', 'an', 'and', 'or', 'of', 'to', 'in', 'on', 'at', 'for', 'is', 'are', 'was', 'were', 'be', 'it', 'this', 'that', 'with', 'we', 'our', 'us', 'i', 'my', 'me', 'he', 'she', 'they', 'them', 'his', 'her',
  'ang', 'ng', 'sa', 'si', 'ni', 'kay', 'mga', 'na', 'at', 'ay', 'ko', 'mo', 'ka', 'ako', 'ikaw', 'siya', 'kami', 'tayo', 'sila', 'namin', 'natin', 'nila', 'niya', 'yung', 'yun', 'ito', 'iyan', 'iyon', 'po', 'opo', 'lang', 'din', 'rin', 'naman', 'pa', 'ba', 'kasi', 'talaga', 'nga', 'daw', 'raw', 'pala', 'may', 'hon',
])
