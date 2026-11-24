import { describe, expect, it, vi } from 'vitest'

const context = {
  question: 'Help me write and organize my report draft.',
  draft: 'yesterday someone in my class kept posting mean things about me',
  firstName: 'Ana',
  roles: ['student'],
  grounded: { reply: 'Say what happened, when, and where.', sources: [{ title: 'Help', href: '/help' }] },
  faq: [{ question: 'How are reports routed?', answer: 'To the adviser first.', href: '/cases' }],
  pages: ['My reports', 'New report', 'Help'],
}

async function load(key: string) {
  vi.resetModules()
  process.env.OPENAI_API_KEY = key
  return import('../src/assistant-ai.js')
}

const reply = (content: string, ok = true) => vi.fn(async () => ({ ok, json: async () => ({ choices: [{ message: { content } }] }) }) as unknown as Response)

describe('assistant model layer', () => {
  it('does nothing without a key', async () => {
    const { refineAnswer } = await load('')
    const fetcher = reply('{}')
    expect(await refineAnswer(context, fetcher)).toBeNull()
    expect(fetcher).not.toHaveBeenCalled()
  })

  it('returns the reworded reply and the draft, keeps the rule-based sources, and stores nothing', async () => {
    const { refineAnswer } = await load('test-key')
    const fetcher = reply(JSON.stringify({ reply: 'Here is a clearer draft.', draft: 'What happened: ... [add: the date]' }))
    const answer = await refineAnswer(context, fetcher)
    expect(answer).toEqual({ reply: 'Here is a clearer draft.', draft: 'What happened: ... [add: the date]', sources: context.grounded.sources })
    const [, init] = fetcher.mock.calls[0] as unknown as [string, RequestInit]
    const body = JSON.parse(String(init.body))
    expect(body.store).toBe(false)
    expect(body.messages[1].content).toContain('DRAFT:\nyesterday someone')
    expect(body.messages[1].content).toContain('FACTS:\nSay what happened')
  })

  it('drops a rewrite that loses a number the student wrote', async () => {
    const { refineAnswer, keepsNumbers } = await load('test-key')
    expect(keepsNumbers('at 3pm in room 304, 3 times', 'At 3pm in room 304. It happened 3 times.')).toBe(true)
    expect(keepsNumbers('at 3pm in room 304', 'At 3pm in our group chat.')).toBe(false)
    const answer = await refineAnswer({ ...context, draft: 'room 304 at 3pm' }, reply(JSON.stringify({ reply: 'Here it is.', draft: 'At 3pm in the chat.' })))
    expect(answer?.draft).toBeUndefined()
    expect(answer?.reply).toMatch(/unchanged/)
  })

  it('drops a draft when none was sent', async () => {
    const { refineAnswer } = await load('test-key')
    const answer = await refineAnswer({ ...context, draft: undefined }, reply(JSON.stringify({ reply: 'Open My reports.', draft: 'invented' })))
    expect(answer).toEqual({ reply: 'Open My reports.', sources: context.grounded.sources })
  })

  it('falls back on a provider error, bad JSON, or an empty reply', async () => {
    const { refineAnswer } = await load('test-key')
    expect(await refineAnswer(context, reply('{}', false))).toBeNull()
    expect(await refineAnswer(context, reply('not json'))).toBeNull()
    expect(await refineAnswer(context, reply('{"reply":""}'))).toBeNull()
    expect(await refineAnswer(context, vi.fn(async () => { throw new Error('timeout') }))).toBeNull()
  })
})
