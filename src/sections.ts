// Campuses and section names (#46, decided 11 November 2026). CCS runs on three QCU campuses. San Bartolome (SB) has
// 1st to 4th year; the satellite campuses Batasan (BAT) and San Francisco (SF) have 1st and 2nd year only, and their
// students move to San Bartolome for 3rd year. A section is named campus + program + year + section letter:
// SBIT1A, BATIT1A, SFIT1A, SBCS3B, SFIS2A.

export const campuses = [
  { code: 'SB', name: 'San Bartolome', years: [1, 2, 3, 4] },
  { code: 'BAT', name: 'Batasan', years: [1, 2] },
  { code: 'SF', name: 'San Francisco', years: [1, 2] },
] as const
export type CampusCode = (typeof campuses)[number]['code']
export const campusCodes = campuses.map((c) => c.code) as [CampusCode, ...CampusCode[]]
/** The main campus. Students and sections stored before campuses existed are at San Bartolome. */
export const mainCampus: CampusCode = 'SB'

/** BSIT -> IT, BSCS -> CS, BSIS -> IS. */
export const programCode = (program: string) => program.replace(/^BS/, '')

export function sectionName(section: { campus?: string; program: string; year: number; section: string }) {
  return `${section.campus ?? mainCampus}${programCode(section.program)}${section.year}${section.section}`
}

/** Returns a message when the campus does not have that year level, otherwise undefined. */
export function campusYearProblem(campus: string, year: number) {
  const known = campuses.find((c) => c.code === campus)
  if (!known) return 'Choose SB (San Bartolome), BAT (Batasan) or SF (San Francisco).'
  if (!(known.years as readonly number[]).includes(year)) return `${known.name} has 1st and 2nd year only. 3rd and 4th year sections are at San Bartolome.`
  return undefined
}
