// Branded HTML email templates aligned with the ACCS landing page design system
// (accs-landing/src/app/globals.css & BRAND_REFERENCE.md).
// Every dynamic field is HTML-escaped and every link is scheme-checked before interpolation.

import type { InviteEmail, NewConcernEmail, ResetCodeEmail } from './mail.js'

const BRAND_LOGO_URL = 'https://access-ccs.com/apple-icon.png'

const TOKENS = {
  canvas: '#F4F7FF',
  surface: '#FFFFFF',
  blue50: '#F3F4FD',
  blue600: '#2F3BD6',
  blue800: '#232E87',
  navy900: '#172033',
  navy950: '#0A0F2E',
  headerStart: '#2F3BD6',
  headerEnd: '#141B5C',
  text: '#111632',
  muted: '#5E6482',
  border: '#E3E5EE',
  pillBg: '#E7E9FB',
  fontDisplay: "'Poppins', 'Plus Jakarta Sans', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif",
  fontBody: "'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif",
  fontMono: "'JetBrains Mono', ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
} as const

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

/** Allows only http/https URLs in email href attributes; returns null otherwise. */
export function safeHref(raw: string): string | null {
  try {
    const parsed = new URL(raw)
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return null
    return parsed.toString()
  } catch {
    return null
  }
}

export interface EmailLayoutOptions {
  preheader: string
  pill: string
  heading: string
  bodyHtml: string
  footerNote?: string
}

export function renderEmailLayout(options: EmailLayoutOptions): string {
  const preheader = escapeHtml(options.preheader)
  const pill = escapeHtml(options.pill)
  const heading = escapeHtml(options.heading)
  const footerNote = options.footerNote ? `<p style="margin:0 0 12px;color:${TOKENS.muted};font-family:${TOKENS.fontBody};font-size:13px;line-height:20px;">${escapeHtml(options.footerNote)}</p>` : ''

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <meta name="color-scheme" content="light" />
  <title>${heading}</title>
</head>
<body style="margin:0;padding:0;background-color:${TOKENS.canvas};color:${TOKENS.text};font-family:${TOKENS.fontBody};-webkit-font-smoothing:antialiased;">
  <div style="display:none;max-height:0;overflow:hidden;opacity:0;mso-hide:all;">${preheader}</div>
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="background-color:${TOKENS.canvas};width:100%;">
    <tr>
      <td align="center" style="padding:36px 16px 40px;">
        <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="max-width:560px;width:100%;">
          <tr>
            <td style="background-color:${TOKENS.headerEnd};background-image:linear-gradient(163.89deg, ${TOKENS.headerStart} 0%, ${TOKENS.headerEnd} 71.429%);border-radius:20px 20px 0 0;padding:24px 32px;">
              <table role="presentation" cellspacing="0" cellpadding="0" border="0">
                <tr>
                  <td style="vertical-align:middle;padding-right:12px;">
                    <img src="${BRAND_LOGO_URL}" alt="ACCS" width="36" height="36" style="display:block;width:36px;height:36px;border-radius:8px;border:0;" />
                  </td>
                  <td style="vertical-align:middle;">
                    <div style="color:#FFFFFF;font-family:${TOKENS.fontDisplay};font-size:18px;font-weight:700;line-height:22px;letter-spacing:0.01em;">ACCS</div>
                    <div style="color:rgba(255,255,255,0.72);font-family:${TOKENS.fontBody};font-size:11px;font-weight:500;line-height:14px;">College of Computer Studies</div>
                  </td>
                </tr>
              </table>
            </td>
          </tr>
          <tr>
            <td style="background-color:${TOKENS.surface};border-left:1px solid ${TOKENS.border};border-right:1px solid ${TOKENS.border};border-bottom:1px solid ${TOKENS.border};border-radius:0 0 20px 20px;padding:32px;">
              <div style="margin:0 0 14px;">
                <span style="display:inline-block;padding:4px 12px;border-radius:999px;background-color:${TOKENS.pillBg};color:${TOKENS.blue600};font-family:${TOKENS.fontBody};font-size:12px;font-weight:600;line-height:16px;">${pill}</span>
              </div>
              <h1 style="margin:0 0 18px;color:${TOKENS.navy900};font-family:${TOKENS.fontDisplay};font-size:24px;font-weight:700;line-height:31px;letter-spacing:-0.01em;">${heading}</h1>
              ${options.bodyHtml}
              <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="margin-top:28px;border-top:1px solid ${TOKENS.border};">
                <tr>
                  <td style="padding-top:20px;">
                    ${footerNote}
                    <p style="margin:0;color:${TOKENS.muted};font-family:${TOKENS.fontBody};font-size:12px;line-height:18px;">
                      Your access to the College of Computer Studies, Quezon City University.
                    </p>
                  </td>
                </tr>
              </table>
            </td>
          </tr>
          <tr>
            <td align="center" style="padding:20px 16px 0;">
              <p style="margin:0;color:${TOKENS.muted};font-family:${TOKENS.fontBody};font-size:12px;line-height:18px;">
                &copy; 2026 ACCS &middot; College of Computer Studies, Quezon City University
              </p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`
}

function renderActionButton(label: string, url: string): string {
  const href = safeHref(url)
  const escapedUrl = escapeHtml(url)
  const escapedLabel = escapeHtml(label)
  if (!href) {
    return `<p style="margin:0 0 16px;color:${TOKENS.text};font-family:${TOKENS.fontMono};font-size:13px;line-height:20px;word-break:break-all;">${escapedUrl}</p>`
  }
  const escapedHref = escapeHtml(href)
  return `<table role="presentation" cellspacing="0" cellpadding="0" border="0" style="margin:24px 0 16px;">
  <tr>
    <td style="border-radius:12px;background-color:${TOKENS.blue600};">
      <a href="${escapedHref}" target="_blank" rel="noopener noreferrer" style="display:inline-block;padding:14px 24px;border-radius:12px;background-color:${TOKENS.blue600};color:#FFFFFF;font-family:${TOKENS.fontBody};font-size:15px;font-weight:600;line-height:18px;text-decoration:none;">${escapedLabel}</a>
    </td>
  </tr>
</table>
<p style="margin:0;color:${TOKENS.muted};font-family:${TOKENS.fontBody};font-size:12px;line-height:18px;word-break:break-all;">
  Or open this link: <a href="${escapedHref}" style="color:${TOKENS.blue600};text-decoration:underline;">${escapedUrl}</a>
</p>`
}

export function resetCodeHtml(message: ResetCodeEmail): string {
  const name = escapeHtml(message.name)
  const code = escapeHtml(message.code)
  const mins = escapeHtml(String(message.expiresInMinutes))

  return renderEmailLayout({
    preheader: `Your ACCS password reset code is ${message.code}. Expires in ${message.expiresInMinutes} minutes.`,
    pill: 'Password reset',
    heading: 'Your password reset code',
    bodyHtml: `<p style="margin:0 0 16px;color:${TOKENS.text};font-family:${TOKENS.fontBody};font-size:15px;line-height:24px;">Hello ${name},</p>
<p style="margin:0 0 20px;color:${TOKENS.muted};font-family:${TOKENS.fontBody};font-size:15px;line-height:24px;">Use this single-use code to reset your ACCS password.</p>
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="margin:0 0 20px;">
  <tr>
    <td align="center" style="background-color:${TOKENS.blue50};border:1px solid ${TOKENS.border};border-radius:14px;padding:22px 20px;">
      <div style="color:${TOKENS.navy900};font-family:${TOKENS.fontMono};font-size:32px;font-weight:700;line-height:38px;letter-spacing:0.22em;">${code}</div>
      <div style="margin-top:8px;color:${TOKENS.muted};font-family:${TOKENS.fontBody};font-size:12px;font-weight:500;line-height:16px;">Expires in ${mins} minutes &middot; Works once</div>
    </td>
  </tr>
</table>`,
    footerNote: 'If you did not ask to reset your password, ignore this email. Your password has not changed.',
  })
}

export function newConcernHtml(message: NewConcernEmail): string {
  const name = escapeHtml(message.name)

  return renderEmailLayout({
    preheader: 'A new concern has been sent to you in ACCS. Sign in to read it.',
    pill: 'Confidential notice',
    heading: 'New concern in ACCS',
    bodyHtml: `<p style="margin:0 0 16px;color:${TOKENS.text};font-family:${TOKENS.fontBody};font-size:15px;line-height:24px;">Hello ${name},</p>
<p style="margin:0;color:${TOKENS.muted};font-family:${TOKENS.fontBody};font-size:15px;line-height:24px;">A new concern has been sent to you in ACCS. Sign in to review and respond to the case.</p>
${renderActionButton('Sign in to read concern', message.link)}`,
    footerNote: "For the student's privacy, this email does not include any details of the concern.",
  })
}

export function inviteHtml(invite: InviteEmail): string {
  const name = escapeHtml(invite.name)
  const username = escapeHtml(invite.username)
  const password = escapeHtml(invite.temporaryPassword)

  return renderEmailLayout({
    preheader: 'An ACCS account was created for you. Sign in with your temporary credentials.',
    pill: 'Account created',
    heading: 'Your ACCS account',
    bodyHtml: `<p style="margin:0 0 16px;color:${TOKENS.text};font-family:${TOKENS.fontBody};font-size:15px;line-height:24px;">Hello ${name},</p>
<p style="margin:0 0 20px;color:${TOKENS.muted};font-family:${TOKENS.fontBody};font-size:15px;line-height:24px;">An ACCS account was created for you. Sign in using the temporary credentials below.</p>
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="margin:0 0 4px;">
  <tr>
    <td style="background-color:${TOKENS.blue50};border:1px solid ${TOKENS.border};border-radius:14px;padding:18px 20px;">
      <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0">
        <tr>
          <td style="padding:0 0 10px;color:${TOKENS.muted};font-family:${TOKENS.fontBody};font-size:12px;font-weight:600;text-transform:uppercase;letter-spacing:0.04em;">Username</td>
          <td align="right" style="padding:0 0 10px;color:${TOKENS.navy900};font-family:${TOKENS.fontMono};font-size:14px;font-weight:600;">${username}</td>
        </tr>
        <tr>
          <td style="padding:10px 0 0;border-top:1px solid ${TOKENS.border};color:${TOKENS.muted};font-family:${TOKENS.fontBody};font-size:12px;font-weight:600;text-transform:uppercase;letter-spacing:0.04em;">Temporary password</td>
          <td align="right" style="padding:10px 0 0;border-top:1px solid ${TOKENS.border};color:${TOKENS.navy900};font-family:${TOKENS.fontMono};font-size:14px;font-weight:600;">${password}</td>
        </tr>
      </table>
    </td>
  </tr>
</table>
${renderActionButton('Sign in to ACCS', invite.signInUrl)}`,
    footerNote: 'The first time you sign in, you will choose your own username and password. Do not share this email.',
  })
}
