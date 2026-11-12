// Issue #36: account invites go out by email through SES when MAIL_FROM is set. Without it, or when sending fails, the
// screen shows the invite once as before. Credentials are never logged, and sample addresses are never emailed.
import { afterEach, describe, expect, it, vi } from 'vitest'

import { sendInvite, type Invite } from '../src/accounts.js'
import { createSesInviteMailer, inviteText } from '../src/mail.js'

const invite: Invite = { accountId: 'USR-01', to: 'ana.cruz@gmail.com', name: 'Ana Cruz', signInUrl: 'https://portal.access-ccs.com/sign-in', username: 'ana.cruz', temporaryPassword: 'Tq7#mPz9!kLw2x' }
afterEach(() => { vi.restoreAllMocks() })

describe('the invite email', () => {
  it('sends the sign-in link and the temporary credentials, as plain text from MAIL_FROM', async () => {
    const commands: { input: unknown }[] = []
    const mailer = createSesInviteMailer('no-reply@access-ccs.com', { send: async (command: { input: unknown }) => { commands.push(command); return {} } } as never)
    expect(await sendInvite(invite, mailer)).toEqual({ sent: true })
    expect(commands[0]!.input).toEqual({
      FromEmailAddress: 'no-reply@access-ccs.com',
      Destination: { ToAddresses: ['ana.cruz@gmail.com'] },
      Content: { Simple: { Subject: { Data: 'Your ACCS account', Charset: 'UTF-8' }, Body: { Text: { Data: inviteText(invite), Charset: 'UTF-8' } } } },
    })
    const text = inviteText(invite)
    for (const part of ['Hello Ana Cruz,', invite.signInUrl, 'Username: ana.cruz', `Temporary password: ${invite.temporaryPassword}`, 'choose your own username and password']) expect(text).toContain(part)
  })

  it('falls back to showing the invite when SES fails, and logs the failure without the credentials', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
    const failing = createSesInviteMailer('no-reply@access-ccs.com', { send: async () => { throw Object.assign(new Error('Email address is not verified'), { name: 'MessageRejected' }) } } as never)
    expect(await sendInvite(invite, failing)).toEqual({ sent: false })
    const logged = errors.mock.calls.map((call) => String(call[0])).join('\n')
    expect(JSON.parse(logged)).toEqual({ level: 'error', message: 'Invite email not sent', accountId: 'USR-01', error: 'MessageRejected' })
    for (const secret of [invite.temporaryPassword, invite.username, invite.to]) expect(logged).not.toContain(secret)
  })

  it('sends nothing without an email service, as before', async () => {
    const logs = vi.spyOn(console, 'log').mockImplementation(() => {})
    expect(await sendInvite(invite)).toEqual({ sent: false })
    expect(logs.mock.calls.map((call) => String(call[0])).join('\n')).not.toContain(invite.temporaryPassword)
  })

  it('never emails a sample address, such as the secretary activated without an email', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {})
    const send = vi.fn(async () => ({ sent: true }))
    for (const to of ['secretary@example.invalid', 'SECRETARY@example.invalid', 'stu.it.a@qcu.edu.ph']) expect(await sendInvite({ ...invite, to }, { send })).toEqual({ sent: false })
    expect(send).not.toHaveBeenCalled()
  })
})
