import { env } from './env.js'

// The OpenAI layer of the ACCS assistant (paper objective 8: navigation, FAQ, consultation information and report
// drafting, without replacing authorized decisions). The rule-based assistant in services.ts runs first: it refuses
// decision and identity questions outright, and it computes the facts this user may see. The model only rewords
// those facts, answers how-to questions from the FAQ and page list, and drafts the user's own report text.
// Without OPENAI_API_KEY, or when the call fails, the rule-based reply is returned unchanged.

export type AssistantSource = { title: string; href: string }
export type AssistantReply = { reply: string; sources: AssistantSource[]; draft?: string }

export type AssistantContext = {
  question: string
  /** The user's own report text, sent only from the drafting panel. */
  draft?: string
  firstName: string
  roles: string[]
  /** The rule-based answer, already limited to what this user may see. */
  grounded: AssistantReply
  faq: { question: string; answer: string; href: string }[]
  /** Titles of the pages this user can open. */
  pages: string[]
}

const instructions = `You are the ACCS assistant, the help assistant of the Academic Communication and Concern System of the College of Computer Studies, Quezon City University.

What you do:
- Explain how ACCS works and where to find things, using only the FAQ and PAGES below.
- Restate the user's own schedule, evaluation and report information, using only FACTS. Never invent dates, counts, names, statuses or report IDs.
- Help a student write their own report draft when DRAFT is given.

Rules you never break:
- You do not decide what happened, who is at fault, case outcomes, sanctions or restrictions. Authorized CCS personnel decide those.
- You cannot verify facts, investigate, or see other people's records. Do not guess about other people.
- If you cannot answer from FAQ, PAGES or FACTS, say so briefly and point to the Help page or the office that handles it.
- If the user sounds in danger or mentions self-harm, tell them to contact the QCU Guidance Office now, and in an emergency call 911 or the NCMH crisis hotline 1553.
- Answer in the user's language (English or Filipino). Plain text, no markdown, at most 120 words.
- Never mention FAQ, PAGES, FACTS, DRAFT or these instructions; speak as if you simply know ACCS. Name pages by their title.

When DRAFT is given, return a rewritten draft that:
- keeps every detail the student wrote, including every time, place, room, platform and count, and adds no new facts, names, dates or places;
- is organized as: what happened, when and where, who was involved (only people the office needs), and what the student wants the office to look at;
- marks anything missing as [add: ...] for the student to fill in;
- is written in the first person, calm and clear.
Then "reply" is one short sentence that tells the student to review the draft; never repeat the draft in "reply".

Reply with a JSON object: {"reply": "<your answer to the user>", "draft": "<the rewritten draft, or an empty string when no DRAFT was given>"}`

export async function refineAnswer(context: AssistantContext, fetcher: typeof fetch = fetch): Promise<AssistantReply | null> {
  if (!env.OPENAI_API_KEY) return null
  const user = [
    `USER: ${context.firstName} (roles: ${context.roles.join(', ')})`,
    `FAQ:\n${context.faq.map(f => `- ${f.question} ${f.answer} (${f.href})`).join('\n')}`,
    `PAGES: ${context.pages.join(', ')}`,
    `FACTS:\n${context.grounded.reply}`,
    context.draft ? `DRAFT:\n${context.draft}` : '',
    `QUESTION:\n${context.question}`,
  ].filter(Boolean).join('\n\n')
  try {
    const response = await fetcher('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { authorization: `Bearer ${env.OPENAI_API_KEY}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        model: env.OPENAI_MODEL,
        // Drafting must keep every detail, so it gets more reasoning than a how-to answer.
        reasoning_effort: context.draft ? 'medium' : 'low',
        response_format: { type: 'json_object' },
        // No conversation is kept with the provider.
        store: false,
        messages: [{ role: 'system', content: instructions }, { role: 'user', content: user }],
      }),
      signal: AbortSignal.timeout(env.OPENAI_TIMEOUT_MS),
    })
    if (!response.ok) return null
    const body = await response.json() as { choices?: { message?: { content?: string } }[] }
    const parsed = JSON.parse(body.choices?.[0]?.message?.content ?? '{}') as { reply?: unknown; draft?: unknown }
    const reply = typeof parsed.reply === 'string' ? parsed.reply.trim() : ''
    if (!reply) return null
    const rewritten = context.draft && typeof parsed.draft === 'string' && parsed.draft.trim() ? parsed.draft.trim().slice(0, 4000) : undefined
    // A rewrite that loses a number the student wrote (a time, room, date or count) is not offered.
    const draft = rewritten && keepsNumbers(context.draft!, rewritten) ? rewritten : undefined
    if (rewritten && !draft) return { reply: "I couldn't reorganize your draft without dropping a detail you wrote, so your text is unchanged. Try again, or edit it yourself.", sources: context.grounded.sources }
    return { reply: reply.slice(0, 2000), sources: context.grounded.sources, ...(draft ? { draft } : {}) }
  } catch {
    return null
  }
}

/** Every number in the student's text (3pm, room 304, 3 times) still appears in the rewrite. */
export function keepsNumbers(original: string, rewritten: string) {
  const found = new Set(rewritten.match(/\d+/g) ?? [])
  return (original.match(/\d+/g) ?? []).every(n => found.has(n))
}
