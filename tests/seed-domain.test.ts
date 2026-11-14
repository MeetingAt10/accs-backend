// Issue #69: seeded demo accounts have made-up addresses on access-ccs.com, the domain we own, instead of qcu.edu.ph, QCU's
// real domain. They are still never emailed (decision A). Accounts stored before the change, with their old qcu.edu.ph
// address, are read with the new one, and the old address still counts as a sample one.
import { describe, expect, it } from 'vitest'

import { applyAccounts, sendInvite } from '../src/accounts.js'
import { formerSeedEmails, isSampleAddress, seed, seedDomain, seedEmail } from '../src/store.js'

describe('seeded demo accounts on access-ccs.com (issue #69)', () => {
  it('gives no seeded account a qcu.edu.ph address', () => {
    expect(seedDomain).toBe('access-ccs.com')
    for (const user of seed().users) expect(user.email, user.id).not.toMatch(/qcu\.edu\.ph$/i)
    expect(seed().users.find((u) => u.id === 'CCS-DEAN')?.email).toBe('dean@access-ccs.com')
    expect(seed().users.find((u) => u.id === 'QCU-STU-IT-A')?.email).toBe('stu.it.a@access-ccs.com')
  })

  it('knows the old addresses, under the current ID and any former one', () => {
    expect(formerSeedEmails('CCS-DEAN')).toEqual(['dean@qcu.edu.ph'])
    expect(formerSeedEmails('ACCS-ADMIN')).toContain('admin@qcu.edu.ph')
    expect(formerSeedEmails('QCU-PROF-IT')).toEqual(['prof.it@qcu.edu.ph'])
    expect(formerSeedEmails('SOMEONE-REAL')).toEqual([])
  })

  it('never emails a seeded account at its new or its old address', async () => {
    expect(isSampleAddress('QCU-PROF-IT', 'prof.it@access-ccs.com')).toBe(true)
    expect(isSampleAddress('QCU-PROF-IT', 'PROF.IT@qcu.edu.ph')).toBe(true)
    expect(isSampleAddress('QCU-PROF-IT', 'charlie.demo@qcu.edu.ph')).toBe(false)
    const send = { send: async () => ({ sent: true }) }
    const invite = (to: string) => ({ accountId: 'QCU-PROF-IT', to, name: 'Demo Professor Charlie', username: 'u', temporaryPassword: 'p', roleLabel: 'Professor' })
    expect(await sendInvite(invite('prof.it@qcu.edu.ph') as never, send as never)).toEqual({ sent: false })
    expect(await sendInvite(invite('prof.it@access-ccs.com') as never, send as never)).toEqual({ sent: false })
  })

  it('reads a stored seeded account that still has its old address with the new one, and leaves a real address alone', () => {
    const db = seed()
    const stored = (id: string, email: string) => ({ ...structuredClone(db.users.find((u) => u.id === id)!), email })
    applyAccounts(db, [stored('QCU-PROF-IT', 'prof.it@qcu.edu.ph'), stored('QCU-STU-IT-A', 'foxtrot.demo@qcu.edu.ph'), stored('CCS-DEAN', 'dean@qcu.edu.ph')])
    expect(db.users.find((u) => u.id === 'QCU-PROF-IT')?.email).toBe(seedEmail('QCU-PROF-IT'))
    expect(db.users.find((u) => u.id === 'CCS-DEAN')?.email).toBe('dean@access-ccs.com')
    // A real address set later (the Dean's real account, a student's real email) is kept.
    expect(db.users.find((u) => u.id === 'QCU-STU-IT-A')?.email).toBe('foxtrot.demo@qcu.edu.ph')
  })
})
