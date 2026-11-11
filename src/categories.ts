// Concern categories and sub-categories (decided 11 November 2026). The student picks a category and then a sub-category
// from dropdowns, so every concern says specifically what it is about. "Other (please specify)" has no sub-categories; the
// student describes it in a short text instead. `studentOnStudent` marks concerns about another student's behaviour.

export type ConcernCategory = { label: string; description: string; studentOnStudent: boolean; subcategories: readonly string[]; requiresDetail?: boolean }

export const otherCategory = 'Other (please specify)'

export const concernCategories: readonly ConcernCategory[] = [
  { label: 'Bullying', description: 'Repeated hurtful behaviour by another student, in person.', studentOnStudent: true, subcategories: ['Name-calling or insults', 'Exclusion or isolation', 'Spreading rumours', 'Physical bullying', 'Intimidation or threats', 'Damaging or taking belongings', 'Other bullying'] },
  { label: 'Cyberbullying', description: 'Hurtful behaviour by another student online: chats, posts, social media.', studentOnStudent: true, subcategories: ['Hurtful messages or comments', 'Posting photos or videos without consent', 'Impersonation or fake accounts', 'Sharing private information', 'Exclusion from online groups', 'Other online behaviour'] },
  { label: 'Harassment', description: 'Unwanted conduct, including sexual harassment.', studentOnStudent: true, subcategories: ['Verbal harassment', 'Sexual harassment', 'Stalking or following', 'Unwanted contact or messages', 'Other harassment'] },
  { label: 'Discrimination', description: 'Unfair treatment because of who someone is.', studentOnStudent: true, subcategories: ['Gender or sexual orientation', 'Religion', 'Disability', 'Ethnicity or origin', 'Economic status', 'Other discrimination'] },
  { label: 'Threat or violence', description: 'Physical harm, threats, or a safety emergency.', studentOnStudent: true, subcategories: ['Physical assault', 'Threat of harm', 'Weapon', 'Risk of self-harm', 'Safety emergency', 'Other threat'] },
  { label: 'Faculty or staff conduct', description: 'A concern about a professor or an employee.', studentOnStudent: false, subcategories: ['Unprofessional behaviour', 'Unfair grading or treatment', 'Absence or lateness', 'Inappropriate remarks', 'Other conduct concern'] },
  { label: 'Academic concern', description: 'Grades, classes, requirements and schedules.', studentOnStudent: false, subcategories: ['Grades', 'Class schedule or section', 'Requirements or deadlines', 'Enrollment or subjects', 'Teaching or class quality', 'Other academic concern'] },
  { label: 'Personal or emotional concern', description: 'Stress, anxiety, family or other personal problems.', studentOnStudent: false, subcategories: ['Stress or anxiety', 'Family problems', 'Financial difficulty', 'Health concern', 'Relationship problems', 'Other personal concern'] },
  { label: 'Facilities', description: 'Rooms, laboratories, equipment and the network.', studentOnStudent: false, subcategories: ['Classroom or laboratory', 'Equipment or computers', 'Internet or network', 'Restrooms or cleanliness', 'Safety hazard', 'Other facilities concern'] },
  { label: otherCategory, description: 'Anything else. Describe it in a few words.', studentOnStudent: false, subcategories: [], requiresDetail: true },
]

// The categories the current filing screen still offers. They are accepted without a sub-category until the screen switches
// to the dropdowns above, then removed. ("Facilities" is in both lists; without a sub-category it is taken as the old one.)
export const legacyCategories: readonly string[] = ['General concern', 'Academic process', 'Facilities', 'Communication']

export type CategoryChoice = { category: string; subcategory?: string; categoryDetail?: string }

/** Returns a message when the choice is not valid, otherwise undefined. */
export function categoryProblem({ category, subcategory, categoryDetail }: CategoryChoice): { path: string; message: string } | undefined {
  const known = concernCategories.find((c) => c.label === category)
  if (!known) {
    if (legacyCategories.includes(category) && !subcategory && !categoryDetail) return undefined
    return { path: 'category', message: 'Choose a category from the list.' }
  }
  if (known.requiresDetail) {
    if (subcategory) return { path: 'subcategory', message: 'This category has no sub-categories.' }
    if (!categoryDetail?.trim()) return { path: 'categoryDetail', message: 'Describe the concern in a few words.' }
    return undefined
  }
  // "Facilities" without a sub-category is the old category, accepted until the screen switches.
  if (!subcategory && legacyCategories.includes(category) && !categoryDetail) return undefined
  if (!subcategory) return { path: 'subcategory', message: 'Choose a sub-category.' }
  if (!known.subcategories.includes(subcategory)) return { path: 'subcategory', message: 'Choose a sub-category from the list.' }
  if (categoryDetail) return { path: 'categoryDetail', message: 'Only "Other (please specify)" takes a description.' }
  return undefined
}
