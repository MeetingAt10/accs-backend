// Appointment categories and sub-categories (decided 11 November 2026). "Consultations" are called appointments, and the
// student picks what the appointment is for from two dropdowns, so the professor knows before the meeting. "Other (please
// specify)" takes a short description instead of a sub-category. "Concern follow-up" is set by the concern flow when a
// student books a time to talk about a filed concern; it cannot be picked by hand.

export type AppointmentCategory = { label: string; description: string; subcategories: readonly string[]; requiresDetail?: boolean; system?: boolean }

export const otherAppointment = 'Other (please specify)'
export const concernFollowUp = { category: 'Concern follow-up', subcategory: 'Talk about a concern' } as const

export const appointmentCategories: readonly AppointmentCategory[] = [
  { label: 'Academic advising', description: 'Your studies as a whole, with your adviser.', subcategories: ['Grades or standing', 'Subject load or enrollment', 'Requirements or deadlines', 'Shifting or program change', 'Study plan', 'Other academic advising'] },
  { label: 'Class or subject', description: 'A class you are taking with this professor.', subcategories: ['Lesson clarification', 'Project or assignment', 'Exam or quiz review', 'Grade inquiry', 'Missed class or make-up work', 'Other class concern'] },
  { label: 'Thesis or capstone', description: 'Your thesis or capstone project.', subcategories: ['Topic or proposal', 'Progress check', 'Manuscript review', 'Defense preparation', 'Other thesis or capstone concern'] },
  { label: 'Career or internship', description: 'Your plans after a subject or after graduation.', subcategories: ['Internship or OJT', 'Career advice', 'Recommendation letter', 'Scholarship or competition', 'Other career concern'] },
  { label: 'Documents and signatures', description: 'Forms, clearances and signatures.', subcategories: ['Clearance signature', 'Form or certificate', 'Excuse letter', 'Other document'] },
  { label: 'Personal concern', description: 'Something personal you want to talk about.', subcategories: ['Stress or well-being', 'Family or financial situation', 'Attendance or health', 'Other personal concern'] },
  { label: concernFollowUp.category, description: 'Set when you book a time from a concern you filed.', subcategories: [concernFollowUp.subcategory], system: true },
  { label: otherAppointment, description: 'Anything else. Describe it in a few words.', subcategories: [], requiresDetail: true },
]

export type AppointmentChoice = { purpose?: string; category?: string; subcategory?: string; details?: string }

/** Returns a message when the choice is not valid, otherwise undefined. A purpose alone (the current booking screen) is still accepted. */
export function appointmentProblem({ purpose, category, subcategory, details }: AppointmentChoice): { path: string; message: string } | undefined {
  if (!category) {
    if (subcategory || details) return { path: 'category', message: 'Choose what the appointment is for.' }
    if (!purpose?.trim()) return { path: 'category', message: 'Choose what the appointment is for.' }
    return undefined
  }
  const known = appointmentCategories.find((c) => c.label === category)
  if (!known) return { path: 'category', message: 'Choose a category from the list.' }
  if (known.system) return { path: 'category', message: 'Book a time for a concern from the concern page.' }
  if (known.requiresDetail) {
    if (subcategory) return { path: 'subcategory', message: 'This category has no sub-categories.' }
    if (!details?.trim()) return { path: 'details', message: 'Describe what the appointment is for in a few words.' }
    return undefined
  }
  if (!subcategory) return { path: 'subcategory', message: 'Choose a sub-category.' }
  if (!known.subcategories.includes(subcategory)) return { path: 'subcategory', message: 'Choose a sub-category from the list.' }
  return undefined
}

/** The short purpose shown on lists: the sub-category, or the description for "Other". */
export function purposeOf({ purpose, category, subcategory, details }: AppointmentChoice) {
  if (!category) return purpose!.trim()
  return category === otherAppointment ? details!.trim() : subcategory!
}
