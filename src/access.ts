import type { Role, User } from './schemas.js'
import type { Database, Report, Space, Thread } from './store.js'

export const permissionRoles: Record<string, Role[]> = {
  'feed.read': ['student','organization','professor','staff','chair','dean','administrator','guidance','osas','secretary'],
  'post.create': ['student','organization','professor','chair','dean','guidance','osas'], 'post.anonymous': ['student'], 'announcement.publish': ['organization','professor','chair','dean'],
  'message.send': ['student','professor','chair','dean','guidance','osas'], 'roster.view': ['student','organization','professor','chair','dean'], 'calendar.view': ['student','organization','professor','chair','dean','guidance','osas'], 'todo.manage': ['student'], 'consultation.request': ['student'], 'consultation.decide': ['professor'],
  'report.create': ['student'], 'report.viewOwn': ['student'], 'case.view': ['professor','chair','dean','guidance','osas'], 'case.act': ['professor','chair','dean','guidance','osas'], 'case.convert': ['guidance'], 'cluster.review': ['chair'], 'analytics.view': ['chair','dean'],
  'evaluation.fill': ['student','professor'], 'evaluation.review': ['professor'], 'evaluation.configure': ['dean'], 'evaluation.results': ['professor','chair','dean'], 'offense.view': ['chair','dean','guidance','osas'], 'goodmoral.review': ['guidance','osas'], 'restriction.manage': ['administrator','guidance','osas'], 'standing.viewOwn': ['student'], 'moderation.review': ['administrator'], 'moderation.referral': ['secretary'], 'role.manage': ['administrator'], 'audit.view': ['administrator'],
  'directory.view': ['student','organization','professor','staff','chair','dean','administrator','guidance','osas','secretary'], 'self.manage': ['student','organization','professor','staff','chair','dean','administrator','guidance','osas','secretary'], 'assistant.use': ['student','organization','professor','staff','chair','dean','administrator','guidance','osas','secretary'],
  // Account provisioning has no page; it is the /api/accounts routes. The Dean activates the secretary, who creates every other account.
  'account.activateSecretary': ['dean'], 'account.provision': ['secretary'],
}
export const pagePermissions: Record<string, string[]> = {
  P01: ['self.manage'], P02: ['self.manage'], P03: ['self.manage'], P04: ['feed.read'], P05: ['post.create'], P06: ['feed.read'], P07: ['roster.view'], P08: ['roster.view'], P09: ['directory.view'], P10: ['directory.view'], P11: ['message.send'], P12: ['message.send'], P13: ['calendar.view'], P14: ['consultation.request','consultation.decide'], P15: ['consultation.request'], P16: ['consultation.request','consultation.decide'], P17: ['consultation.decide'], P18: ['report.viewOwn'], P19: ['report.create'], P20: ['report.viewOwn'], P21: ['case.view'], P22: ['case.view'], P23: ['cluster.review'], P24: ['cluster.review'], P25: ['analytics.view'], P26: ['evaluation.fill','evaluation.results','evaluation.configure'], P27: ['evaluation.fill'], P28: ['evaluation.results'], P29: ['evaluation.results'], P30: ['evaluation.configure'], P31: ['evaluation.configure'], P32: ['evaluation.review'], P33: ['offense.view'], P34: ['offense.view'], P35: ['restriction.manage'], P36: ['standing.viewOwn'], P37: ['directory.view'], P38: ['directory.view'], P39: ['self.manage'], P40: ['self.manage'], P41: ['assistant.use'], P42: ['self.manage'], P43: ['self.manage'], P44: ['self.manage'], P45: ['audit.view'], P46: ['role.manage'], P47: ['role.manage'], P48: ['role.manage'], P49: ['moderation.review','moderation.referral'], P50: ['moderation.review','moderation.referral'], P51: ['audit.view'], P52: ['audit.view'],
}
export const pageTitles: Record<string, string> = { P01:'ACCS',P02:'Sign in',P03:'Home',P04:'Feed',P05:'New post',P06:'Discussion',P07:'Classes and sections',P08:'Class space',P09:'Organizations',P10:'Organization',P11:'Messages',P12:'Conversation',P13:'Calendar',P14:'Consultations',P15:'Faculty availability',P16:'Consultation request',P17:'My availability',P18:'My reports',P19:'New report',P20:'Report',P21:'Case queue',P22:'Case workspace',P23:'Similar reports',P24:'Group review',P25:'Analytics',P26:'Evaluations',P27:'Evaluation form',P28:'Evaluation results',P29:'Faculty results',P30:'Evaluation cycles',P31:'Cycle editor',P32:'Review questions',P33:'Student records',P34:'Student record',P35:'Restrictions',P36:'My standing',P37:'Personnel directory',P38:'Profile',P39:'My profile',P40:'Notifications',P41:'Assistant',P42:'Help',P43:'Settings',P44:'Notification priorities',P45:'Administration',P46:'Users and roles',P47:'User assignment',P48:'Permission matrix',P49:'Moderation',P50:'Moderation review',P51:'Audit trail',P52:'Monitoring' }
export function hasRole(user: User, ...roles: Role[]) { return user.roles.some(role => roles.includes(role)) }
export function hasPermission(user: User, permission: string) { return !!permissionRoles[permission]?.some(role => user.roles.includes(role)) && !user.restrictions.includes(permission) }
export function permissions(user: User) { return Object.keys(permissionRoles).filter(key => hasPermission(user,key)) }
export function canPage(user: User, pageId: string) {
  if ((pageId === 'P07' || pageId === 'P08') && !hasRole(user,'student','professor','chair','dean')) return false
  return !!pagePermissions[pageId]?.some(key => hasPermission(user,key))
}
export function allowedPages(user: User) { return Object.keys(pagePermissions).filter(pageId => canPage(user,pageId)) }
export function canSpace(user: User, space: Space) { return hasRole(user,'dean') || hasRole(user,'chair') && user.program === space.program || hasRole(user,'professor') && space.professorIds.includes(user.id) || hasRole(user,'student') && space.studentIds.includes(user.id) }
export function isOrganizationMember(db: Database, user: User, organizationId: string) { return db.organizations.some(org => org.id === organizationId && (org.representativeId === user.id || org.memberIds.includes(user.id))) }
export function canAudience(db: Database, user: User, audience: string, privateContent = false) {
  if (audience === 'college') return true
  if (audience === 'faculty') return hasRole(user,'professor','chair','dean','administrator')
  const [kind,id] = audience.split(':')
  if (kind === 'program') return user.program === id || hasRole(user,'dean','administrator')
  if (kind === 'space') { const space = db.spaces.find(s => s.id === id); return !!space && (hasRole(user,'administrator') || canSpace(user,space)) }
  if (kind === 'organization') return !privateContent || isOrganizationMember(db,user,id!)
  return false
}
export function canPublish(db: Database, user: User, audience: string, announcement: boolean, operation: 'create' | 'comment' | 'react' = 'create') {
  const participant = operation === 'create' ? user : { ...user, restrictions: user.restrictions.filter(key => key !== 'post.create') }
  if (operation === 'comment' && user.restrictions.includes('post.comment')) return false
  if (!hasPermission(participant, announcement ? 'announcement.publish' : 'post.create') || !canAudience(db,user,audience,audience.startsWith('organization:'))) return false
  if (!announcement) {
    const space = db.spaces.find(s => audience === `space:${s.id}`)
    if (hasRole(user,'student') && (audience === 'college' || audience === `program:${user.program}` || !!space?.studentIds.includes(user.id) || audience.startsWith('organization:') && isOrganizationMember(db,user,audience.split(':')[1]!))) return true
    if (hasRole(user,'organization') && audience === `organization:${user.organizationId}`) return true
    if (hasRole(user,'professor') && (audience === 'faculty' || !!space?.professorIds.includes(user.id))) return true
    if (hasRole(user,'chair') && (audience === 'faculty' || audience === `program:${user.program}`)) return true
    if (hasRole(user,'dean') && ['college','faculty'].includes(audience)) return true
    return hasRole(user,'guidance','osas') && audience === 'college'
  }
  if (hasRole(user,'dean') && audience === 'college') return true
  if (hasRole(user,'chair') && audience === `program:${user.program}`) return true
  if (hasRole(user,'organization') && audience === `organization:${user.organizationId}`) return true
  const space = db.spaces.find(s => audience === `space:${s.id}`)
  return hasRole(user,'professor') && !!space?.professorIds.includes(user.id)
}
export function canReach(db: Database, user: User, target: User) {
  if (user.id === target.id || !hasPermission(user,'message.send') || !target.active) return false
  const targetFaculty = hasRole(target,'professor','chair','dean')
  const shared = db.spaces.some(space => (space.studentIds.includes(user.id) || space.professorIds.includes(user.id)) && (space.studentIds.includes(target.id) || space.professorIds.includes(target.id)))
  if (hasRole(user,'student') && (hasRole(target,'student') || hasRole(target,'professor')) && shared) return true
  if (hasRole(user,'professor') && (targetFaculty || hasRole(target,'student') && shared)) return true
  if (hasRole(user,'chair') && targetFaculty && user.program === target.program) return true
  if (hasRole(user,'dean') && targetFaculty) return true
  if (hasRole(user,'guidance','osas') && targetFaculty) {
    const relevantPrograms = db.reports.filter(r => hasRole(user,'guidance') ? ['guidance','osas'].includes(r.stage) : r.stage === 'osas').map(r=>r.program)
    return !!target.program && relevantPrograms.includes(target.program)
  }
  return false
}
export function canThread(db: Database, user: User, thread: Thread) {
  if (!hasPermission(user,'message.send') || !thread.memberIds.includes(user.id)) return false
  if (thread.spaceId) { const space = db.spaces.find(s=>s.id===thread.spaceId); return !!space && (hasRole(user,'student') && space.studentIds.includes(user.id) || hasRole(user,'professor') && space.professorIds.includes(user.id)) }
  const other = db.users.find(u => thread.memberIds.includes(u.id) && u.id !== user.id)
  return !!other && canReach(db,user,other)
}
// A concern about the adviser never reaches the adviser, whatever stage it is at.
export function isConflicted(user: User, report: Report) { return report.involvedUserIds.includes(user.id) || (report.bypassed || report.aboutAdvisor) && report.adviserId === user.id }
// Baseline of 10 November 2026: the Program Chair has access to every concern of their program and the Dean to every concern of
// the college, without the student's permission. The student's old allowChair / allowDean answers no longer decide anything.
const chairMay = (user: User, report: Report) => hasRole(user,'chair') && user.program === report.program
const deanMay = (user: User, report: Report) => hasRole(user,'dean')
/** The Program Chair (own program) and the Dean oversee every concern in scope, whatever stage it is at. */
export function overseesCase(user: User, report: Report) { return report.ownerId !== user.id && !isConflicted(user,report) && (chairMay(user,report) || deanMay(user,report)) }
/** Overseers read the full concern unless the adviser marked it confidential; then they see its status only. */
export function canReadCase(user: User, report: Report) { return overseesCase(user,report) && report.confidential !== true }
export function canActCase(user: User, report: Report) {
  if (isConflicted(user,report) || report.ownerId === user.id) return false
  return report.stage === 'adviser' && hasRole(user,'professor') && report.adviserId === user.id || report.stage === 'chair' && chairMay(user,report) || report.stage === 'dean' && deanMay(user,report) || report.stage === 'guidance' && hasRole(user,'guidance') || report.stage === 'osas' && hasRole(user,'osas')
}
/** For counts that span every stage (analytics): the reports this person's office may see, whichever stage they are at. */
export function canCountCase(user: User, report: Report) { return overseesCase(user,report) }
/** Who handles a stage: the adviser of the report, the Program Chair of its program, the Dean, Guidance, OSAS. */
function handlesStage(user: User, report: Report, stage: Report['stage']) {
  return stage === 'adviser' ? hasRole(user,'professor') && report.adviserId === user.id : stage === 'chair' ? chairMay(user,report) : stage === 'dean' ? deanMay(user,report) : hasRole(user,stage)
}
/** An office the case has moved past: it handled a stage in the history that is not the current one. It keeps the status updates (#30). */
export function isEarlierHandler(user: User, report: Report) {
  if (report.ownerId === user.id || isConflicted(user,report) || canActCase(user,report)) return false
  return report.history.some(entry => entry.stage !== report.stage && handlesStage(user,report,entry.stage))
}
export function canViewCase(user: User, report: Report) { return report.ownerId !== user.id && !isConflicted(user,report) && (canActCase(user,report) || overseesCase(user,report) || isEarlierHandler(user,report) || report.history.some(entry => entry.actorId === user.id && entry.actorRole !== 'student' && user.roles.includes(entry.actorRole as Role) && (entry.actorRole !== 'chair' || user.program === report.program))) }
export function canStudentRecord(db: Database, user: User, student: User) { return hasRole(student,'student') && (hasRole(user,'dean') || hasRole(user,'chair') && user.program === student.program || hasRole(user,'guidance') && db.reports.some(r => r.ownerId === student.id && ['guidance','osas'].includes(r.stage)) || hasRole(user,'osas') && db.reports.some(r=>r.ownerId === student.id && r.stage === 'osas')) }
export function canFacultyResult(user: User, faculty: User) { return hasRole(user,'dean') || hasRole(user,'chair') && user.program === faculty.program || hasRole(user,'professor') && user.id === faculty.id }
export function scopeLabel(user: User) { return hasRole(user,'administrator') ? 'Platform administration' : hasRole(user,'chair') ? `${user.program} program` : hasRole(user,'dean') ? 'College of Computer Studies' : user.office || [user.program,user.section && `Section ${user.section}`].filter(Boolean).join(' · ') || 'Your permitted workspace' }
