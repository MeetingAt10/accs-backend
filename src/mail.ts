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
