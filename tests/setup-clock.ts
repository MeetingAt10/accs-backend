import { vi } from 'vitest'

// The suite runs on the day after the seed data was written (src/store.ts, 20 October 2026), so seeded open times and
// events are still ahead and the rules about the past (no booking or opening a time that has passed) can be tested
// whatever the real date is. Only Date is faked, and the clock keeps moving; tests that set their own time still can.
vi.useFakeTimers({ toFake: ['Date'], shouldAdvanceTime: true })
vi.setSystemTime(new Date('2026-10-21T00:00:00.000Z'))
