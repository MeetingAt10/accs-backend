import { SESv2Client, SendEmailCommand } from '@aws-sdk/client-sesv2'

// Password reset codes reach the account holder through one of these channels:
// - `email`: Amazon SES, when MAIL_FROM is set (deployed stacks with a verified SES identity).
// - `console`: local runs and tests without MAIL_FROM. The code is logged so a developer can use it.
// - `none`: production without MAIL_FROM. Nothing is sent; an administrator issues codes instead.

export type ResetCodeEmail = { userId: string; to: string; name: string; code: string; expiresInMinutes: number }
export type MailChannel = 'email' | 'console' | 'none'

export interface ResetCodeMailer {
  readonly channel: MailChannel
  /** Throws if delivery fails; the caller logs it and still answers with the generic message. */
  send(message: ResetCodeEmail): Promise<void>
}

export function resetCodeText(message: ResetCodeEmail) {
  return [
    `Hello ${message.name},`,
    '',
    `Your ACCS password reset code is ${message.code}.`,
    `It expires in ${message.expiresInMinutes} minutes and works once.`,
    '',
    'If you did not ask to reset your password, ignore this email. Your password has not changed.',
  ].join('\n')
}

/** Sends plain text only, so a name cannot inject markup. */
export function createSesResetMailer(from: string, ses: Pick<SESv2Client, 'send'> = new SESv2Client({})): ResetCodeMailer {
  return {
    channel: 'email',
    async send(message) {
      await ses.send(new SendEmailCommand({
        FromEmailAddress: from,
        Destination: { ToAddresses: [message.to] },
        Content: {
          Simple: {
            Subject: { Data: 'Your ACCS password reset code', Charset: 'UTF-8' },
            Body: { Text: { Data: resetCodeText(message), Charset: 'UTF-8' } },
          },
        },
      }))
    },
  }
}

export const consoleResetMailer: ResetCodeMailer = {
  channel: 'console',
  async send(message) {
    console.log(`[accs] password reset code for ${message.userId}: ${message.code}`)
  },
}

export const noResetMailer: ResetCodeMailer = {
  channel: 'none',
  async send() {
    throw new Error('No reset code channel is configured.')
  },
}

export function createResetMailer(options: { nodeEnv: string; mailFrom?: string }): ResetCodeMailer {
  if (options.mailFrom) return createSesResetMailer(options.mailFrom)
  return options.nodeEnv === 'production' ? noResetMailer : consoleResetMailer
}

// New-concern emails (#37). When a student files a concern, the office receiving it (the adviser, or the Program Chair
// for a concern that goes around the adviser) also gets an email. It says only that a concern arrived and links to the
// case: never the statement, the category, the reporter or anything else from the concern. The in-app notification
// is sent either way. Channels follow the reset codes: SES with MAIL_FROM, a log line on local runs, nothing in
// production without MAIL_FROM.

export type NewConcernEmail = { userId: string; to: string; name: string; link: string }

export interface NewConcernMailer {
  readonly channel: MailChannel
  /** Throws if delivery fails; the caller logs it, and the concern stays filed. */
  send(message: NewConcernEmail): Promise<void>
}

export function newConcernText(message: NewConcernEmail) {
  return [
    `Hello ${message.name},`,
    '',
    'A new concern has been sent to you in ACCS.',
    `Sign in to read it: ${message.link}`,
    '',
    'For the student\'s privacy, this email does not include any details of the concern.',
  ].join('\n')
}

/** Sends plain text only, so a name cannot inject markup. */
export function createSesNewConcernMailer(from: string, ses: Pick<SESv2Client, 'send'> = new SESv2Client({})): NewConcernMailer {
  return {
    channel: 'email',
    async send(message) {
      await ses.send(new SendEmailCommand({
        FromEmailAddress: from,
        Destination: { ToAddresses: [message.to] },
        Content: {
          Simple: {
            Subject: { Data: 'New concern in ACCS', Charset: 'UTF-8' },
            Body: { Text: { Data: newConcernText(message), Charset: 'UTF-8' } },
          },
        },
      }))
    },
  }
}

export const consoleNewConcernMailer: NewConcernMailer = {
  channel: 'console',
  async send(message) {
    console.log(`[accs] new concern email for ${message.userId} not sent (MAIL_FROM is not set): ${message.link}`)
  },
}

export const noNewConcernMailer: NewConcernMailer = {
  channel: 'none',
  async send() {},
}

export function createNewConcernMailer(options: { nodeEnv: string; mailFrom?: string }): NewConcernMailer {
  if (options.mailFrom) return createSesNewConcernMailer(options.mailFrom)
  return options.nodeEnv === 'production' ? noNewConcernMailer : consoleNewConcernMailer
}

// Account invites (#36). When the CCS Secretary or the Dean creates an account, the new user gets an email with the
// sign-in link and their temporary username and password, which they must change at first sign-in. Plain text only.
// Without MAIL_FROM nothing is sent and the screen shows the invite once, as before (`unsentMailer` in accounts.ts).

export type InviteEmail = { accountId: string; to: string; name: string; signInUrl: string; username: string; temporaryPassword: string }

export function inviteText(invite: InviteEmail) {
  return [
    `Hello ${invite.name},`,
    '',
    'An ACCS account was created for you.',
    `Sign in at ${invite.signInUrl}`,
    '',
    `Username: ${invite.username}`,
    `Temporary password: ${invite.temporaryPassword}`,
    '',
    'The first time you sign in, you will choose your own username and password. Do not share this email.',
  ].join('\n')
}

/** Throws if SES refuses or fails; the caller logs it without the credentials and shows the invite on screen instead. */
export function createSesInviteMailer(from: string, ses: Pick<SESv2Client, 'send'> = new SESv2Client({})) {
  return {
    async send(invite: InviteEmail) {
      await ses.send(new SendEmailCommand({
        FromEmailAddress: from,
        Destination: { ToAddresses: [invite.to] },
        Content: {
          Simple: {
            Subject: { Data: 'Your ACCS account', Charset: 'UTF-8' },
            Body: { Text: { Data: inviteText(invite), Charset: 'UTF-8' } },
          },
        },
      }))
      return { sent: true }
    },
  }
}
