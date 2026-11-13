// Curse words and slurs that flag a post, comment or message for a moderator (#84). English and Filipino, because QCU
// students write in both. A match does not block anyone: the item is held for review (#43) and a person decides.
//
// Disguised spellings are caught too: letters swapped for look-alikes (@ or 4 for a, 1 or ! for i, 0 for o, $ or 5 for s,
// 3 for e, 7 for t), repeated letters (fuuuck), and dots, dashes, stars or single spaces between letters (f.u.c.k, g a g o).
// Matching is by whole word, with a few common endings (-s, -ing, -er, -ed, -ng), so "computation" or "Dickens" is not caught.
// Words that are also ordinary words (leche flan, hayop for animal, puke in English) are left out on purpose.

const english = [
  'fuck', 'fucking', 'fucker', 'motherfucker', 'shit', 'bullshit', 'bitch', 'bastard', 'asshole', 'dick', 'dickhead',
  'pussy', 'cunt', 'slut', 'whore', 'retard', 'nigger', 'nigga', 'faggot', 'idiot', 'stupid', 'moron', 'dumbass', 'wtf', 'stfu',
]
const filipino = [
  'putangina', 'putang ina', 'tangina', 'tang ina', 'puta', 'gago', 'gaga', 'tanga', 'bobo', 'ulol', 'ulul', 'tarantado',
  'punyeta', 'lintik', 'pakyu', 'pakshet', 'kupal', 'burat', 'pokpok', 'hindot', 'kantot', 'jakol', 'siraulo', 'tangamo', 'gagu',
]
export const flaggedWords: readonly string[] = [...english, ...filipino]

const lookAlikes: Record<string, string> = { a: 'a@4', e: 'e3', i: 'i1!|', o: 'o0', s: 's5$', t: 't7+', g: 'g9', u: 'uv' }
const escape = (char: string) => char.replace(/[\\\]^-]/g, (c) => '\\' + c)
const letterClass = (char: string) => `[${[...(lookAlikes[char] ?? char)].map(escape).join('')}]`
// Between letters: nothing, or up to two dots, dashes, underscores, stars or spaces.
const between = '[\\s.\\-_*]{0,2}'

function wordPattern(word: string) {
  const letters = [...word.replace(/\s+/g, '')]
  return letters.map((char) => `${letterClass(char)}+`).join(between)
}

const pattern = new RegExp(
  `(?<![\\p{L}\\p{N}])(?:${flaggedWords.map(wordPattern).join('|')})(?:s|es|ing|in|er|ers|ed|ng)?(?![\\p{L}\\p{N}])`,
  'iu',
)

/** The first flagged word in `text`, as written there, or undefined when the text is clean. */
export function findFlaggedWord(text: string): string | undefined {
  return pattern.exec(text.normalize('NFKC'))?.[0]
}
