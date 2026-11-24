import { findFlaggedWord } from './profanity.js'
import { z } from 'zod'
import { categoryProblem, concernCategories } from './categories.js'
import { campusYearProblem, mainCampus, sectionName } from './sections.js'
import { materialFileTypes, materialMaxBytes, messageFileMaxBytes, messageFileTypes, safeFileName, uploadUrlSeconds, type MaterialStorage } from './material-storage.js'
import { ulid } from './ids.js'
import { appointmentCategories, appointmentProblem, concernFollowUp, purposeOf, type AppointmentChoice } from './appointments.js'
import { reactionKinds, type ReactionKind, loadRowSchema, materialUploadSchema, messageUploadSchema, actionPayloads, announcementPriorities, postLabels, programs, roleLabels, roles, type ActionRequest, type PageQuery, type User } from './schemas.js'
import { allowedPages, ownOrganizationId, roleHas, lockedPermissions, setApprovedOverrides, canActCase, earlierConsent, canAudience, canReadCase, isEarlierHandler, overseesCase, canCountCase, canFacultyResult, canPage, canPublish, canReach, canSpace, canStudentRecord, canThread, canViewCase, hasPermission, hasRole, isOrganizationMember, pageTitles, permissionRoles, permissions, scopeLabel } from './access.js'
import { consentWording } from './consent.js'
import { route, rosterFor } from './escalation/engine.js'
import { escalationConfig } from './escalation/lexicon.js'
import { assign } from './escalation/similarity.js'
import type { Attachment, Material, Space, Assignment, Consultation, Cycle, Database, Message, Moderation, PermissionOverride, Post, Report, Repository, Slot, Stage, Strike, Thread, UnitOfWork } from './store.js'

// Who a faculty member may report: own classes; a Chair also their program; the Dean the whole college.
function canReportStudent(db: Database, user: User, student: User) { return student.active && hasRole(student, 'student') && (hasRole(user, 'dean') || hasRole(user, 'chair') && user.program === student.program || db.spaces.some(sp => sp.professorIds.includes(user.id) && sp.studentIds.includes(student.id))) }

export class ApiError extends Error { constructor(public status: number, message: string, public code = 'FORBIDDEN') { super(message) } }
export const unavailable = () => new ApiError(404, "This record isn't available to you.", 'UNAVAILABLE')
export const deny = () => new ApiError(403, "This action isn't available to your role.", 'FORBIDDEN')
export const conflict = (message: string) => new ApiError(409, message, 'CONFLICT')
const now = () => new Date().toISOString()
/** Campus date and time (Manila, UTC+8, no daylight saving), for rules about the past: "2026-11-16" and "14:05". */
export const campusNow = () => { const t = new Date(Date.now() + 8 * 3_600_000).toISOString(); return { date: t.slice(0, 10), time: t.slice(11, 16) } }
/** True when a campus date (and start time) has already begun. */
const hasBegun = (date: string, start = '00:00') => { const n = campusNow(); return date < n.date || date === n.date && start <= n.time }
/** A date and time someone picked has already come; one written without an offset is campus time. */
const isPastMoment = (value: string) => {
  const at = Date.parse(/(Z|[+-]\d\d:\d\d)$/.test(value) ? value : value + '+08:00')
  return at <= Date.now()
}
/** A report says when it happened or that it is ongoing (no single date); a date is never in the future. */
const checkIncidentDate = (p: { occurredOn?: string; ongoing?: boolean }) => {
  if (p.occurredOn && p.occurredOn > campusNow().date) throw dateIssue('occurredOn', 'Choose today or an earlier date: it cannot be in the future.')
  if (!p.occurredOn && !p.ongoing) throw dateIssue('occurredOn', 'Choose when it happened, or mark it as ongoing.')
}
// Frees every slot an office meeting for this report blocked (C12), whoever held it.
const releaseMeetingSlots = (db: Database, reportId: string) => {
  for (const s of db.slots) if (s.state === 'unavailable' && s.reason === `Meeting for report ${reportId}`) { s.state = 'open'; delete s.reason }
}
const dateIssue = (path: string, message: string) => new z.ZodError([{ code: 'custom', path: [path], message, input: undefined }])
const offices: Record<Stage,string> = { adviser:'Adviser',chair:'Program Chair',dean:'Dean',guidance:'Guidance Office',osas:'OSAS',executive:"President's Office" }
const stageRoles: Record<Stage,string> = { adviser:'professor',chair:'chair',dean:'dean',guidance:'guidance',osas:'osas',executive:'president' }
// A case's status is its step (decided 20 November 2026, replacing "Escalated to <office>" of 16 November): Submitted,
// Read, Escalated, Resolved or Closed, the same five steps the student's progress shows. The office is given separately
// (`office`), so a report at Submitted no longer reads "Escalated to Adviser". A case file shows as one by its type and
// CF reference.
const statusFor = (report: Report): string => report.status === 'Draft' ? 'Draft' : progressSteps[progressFor(report).step]
const daysBetween = (from: string, to: string) => Math.max(0, (Date.parse(to) - Date.parse(from)) / 86400000)
/** When the report entered its current stage: the first entry of the last unbroken run of history entries in that stage. */
function stageEnteredAt(report: Report) {
  let at = report.createdAt
  for (let i = report.history.length - 1; i >= 0 && report.history[i]!.stage === report.stage; i--) at = report.history[i]!.at
  return at
}
/** Median rounded to one decimal, or undefined for no values. */
function median(values: number[]) {
  if (!values.length) return undefined
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  const value = sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2
  return Math.round(value * 10) / 10
}
/** Opened and resolved counts per week (weeks start Monday, UTC), from the first week with activity to the last. */
function weeklyTrend(opened: string[], resolved: string[]) {
  const weekOf = (iso: string) => { const d = new Date(iso); d.setUTCHours(0, 0, 0, 0); d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7)); return d.getTime() }
  const all = [...opened, ...resolved].map(weekOf)
  if (!all.length) return []
  const week = 7 * 86400000
  const rows: { label: string; opened: number; resolved: number }[] = []
  for (let start = Math.min(...all); start <= Math.max(...all); start += week) {
    rows.push({
      label: new Date(start).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' }),
      opened: opened.filter((at) => weekOf(at) === start).length,
      resolved: resolved.filter((at) => weekOf(at) === start).length,
    })
  }
  return rows
}
function requirePermission(user: User, key: string) { if (!hasPermission(user,key)) throw deny() }
const referredStatus = 'Referred to the CCS Secretary'
/** The CCS Secretary dismisses a referred flag or sends it on to OSAS, which decides it (decided 19 November 2026). */
const osasStatus = 'Sent to OSAS'
/** Moderators see every item; the CCS Secretary sees items referred to them, and OSAS items sent to it, including ones they have decided. */
const canSeeModeration = (user: User, m: { history: { decision: string }[] }) =>
  hasPermission(user,'moderation.review') || hasPermission(user,'moderation.referral') && m.history.some(entry => entry.decision === 'refer') || hasPermission(user,'moderation.osas') && m.history.some(entry => entry.decision === 'osas')
// Flagged content is hidden until it is reviewed (#43, baseline chapter 10.4). While a post, comment or message has a
// moderation item that is Pending (a user's flag or a word-filter match) or referred to the CCS Secretary, only its author
// and the people reviewing it see it: moderators, and the Secretary once it is referred. "Keep" shows it again.
const heldStatuses = ['Pending', referredStatus, osasStatus]
/** The decisions this person may make on the item now, in the order the page offers them. */
function moderationDecisions(user: User, m: Moderation) {
  if (m.status === referredStatus) return hasPermission(user,'moderation.referral') ? ['dismiss', 'osas'] : []
  if (m.status === osasStatus) return hasPermission(user,'moderation.osas') ? ['keep', 'remove', 'warn'] : []
  if (m.status !== 'Pending' || !hasPermission(user,'moderation.review')) return []
  return ['keep', 'remove', 'warn', ...(m.source === 'User' ? ['refer'] : [])]
}
function heldItem(db: Database, itemType: Moderation['itemType'], itemId: string) { return db.moderation.find(m => m.itemType === itemType && m.itemId === itemId && heldStatuses.includes(m.status)) }
function canSeeItem(db: Database, user: User, itemType: Moderation['itemType'], itemId: string, authorId: string) {
  const held = heldItem(db, itemType, itemId)
  return !held || authorId === user.id || hasPermission(user, 'moderation.review') || hasPermission(user, 'moderation.referral') && held.status === referredStatus
}
function requireRole(user: User, ...roleNames: User['roles']) { if (!hasRole(user,...roleNames)) throw deny() }
function find<T extends {id:string}>(items:T[], id:string|undefined):T { const item = items.find(entry=>entry.id===id); if (!item) throw unavailable(); return item }
function pick<T extends {id:string}>(items:T[], id?:string):T|undefined { return id ? find(items,id) : items[0] }
/** A report named by its report ID or, once Guidance opened one, its Case File number (CF-...). */
const reportIdOf = (db:Database, id?:string) => id && db.reports.find(r => r.caseFileId === id && !db.reports.some(other => other.id === id))?.id || id
function reasonOf(request:ActionRequest) { return z.string().trim().min(1,'A reason is required.').max(2000).parse(request.reason) }
export function refreshRestrictions(db: Database, user: User): User { const date = now().slice(0,10); return { ...user, restrictions:[...new Set(db.restrictions.filter(r=>r.studentId===user.id&&r.active&&r.until>=date).flatMap(r=>r.features))] } }
export function sessionView(user:User) { return { user, permissions:permissions(user),allowedPages:allowedPages(user),roleLabels } }
function person(user:User) { return { id:user.id,photo:user.photo,name:user.name,email:user.email,roles:user.roles,program:user.program,/* Only a student has a section and a year level (QA v5): a stale one on another account is not shown. */section:hasRole(user,'student')?user.section:undefined,...(hasRole(user,'student')?{campus:user.campus??mainCampus,...(user.program&&user.year&&user.section?{sectionName:sectionName({campus:user.campus,program:user.program,year:user.year,section:user.section})}:{})}:{}),office:user.office,title:user.title,bio:user.bio,education:user.education,...(hasRole(user,'student')?{}:{officeHours:user.officeHours}),studentId:user.studentId,year:hasRole(user,'student')?user.year:undefined,standing:user.restrictions.length?'Some features paused':'Good standing' } }
/** Whether a student is irregular: shown on the account and record pages, not on profiles. */
const irregularOf = (user:User) => hasRole(user,'student')&&user.irregular?{irregular:true}:{}
function author(db:Database,id:string,anonymous=false,alias='Student A-12') { const u=db.users.find(item=>item.id===id); return anonymous ? {name:alias,roles:['student'],anonymous:true} : u?{id:u.id,name:u.name,roles:u.roles,email:u.email,...(u.photo?{photo:u.photo}:{})}:{name:'College office',roles:[]} }
/** Where a sender's upload is stored. Only the sender's own uploads can be attached, because the key starts with their ID. */
// Under materials/, the one prefix the API role may use in the files bucket (accs-architecture api.yaml).
const messageFileKey=(userId:string,id:string,fileName:string)=>`materials/messages/${userId}/${id}/${safeFileName(fileName)}`
/** A file as people see it: never its storage key. */
const attachmentView=({key:_key,...shown}:Attachment)=>shown
/** A direct conversation started from Messages is stored under the recipient's name; each person sees the other one's name instead. */
function threadTitle(db:Database,thread:Thread,user:User){
  if(thread.spaceId||thread.group||thread.memberIds.length!==2)return thread.title
  const names=thread.memberIds.map(id=>db.users.find(u=>u.id===id)?.name)
  if(!names.includes(thread.title))return thread.title
  const other=thread.memberIds.find(id=>id!==user.id)
  return (other&&db.users.find(u=>u.id===other)?.name)||thread.title
}
/** The last line shown in the conversation list: the words, or the file when only a file was sent. */
const messagePreview=(message?:Message)=>!message?'':message.deleted?'Message deleted':message.body||(message.attachments?.length?`Sent ${message.attachments.length===1?message.attachments[0]!.fileName:`${message.attachments.length} files`}`:'')
function messageView(db:Database,message:Message,report?:Report,viewerStage=report?.stage) { return {id:message.id,body:message.deleted?'':message.body,at:message.at,...(message.editedAt?{editedAt:message.editedAt}:{}),...(message.deleted?{deleted:true}:{}),...(message.attachments?.length&&!message.deleted?{attachments:message.attachments.map(attachmentView)}:{}),author:author(db,message.authorId,!!report&&message.authorId===report.ownerId&&report.identity==='anonymous'&&!report.disclosedTo.includes(viewerStage!),report?.alias)} }
/** Everyone's reaction to a post or comment: the old single reaction counts as "like" (#86). */
function reactionsOf(item: { reactions?: string[]; reactionsBy?: Record<string, ReactionKind> }): Record<string, ReactionKind> {
  return { ...Object.fromEntries((item.reactions ?? []).map(id => [id, 'like' as ReactionKind])), ...(item.reactionsBy ?? {}) }
}
/** Counts per reaction, and the viewer's own. */
function reactionView(item: { reactions?: string[]; reactionsBy?: Record<string, ReactionKind> }, user: User) {
  const all = reactionsOf(item)
  const counts = Object.fromEntries(reactionKinds.map(kind => [kind, Object.values(all).filter(value => value === kind).length]))
  return { reactionCounts: counts, myReaction: all[user.id] ?? null, reactionCount: Object.keys(all).length, reacted: user.id in all }
}
/** Sets, changes, or (choosing the same one again) removes the person's reaction, and moves old reactions into the new map. */
function toggleReaction(item: { reactions?: string[]; reactionsBy?: Record<string, ReactionKind> }, userId: string, reaction: ReactionKind) {
  const all = reactionsOf(item)
  if (all[userId] === reaction) delete all[userId]
  else all[userId] = reaction
  item.reactionsBy = all
  if ('reactions' in item) item.reactions = []
}
function postView(db: Database, post: Post, user: User) {
  return {
    id: post.id,
    title: post.removed ? 'This content was removed.' : post.title,
    body: post.removed ? 'This content was removed.' : post.body,
    audience: post.audience,
    kind: post.kind,
    label: post.label,
    priority: post.priority,
    anonymous: post.anonymous,
    private: post.private,
    at: post.at,
    updatedAt: post.updatedAt,
    eventDate: post.eventDate,
    eventTime: post.eventTime,
    eventPlace: post.eventPlace,
    eventContact: post.eventContact,
    notifyMembers: post.notifyMembers,
    ...(post.attachments?.length && !post.removed ? { attachments: post.attachments.map(attachmentView) } : {}),
    author: author(db, post.authorId, post.anonymous),
    owned: post.authorId === user.id,
    ...reactionView(post, user),
    // Same rule as the react action, so the feed list can show the button per post.
    canReact: !post.removed && canPublish(db, user, post.audience, false, 'react'),
    commentCount: post.comments.filter(comment => canSeeItem(db, user, 'comment', comment.id, comment.authorId)).length,
    comments: post.removed ? [] : post.comments.filter(comment => canSeeItem(db, user, 'comment', comment.id, comment.authorId)).map(comment => ({
      ...messageView(db, comment),
      ...reactionView(comment, user),
      author: author(db, comment.authorId, comment.anonymous),
      // Your own comment, anonymous or not, so the page can leave out "Report comment" for it.
      owned: comment.authorId === user.id,
      ...(heldItem(db, 'comment', comment.id) ? { underReview: true } : {}),
    })),
    removed: post.removed,
    ...(heldItem(db, 'post', post.id) ? { underReview: true } : {}),
  }
}
/** A report this faculty member filed about a student: they follow its status, never its notes or messages. */
const filedByFaculty = (user:User,report:Report) => report.source === 'faculty' && report.ownerId === user.id
/** Where the owner of a report reads it: a student on P20, a faculty member who filed one on P22. */
const ownerPage = (report:Report) => report.source === 'faculty' ? 'P22' : 'P20'
/**
 * The student's progress bar (decided 19 November 2026): Submitted, Read, Escalated, Resolved, Closed, instead of which
 * office has the report. Read is when a handling office first opened it; Escalated is any move past the first office.
 */
export const progressSteps = ['Submitted', 'Read', 'Escalated', 'Resolved', 'Closed'] as const
export function progressFor(report: Report) {
  const first = report.history[0]?.stage ?? report.stage
  const escalated = report.stage !== first || report.history.some(h => h.action === 'Transferred' || h.action === 'Escalated')
  const step = report.status === 'Closed' ? 4 : report.status === 'Resolved' ? 3 : escalated ? 2 : report.readAt ? 1 : 0
  return { steps: [...progressSteps], step, label: progressSteps[step], ...(escalated ? { escalatedTo: offices[report.stage] } : {}), ...(report.readAt ? { readAt: report.readAt } : {}) }
}
function reportView(db:Database,report:Report,user:User,owner=false) {
  const current=canActCase(user,report)
  if(filedByFaculty(user,report)){
    const student=report.reportedStudentId?db.users.find(u=>u.id===report.reportedStudentId):undefined
    return {id:report.id,caseFileId:report.caseFileId,source:'faculty',category:report.category,subcategory:report.subcategory,categoryDetail:report.categoryDetail,severity:report.severity,narrative:report.narrative,location:report.location,occurredOn:report.occurredOn,ongoing:report.ongoing,reportedStudent:student&&person(student),status:statusFor(report),stage:report.stage,office:offices[report.stage],program:report.program,createdAt:report.createdAt,updatedAt:report.updatedAt,statusOnly:true,timeline:report.history.filter(h=>h.public).map(h=>({at:h.at,action:h.action,office:offices[h.stage]})),statusNotice:`You filed this report. It is with ${offices[report.stage]}; you can follow its status here.`}
  }
  // Status only, never the statement, reporter, messages or notes: for the Program Chair and the Dean on a confidential
  // concern, and for an office the case has moved past (#30). Anyone else who appears in the history sees only their own entries.
  if(!owner&&!current&&!canReadCase(user,report)){
    const status={progress:progressFor(report),id:report.id,caseFileId:report.caseFileId,status:statusFor(report),stage:report.stage,office:offices[report.stage],program:report.program,createdAt:report.createdAt,updatedAt:report.updatedAt,statusOnly:true,timeline:report.history.filter(h=>h.public).map(h=>({at:h.at,action:h.action,office:offices[h.stage]}))}
    if(overseesCase(user,report)) return {...status,confidential:true,statusNotice:'The adviser marked this concern confidential. You can see its status only.'}
    if(isEarlierHandler(user,report)) return {...status,confidential:report.confidential===true,statusNotice:`This concern is now with ${offices[report.stage]}. You can follow its status here.`}
    return {id:report.id,caseFileId:report.caseFileId,status:statusFor(report),stage:report.stage,office:offices[report.stage],program:report.program,createdAt:report.createdAt,updatedAt:report.updatedAt,historyOnly:true,history:report.history.filter(h=>h.actorId===user.id).map(h=>({...h,actor:author(db,h.actorId)})),historyNotice:'You can see only your own entries on this report.'}
  }
  // A reader who is not the current handler sees the name only if the student shared it with the reader's own office.
  const viewerStage=current?report.stage:hasRole(user,'dean')?'dean':'chair'
  const showName=report.identity==='named'||!owner&&report.disclosedTo.includes(viewerStage)
  return {progress:progressFor(report),id:report.id,caseFileId:report.caseFileId,type:report.caseFileId?'Case File':'Report',category:report.category,subcategory:report.subcategory,categoryDetail:report.categoryDetail,severity:report.severity,status:statusFor(report),stage:report.stage,office:offices[report.stage],program:report.program,narrative:report.narrative,identity:report.identity,alias:report.alias,reporter:showName?author(db,report.ownerId):{name:report.alias,roles:['student'],anonymous:true},createdAt:report.createdAt,updatedAt:report.updatedAt,sourcePostId:report.sourcePostId,location:report.location,occurredOn:report.occurredOn,ongoing:report.ongoing,disclosedTo:owner?report.disclosedTo:undefined,bypassed:owner?undefined:report.bypassed,consent:report.consent&&{readStatement:true,at:report.consent.at,version:report.consent.version,wording:report.consent.wording},allowChair:!earlierConsent(report)||report.allowChair===true,allowDean:!earlierConsent(report)||report.allowDean===true,confidential:report.confidential===true,readOnly:!owner&&!current,aboutAdvisor:report.aboutAdvisor===true,talk:report.talk,history:report.history.filter(h=>!owner||h.public).map(h=>owner?{id:h.id,at:h.at,action:h.action,update:h.update,stage:h.stage,office:offices[h.stage],state:h.stage===report.stage?'current':'done'}:{...h,actorId:h.actorId===report.ownerId&&!showName?undefined:h.actorId,actor:author(db,h.actorId,h.actorId===report.ownerId&&!showName,report.alias)}),messages:report.messages.map(m=>messageView(db,m,report,owner?report.stage:viewerStage)),notes:owner?undefined:report.notes.map(m=>messageView(db,m)),allowedActions:owner?[]:caseActions(user,report),routing:owner?undefined:report.routing,...(report.source==='faculty'?{source:'faculty',reportedStudent:report.reportedStudentId?person(find(db.users,report.reportedStudentId)):undefined}:{}),...(!owner&&hasRole(user,'dean','osas')?{strikes:db.strikes.filter(s=>s.reportId===report.id).map(s=>strikeView(db,s)),canRecommendStrike:current&&report.stage==='dean'&&hasPermission(user,'strike.recommend'),strikeCandidates:current&&report.stage==='dean'&&hasPermission(user,'strike.recommend')?strikeCandidates(db,report):[],canDecideStrike:current&&report.stage==='osas'&&hasPermission(user,'strike.record')}:{})}
}
function caseActions(user:User,r:Report) { if(!canActCase(user,r))return[]; if(r.status==='Closed')return[]; if(r.status==='Resolved')return['close'];if(r.stage==='guidance'&&!r.caseFileId)return['convert'];return ['respond','recordAction',...(['guidance','osas'].includes(r.stage)?['milestone']:[]),'resolve',...(r.stage==='adviser'||r.stage==='chair'?['escalate']:r.stage==='dean'||r.stage==='guidance'||r.stage==='osas'?['transfer']:r.stage==='executive'?['return']:[])] }
/**
 * An appointment as people see it. Its time or a person on it can be gone (a time removed after the appointment was
 * declined, cancelled or completed): the appointment still shows, with the copied time, instead of failing the whole page
 * (Home, Calendar and Appointments all list appointments).
 */
function consultationView(db:Database,c:Database['consultations'][number],user:User) {
  const who=(id:string)=>{const u=db.users.find(x=>x.id===id);return u?person(u):{id,name:'Removed account',roles:[]}}
  const slot=db.slots.find(s=>s.id===c.slotId)
  return {...c,student:who(c.studentId),faculty:who(c.facultyId),slot:slot?slotView(user,slot):{id:c.slotId,facultyId:c.facultyId,date:c.slotDate??'',start:c.slotStart??'',end:c.slotEnd??'',state:'removed'}}
}
function assignmentView(db:Database,a:Assignment,receipt=false) { const cycle=find(db.cycles,a.cycleId); return {id:a.id,faculty:person(find(db.users,a.facultyId)),cycleId:a.cycleId,cycleTitle:cycle.title,relation:a.relation,subject:a.subject,due:cycle.closes,status:a.submittedAt?'Submitted':'Not started',submittedAt:a.submittedAt,questions:receipt?cycle.questions:undefined,instructions:receipt?cycle.instructions:undefined,cycleStatus:cycle.status,answers:receipt?a.answers:undefined,comment:receipt?a.comment:undefined} }
function resultViews(db:Database,user:User,cycleId?:string) { return db.users.filter(u=>hasRole(u,'professor','chair','dean')&&canFacultyResult(user,u)).map(faculty=>{// Assigned evaluations in published cycles, and the submitted ones among them; completion is the share submitted (QA 24 November: it was 100 or 0).
const assigned=db.assignments.filter(a=>a.facultyId===faculty.id&&(!cycleId||a.cycleId===cycleId)&&find(db.cycles,a.cycleId).resultsPublished);const entries=assigned.filter(a=>a.submittedAt);const ratings=entries.flatMap(a=>Object.values(a.answers??{}).filter((v):v is number=>typeof v==='number'));const criteria=['Q1','Q2','Q3'].map((id,index)=>{const values=entries.map(a=>a.answers?.[id]).filter((v):v is number=>typeof v==='number');return {label:['Clarity','Support','Fairness'][index],value:values.length?Number((values.reduce((s,n)=>s+n,0)/values.length).toFixed(2)):0}});
// Paper Fig 3.14 (restored 2026-11-24): the full faculty result (criteria, themes, follow-up notes) shows only once 100% of
// the faculty member's program has rated; until then the result is the faculty average only, with the counts.
const released=programAverageView(db,faculty.program,cycleId).released;const followUps=hasRole(user,'chair','dean')&&released?db.followUps.filter(f=>f.facultyId===faculty.id).map(f=>({id:f.id,note:f.note,at:f.at,author:person(find(db.users,f.actorId))})).sort((a,b)=>b.at.localeCompare(a.at)):[];
return {id:faculty.id,faculty:person(faculty),responses:entries.length,assigned:assigned.length,average:ratings.length?Number((ratings.reduce((s,n)=>s+n,0)/ratings.length).toFixed(2)):0,completion:assigned.length?Math.round(entries.length/assigned.length*100):0,released,criteria:released?criteria:[],themes:released&&entries.length?[{title:'Clear guidance',count:entries.length,summary:'Students describe the requirements as clear and say they get help when they ask.'}]:[],followUps,canFollowUp:released&&hasRole(user,'chair','dean')}}) }
/** Every evaluation assigned to the program's faculty in the published cycles in scope, submitted or not. */
function programAssignments(db:Database,program?:string,cycleId?:string) {
  const facultyIds = db.users
    .filter(user => hasRole(user,'professor','chair','dean') && (!program || user.program === program))
    .map(user => user.id)
  return db.assignments.filter(assignment =>
    facultyIds.includes(assignment.facultyId)
    && (!cycleId || assignment.cycleId === cycleId)
    && find(db.cycles,assignment.cycleId).resultsPublished
    && (isStudentForm(assignment) || !!assignment.submittedAt),
  )
}
// D-08 (approved 2026-11-10): evaluation is mandatory for clearance, so a program average is released only when every
// assigned evaluation in scope is submitted. Until then it carries the counts and no criteria.
function programAverageView(db:Database,program?:string,cycleId?:string) {
  const population = programAssignments(db,program,cycleId)
  const submitted = population.filter(assignment => assignment.submittedAt).length
  const released = population.length > 0 && submitted === population.length
  return { program: program ?? 'College', released, submitted, assigned: population.length, criteria: released ? programResultCriteria(db,program,cycleId) : [] }
}
function programResultCriteria(db:Database,program?:string,cycleId?:string) {
  const responses = programAssignments(db,program,cycleId).filter(assignment => assignment.submittedAt)
  return ['Q1','Q2','Q3'].map((questionId,index) => {
    const values = responses
      .map(assignment => assignment.answers?.[questionId])
      .filter((value): value is number => typeof value === 'number')
    return {
      label: ['Clarity','Support','Fairness'][index],
      value: values.length
        ? Number((values.reduce((sum,value) => sum + value,0) / values.length).toFixed(2))
        : 0,
    }
  })
}
function audit(repo:UnitOfWork,user:User,action:string,module:string,reference:string,purpose?:string,reason?:string) { const entry={id:repo.nextId('AUDIT'),at:now(),actorId:user.id,action,module,reference,result:'Recorded',...(purpose?{purpose}:{}),...(reason?{reason}:{})};repo.read().audit.push(entry);return entry }
// Categories nobody can mute: a person always hears about their own concern (decided 2026-11-10).
// Report, Case and Evaluation updates cannot be muted (baseline chapter 8; case and evaluation added for #42). A mute
// saved before a category became required is ignored.
export const requiredNotificationCategories: readonly string[] = ['report', 'case', 'evaluation', 'restriction']
/** Features a restriction can pause, in words people use. */
export const restrictionFeatureLabels: Record<string, string> = { 'post.create': 'Posting', 'post.comment': 'Commenting', 'report.anonymous': 'Anonymous reports' }
/** The administrator acted on a student's restrictions, so that student's waiting change requests are done. */
function closeReferrals(db: Database, studentId: string, user: User, outcome: string) { for (const referral of db.referrals.filter(r => r.studentId === studentId && r.status === 'Awaiting administrator review')) Object.assign(referral, { status: `Done: ${outcome}`, handledAt: now(), handledBy: user.id }) }
const featureWords = (features: string[]) => features.map(f => restrictionFeatureLabels[f] ?? f).join(', ')
const requiredCategoryLabels: Record<string,string> = { report: 'Report updates', case: 'Case updates', evaluation: 'Evaluation updates' }
/** Roles only the System Administrator assigns or removes, and whose accounts only the administrator changes. */
const privilegedRoles: readonly string[] = ['administrator','dean','secretary']
/** QA v5 C7: open cases first, then high severity first, then most recently updated; closed last. */
const severityRank:Record<string,number>={high:0,medium:1,low:2}
function byUrgency<T extends {status:string;severity?:string;updatedAt:string}>(rows:T[]){const closed=(r:T)=>['Resolved','Closed'].includes(r.status)?1:0;return [...rows].sort((a,b)=>closed(a)-closed(b)||(severityRank[a.severity??'medium']??1)-(severityRank[b.severity??'medium']??1)||b.updatedAt.localeCompare(a.updatedAt))}
/** `urgent` (an urgent announcement) reaches the recipient even if they muted its category. */
/**
 * Which roles one account may hold (QA 17 November; decided 19 and 20 November 2026; QA v5, D1). Every account holds at
 * most two roles. A student may also be a CCS student organization representative and nothing else; an organization
 * account holds no faculty or office role. Faculty are professors, who may also be the Dean or a Program Chair, one of
 * the two. The CCS Secretary, OSAS, Guidance and the System Administrator hold their role alone. `current` is what the
 * account holds now: a role change never turns a student into anyone else, or anyone else into a student, and a single
 * role the account already holds stays as it is (a Dean or Program Chair without Professor, CCS Staff, which is no
 * longer assigned). Only a student has a section, and a section is one letter, like A. Answers the problem in words, or
 * nothing when the roles are fine.
 */
const roleSets: readonly (readonly string[])[] = [['student'], ['student', 'organization'], ['organization'], ['professor'], ['professor', 'dean'], ['professor', 'chair'], ['secretary'], ['osas'], ['guidance'], ['administrator']]
const aloneRoles: readonly string[] = ['secretary', 'osas', 'guidance', 'administrator', 'staff']
export function rolesProblem(roles: readonly string[], section?: string, current: readonly string[] = []) {
  const unique = new Set(roles)
  if (unique.size !== roles.length) return 'Choose each role once.'
  if (unique.size > 2) return 'Choose at most two roles for one person, like Dean and professor.'
  if (unique.has('student') && [...unique].some(role => !['student', 'organization'].includes(role))) return 'A student can also be a CCS student organization representative, and nothing else. Their program and section say where they belong.'
  if (unique.has('organization') && [...unique].some(role => !['student', 'organization'].includes(role))) return 'An organization account can only be paired with the student role.'
  const same = (set: readonly string[]) => set.length === unique.size && set.every(role => unique.has(role))
  if (!roleSets.some(same) && !(unique.size === 1 && same(current))) {
    const alone = roles.find(role => aloneRoles.includes(role))
    if (alone && unique.size > 1) return `${roleLabels[alone as keyof typeof roleLabels]} is a single-role account: it can't be combined with another role.`
    return alone ? 'CCS Staff is no longer assigned.' : 'A Dean or Program Chair is also a Professor: choose Professor with one of them.'
  }
  if (current.length && current.includes('student') !== unique.has('student')) return current.includes('student') ? 'A student stays a student. They can also be a CCS student organization representative, and nothing else.' : "The Secretary creates student accounts: a role change can't make one."
  if (section && !unique.has('student')) return 'Only students have a section.'
  if (section && !/^[A-Za-z]$/.test(section.trim())) return 'Use the section letter, like A.'
  return undefined
}
/** An organization member as other members see them: name, role in the organization, and their section when they are a student. */
/** Active students to choose from (a President, a new member): name and section only. */
function studentChoices(db: Database, except: readonly string[] = []) {
  return db.users.filter(u => u.active && hasRole(u, 'student') && !except.includes(u.id)).sort((a, b) => a.name.localeCompare(b.name)).map(u => organizationMember(db, u.id, 'Student'))
}
function organizationMember(db: Database, id: string, organizationRole: string) {
  const u = find(db.users, id)
  const section = hasRole(u,'student') && u.program && u.year && u.section ? sectionName({ campus: u.campus ?? mainCampus, program: u.program, year: u.year, section: u.section }) : undefined
  return { id: u.id, name: u.name, organizationRole, ...(u.program ? { program: u.program } : {}), ...(section ? { section } : {}) }
}
/**
 * A professor's soonest open time that has not started (QA 19 November: the first open slot found was used, often a past
 * one, so the Appointments list was not in order of availability).
 */
/** Soonest open time first; no open time last. Not localeCompare on a "~" stand-in: it sorts "~" before digits. */
function byNextOpen(a?: { date: string; start: string }, b?: { date: string; start: string }) {
  if (!a || !b) return Number(!a) - Number(!b)
  const x = `${a.date}${a.start}`, y = `${b.date}${b.start}`
  return x < y ? -1 : x > y ? 1 : 0
}
function nextOpenSlot(db: Database, facultyId: string) {
  return db.slots.filter(s => s.facultyId === facultyId && s.state === 'open' && !hasBegun(s.date, s.start)).sort((a, b) => `${a.date}${a.start}`.localeCompare(`${b.date}${b.start}`))[0]
}
function notify(repo:UnitOfWork,recipientId:string,kind:string,pageId:string,recordId?:string,options:{urgent?:boolean;body?:string;itemId?:string}={}) {
  const db = repo.read()
  const stored = db.settings[recipientId]?.priorities[kind]
  // A mute saved before a category became required is ignored, not obeyed.
  const preference = stored === 'muted' && requiredNotificationCategories.includes(kind) ? undefined : stored
  if (preference === 'muted' && !options.urgent) return
  if (kind === 'message' && db.threads.find(thread => thread.id === recordId)?.mutedBy.includes(recipientId)) return
  const titles:Record<string,string> = {
    announcement: 'New college announcement',
    class: 'New post in your class',
    message: 'New message',
    consultation: 'Appointment request updated',
    report: 'Report update',
    case: 'Case update',
    evaluation: 'Evaluation update',
    restriction: 'Account features changed',
    role: 'Your role assignment changed',
    permission: 'Permission change request',
    moderation: 'Content review update',
  }
  db.notifications.push({
    id: repo.nextId('NOTIF'),
    recipientId,
    kind,
    title: kind === 'announcement' && options.urgent ? 'Urgent announcement' : titles[kind] ?? 'New update',
    body: options.body ?? 'Open this update to see the details.',
    priority: options.urgent ? 'high' : preference && preference !== 'muted' ? preference : (['report', 'case', 'restriction'].includes(kind) ? 'high' : 'normal'),
    pageId,
    recordId,
    at: now(),
    read: false,
    ...(options.itemId ? { itemId: options.itemId } : {}),
  })
}
/** A message held or removed by moderation stops showing its words in the notifications that previewed it. */
function redactNotices(db:Database,messageId:string) {
  for (const n of db.notifications) if (n.itemId === messageId) n.body = 'Open this update to see the details.'
}
/** What a message notification says: who wrote, where (for a group), and the start of the message. */
function messageNotice(sender:User,thread:Thread,body:string,held=false) {
  const words=held?'':body.replace(/\s+/g,' ').trim()
  const preview=words.length>100?`${words.slice(0,99)}…`:words
  const who=thread.spaceId||thread.group?`${sender.name} in ${thread.title}`:sender.name
  return preview?`${who}: ${preview}`:held?`${who} sent a message.`:`${who} sent a file.`
}
function unreadMessages(db:Database,thread:Thread,user:User) {
  const readCount = Math.min(thread.messages.length, thread.readMessageCounts[user.id] ?? 0)
  return thread.messages.slice(readCount).filter(message => message.authorId !== user.id && canSeeItem(db, user, 'message', message.id, message.authorId)).length
}
/** Puts a new report in a similar-report group of its program, or opens a group of two. Confidential and finished reports stay out. */
function groupSimilar(repo:UnitOfWork,db:Database,r:Report) {
  if(r.confidential)return
  const open=db.reports.filter(x=>x.program===r.program&&!x.confidential&&!['Resolved','Closed'].includes(x.status)).map(x=>({id:x.id,text:x.narrative}))
  const groups=db.clusters.filter(c=>c.program===r.program&&c.status!=='Dismissed')
  const hit=assign({id:r.id,text:r.narrative},open,groups,escalationConfig.similarityThreshold)
  if(!hit)return
  const similarity=Math.round(hit.similarity*100)
  if(hit.groupIndex!==undefined){const c=groups[hit.groupIndex]!;c.reportIds.push(r.id);c.similarity=similarity;c.phrases=hit.phrases;c.supporting=`${c.reportIds.length} reports share these terms.`;return}
  db.clusters.push({id:repo.nextId('CLUSTER'),program:r.program,title:hit.phrases.slice(0,3).join(', ')||'Similar reports',reportIds:[hit.partnerId!,r.id],similarity,supporting:'2 reports share these terms.',dissenting:'None recorded yet.',phrases:hit.phrases,status:'To review',history:[]})
}
// A cluster's title and phrases come from its reports' words. They show only when the viewer may read every one of them:
// a report marked confidential, or one the viewer is involved in, keeps its words out (#31).
function clusterViewFor(db:Database,user:User,c:Database['clusters'][number]) {
  const readable=db.reports.filter(r=>c.reportIds.includes(r.id)).every(r=>canActCase(user,r)||canReadCase(user,r))
  return {...c,reportIds:undefined,...(readable?{}:{title:'Similar reports',phrases:[],supporting:`${c.reportIds.length} reports share some terms.`,dissenting:''})}
}
function handlerIds(db:Database,r:Report) { return db.users.filter(u=>u.active&&canActCase(u,r)).map(u=>u.id) }
/** Offices the case has moved past; they are told about every later step (#30). */
function earlierHandlerIds(db:Database,r:Report) { return db.users.filter(u=>u.active&&isEarlierHandler(u,r)).map(u=>u.id) }
const faq=[{id:'FAQ-1',question:'How do I book an appointment?',answer:'Open Appointments, pick one of your professors, choose what the appointment is for, and request an open time. The professor confirms or declines.',href:'/consultations',roles:['student']},{id:'FAQ-2',question:'What does anonymous reporting mean?',answer:'Your report stays linked to your verified account. Handlers see an alias until you choose to share your name with their office.',href:'/reports/new',roles:['student']},{id:'FAQ-3',question:'How are reports routed?',answer:'A report goes to the student\'s adviser first. If the report involves that adviser, it goes to the program chair instead. The program chair and the Dean can read every report in their scope, unless the adviser marks it confidential; then they see only its status. Each office decides the next step.',href:'/cases',roles:['professor','chair','dean','guidance','osas']},{id:'FAQ-4',question:'What can the assistant do?',answer:'It explains ACCS pages, your schedule, and the milestones on your own reports. It cannot decide cases or restrictions. Staff do that.',href:'/assistant',roles:roles as readonly string[]},{id:'FAQ-5',question:'Where do I find official contact details?',answer:'The directory lists faculty and staff offices and their QCU email addresses.',href:'/directory',roles:roles as readonly string[]},{id:'FAQ-6',question:'What still works when features are paused?',answer:'You can still read announcements and class information, use the assistant, and message your professors.',href:'/standing',roles:['student']},{id:'FAQ-7',question:'What does a moderation flag mean?',answer:'A flag asks a moderator to read the post in context. It does not mean anyone did something wrong, and it does not restrict anyone.',href:'/admin/moderation',roles:['administrator']},{id:'FAQ-8',question:'How are roles assigned?',answer:'The CCS Secretary creates student and faculty accounts and names the advisers and Program Chairs. The Dean activates the Secretary account. The Secretary and the System Administrator change roles. A student can also be a CCS student organization representative. Faculty are professors and can also be the Dean or a Program Chair, one of the two, and each program has one Program Chair. The CCS Secretary, OSAS, Guidance and the System Administrator hold that role only.',href:'/help',roles:['student','organization','professor','staff','chair','dean','administrator','guidance','osas','secretary']}]
function notificationCategories(user:User){return ['announcement',...(hasRole(user,'student')?['class']:[]),...(hasPermission(user,'message.send')?['message']:[]),...(hasRole(user,'student','professor')?['consultation']:[]),...(hasRole(user,'student','professor','chair','dean','guidance','osas','president')?['report','case']:[]),...(hasPermission(user,'evaluation.fill')||hasPermission(user,'evaluation.configure')?['evaluation']:[]),...(hasRole(user,'administrator')||hasPermission(user,'moderation.referral')?['moderation']:[])]}
function filteredFaq(user:User){return faq.filter(entry=>entry.roles.some(role=>user.roles.includes(role as User['roles'][number])))}
// Three unsettled strikes hold a student's clearance until OSAS records the settlement (#34). Settled strikes stay on the
// record and do not count again; strikes recorded after a settlement start a new count. A strike counts once OSAS confirms
// the Dean's recommendation; a stored strike without a status was recorded by OSAS before that rule and counts.
export const strikeLimit = 3
const confirmed = (s:Strike) => (s.status ?? 'confirmed') === 'confirmed'
function clearanceOf(db:Database,studentId:string) {
  const settled = new Set(db.strikeSettlements.filter(s=>s.studentId===studentId).flatMap(s=>s.strikeIds))
  const strikes = db.strikes.filter(s=>s.studentId===studentId&&confirmed(s))
  const unsettled = strikes.filter(s=>!settled.has(s.id))
  return { onHold: unsettled.length >= strikeLimit, unsettledStrikes: unsettled.length, totalStrikes: strikes.length, limit: strikeLimit, unsettled }
}
const clearanceView = (db:Database,studentId:string) => { const { unsettled: _unsettled, ...view } = clearanceOf(db,studentId); return view }
function strikeViews(db:Database,studentId:string) {
  const settled = new Set(db.strikeSettlements.filter(s=>s.studentId===studentId).flatMap(s=>s.strikeIds))
  return db.strikes.filter(s=>s.studentId===studentId).map(s=>strikeView(db,s,settled))
}
/** The students a concern names that the Dean may recommend a strike against: never the student who filed it. */
function strikeCandidates(db:Database,report:Report) {
  return report.involvedUserIds.filter(id=>id!==report.ownerId).map(id=>db.users.find(u=>u.id===id)).filter((u):u is User=>!!u&&hasRole(u,'student')).map(person)
}
function strikeView(db:Database,s:Strike,settled=new Set<string>()) {
  const r=db.reports.find(item=>item.id===s.reportId)
  const status=s.status??'confirmed'
  return {id:s.id,kind:s.kind,status,note:s.note,at:s.at,caseReference:r?.caseFileId??s.reportId,student:person(find(db.users,s.studentId)),settled:settled.has(s.id),recommendedBy:s.status?author(db,s.actorId):undefined,recordedBy:author(db,s.status?s.decidedBy??s.actorId:s.actorId),decidedAt:s.decidedAt,decisionNote:s.decisionNote}
}
function restrictionViews(db:Database,user:User,studentId?:string) {
  const today = now().slice(0, 10)
  return db.restrictions
    .filter(r => (!studentId || r.studentId === studentId) && (hasRole(user,'administrator') || r.studentId === user.id || canStudentRecord(db,user,find(db.users,r.studentId))))
    .map(r => ({ ...r, active: r.active && r.until >= today, student: person(find(db.users,r.studentId)), authorizer: author(db,r.actorId) }))
}
// Entries whose actor is the reporting student, who may be anonymous to the people reading the trail.
const studentActions=['Identity disclosed','Report submitted','Report consent recorded','Talk consent recorded','Reporter message sent']
/** Audit entries as staff see them, newest first (QA 17 November: the oldest came first in every list). The trail is kept in the order things happened. */
/**
 * A person's unsent messages, by conversation (decided 20 November 2026). They live in `drafts` beside the report draft,
 * under their own key so the two never overwrite each other.
 */
function messageDraftsOf(db: Database, user: User): MessageDrafts
function messageDraftsOf(db: Database, user: User, create: false): MessageDrafts | undefined
function messageDraftsOf(db: Database, user: User, create = true) {
  const key = `${user.id}:messages`
  if (!create) return db.drafts[key] as MessageDrafts | undefined
  return (db.drafts[key] ??= {}) as MessageDrafts
}
type MessageDrafts = Record<string, { body: string; attachments: unknown[]; at: string }>
/** A stored permission change; a proposal saved before approvals existed (a bare boolean) reads as waiting. */
function overrideOf(value: PermissionOverride | boolean | undefined): PermissionOverride {
  if (typeof value === 'boolean') return { proposal: { allowed: value, by: '', at: '' }, decisions: [] }
  return value ? { ...value, decisions: value.decisions ?? [] } : { decisions: [] }
}
/** The approved permission changes in force, "role:permission" -> allowed (access.ts applies them). */
export function approvedOverrides(db: Pick<Database, 'permissionOverrides'>) {
  return Object.fromEntries(Object.entries(db.permissionOverrides ?? {}).flatMap(([key, value]) => {
    const override = overrideOf(value)
    return override.approved === undefined ? [] : [[key, override.approved] as const]
  }))
}
/** Who decides an administrator's request: the CCS Secretary (QA v5 D2). */
function permissionDeciders(db: Database, proposer: User) {
  const deciders = db.users.filter(u => u.active && u.id !== proposer.id && hasPermission(u, 'permission.review'))
  const secretaries = deciders.filter(u => hasRole(u, 'secretary'))
  return secretaries.length ? secretaries : deciders
}
/**
 * The audit references of a student's records: the student ID, and the QCU-2024-0101 form it had before the 00-0000
 * format (19 November 2026), which entries written before then still carry (code review, 23 November 2026).
 */
export function studentReferences(student: Pick<User,'id'|'studentId'>) {
  const current = student.studentId ?? student.id
  const parts = /^(\d{2})-(\d{4})$/.exec(current)
  return parts ? [current, `QCU-20${parts[1]}-${parts[2]}`] : [current]
}
function safeAudit(db:Database,entries:Database['audit']) {return [...entries].reverse().sort((a,b)=>b.at.localeCompare(a.at)).map(entry=>{const confidentialStudent=studentActions.includes(entry.action);return {...entry,actorId:confidentialStudent?undefined:entry.actorId,reason:['cases','reports','records'].includes(entry.module)?undefined:entry.reason,actor:confidentialStudent?{name:'Verified student',roles:['student']}:author(db,entry.actorId)}})}
function defaultSettings(user: User) {
  const compactRoles: User['roles'] = ['administrator', 'chair', 'dean', 'guidance', 'osas', 'president']
  return {
    theme: 'system',
    density: hasRole(user, ...compactRoles) ? 'compact' : 'comfortable',
    priorities: { report: 'high', case: 'high', message: 'normal', consultation: 'normal', evaluation: 'normal', announcement: 'normal' },
  }
}
/** How many people an organization has: its representative and its members, each once. */
const organizationSize=(o:{representativeId:string;memberIds:string[]})=>new Set([o.representativeId,...o.memberIds]).size
function visiblePosts(db:Database,user:User,q?:string) { return db.posts.filter(post=>canAudience(db,user,post.audience,post.private)&&canSeeItem(db,user,'post',post.id,post.authorId)&&(!q||`${post.title} ${post.body}`.toLowerCase().includes(q.toLowerCase()))) }
function visibleEvents(db: Database, user: User) {
  return db.events.filter(event => {
    const source = event.postId ? db.posts.find(post => post.id === event.postId) : undefined
    return (!event.postId || !!source && !source.removed && canSeeItem(db, user, 'post', source.id, source.authorId))
      && (!event.audience || canAudience(db, user, event.audience, event.private))
  // A contact whose account is not active has no profile to open, so the event names none ("isn't available" before).
  }).map(event => db.users.some(u => u.id === event.contactId && u.active) ? event : { ...event, contactId: '' })
}
function validateFeedScope(db: Database, user: User, scope?: string) {
  if (!scope) return
  const parts = scope.split(':')
  const [kind, id] = parts
  const resourceScope = parts.length === 2
  const exists = scope === 'college'
    || scope === 'faculty'
    || resourceScope && kind === 'program' && programs.includes(id as typeof programs[number])
    || resourceScope && kind === 'space' && db.spaces.some(space => space.id === id)
    || resourceScope && kind === 'organization' && db.organizations.some(organization => organization.id === id)
  if (!exists || !canAudience(db, user, scope, kind === 'organization')) throw unavailable()
}
function spaceThreadId(db: Database, user: User, spaceId: string) {
  return db.threads.find(thread => thread.spaceId === spaceId && canThread(db, user, thread))?.id
}
function syncPostEvent(repo: UnitOfWork, post: Post) {
  const db = repo.read()
  const previous = db.events.find(event => event.postId === post.id)
  db.events = db.events.filter(event => event.postId !== post.id)
  if (post.removed || post.kind !== 'announcement' || !post.eventDate || !post.eventTime) return
  db.events.push({
    id: previous?.id ?? repo.nextId('EVENT'),
    postId: post.id,
    title: post.title,
    description: post.body,
    date: post.eventDate,
    start: post.eventTime,
    type: post.audience.startsWith('organization:') ? 'Organization' : 'Class',
    contactId: post.authorId,
    audience: post.audience,
    private: post.private,
    organizationId: post.audience.startsWith('organization:') ? post.audience.split(':')[1] : undefined,
    place: post.eventPlace,
    contact: post.eventContact,
  })
}
/** A class space's name as people see it: "SBIT3A", or "SBIT3A - CC 104 Data Structures" for a subject. */
function spaceName(space: Space) {
  const parts = space.title.split(',')
  const code = (parts.length > 1 ? parts[parts.length - 1]! : space.title).trim()
  return !space.title.includes(',') || /^section group$/i.test(space.subject) ? code : `${code} - ${space.subject}`
}
/** A professor's post in a class space tells its students. An announcement already sent to members is not sent twice. */
function notifyClassPost(repo: UnitOfWork, post: Post) {
  if (post.anonymous || post.kind === 'announcement' && post.notifyMembers) return
  const [kind, id] = post.audience.split(':')
  if (kind !== 'space') return
  const db = repo.read()
  const space = db.spaces.find(item => item.id === id)
  if (!space || !space.professorIds.includes(post.authorId)) return
  const author = db.users.find(u => u.id === post.authorId)
  for (const recipient of db.users.filter(u => u.active && u.id !== post.authorId && space.studentIds.includes(u.id))) {
    if (!canAudience(db, recipient, post.audience, post.private)) continue
    notify(repo, recipient.id, 'class', 'P06', post.id, { body: `${author?.name ?? 'Your professor'} posted in ${spaceName(space)}: ${post.title}`, urgent: post.priority === 'urgent' })
  }
}
function notifyAnnouncementMembers(repo: UnitOfWork, post: Post) {
  // An urgent or important announcement reaches everyone in its audience, whether or not "Notify members" was ticked
  // (decided 19 November 2026). Urgent also gets past a muted category; the open portal shows either within seconds.
  const urgent = post.priority === 'urgent'
  const everyone = urgent || post.priority === 'important'
  if (post.kind !== 'announcement' || !post.notifyMembers && !everyone) return
  const db = repo.read()
  const [kind, id] = post.audience.split(':')
  const space = db.spaces.find(item => item.id === id)
  for (const recipient of db.users.filter(user => user.active && user.id !== post.authorId)) {
    const member = post.audience === 'college'
      || post.audience === 'faculty' && hasRole(recipient, 'professor', 'chair', 'dean', 'secretary')
      || kind === 'program' && recipient.program === id
      || kind === 'space' && !!space && [...space.studentIds, ...space.professorIds].includes(recipient.id)
      || kind === 'organization' && isOrganizationMember(db, recipient, id!)
    if (member && canAudience(db, recipient, post.audience, post.private)) {
      notify(repo, recipient.id, 'announcement', 'P06', post.id, urgent ? { urgent, body: `Urgent: ${post.title}` } : everyone ? { body: `Important: ${post.title}` } : {})
    }
  }
}
/**
 * Holds a post, comment or message that contains a flagged word (#84, src/profanity.ts) for a moderator: a pending
 * moderation item from the Filter, which hides it from everyone but its author until someone decides (#43).
 */
function autoFlag(repo: UnitOfWork, item: { itemType: Moderation['itemType']; itemId: string; parentId: string; authorId: string; text: string }) {
  const word = findFlaggedWord(item.text)
  if (!word) return false
  const db = repo.read()
  if (db.moderation.some(entry => entry.itemType === item.itemType && entry.itemId === item.itemId && heldStatuses.includes(entry.status))) return true
  db.moderation.push({
    id: repo.nextId('MOD'),
    itemType: item.itemType,
    itemId: item.itemId,
    parentId: item.parentId,
    authorId: item.authorId,
    source: 'Filter',
    reason: 'Automatic: possible offensive language. A moderator must review it.',
    excerpt: item.text.slice(0, 160),
    status: 'Pending',
    at: now(),
    history: [],
  })
  return true
}
function queuePostReview(repo: UnitOfWork, post: Post) {
  autoFlag(repo, { itemType: 'post', itemId: post.id, parentId: post.id, authorId: post.authorId, text: `${post.title}\n${post.body}` })
}
function visibleConsultations(db:Database,user:User){return db.consultations.filter(c=>c.studentId===user.id&&hasRole(user,'student')||c.facultyId===user.id&&hasRole(user,'professor'))}
// Why a time is not available is for the faculty member and the CCS Secretary only (#32). Students do not see unavailable
// times at all, only the times they can book or already asked for; others see the time without the reason.
function slotView(user:User,slot:Slot){if(slot.facultyId===user.id||hasRole(user,'secretary'))return slot;const {reason:_reason,...rest}=slot;return rest}
const slotsFor=(user:User,slots:Slot[])=>slots.filter(s=>(!hasRole(user,'student')||s.state!=='unavailable')&&(s.facultyId===user.id||s.state!=='open'||!hasBegun(s.date,s.start))).map(s=>slotView(user,s))
// Faculty load (#39). A class blocks open consultation times on its weekday between the term's dates.
const weekdays = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'] as const
const weekdayOf = (date:string) => weekdays[new Date(`${date}T00:00:00Z`).getUTCDay()]!
function classAt(db:Database,facultyId:string,date:string,start:string,end:string) { const day=weekdayOf(date); return db.loadSchedules.find(c=>c.facultyId===facultyId&&c.day===day&&c.startsOn<=date&&date<=c.endsOn&&c.start<end&&start<c.end) }
const isFaculty = (u:User) => u.active && hasRole(u,'professor','chair','dean')
// Subjects and class materials (#44, baseline 6.3). A section space lists the subject spaces of the same section, each
// with its professors. A subject's materials are for its professors and its students only, not for other offices.
const isSectionSpace = (space:Space) => space.subject === 'Section group'
function subjectsOf(db:Database,section:Space) { return db.spaces.filter(s=>!isSectionSpace(s)&&s.program===section.program&&s.section===section.section&&(s.campus??'SB')===(section.campus??'SB')&&(s.year===undefined||section.year===undefined||s.year===section.year)) }
const teachesSubject = (user:User,space:Space) => hasRole(user,'professor','chair','dean') && space.professorIds.includes(user.id)
const opensMaterials = (user:User,space:Space) => teachesSubject(user,space) || hasRole(user,'student') && space.studentIds.includes(user.id)
// A file shows to students once its upload is confirmed; its professors also see pending ones. The storage key stays inside.
function materialsFor(db:Database,user:User,space:Space) { if(!opensMaterials(user,space))return undefined; const teacher=teachesSubject(user,space); return db.materials.filter(m=>m.spaceId===space.id&&(m.kind==='link'||m.status==='ready'||teacher)).map(({key:_key,comments,...m})=>({...m,author:author(db,m.authorId),comments:(comments??[]).map(c=>({...messageView(db,c),canDelete:c.authorId===user.id||teacher})),...(m.kind==='file'&&m.status==='ready'?{downloadUrl:`/api/materials/${encodeURIComponent(m.id)}/file`}:{})})) }
function visibleSlots(db:Database,user:User){return slotsFor(user,db.slots.filter(s=>s.facultyId===user.id||hasRole(user,'dean','chair')||canReach(db,user,find(db.users,s.facultyId))))}
/** One request per time: the rule for a student's appointment request and for a time booked to talk about a concern. */
function reserveSlot(repo:UnitOfWork,studentId:string,slot:Slot,choice:AppointmentChoice,reportId?:string):Consultation {
  const db=repo.read()
  if(hasBegun(slot.date,slot.start))throw conflict('That time has passed. Pick a later time.')
  if(slot.state!=='open'||db.consultations.some(c=>c.slotId===slot.id&&!['Declined','Cancelled','Completed'].includes(c.status)))throw conflict('That time was just taken. Pick another time.')
  // A time opened before the faculty load was uploaded may now be during a class (#39): it cannot be booked.
  if(classAt(db,slot.facultyId,slot.date,slot.start,slot.end))throw conflict('The faculty member has a class at that time. Pick another time.')
  slot.state='requested'
  const at=now()
  const c:Consultation={id:repo.nextId('CONSULT'),studentId,facultyId:slot.facultyId,slotId:slot.id,slotDate:slot.date,slotStart:slot.start,slotEnd:slot.end,...(reportId?{reportId}:{}),purpose:purposeOf(choice),...(choice.category?{category:choice.category}:{}),...(choice.subcategory?{subcategory:choice.subcategory}:{}),...(choice.details?.trim()?{details:choice.details.trim()}:{}),status:'Requested',createdAt:at,updatedAt:at,history:[{at,status:'Requested',note:'Request received',actorId:studentId}]}
  db.consultations.push(c)
  notify(repo,slot.facultyId,'consultation','P16',c.id)
  return c
}
/**
 * The top search (decided 16 November 2026: "best and scalable"): one query over what this person may open, posts, class
 * spaces, people, cases and student records, each group filtered by the same rules as its own page and capped at a few
 * results. It never searches report narratives, and a confidential case the reader may not read shows no category.
 * Records link to the list filtered by the student, because opening a record asks for a reason and is logged.
 */
export function search(repo:Repository,user:User,q:string){
  const needle=q.trim().toLowerCase()
  const limit=5
  return repo.view(unit=>{
    const db=unit.read();attachPhotos(db)
    const has=(text:string)=>text.toLowerCase().includes(needle)
    const posts=canPage(user,'P04')?visiblePosts(db,user).filter(p=>!p.removed&&has(`${p.title} ${p.body}`)).sort((a,b)=>b.at.localeCompare(a.at)).slice(0,limit).map(p=>({id:p.id,title:p.title,sub:p.kind==='announcement'?'Announcement':p.label,href:`/feed/${encodeURIComponent(p.id)}`})):[]
    const spaces=canPage(user,'P07')?db.spaces.filter(s=>canSpace(user,s)&&has(`${s.title} ${s.subject} ${spaceName(s)}`)).slice(0,limit).map(s=>({id:s.id,title:spaceName(s),sub:s.program,href:`/spaces/${encodeURIComponent(s.id)}`})):[]
    const people=canPage(user,'P37')?db.users.filter(u=>u.active&&!hasRole(u,'student','organization')&&has(`${u.name} ${u.office??''} ${u.program??''}`)).slice(0,limit).map(u=>({id:u.id,title:u.name,sub:u.title||u.office||'',href:`/people/${encodeURIComponent(u.id)}`})):[]
    const handler=canPage(user,'P21')
    const reportsFound=(handler?db.reports.filter(r=>canViewCase(user,r)||filedByFaculty(user,r)):canPage(user,'P18')?db.reports.filter(r=>r.ownerId===user.id):[])
      .filter(r=>{const readable=r.ownerId===user.id||canReadCase(user,r);return has(`${r.id} ${r.caseFileId??''} ${readable?`${r.category} ${r.subcategory??''}`:''}`)})
      .sort((a,b)=>b.updatedAt.localeCompare(a.updatedAt)).slice(0,limit)
    const cases=reportsFound.map(r=>({id:r.id,title:r.ownerId===user.id||canReadCase(user,r)?r.category:'Confidential case',sub:`${r.caseFileId??r.id} · ${statusFor(r)}`,href:handler?`/cases/${encodeURIComponent(r.id)}`:`/reports/${encodeURIComponent(r.id)}`}))
    const records=canPage(user,'P33')?db.users.filter(u=>canStudentRecord(db,user,u)&&has(`${u.name} ${u.studentId??''}`)).slice(0,limit).map(u=>({id:u.id,title:u.name,sub:[u.studentId,u.program,u.section].filter(Boolean).join(' · '),href:`/records?q=${encodeURIComponent(u.studentId??u.name)}`})):[]
    return {query:q.trim(),groups:{posts,spaces,people,cases,records}}
  })
}
// P34 records every opening of a student record in the audit trail, so that one read has to commit.
export function getPage(repo:Repository,user:User,pageId:string,query:PageQuery={}) {
  const work=(unit:UnitOfWork)=>readPage(unit,user,pageId,query)
  // P22 commits too, only to stamp the first opening by a handling office (the Read step); nothing changes after that.
  return pageId==='P34'||pageId==='P22'?repo.transact(work):repo.view(work)
}
/** Puts each person's profile photo (#85) on the loaded accounts, so every view that shows a person can show it. */
function attachPhotos(db:Database) { for (const u of db.users) { const photo=db.photos?.[u.id]; if (photo) u.photo=photo; else delete u.photo } }
function readPage(repo:UnitOfWork,user:User,pageId:string,query:PageQuery={},internalRole=false) {
  if(!canPage(user,pageId))throw new ApiError(403,"This page isn't available to your role.")
  const db=repo.read(); attachPhotos(db); const data:Record<string,unknown>={}; const ownReports=byUrgency(db.reports.filter(r=>r.ownerId===user.id));const cases=byUrgency(db.reports.filter(r=>canViewCase(user,r)||filedByFaculty(user,r)));
  if (pageId === 'P04') validateFeedScope(db, user, query.scope)
  const labels = query.label?.split(',').map(label => label.trim()).filter(Boolean) ?? []
  const posts = visiblePosts(db, user, query.q).filter(post => (
    (!labels.length || labels.includes(post.label) || labels.includes('Announcements') && post.kind === 'announcement')
    && (!query.scope || post.audience === query.scope)
    && (!query.type || post.kind === query.type)
  ))
  const spaces=db.spaces.filter(s=>canSpace(user,s));// Professors to book; a student account never shows here, whatever roles it was given (QA 19 November).
  const faculty=db.users.filter(u=>hasRole(u,'professor')&&!hasRole(u,'student')&&canReach(db,user,u));
  const match=(value:string)=>!query.q||value.toLowerCase().includes(query.q.toLowerCase())
  switch(pageId){
    case'P01':data.redirect='/home';break
    case'P02':data.redirect='/home';break
    case'P03':{
      if(hasRole(user,'administrator'))data.redirect='/admin'
      const consultations=visibleConsultations(db,user);const assignments=db.assignments.filter(a=>a.evaluatorId===user.id&&['Published','Closed'].includes(find(db.cycles,a.cycleId).status))
      // Only cards for pages the role can open (QA 17 November: CCS Staff saw reports, appointments and evaluations).
      data.stats=([{page:hasRole(user,'student')?'P18':'P21',label:hasRole(user,'student')?'Active reports':'Reports in your queue',value:(hasRole(user,'student')?ownReports:cases).filter(r=>!['Resolved','Closed'].includes(r.status)).length,note:'Reports you can see'},{page:'P14',label:'Appointments',value:consultations.filter(c=>!['Completed','Declined','Cancelled'].includes(c.status)).length,note:'Requests and booked times'},{page:'P26',label:'Evaluations due',value:assignments.filter(a=>!a.submittedAt).length,note:'Forms assigned to you'},{page:'P40',label:'Unread updates',value:db.notifications.filter(n=>n.recipientId===user.id&&!n.read).length,note:'In your notifications'}]).filter(stat=>canPage(user,stat.page)).map(({page:_page,...stat})=>stat)
      Object.assign(data,{announcements:posts.filter(p=>p.kind==='announcement'&&!p.removed).slice(0,3).map(p=>postView(db,p,user)),posts:posts.filter(p=>!p.removed).slice(0,3).map(p=>postView(db,p,user)),events:visibleEvents(db,user), reports:hasRole(user,'student')?ownReports.slice(0,4).map(r=>reportView(db,r,user,true)):[],cases:cases.slice(0,4).map(r=>reportView(db,r,user)),consultations:canPage(user,'P14')?consultations.map(c=>consultationView(db,c,user)):[],assignments:canPage(user,'P26')?assignments.map(a=>assignmentView(db,a)):[],todos:db.todos.filter(t=>t.ownerId===user.id),notifications:db.notifications.filter(n=>n.recipientId===user.id).slice(0,5),sections:spaces.filter(s=>s.subject==='Section group').map(s=>({id:s.id,title:s.title,program:s.program,subject:s.subject})),roleSections:internalRole?[]:user.roles.map(role=>({role,title:roleLabels[role],description:scopeLabel({...user,roles:[role]}),...readPage(repo,{...user,roles:[role]},'P03',{},true).data}))});break}
    case'P04':Object.assign(data,{posts:posts.map(p=>postView(db,p,user)),spaces:spaces.map(s=>({id:s.id,title:s.title})),canPost:hasPermission(user,'post.create')});break
    case 'P05':
      Object.assign(data, {
        audiences: ['college', 'faculty', ...(user.program ? [`program:${user.program}`] : []), ...spaces.map(space => `space:${space.id}`), ...db.organizations.filter(organization => isOrganizationMember(db, user, organization.id)).map(organization => `organization:${organization.id}`)].filter(audience => canPublish(db, user, audience, false)),
        announcementAudiences: ['college', 'faculty', ...(user.program ? [`program:${user.program}`] : []), ...spaces.map(space => `space:${space.id}`), ...db.organizations.map(organization => `organization:${organization.id}`)].filter(audience => canPublish(db, user, audience, true)),
        anonymityAllowed: hasRole(user, 'student') && !user.restrictions.includes('post.create'),
        labels: postLabels,
        priorities: announcementPriorities,
      })
      break
    case'P06':{const p=pick(posts,query.id);if(p)data.record=postView(db,p,user);data.canComment=!!p&&canPublish(db,user,p.audience,false,'comment');data.canReact=!!p&&canPublish(db,user,p.audience,false,'react');data.ownedReports=ownReports.map(r=>({id:r.id,sourcePostId:r.sourcePostId}));break}
    case 'P07':
      data.spaces = spaces.filter(space => match(`${space.title} ${space.subject}`)).map(space => ({
        id: space.id,
        title: space.title,
        program: space.program,
        section: space.section,
        subject: space.subject,
        professors: space.professorIds.map(id => person(find(db.users, id))),
        studentCount: space.studentIds.length,
        threadId: spaceThreadId(db, user, space.id),
      }))
      break
    case 'P08': {
      const space = pick(spaces, query.id)
      if (space) {
        const academicRoster = hasRole(user, 'dean')
          || hasRole(user, 'chair') && user.program === space.program
          || hasRole(user, 'professor') && space.professorIds.includes(user.id)
        data.record = {
          id: space.id,
          title: space.title,
          program: space.program,
          section: space.section,
          subject: space.subject,
          professors: space.professorIds.map(id => person(find(db.users, id))),
          studentCount: space.studentIds.length,
          threadId: spaceThreadId(db, user, space.id),
          students: space.studentIds.map(id => {
            const student = refreshRestrictions(db, find(db.users, id))
            // D-08 (approved 2026-11-10): students see classmates' names and roles only.
            return academicRoster ? { ...person(student), enrollmentStatus: 'Enrolled' } : { name: student.name, roles: student.roles }
          }),
          academicRoster,
          // A section space lists its subjects; a subject space carries its own materials.
          subjects: isSectionSpace(space) ? subjectsOf(db, space).map(subject => ({ id: subject.id, title: subject.title, subject: subject.subject, professors: subject.professorIds.map(id => person(find(db.users, id))), materials: materialsFor(db, user, subject), canManageMaterials: teachesSubject(user, subject) })) : undefined,
          materials: isSectionSpace(space) ? undefined : materialsFor(db, user, space),
          canManageMaterials: !isSectionSpace(space) && teachesSubject(user, space),
        }
        data.posts = posts.filter(post => post.audience === `space:${space.id}`).map(post => postView(db, post, user))
        data.canPost = canPublish(db, user, `space:${space.id}`, false)
      }
      break
    }
    case'P09':data.organizations=db.organizations.filter(o=>match(o.name)).map(o=>({id:o.id,name:o.name,description:o.description,member:isOrganizationMember(db,user,o.id),memberCount:organizationSize(o)}))
      // The Secretary and the Dean create organizations, choosing a student as President (19 November 2026).
      if(hasPermission(user,'organization.create'))Object.assign(data,{canCreate:true,studentOptions:studentChoices(db)});break
    case 'P10': {
      const organization = pick(db.organizations, query.id)
      if (organization) {
        const member = isOrganizationMember(db, user, organization.id)
        data.record = {
          id: organization.id,
          name: organization.name,
          description: organization.description,
          member,
          representative: person(find(db.users, organization.representativeId)),
          memberCount: organizationSize(organization),
          // Each member with their id (the name opens their profile) and section, like SBIT3A (QA 19 November).
          members: member ? [
            organizationMember(db, organization.representativeId, organization.positions?.[organization.representativeId] ?? 'Officer'),
            // Each member's position, like President or VP for Information, set by the organization account (19 November 2026).
            ...organization.memberIds.map(id => organizationMember(db, id, organization.positions?.[id] ?? 'Member')),
          ] : [],
        }
        // The organization account adds and removes members and names their positions.
        data.canManageMembers = organization.representativeId === user.id
        if (data.canManageMembers) data.studentOptions = studentChoices(db, organization.memberIds)
        data.posts = posts.filter(post => post.audience === `organization:${organization.id}` || post.authorId === organization.representativeId && !post.private).map(post => postView(db, post, user))
        data.events = visibleEvents(db, user).filter(event => event.organizationId === organization.id)
        data.canPublish = organization.representativeId === user.id
        data.canPost = canPublish(db, user, `organization:${organization.id}`, false)
      }
      break
    }
    case 'P11':
    case 'P12': {
      // Most recent conversation first, direct and group alike (QA 17 November, V3: direct messages came first even when
      // a group had the newest message).
      const lastAt = (thread: Thread) => thread.messages.at(-1)?.at ?? ''
      const threads = db.threads.filter(thread => canThread(db, user, thread)).sort((a, b) => lastAt(b).localeCompare(lastAt(a)))
      data.threads = threads
        .filter(thread => match(threadTitle(db, thread, user)))
        .map(thread => ({
          id: thread.id,
          title: threadTitle(db, thread, user),
          kind: thread.spaceId || thread.group ? 'group' : 'direct',
          ...(thread.group ? { groupKind: 'people' } : thread.spaceId ? { groupKind: 'class' } : {}),
          members: thread.memberIds.map(memberId => person(find(db.users, memberId))),
          lastMessage: messagePreview(thread.messages.filter(message => canSeeItem(db, user, 'message', message.id, message.authorId)).at(-1)),
          updatedAt: thread.messages.at(-1)?.at,
          unread: unreadMessages(db, thread, user),
        }))
      data.recipients = db.users.filter(target => canReach(db, user, target)).map(person)
      if (pageId === 'P12') {
        const thread = pick(threads, query.id)
        if (thread) {
          data.record = {
            id: thread.id,
            title: threadTitle(db, thread, user),
            members: thread.memberIds.map(memberId => person(find(db.users, memberId))),
            messages: thread.messages.filter(message => canSeeItem(db, user, 'message', message.id, message.authorId)).map(message => ({ ...messageView(db, message), ...(heldItem(db, 'message', message.id) ? { underReview: true } : {}) })),
            muted: thread.mutedBy.includes(user.id),
            unread: unreadMessages(db, thread, user),
            kind: thread.spaceId || thread.group ? 'group' : 'direct',
            ...(thread.group ? { groupKind: 'people' } : thread.spaceId ? { groupKind: 'class' } : {}),
            // The reader's unsent message, kept on the server so a refresh or another device does not lose it.
            ...(messageDraftsOf(db, user, false)?.[thread.id] ? { draft: messageDraftsOf(db, user, false)![thread.id] } : {}),
            canAddMembers: !!thread.group && hasPermission(user, 'message.send'),
          }
        }
      }
      break
    }
    case'P13':Object.assign(data,{events:visibleEvents(db,user).filter(e=>!hasRole(user,'organization')||!e.organizationId||e.organizationId===ownOrganizationId(db,user)),slots:hasRole(user,'organization')?[]:visibleSlots(db,user),todos:db.todos.filter(t=>t.ownerId===user.id),consultations:visibleConsultations(db,user).map(c=>consultationView(db,c,user))});break
    case'P14':Object.assign(data,{appointmentCategories:appointmentCategories.filter(c=>!c.system),consultations:visibleConsultations(db,user).map(c=>consultationView(db,c,user)),faculty:faculty.filter(u=>match(u.name)).map(u=>({...person(u),nextSlot:nextOpenSlot(db,u.id)})).sort((a,b)=>byNextOpen(a.nextSlot,b.nextSlot)||a.name.localeCompare(b.name))});break
    case'P15':{data.appointmentCategories=appointmentCategories.filter(c=>!c.system);const f=pick(faculty,query.id);if(f){data.record=person(f);data.slots=slotsFor(user,db.slots.filter(s=>s.facultyId===f.id))}break}
    case'P16':{const c=pick(visibleConsultations(db,user),query.id);if(c)data.record=consultationView(db,c,user);break}
    case'P17':data.slots=db.slots.filter(s=>s.facultyId===user.id);data.load=db.loadSchedules.filter(c=>c.facultyId===user.id);break
    case'P54':{
      const terms=[...new Map(db.loadSchedules.map(c=>[c.term,{term:c.term,startsOn:c.startsOn,endsOn:c.endsOn}])).values()].sort((a,b)=>b.startsOn.localeCompare(a.startsOn))
      const term=query.period?terms.find(t=>t.term===query.period):terms[0]
      if(query.period&&!term)throw unavailable()
      const classes=term?db.loadSchedules.filter(c=>c.term===term.term):[]
      data.terms=terms
      data.term=term
      data.faculty=db.users.filter(u=>isFaculty(u)&&match(`${u.name} ${u.email}`)).map(u=>{
        const own=classes.filter(c=>c.facultyId===u.id)
        const slots=db.slots.filter(s=>s.facultyId===u.id)
        const conflicts=slots.filter(s=>s.state!=='unavailable').flatMap(s=>{const c=own.find(c=>c.day===weekdayOf(s.date)&&c.startsOn<=s.date&&s.date<=c.endsOn&&c.start<s.end&&s.start<c.end);return c?[{slotId:s.id,date:s.date,start:s.start,end:s.end,state:s.state,classId:c.id,subject:c.subject,day:c.day,classStart:c.start,classEnd:c.end}]:[]})
        return {...person(u),classes:own,slots:slots.map(s=>slotView(user,s)),conflicts}
      })
      break
    }
    case'P18':data.reports=ownReports.map(r=>reportView(db,r,user,true));break
    case'P19':Object.assign(data,{categories:['General concern','Academic process','Facilities','Communication'],categoryOptions:concernCategories,adviser:user.adviserId?person(find(db.users,user.adviserId)):null,anonymityAllowed:!user.restrictions.includes('report.anonymous'),consentWording,draft:db.drafts[user.id]??null,sourcePost:query.from?(()=>{const p=posts.find(p=>p.id===query.from&&p.authorId===user.id);if(!p)throw unavailable();return postView(db,p,user)})():null});break
    case'P20':{const r=pick(ownReports,reportIdOf(db,query.id));if(r)data.record=reportView(db,r,user,true);data.consentWording=consentWording;break}
    // Every handler gets the full category list, so the queue can filter by any category and sub-category.
    case'P21':data.categoryOptions=concernCategories;if(hasPermission(user,'student.report'))Object.assign(data,{canReportStudent:true,categoryOptions:concernCategories,reportableStudents:db.users.filter(u=>canReportStudent(db,user,u)).map(u=>({id:u.id,name:u.name,studentId:u.studentId,program:u.program,section:u.section}))});if(hasPermission(user,'student.report'))data.filedReports=db.reports.filter(r=>r.source==='faculty'&&r.ownerId===user.id).map(r=>({id:r.id,source:'faculty',caseFileId:r.caseFileId,category:r.category,createdAt:r.createdAt,updatedAt:r.updatedAt,status:statusFor(r),stage:r.stage,office:offices[r.stage],reportedStudent:{name:db.users.find(u=>u.id===r.reportedStudentId)?.name}}));data.cases=cases.filter(r=>!query.status||r.status===query.status).map(r=>reportView(db,r,user)).filter(r=>!query.q||match(`${r.id} ${'caseFileId' in r?r.caseFileId??'':''} ${'reporter' in r?(r.reporter as {name?:string}|undefined)?.name??'':''} ${'reportedStudent' in r?(r.reportedStudent as {name?:string}|undefined)?.name??'':''} ${'category' in r?r.category:''} ${'subcategory' in r?r.subcategory??'':''} ${'severity' in r?r.severity:''}`)).filter(r=>(!query.category||('category' in r&&r.category===query.category))&&(!query.severity||('severity' in r&&r.severity===query.severity)));break
    // The first time an office that handles the report opens it, the student's progress moves to Read.
    case'P22':{const r=pick(cases,reportIdOf(db,query.id));if(r){if(!r.readAt&&canActCase(user,r))r.readAt=now();data.record=reportView(db,r,user)}break}
    case'P23':case'P24':{
      const clusterView=(c:Database['clusters'][number])=>clusterViewFor(db,user,c)
      const clusters=db.clusters.filter(c=>c.program===user.program);data.clusters=clusters.map(c=>({...clusterView(c),reportCount:db.reports.filter(r=>c.reportIds.includes(r.id)&&canViewCase(user,r)).length}));data.threshold=Math.round(escalationConfig.similarityThreshold*100);if(pageId==='P24'){const c=pick(clusters,query.id);if(c){data.record=clusterView(c);data.reports=db.reports.filter(r=>c.reportIds.includes(r.id)&&canViewCase(user,r)).map(r=>reportView(db,r,user))}}break}
    case 'P25': {
      if (query.from && query.to && query.from > query.to) throw dateIssue('from', 'The start date must be on or before the end date.')
      if (query.program && hasRole(user, 'chair') && query.program !== user.program) {
        throw unavailable()
      }
      let records = db.reports.filter((report) =>
        canCountCase(user, report)
        && (!hasRole(user, 'chair') || report.program === user.program)
        && (!query.program || report.program === query.program)
        && (!query.q || report.id.toLowerCase().includes(query.q.toLowerCase()))
        && (!query.stage || report.stage === query.stage)
        && (!query.category || report.category === query.category)
        && (!query.from || report.createdAt >= query.from)
        && (!query.to || report.createdAt <= `${query.to}T23:59:59.999Z`),
      )
      if (query.period === 'none') records = []
      // Times come from the report's own history: resolution is its first Resolved or Closed entry, and waiting in a stage
      // counts from when the report entered it (stageEnteredAt).
      const resolvedAt = (report: Report) => report.history.find((entry) => entry.action === 'Resolved' || entry.action === 'Closed')?.at
      const resolvedDays = records.flatMap((report) => { const at = resolvedAt(report); return at ? [daysBetween(report.createdAt, at)] : [] })
      data.stats = [
        { label: 'Open', value: records.filter((report) => !['Resolved', 'Closed'].includes(report.status)).length, note: 'Not yet resolved' },
        { label: 'Escalated', value: records.filter((report) => report.stage !== 'adviser').length, note: 'Past the adviser' },
        { label: 'Resolved', value: records.filter((report) => ['Resolved', 'Closed'].includes(report.status)).length, note: 'Resolved or closed' },
        { label: 'Median days to resolve', value: median(resolvedDays) ?? 0, note: resolvedDays.length ? `Across ${resolvedDays.length} resolved report${resolvedDays.length === 1 ? '' : 's'}` : 'No resolved reports yet' },
        { label: 'Adviser bypassed', value: records.filter((report) => report.bypassed).length, note: 'Sent straight to the chair' },
      ]
      data.byStage = Object.keys(offices).map((stage) => ({
        label: offices[stage as Stage],
        value: records.filter((report) => report.stage === stage).length,
      }))
      data.trend = weeklyTrend(records.map((report) => report.createdAt), records.flatMap((report) => { const at = resolvedAt(report); return at ? [at] : [] }))
      data.waitingByStage = Object.keys(offices).map((stage) => {
        const waiting = records
          .filter((report) => report.stage === stage && !['Resolved', 'Closed'].includes(report.status))
          .map((report) => daysBetween(stageEnteredAt(report), new Date().toISOString()))
        return { label: offices[stage as Stage], value: median(waiting) ?? 0, count: waiting.length }
      })
      // High, Medium, Low, shown red, yellow and green (QA 19 November). Counted like stages, not suppressed like categories.
      data.bySeverity = (['high', 'medium', 'low'] as const).map((severity) => ({
        severity,
        label: severity.charAt(0).toUpperCase() + severity.slice(1),
        value: records.filter((report) => (report.severity ?? 'medium') === severity).length,
      }))
      data.byCategory = [...new Set(records.map((report) => report.category))].map((label) => {
        const count = records.filter((report) => report.category === label).length
        return { label, value: count >= 5 ? count : null, suppressed: count < 5 }
      })
      data.cases = records.filter((report) => canViewCase(user, report)).map((report) => ({
        id: report.id,
        stage: report.stage,
        status: statusFor(report),
        severity: report.severity,
        createdAt: report.createdAt,
      }))
      break
    }
    case'P26':Object.assign(data,{completion:hasRole(user,'student')?evaluationCycles(db).map(c=>evaluationCompletion(db,user.id,c)):undefined,assignments:db.assignments.filter(a=>a.evaluatorId===user.id&&(isCycleForm(db,a)||a.submittedAt)&&['Published','Closed'].includes(find(db.cycles,a.cycleId).status)).map(a=>assignmentView(db,a)),// Cycles to review, and those this professor already reviewed (QA 17 November: reviewed ones stayed under "to review").
      reviewCycles:hasRole(user,'professor')?db.cycles.filter(c=>c.status==='In review'||c.reviews.some(r=>r.userId===user.id)).map(c=>({...c,reviews:undefined,reviewed:c.reviews.some(r=>r.userId===user.id)})):[],canConfigure:hasRole(user,'dean'),canViewResults:hasPermission(user,'evaluation.results')});break
    case'P27':{const a=pick(db.assignments.filter(a=>a.evaluatorId===user.id),query.id);if(a)data.record=assignmentView(db,a,true);break}
    case 'P28':
    case 'P29': {
      if (query.program && hasRole(user,'chair') && query.program !== user.program) {
        throw unavailable()
      }
      const results = resultViews(db,user,query.cycle)
        .filter(result => !query.program || result.faculty.program === query.program)
      data.results = results
      data.cycles = db.cycles.filter(cycle => cycle.resultsPublished)
      const answered = results.filter(result => result.responses > 0)
      data.stats = [
        {
          label: 'Responses',
          value: results.reduce((total,result) => total + result.responses,0),
          note: 'Combined, not individual',
        },
        {
          label: 'Faculty evaluated',
          value: results.filter(result => result.responses > 0).length,
          note: scopeLabel(user),
        },
        {
          label: 'Overall average',
          value: answered.length
            ? Number((answered.reduce((total,result) => total + result.average,0) / answered.length).toFixed(2))
            : 0,
          note: 'Out of 5',
        },
      ]
      if (pageId === 'P29') {
        const result = pick(results,query.id)
        if (result) {
          data.record = result
          data.programAverage = programAverageView(db,result.faculty.program,query.cycle)
        }
      }
      break
    }
    case'P30':data.cycles=db.cycles.map(c=>({...c,completion:db.assignments.filter(a=>a.cycleId===c.id&&a.submittedAt).length,assigned:db.assignments.filter(a=>a.cycleId===c.id).length}));break
    case 'P31': {
      const cycle = pick(db.cycles,query.id)
      if (cycle) {
        data.record = {
          ...cycle,
          reviews: cycle.reviews.map(review => ({
            ...review,
            person: person(find(db.users,review.userId)),
          })),
        }
        data.completion = db.spaces.map(space => ({
          id: space.id,
          title: space.title,
          program: space.program,
          assigned: db.assignments.filter(assignment =>
            assignment.cycleId === cycle.id && space.studentIds.includes(assignment.evaluatorId),
          ).length,
          submitted: db.assignments.filter(assignment =>
            assignment.cycleId === cycle.id
            && space.studentIds.includes(assignment.evaluatorId)
            && assignment.submittedAt,
          ).length,
        }))
        data.facultyCompletion = db.users
          .filter(faculty => hasRole(faculty,'professor','chair','dean'))
          .map(faculty => {
            const assignments = db.assignments.filter(assignment =>
              assignment.cycleId === cycle.id && assignment.facultyId === faculty.id,
            )
            return {
              id: faculty.id,
              name: faculty.name,
              program: faculty.program,
              assigned: assignments.length,
              submitted: assignments.filter(assignment => assignment.submittedAt).length,
            }
          })
          .filter(faculty => faculty.assigned > 0)
        // Every active professor reviews the questions, not only those with classes in the cycle (QA 19 November).
        data.facultyReviews = db.users
          .filter(faculty => faculty.active && hasRole(faculty,'professor'))
          .map(faculty => {
            const review = cycle.reviews.find(item => item.userId === faculty.id)
            return {
              id: faculty.id,
              name: faculty.name,
              program: faculty.program,
              status: review
                ? review.decision === 'changes' ? 'Commented' : 'Reviewed'
                : 'Not yet',
              note: review?.note ?? '',
            }
          })
        data.stats = [
          {
            label: 'Assigned',
            value: db.assignments.filter(assignment => assignment.cycleId === cycle.id).length,
            note: 'All assigned forms',
          },
          {
            label: 'Submitted',
            value: db.assignments.filter(assignment => assignment.cycleId === cycle.id && assignment.submittedAt).length,
            note: 'Forms completed',
          },
        ]
      }
      break
    }
    case'P32':{const c=pick(db.cycles.filter(c=>hasRole(user,'professor')&&(c.status==='In review'||c.reviews.some(r=>r.userId===user.id))),query.id);if(c){data.record={...c,reviews:c.reviews.filter(r=>r.userId===user.id)};data.canReview=c.status==='In review'&&!c.reviews.some(r=>r.userId===user.id)}break}
    case'P53':{
      const cycles=evaluationCycles(db)
      const cycle=query.cycle?cycles.find(c=>c.id===query.cycle):cycles[0]
      if(query.cycle&&!cycle)throw unavailable()
      const students=clearanceStudents(db,user).filter(u=>(!query.program||u.program===query.program)&&(!query.year||String(u.year??'')===query.year)&&(!query.section||u.section===query.section)&&match(`${u.name} ${u.studentId??''}`))
      const showCounts=hasPermission(user,'offense.view')
      const rows=students.map(u=>({student:person(u),program:u.program,year:u.year,section:u.section,evaluation:cycle?evaluationCompletion(db,u.id,cycle):undefined,clearance:clearanceStatus(db,u.id,showCounts)}))
      const statuses=query.status?.split(',').map(s=>s.trim()).filter(Boolean)??[]
      Object.assign(data,{cycles:cycles.map(c=>({id:c.id,title:c.title,status:c.status,opens:c.opens,closes:c.closes})),cycle:cycle&&{id:cycle.id,title:cycle.title,status:cycle.status,closes:cycle.closes},
        students:rows.filter(r=>(!statuses.length||r.evaluation&&statuses.includes(r.evaluation.status))&&(!query.clearance||r.clearance.status===query.clearance)),
        clearanceSummary:{clear:rows.filter(r=>r.clearance.status==='clear').length,onHold:rows.filter(r=>r.clearance.status==='on_hold').length},
        summary:cycle?Object.fromEntries((['submitted','pending','missing','none'] as const).map(s=>[s,rows.filter(r=>r.evaluation?.status===s).length])):undefined,
        filters:{programs:[...new Set(clearanceStudents(db,user).map(u=>u.program).filter(Boolean))].sort(),sections:[...new Set(clearanceStudents(db,user).map(u=>u.section).filter(Boolean))].sort(),scope:hasRole(user,'secretary','dean','osas')?'College of Computer Studies':`${user.program} program`}})
      break
    }
    case'P33':data.students=db.users.filter(u=>canStudentRecord(db,user,u)&&match(`${u.name} ${u.studentId}`)).map(u=>({...person(refreshRestrictions(db,u)),...irregularOf(u)}));break
    case'P34':{if(!query.purpose){data.purposeRequired=true;break}const students=db.users.filter(u=>canStudentRecord(db,user,u));const s=pick(students,query.id);if(s){const entry=audit(repo,user,'Record opened','records',s.studentId??s.id,query.purpose,query.note||undefined);data.record={...person(refreshRestrictions(db,s)),...irregularOf(s),offenses:db.offenses.filter(o=>o.studentId===s.id),restrictions:restrictionViews(db,user,s.id),goodMoral:hasPermission(user,'goodmoral.review')?db.goodMoral.find(g=>g.studentId===s.id):undefined,strikes:strikeViews(db,s.id),strikeSettlements:db.strikeSettlements.filter(x=>x.studentId===s.id).map(x=>({id:x.id,kind:x.kind,reference:x.reference,note:x.note,at:x.at,strikeCount:x.strikeIds.length,settledBy:author(db,x.actorId)})),clearance:clearanceView(db,s.id),clearanceStatus:clearanceStatus(db,s.id,true),canRecordStrikes:hasPermission(user,'strike.record'),canRecommendStrikes:hasPermission(user,'strike.recommend'),openedAt:entry.at,accessHistory:hasRole(user,'dean')?safeAudit(db,db.audit.filter(a=>a.action==='Record opened'&&studentReferences(s).includes(a.reference))):undefined}}break}
    case'P35':{const students=db.users.filter(u=>hasRole(u,'student')&&(hasRole(user,'administrator')||canStudentRecord(db,user,u)));data.students=students.map(u=>person(refreshRestrictions(db,u)));data.restrictions=restrictionViews(db,user);data.referrals=db.referrals.filter(r=>hasRole(user,'administrator')||r.actorId===user.id).map(r=>({...r,student:person(find(db.users,r.studentId)),actor:author(db,r.actorId)}));data.canApply=hasRole(user,'administrator');break}
    case 'P36': {
      const activeRestrictions = restrictionViews(db, user, user.id).filter(restriction => restriction.active)
      const standing = refreshRestrictions(db, user).restrictions.length ? 'Some features paused' : 'Good standing'
      data.record = {
        standing,
        restrictions: activeRestrictions.map(restriction => ({ id: restriction.id, features: restriction.features, until: restriction.until, starts: restriction.starts })),
        essentialAccess: ['Announcements', 'Classes and academic information', 'Assistant', 'Messages with your professors'],
        clearance: clearanceStatus(db, user.id, true),
      }
      break
    }
    case'P37':data.people=db.users.filter(u=>u.active&&!hasRole(u,'student','organization')&&match(`${u.name} ${u.office} ${u.program} ${u.email}`)).map(person);break
    case'P38':{const u=pick(db.users.filter(u=>u.active),query.id);if(u){const {studentId: _studentId,...profile}=person(refreshRestrictions(db,u));data.record=profile}break}
    case'P39':data.record=person({...user,photo:db.photos?.[user.id]});break
    // Newest first: the bell shows the first five (it showed the five oldest before, so new notices never appeared there).
    case'P40':data.notifications=db.notifications.filter(n=>n.recipientId===user.id).sort((a,b)=>b.at.localeCompare(a.at));break
    case'P41':data.faq=filteredFaq(user);data.suggestions=['What can you help me with?',...filteredFaq(user).slice(0,3).map(f=>f.question),...(hasRole(user,'student')?['Show my schedule','Explain my report milestones']:[])];break
    // Matches the question, not the answer text (QA 17 November: "report" or "can" listed unrelated questions).
    case'P42':data.faq=filteredFaq(user).filter(f=>match(f.question));break
    case 'P43':
    case 'P44': {
      data.settings = db.settings[user.id] ?? defaultSettings(user)
      data.record = person(user)
      data.categories = notificationCategories(user)
      data.requiredCategories = notificationCategories(user).filter(category => requiredNotificationCategories.includes(category))
      break
    }
    case'P45':data.stats=[{label:'Active accounts',value:db.users.filter(u=>u.active).length,note:'Can sign in'},{label:'Pending reviews',value:db.moderation.filter(m=>m.status==='Pending').length,note:'Waiting for a moderator'},{label:'Active restrictions',value:db.restrictions.filter(r=>r.active&&r.until>=now().slice(0,10)).length,note:'Features currently paused'},{label:'Assistant sessions',value:db.telemetry.length,note:'Questions are not stored'}];data.moderation=db.moderation.slice(0,5).map(m=>({id:m.id,itemType:m.itemType,source:m.source,status:m.status,at:m.at}));data.audit=safeAudit(db,db.audit.slice(-5));data.systemStatus={api:'Operational',assistant:'Built-in help assistant',storage:'Application store'};data.adoption=roles.map(role=>({label:roleLabels[role],value:db.users.filter(u=>u.roles.includes(role)).length}));break
    case'P46':data.users=db.users.filter(u=>match(`${u.name} ${u.email} ${u.id}`)).map(u=>({...person(refreshRestrictions(db,u)),active:u.active}));break
    case'P47':{const u=pick(db.users,query.id);if(u){data.record={...person(refreshRestrictions(db,u)),active:u.active,...irregularOf(u)};data.audit=safeAudit(db,db.audit.filter(a=>a.reference===u.id))}data.roles=roles.map(role=>({id:role,label:roleLabels[role]}));break}
    case'P48':{
      // The matrix shows what is in force (approved changes included); waiting proposals show beside it.
      data.permissionMatrix=Object.keys(permissionRoles).map(key=>({key,roles:roles.filter(role=>roleHas(role,key)),locked:lockedPermissions.includes(key)}))
      const overrides=Object.entries(db.permissionOverrides).map(([key,value])=>({key,override:overrideOf(value)}))
      data.permissionProposals=Object.fromEntries(overrides.flatMap(({key,override})=>override.proposal?[[key,override.proposal.allowed]]:[]))
      const nameOf=(id:string)=>db.users.find(u=>u.id===id)?.name??'Earlier request'
      data.permissionRequests=overrides.flatMap(({key,override})=>{
        if(!override.proposal)return []
        const role=key.slice(0,key.indexOf(':')),permission=key.slice(key.indexOf(':')+1)
        return [{key,role,permission,allowed:override.proposal.allowed,proposedBy:nameOf(override.proposal.by),proposedAt:override.proposal.at,reason:override.proposal.reason,
          canDecide:hasPermission(user,'permission.review')&&override.proposal.by!==user.id}]
      })
      data.permissionDecisions=overrides.flatMap(({key,override})=>override.decisions.map(d=>({key,...d,by:nameOf(d.by)}))).sort((a,b)=>b.at.localeCompare(a.at)).slice(0,20)
      data.canReviewPermissions=hasPermission(user,'permission.review')
      data.roles=roles.map(role=>({id:role,label:roleLabels[role]}));break}
    case'P49':data.moderation=db.moderation.filter(m=>canSeeModeration(user,m)&&(!query.status||m.status===query.status)).map(m=>({...m,authorId:undefined,reporterId:undefined}));break
    case'P50':{const m=pick(db.moderation.filter(item=>canSeeModeration(user,item)),query.id);if(m){data.record={...m,authorId:undefined,reporterId:undefined,reporter:m.reporterId?{name:'Verified community member'}:undefined};data.decisions=moderationDecisions(user,m);const p=db.posts.find(p=>p.id===m.parentId);if(p)data.post=postView(db,p,user);// The flagged message with up to three before and two after it, so the reviewer reads it in context (QA 17 November).
if(m.itemType==='message'){const thread=db.threads.find(t=>t.id===m.parentId);const at=thread?thread.messages.findIndex(message=>message.id===m.itemId):-1;data.messages=thread&&at>=0?thread.messages.slice(Math.max(0,at-3),at+3).map(message=>({...messageView(db,message),flagged:message.id===m.itemId})):[]}}break}
    case'P51':if(query.from&&query.to&&query.from>query.to)throw dateIssue('from','The start date must be on or before the end date.');data.audit=safeAudit(db,db.audit.filter(a=>(!query.from||a.at>=query.from)&&(!query.to||a.at<=`${query.to}T23:59:59.999Z`)&&(!query.q||`${a.reference} ${a.action} ${a.module}`.toLowerCase().includes(query.q.toLowerCase()))));break
    case'P52':{const telemetry=query.period==='none'?[]:db.telemetry;data.stats=[{label:'Assistant sessions',value:telemetry.length,note:'Help assistant'},{label:'Failures',value:telemetry.filter(t=>!t.success).length,note:'Counts only'},{label:'Median response time',value:telemetry.length?`${telemetry.map(t=>t.durationMs).sort((a,b)=>a-b)[Math.floor(telemetry.length/2)]} ms`:'No data',note:'Since the server started'}];data.systemStatus={api:'Operational',assistant:'Built-in help assistant',storage:'Application store'};data.telemetry=telemetry;data.incidents=[];// The last seven campus days, oldest first, with empty days kept at 0 (QA 17 November: only today was shown).
const days=Array.from({length:7},(_,n)=>new Date(Date.now()+8*3_600_000-(6-n)*86_400_000).toISOString().slice(0,10));const dayOf=(at:string)=>new Date(Date.parse(at)+8*3_600_000).toISOString().slice(0,10);data.trend=telemetry.length?days.map(day=>({label:day,value:telemetry.filter(t=>dayOf(t.at)===day).length})):[];break}
  }
  return JSON.parse(JSON.stringify({pageId,title:pageTitles[pageId],scope:scopeLabel(user),data})) as {pageId:string;title:string;scope:string;data:Record<string,unknown>}
}

// 360-degree evaluation (paper, Chapter 1 Scope item 5; restored 2026-11-24 after #47 had limited cycles to the student
// form). Every cycle carries the student form: each student evaluates every professor of their class spaces. The Dean may
// add the peer form (a professor evaluates a colleague in the same program) and the upward forms (professors evaluate their
// Program Chair and the Dean). Completion and clearance count the student form only.
export const studentForm = 'student'
export const studentRelation = 'Student to faculty'
const isStudentForm = (a:Assignment) => a.relation === studentRelation
const relationForms: Record<string,string> = { [studentRelation]:'student', Peer:'peer', 'Upward: Program Chair':'upward-chair', 'Upward: Dean':'upward-dean', 'upward-chair':'upward-chair', 'upward-dean':'upward-dean' }
/** An assignment is open to fill while its form is part of its cycle; a submitted one always stays listed. */
const isCycleForm = (db:Database,a:Assignment) => { const form=relationForms[a.relation]; return !!form && (db.cycles.find(c=>c.id===a.cycleId)?.forms ?? []).includes(form) }
// Evaluation completion (#33, baseline chapter 9.2). Per student and cycle: finished when every student-form evaluation is
// submitted, not finished while the cycle is open, missing once the cycle is closed. A student with nothing to evaluate
// in a cycle has status "none". Only published and closed cycles count; the current cycle is the latest of them.
export type CompletionStatus = 'submitted' | 'pending' | 'missing' | 'none'
const completionLabels: Record<CompletionStatus,string> = { submitted: 'Finished', pending: 'Not finished', missing: 'Missing', none: 'Nothing to evaluate' }
function evaluationCycles(db:Database) { return db.cycles.filter(c=>['Published','Closed'].includes(c.status)).sort((a,b)=>b.opens.localeCompare(a.opens)||b.id.localeCompare(a.id)) }
function evaluationCompletion(db:Database,studentId:string,cycle:Cycle) {
  const mine=db.assignments.filter(a=>a.cycleId===cycle.id&&a.evaluatorId===studentId&&isStudentForm(a))
  const submitted=mine.filter(a=>a.submittedAt).length
  const status:CompletionStatus=!mine.length?'none':submitted===mine.length?'submitted':cycle.status==='Closed'?'missing':'pending'
  return {cycleId:cycle.id,cycleTitle:cycle.title,cycleStatus:cycle.status,closes:cycle.closes,status,label:completionLabels[status],submitted,total:mine.length}
}
// One clearance status per student (#35, DOC003 D-02), always worked out from the data: on hold when the current cycle
// has closed and the student did not finish it (status "missing"; a cycle still open blocks no one, decided 11 November 2026), or when
// strikes are not settled (#34). `showCounts` adds the number of unsettled strikes; the Secretary sees only the reason.
export type ClearanceReason = { kind: 'evaluation'; message: string; cycleId: string } | { kind: 'strikes'; message: string; unsettledStrikes?: number }
function clearanceStatus(db:Database,studentId:string,showCounts:boolean) {
  const reasons:ClearanceReason[]=[]
  const cycle=evaluationCycles(db)[0]
  if(cycle&&evaluationCompletion(db,studentId,cycle).status==='missing')reasons.push({kind:'evaluation',message:`Evaluations not finished for ${cycle.title}`,cycleId:cycle.id})
  const strikes=clearanceOf(db,studentId)
  if(strikes.onHold)reasons.push({kind:'strikes',message:'Strikes not settled with OSAS',...(showCounts?{unsettledStrikes:strikes.unsettledStrikes}:{})})
  return {status:reasons.length?'on_hold' as const:'clear' as const,label:reasons.length?'On hold':'Clear',reasons}
}
/** The students whose clearance this person may see: the whole college, or the Program Chair's own program. */
function clearanceStudents(db:Database,user:User) { return db.users.filter(u=>hasRole(u,'student')&&u.active&&(hasRole(user,'secretary','dean','osas')||hasRole(user,'chair')&&u.program===user.program)) }
function ensureCycleAssignments(repo:UnitOfWork,cycle:Cycle){
  const db=repo.read()
  const add=(evaluatorId:string,facultyId:string,relation:string,subject:string)=>{if(!db.assignments.some(a=>a.cycleId===cycle.id&&a.evaluatorId===evaluatorId&&a.facultyId===facultyId&&a.relation===relation))db.assignments.push({id:repo.nextId('EVAL'),evaluatorId,facultyId,cycleId:cycle.id,relation,subject})}
  for(const student of db.users.filter(u=>hasRole(u,'student')))for(const facultyId of [...new Set(db.spaces.filter(s=>s.studentIds.includes(student.id)).flatMap(s=>s.professorIds))])add(student.id,facultyId,studentRelation,student.program??'CCS')
  for(const professor of db.users.filter(u=>u.active&&hasRole(u,'professor'))){
    if(cycle.forms.includes('peer'))for(const peer of db.users.filter(u=>u.active&&u.id!==professor.id&&hasRole(u,'professor')&&u.program===professor.program))add(professor.id,peer.id,'Peer','Faculty peer review')
    for(const[form,role,relation,subject]of [['upward-chair','chair','Upward: Program Chair','Program leadership'],['upward-dean','dean','Upward: Dean','College leadership']] as const){
      if(!cycle.forms.includes(form))continue
      const leader=db.users.find(u=>u.active&&hasRole(u,role)&&(role==='dean'||u.program===professor.program))
      if(leader&&leader.id!==professor.id)add(professor.id,leader.id,relation,subject)
    }
  }
}
const actionPages: Record<string, string[]> = {
  createPost: ['P05', 'P08', 'P10'],
  addOrganizationMember: ['P10'],
  removeOrganizationMember: ['P10'],
  setMemberPosition: ['P10'],
  updatePost: ['P06'],
  deletePost: ['P06'],
  comment: ['P06'],
  react: ['P06'],
  reactComment: ['P06'],
  flag: ['P06', 'P12'],
  createReport: ['P19'],
  reportStudent: ['P21'],
  saveDraft: ['P19'],
  sendReportMessage: ['P20', 'P22'],
  chooseTalkMode: ['P19', 'P20'],
  setTalkDetails: ['P22'],
  setConfidential: ['P22'],
  discloseIdentity: ['P20'],
  caseAction: ['P22'],
  addNote: ['P22'],
  reviewCluster: ['P24'],
  createConsultation: ['P15'],
  decideConsultation: ['P16'],
  saveAvailability: ['P17'],
  addMaterial: ['P08'],
  updateMaterial: ['P08'],
  removeMaterial: ['P08'],
  commentMaterial: ['P08'],
  deleteMaterialComment: ['P08'],
  uploadLoadSchedule: ['P54'],
  deleteAvailability: ['P17'],
  createTodo: ['P13'],
  toggleTodo: ['P13'],
  deleteTodo: ['P13'],
  createThread: ['P11'],
  createGroupThread: ['P11'],
  sendMessage: ['P12'],
  addGroupMembers: ['P12'],
  saveMessageDraft: ['P12'],
  muteThread: ['P12'],
  editMessage: ['P12'],
  deleteMessage: ['P12'],
  markThreadRead: ['P12'],
  markNotification: ['P40'],
  markAllNotifications: ['P40'],
  openNotification: ['P40'],
  assistantAsk: ['P41', 'P19'],
  submitEvaluation: ['P27'],
  createCycle: ['P30'],
  saveCycle: ['P31'],
  cycleAction: ['P31'],
  reviewQuestions: ['P32'],
  saveFollowUp: ['P29'],
  openRecord: ['P34'],
  reviewGoodMoral: ['P34'],
  recommendStrike: ['P22', 'P34'],
  decideStrike: ['P22', 'P34'],
  settleStrikes: ['P34'],
  applyRestriction: ['P35'],
  liftRestriction: ['P35'],
  changeRestrictionEnd: ['P35'],
  declineReferral: ['P35'],
  referRestriction: ['P34', 'P35'],
  saveProfile: ['P39'],
  setProfilePhoto: ['P39'],
  saveSettings: ['P43'],
  saveNotificationPreferences: ['P44'],
  updateRoles: ['P46', 'P47'],
  updatePermission: ['P48'],
  decidePermission: ['P48'],
  moderate: ['P50'],
}
/** The fields `updateRoles` changes, as the auth store keeps them. */
export type AccountChange = Pick<User,'id'|'roles'|'active'> & Partial<Pick<User,'program'|'section'|'year'|'irregular'>>
/** The fields `saveProfile` changes. */
export type ProfileChange = { title: string; bio: string; education: string; officeHours: string }
// Accounts live in the auth store, shared by every instance, so a role or profile change is saved there once the action has committed.
/** An email to send after an action commits: for now, a new concern for the office receiving it (#37). */
export type OutgoingMail = { kind: 'newConcern'; userId: string; to: string; name: string; reportId: string }
/** Work done once an action has committed: emails, and stored files to delete (#44). */
export type AfterCommit = OutgoingMail | { kind: 'deleteFile'; key: string }
export async function performAction(repo:Repository,user:User,pageId:string,request:ActionRequest,saveAccount?:(change:AccountChange)=>Promise<void>,saveProfile?:(id:string,change:ProfileChange)=>Promise<void>,sendMail?:(work:AfterCommit[])=>Promise<void>,files?:MaterialStorage){
  // Page access first, so a request this page refuses copies no files; a refused or failed action removes its copies.
  if(fileActions.includes(request.action)&&(!canPage(user,pageId)||!actionPages[request.action]?.includes(pageId)))throw deny()
  const fileKeys=fileActions.includes(request.action)?await checkMessageFiles(repo,user,request,files):new Map<string,string>()
  const {outbox,...result}=await repo.transact(unit=>runAction(unit,user,pageId,request,fileKeys)).catch(async(error:unknown)=>{
    await Promise.all([...fileKeys.values()].map(key=>files?.remove(key).catch(()=>undefined)))
    throw error
  })
  // Emails go out only once the change is saved, and never reach the response.
  if(outbox.length)await sendMail?.(outbox)
  if(request.action==='updateRoles')await saveAccount?.(result.record as AccountChange)
  if(request.action==='saveProfile')await saveProfile?.(user.id,actionPayloads.saveProfile.parse(request.payload))
  return result
}
function runAction(repo:UnitOfWork,user:User,pageId:string,request:ActionRequest,fileKeys=new Map<string,string>()){
  if(!canPage(user,pageId)||!actionPages[request.action]?.includes(pageId))throw deny()
  const db=repo.read();attachPhotos(db);const id=request.recordId;let record:unknown;let message='Changes saved.';const outbox:AfterCommit[]=[]
  // The report is named by the record ID, or by `reportId` in the payload for the talk actions.
  const getOwnReport=(reportId=id)=>{const r=find(db.reports,reportIdOf(db,reportId));if(r.ownerId!==user.id||!hasRole(user,'student'))throw unavailable();return r}
  const getCase=(reportId=id)=>{const r=find(db.reports,reportIdOf(db,reportId));if(!canActCase(user,r))throw unavailable();return r}
  const addMessage=(list:Message[],body:string,files:{id:string;fileName:string;contentType:string;size:number}[]=[])=>{const m:Message={id:repo.nextId('MESSAGE'),authorId:user.id,body,at:now(),...(files.length?{attachments:files.map(f=>({...f,key:fileKeys.get(f.id)!}))}:{})};list.push(m);return m}
  switch(request.action){
    case 'createPost': {
      const payload = actionPayloads.createPost.parse(request.payload)
      if (payload.eventDate && (payload.eventTime ? hasBegun(payload.eventDate, payload.eventTime) : payload.eventDate < campusNow().date)) throw dateIssue('eventDate', 'Choose today or a later date for the event.')
      if (!canPublish(db, user, payload.audience, payload.kind === 'announcement')) throw deny()
      if (payload.anonymous && (!hasRole(user, 'student') || payload.kind === 'announcement' || user.restrictions.includes('post.create'))) throw deny()
      const { attachments: postFiles, ...postFields } = payload
      const post: Post = {
        ...postFields,
        ...(postFiles?.length ? { attachments: postFiles.map(f => ({ ...f, key: fileKeys.get(f.id)! })) } : {}),
        label: payload.kind === 'announcement' ? 'Announcement' : payload.label!,
        id: repo.nextId('POST'),
        authorId: user.id,
        at: now(),
        reactions: [],
        comments: [],
        removed: false,
      }
      db.posts.push(post)
      queuePostReview(repo, post)
      syncPostEvent(repo, post)
      if (!heldItem(db, 'post', post.id)) { notifyAnnouncementMembers(repo, post); notifyClassPost(repo, post) }
      record = postView(db, post, user)
      message = 'Post published.'
      break
    }
    case 'updatePost': {
      const payload = actionPayloads.updatePost.parse(request.payload)
      const post = find(db.posts, id)
      if (post.authorId !== user.id || !canAudience(db, user, post.audience, post.private)) throw unavailable()
      if (post.removed) throw conflict('This post has been removed.')
      if (!canPublish(db, user, post.audience, post.kind === 'announcement')) throw deny()
      const label = post.kind === 'announcement'
        ? 'Announcement'
        : z.object({ label: z.enum(postLabels) }).parse({ label: payload.label }).label
      const { attachments: postFiles, ...postFields } = payload
      Object.assign(post, postFields, { label, updatedAt: now() })
      if (postFiles) {
        if (postFiles.length) post.attachments = postFiles.map(f => ({ ...f, key: post.attachments?.find(a => a.id === f.id)?.key ?? fileKeys.get(f.id)! }))
        else delete post.attachments
      }
      if (!post.body && !post.attachments?.length) throw new z.ZodError([{ code: 'custom', path: ['body'], message: 'Write something or attach a file.', input: undefined }])
      queuePostReview(repo, post)
      syncPostEvent(repo, post)
      record = postView(db, post, user)
      message = 'Post updated.'
      break
    }
    case 'deletePost': {
      actionPayloads.deletePost.parse(request.payload)
      const post = find(db.posts, id)
      if (post.authorId !== user.id || !canAudience(db, user, post.audience, post.private)) throw unavailable()
      if (post.removed) throw conflict('This post has already been removed.')
      post.removed = true
      post.updatedAt = now()
      syncPostEvent(repo, post)
      record = postView(db, post, user)
      message = 'Post deleted.'
      break
    }
    case'comment':{if(!user.roles.some(role=>roleHas(role,'post.create')))throw deny();if(user.restrictions.includes('post.comment'))throw deny();const p=actionPayloads.comment.parse(request.payload);const post=find(db.posts,id);if(!canAudience(db,user,post.audience,post.private)||!canSeeItem(db,user,'post',post.id,post.authorId)||post.removed)throw unavailable();if(!canPublish(db,user,post.audience,false,'comment'))throw deny();if(p.anonymous&&!hasRole(user,'student'))throw deny();const added={...addMessage([],p.body),anonymous:p.anonymous};post.comments.push(added);autoFlag(repo,{itemType:'comment',itemId:added.id,parentId:post.id,authorId:user.id,text:p.body});record=postView(db,post,user);message='Comment added.';break}
    case'react':{const p=actionPayloads.react.parse(request.payload);const post=find(db.posts,id);if(!canAudience(db,user,post.audience,post.private)||!canSeeItem(db,user,'post',post.id,post.authorId)||post.removed)throw unavailable();if(!canPublish(db,user,post.audience,false,'react'))throw deny();toggleReaction(post,user.id,p.reaction);record=postView(db,post,user);message='Reaction updated.';break}
    case'reactComment':{const p=actionPayloads.reactComment.parse(request.payload);const post=find(db.posts,id);if(!canAudience(db,user,post.audience,post.private)||!canSeeItem(db,user,'post',post.id,post.authorId)||post.removed)throw unavailable();if(!canPublish(db,user,post.audience,false,'react'))throw deny();const comment=post.comments.find(c=>c.id===p.commentId);if(!comment||!canSeeItem(db,user,'comment',comment.id,comment.authorId))throw unavailable();toggleReaction(comment,user.id,p.reaction);record=postView(db,post,user);message='Reaction updated.';break}
    case'flag':{const p=actionPayloads.flag.parse(request.payload);let authorId:string,body:string,parentId:string,itemId:string;if(p.itemType==='message'){const thread=find(db.threads,id);if(!canThread(db,user,thread))throw unavailable();const m=find(thread.messages,p.itemId);authorId=m.authorId;body=m.body;parentId=thread.id;itemId=m.id}else{const post=find(db.posts,id);if(!canAudience(db,user,post.audience,post.private))throw unavailable();const item=p.itemType==='comment'?find(post.comments,p.itemId):post;authorId=item.authorId;body=item.body;parentId=post.id;itemId=item.id}if(authorId===user.id)throw new ApiError(400,'You cannot report your own post, comment or message.','VALIDATION_ERROR');const mod={id:repo.nextId('MOD'),itemType:p.itemType,itemId,parentId,authorId,reporterId:user.id,source:'User' as const,reason:p.reason,excerpt:body.slice(0,160),status:'Pending',at:now(),history:[]};db.moderation.push(mod);if(p.itemType==='message')redactNotices(db,itemId);audit(repo,user,'Content reported','moderation',mod.id);record={id:mod.id,status:mod.status};message='Sent to a moderator.';break}
    case 'reportStudent': {
      requirePermission(user, 'student.report')
      const p = actionPayloads.reportStudent.parse(request.payload)
      checkIncidentDate(p)
      const categoryIssue = categoryProblem(p)
      if (categoryIssue) throw new z.ZodError([{ code: 'custom', path: [categoryIssue.path], message: categoryIssue.message, input: undefined }])
      const student = db.users.find(u => u.id === p.studentId)
      if (!student || !canReportStudent(db, user, student)) throw unavailable()
      if (student.id === user.id) throw conflict('You cannot report yourself.')
      // The student's Program Chair receives it; a Chair reporting a student of their own program sends it to the Dean.
      // The Dean cannot act on a case they own, so a Dean's own report goes to Guidance.
      const byDean = hasRole(user, 'dean')
      const stage: Stage = byDean ? 'guidance' : hasRole(user, 'chair') && user.program === student.program ? 'dean' : 'chair'
      const at = now()
      const r: Report = {
        id: repo.nextId('RPT'),
        ownerId: user.id,
        source: 'faculty',
        reportedStudentId: student.id,
        program: student.program!,
        adviserId: student.adviserId,
        stage,
        status: 'Submitted',
        narrative: p.narrative,
        category: p.category,
        ...(p.subcategory ? { subcategory: p.subcategory } : {}),
        ...(p.categoryDetail ? { categoryDetail: p.categoryDetail } : {}),
        severity: p.severity,
        identity: 'named',
        alias: 'Faculty report',
        disclosedTo: [],
        involvedUserIds: [student.id],
        bypassed: false,
        aboutAdvisor: false,
        createdAt: at,
        updatedAt: at,
        ...(p.location ? { location: p.location } : {}),
        ...(p.occurredOn ? { occurredOn: p.occurredOn } : {}),
        ...(p.ongoing && !p.occurredOn ? { ongoing: true } : {}),
        history: [{ id: repo.nextId('HISTORY'), at, actorId: user.id, actorRole: byDean ? 'dean' : hasRole(user, 'chair') ? 'chair' : 'professor', action: 'Submitted', reason: 'Filed by a faculty member.', update: `Sent to ${offices[stage]}.`, public: true, stage }],
        notes: [],
        messages: [],
      }
      if (!handlerIds(db, r).length) throw conflict(stage === 'dean' ? 'The Dean cannot receive reports right now.' : 'This student\'s program does not have a Program Chair who can receive reports yet. Ask the CCS office to set one, then try again.')
      db.reports.push(r)
      audit(repo, user, 'Student reported by faculty', 'reports', r.id)
      // The reported student is not told now; they hear from an office when it calls them in or records a decision.
      const receiving = handlerIds(db, r)
      for (const handlerId of receiving) notify(repo, handlerId, 'report', 'P22', r.id)
      for (const handler of db.users.filter(u => receiving.includes(u.id) && u.email)) outbox.push({ kind: 'newConcern', userId: handler.id, to: handler.email, name: handler.name, reportId: r.id })
      record = reportView(db, r, user)
      message = `Report sent to ${offices[stage]}.`
      break
    }
    case 'createReport': {
      requirePermission(user, 'report.create')
      const p = actionPayloads.createReport.parse(request.payload)
      checkIncidentDate(p)
      const categoryIssue = categoryProblem(p)
      if (categoryIssue) throw new z.ZodError([{ code: 'custom', path: [categoryIssue.path], message: categoryIssue.message, input: undefined }])
      if (p.identity === 'anonymous' && user.restrictions.includes('report.anonymous')) throw deny()
      // The adviser is a professor set as the student's adviser. Without one a concern can still go to the chair, if it goes around the adviser.
      const adviser = db.users.find(u => u.id === user.adviserId && u.active && hasRole(u, 'professor'))
      // Context-aware routing: the report text read together with the reporter's own faculty (src/escalation, no external service).
      const chairIds = db.users.filter(u => u.active && hasRole(u, 'chair') && u.program === user.program).map(u => u.id)
      const roster = rosterFor({ ...user, adviserId: adviser?.id }, db.users, db.spaces)
      const decision = route(p.narrative, roster, p, chairIds)
      if (!adviser && decision.stage === 'adviser') throw conflict('You do not have an active adviser, so this concern cannot be sent. Ask the CCS office to set your adviser, then try again.')
      const { stage, bypassed } = decision
      if (p.sourcePostId) {
        const source = find(db.posts, p.sourcePostId)
        if (source.authorId !== user.id || !canAudience(db, user, source.audience, source.private)) throw unavailable()
      }
      const at = now()
      const r: Report = {
        id: repo.nextId('RPT'),
        ownerId: user.id,
        program: user.program!,
        adviserId: adviser?.id,
        stage,
        status: 'Submitted',
        narrative: p.narrative,
        category: p.category,
        ...(p.subcategory ? { subcategory: p.subcategory } : {}),
        ...(p.categoryDetail ? { categoryDetail: p.categoryDetail } : {}),
        severity: p.severity,
        identity: p.identity,
        alias: `Reporter A-${repo.nextId('ALIAS').slice(-4)}`,
        disclosedTo: [],
        involvedUserIds: decision.involvedUserIds,
        bypassed,
        // "About the adviser" keeps the adviser out of every later step; a concern sent up for another reason does not set it.
        aboutAdvisor: decision.aboutAdvisor,
        routing: decision.trace,
        consent: { readStatement: true, at, userId: user.id, version: consentWording.version, wording: consentWording.report },
        createdAt: at,
        updatedAt: at,
        sourcePostId: p.sourcePostId,
        location: p.location,
        occurredOn: p.occurredOn,
        ...(p.ongoing && !p.occurredOn ? { ongoing: true } : {}),
        history: [{ id: repo.nextId('HISTORY'), at, actorId: user.id, actorRole: 'student', action: 'Submitted', reason: decision.reason, update: 'Your report was sent to the office handling it.', public: true, stage }],
        notes: [],
        messages: [],
      }
      // A critical concern is never refused because Guidance has no one to receive it. The normal rules pick the stage again, but never the
      // adviser: the Program Chair is the lowest it falls back to. aboutAdvisor and involvedUserIds do not depend on the switch, so they stay as set.
      if (stage === 'guidance' && !handlerIds(db, r).length) {
        const fallback = route(p.narrative, roster, p, chairIds, { ...escalationConfig, criticalToGuidance: false })
        r.stage = fallback.stage === 'adviser' ? 'chair' : fallback.stage
        r.bypassed = true
        r.routing = { ...fallback.trace, rule: 'critical-no-guidance' }
        Object.assign(r.history[0]!, { stage: r.stage, reason: `No Guidance officer can receive this yet. Sent to the ${offices[r.stage]}.` })
      }
      // Nothing is stored or sent when no one can receive it.
      if (!handlerIds(db, r).length) throw conflict(r.stage === 'dean' ? 'Your concern goes to the Dean, and no Dean can receive it yet. Ask the CCS office, then try again.' : r.stage === 'guidance' ? 'Your concern goes to the Guidance Office, and no Guidance officer can receive it yet. Ask the CCS office, then try again.' : r.bypassed ? 'Your concern goes to your Program Chair, and your program does not have a Program Chair who can receive it yet. Ask the CCS office to set one, then try again.' : 'Your adviser cannot receive concerns right now. Ask the CCS office to check your adviser, then try again.')
      db.reports.push(r)
      groupSimilar(repo, db, r)
      delete db.drafts[user.id]
      audit(repo, user, 'Report submitted', 'reports', r.id)
      audit(repo, user, 'Report consent recorded', 'reports', r.id)
      notify(repo, user.id, 'report', 'P20', r.id)
      for (const handlerId of handlerIds(db, r)) notify(repo, handlerId, 'report', 'P22', r.id)
      // The receiving office also gets an email, with no details (#37). handlerIds never includes a conflicted adviser.
      const receiving = handlerIds(db, r)
      for (const handler of db.users.filter(u => receiving.includes(u.id) && u.email)) outbox.push({ kind: 'newConcern', userId: handler.id, to: handler.email, name: handler.name, reportId: r.id })
      record = reportView(db, r, user, true)
      message = 'Report submitted.'
      break
    }
    case'saveDraft':{requirePermission(user,'report.create');db.drafts[user.id]=actionPayloads.saveDraft.parse(request.payload);message='Draft saved.';record=db.drafts[user.id];break}
    case 'sendReportMessage': {
      const p = actionPayloads.sendReportMessage.parse(request.payload)
      const fromStudent = pageId === 'P20'
      const r = fromStudent ? getOwnReport() : getCase()
      if (['Resolved', 'Closed'].includes(r.status)) throw conflict('This conversation is closed.')
      // The student picks how to talk, and messages are only for chat.
      if (r.talk?.mode !== 'chat') throw conflict(fromStudent ? 'Messages are open only when you choose chat as the way to talk. Choose chat to write to the office.' : 'Messages are open only when the student chooses chat as the way to talk.')
      const m = addMessage(r.messages, p.body)
      r.updatedAt = now()
      // The trail records that a message was sent and by whom, never what it said.
      audit(repo, user, fromStudent ? 'Reporter message sent' : 'Handler message sent', 'reports', r.id)
      if (fromStudent) for (const handlerId of handlerIds(db, r)) notify(repo, handlerId, 'report', 'P22', r.id)
      else notify(repo, r.ownerId, 'report', 'P20', r.id)
      record = messageView(db, m, r)
      message = 'Message sent.'
      break
    }
    case 'chooseTalkMode': {
      const p = actionPayloads.chooseTalkMode.parse(request.payload)
      // A preferred time is still to come (QA 17 November, V3: past dates could be picked).
      if (p.preferredAt && isPastMoment(p.preferredAt)) throw dateIssue('preferredAt', 'Choose a date and time that has not passed yet.')
      const r = getOwnReport(p.reportId)
      if (['Resolved', 'Closed'].includes(r.status)) throw conflict('This concern is closed.')
      const call = p.mode === 'video' || p.mode === 'voice'
      if (p.consent.recordCall && !call) throw new ApiError(400, 'Recording only applies to video and voice calls.', 'VALIDATION_ERROR')
      let consultation: Consultation | undefined
      if (p.slotId) {
        // The time must be one of the office handling the concern, and the booking tells that office who asked, so an anonymous student shares their name first.
        const slot = find(db.slots, p.slotId)
        if (!handlerIds(db, r).includes(slot.facultyId)) throw unavailable()
        if (r.identity === 'anonymous' && !r.disclosedTo.includes(r.stage)) throw conflict('To book a time, share your name with the office first.')
        if (db.consultations.some(c => c.id === r.talk?.consultationId && !['Declined', 'Cancelled', 'Completed'].includes(c.status))) throw conflict('You already asked for a time for this concern. Cancel that request under Appointments first.')
        consultation = reserveSlot(repo, user.id, slot, { ...concernFollowUp }, r.id)
      }
      const at = now()
      // Recording is off unless the student says yes.
      const recordCall = call ? p.consent.recordCall === true : undefined
      const wording = [consentWording.talk[p.mode], ...(recordCall === undefined ? [] : [consentWording.recording[recordCall ? 'allow' : 'deny']])].join(' ')
      // A link, place, or time was set for the way the student had chosen. Another way needs its own.
      const kept = r.talk?.mode === p.mode ? r.talk : undefined
      r.talk = {
        mode: p.mode,
        consents: [...(r.talk?.consents ?? []), { mode: p.mode, participate: true, ...(recordCall === undefined ? {} : { recordCall }), wording, at }],
        slotId: consultation?.slotId ?? r.talk?.slotId,
        consultationId: consultation?.id ?? r.talk?.consultationId,
        preferredAt: p.preferredAt ?? r.talk?.preferredAt,
        scheduledAt: kept?.scheduledAt,
        meetingLink: kept?.meetingLink,
        place: kept?.place,
        updatedAt: at,
      }
      r.updatedAt = at
      audit(repo, user, 'Talk consent recorded', 'reports', r.id)
      for (const handlerId of handlerIds(db, r)) notify(repo, handlerId, 'report', 'P22', r.id)
      record = reportView(db, r, user, true)
      message = 'Your choice is saved.'
      break
    }
    case 'setTalkDetails': {
      const p = actionPayloads.setTalkDetails.parse(request.payload)
      const r = getCase(p.reportId)
      // A new time is still to come; a time already saved may stay when only the link or place changes.
      const kept = [r.talk?.scheduledAt, r.talk?.preferredAt].some(saved => saved && Date.parse(saved) === Date.parse(p.scheduledAt ?? ''))
      if (p.scheduledAt && !kept && isPastMoment(p.scheduledAt)) throw dateIssue('scheduledAt', 'Choose a date and time that has not passed yet.')
      if (['Resolved', 'Closed'].includes(r.status)) throw conflict('This concern is closed.')
      if (!r.talk) throw conflict('The student has not chosen how to talk yet.')
      if (p.meetingLink && r.talk.mode !== 'video' && r.talk.mode !== 'voice') throw conflict('A meeting link only applies to video and voice calls.')
      if (p.place && r.talk.mode !== 'face_to_face') throw conflict('A place only applies to meeting in person.')
      const { reportId: _reportId, ...details } = p
      r.talk = { ...r.talk, ...details, updatedAt: now() }
      r.updatedAt = r.talk.updatedAt
      if (p.scheduledAt) {
        // The office's meeting time takes the handler's overlapping open slot out of booking (C12); a moved time frees the old one.
        const reason = `Meeting for report ${r.id}`
        releaseMeetingSlots(db, r.id)
        const at = new Date(Date.parse(/(Z|[+-]\d\d:\d\d)$/.test(p.scheduledAt) ? p.scheduledAt : p.scheduledAt + '+08:00') + 8 * 3_600_000).toISOString()
        for (const s of db.slots) if (s.facultyId === user.id && s.state === 'open' && s.date === at.slice(0, 10) && s.start <= at.slice(11, 16) && at.slice(11, 16) < s.end) { s.state = 'unavailable'; s.reason = reason }
      }
      audit(repo, user, 'Talk details set', 'reports', r.id)
      notify(repo, r.ownerId, 'report', 'P20', r.id)
      record = reportView(db, r, user)
      message = 'Details saved.'
      break
    }
    case 'setConfidential': {
      const p = actionPayloads.setConfidential.parse(request.payload)
      const reason = reasonOf(request)
      const r = getCase()
      // Only the adviser marks a concern confidential, while it is with them; a concern about the adviser goes to the chair and cannot be.
      if (r.stage !== 'adviser' || r.adviserId !== user.id) throw conflict('Only the adviser can mark a concern confidential, while it is with them.')
      if (r.aboutAdvisor) throw conflict('A concern about the adviser cannot be marked confidential.')
      if (['Resolved', 'Closed'].includes(r.status)) throw conflict('This concern is closed.')
      if ((r.confidential === true) === p.confidential) throw conflict(p.confidential ? 'This concern is already confidential.' : 'This concern is not marked confidential.')
      r.confidential = p.confidential
      r.updatedAt = now()
      const action = p.confidential ? 'Marked confidential' : 'Confidential mark removed'
      r.history.push({ id: repo.nextId('HISTORY'), at: r.updatedAt, actorId: user.id, actorRole: 'professor', action, reason, update: p.confidential ? 'Your adviser marked this concern confidential. The Program Chair and the Dean see only its status.' : 'Your adviser removed the confidential mark.', public: true, stage: r.stage })
      audit(repo, user, action, 'cases', r.id)
      notify(repo, r.ownerId, 'case', ownerPage(r), r.id)
      record = reportView(db, r, user)
      message = `${action}.`
      break
    }
    case'discloseIdentity':{const p=actionPayloads.discloseIdentity.parse(request.payload);const r=getOwnReport();if(p.office&&p.office!==r.stage&&p.office!==offices[r.stage])throw deny();if(!r.disclosedTo.includes(r.stage)){r.disclosedTo.push(r.stage);audit(repo,user,'Identity disclosed','reports',r.id);for(const handlerId of handlerIds(db,r))notify(repo,handlerId,'report','P22',r.id)}record=reportView(db,r,user,true);message=`Your name is shared with ${offices[r.stage]}.`;break}
    case'caseAction':{const p=actionPayloads.caseAction.parse(request.payload);const reason=reasonOf(request);const r=getCase();if(!caseActions(user,r).includes(p.type))throw conflict('That action is not available at this stage.');const previous=r.stage;let action=p.type as string;if(p.type==='convert'){requirePermission(user,'case.convert');r.caseFileId=repo.nextId('CF');r.status='Case File at Guidance';action='Case File opened'}else if(p.type==='resolve'){r.status='Resolved';action='Resolved'}else if(p.type==='close'){r.status='Closed';action='Closed'}else if(['escalate','transfer','return'].includes(p.type)){/* Fixed order: Dean to Guidance, Guidance to OSAS, OSAS to the President's Office (restored 2026-11-24, per the paper); the President's Office can return a case to OSAS. */const next:Partial<Record<Stage,Stage>>=p.type==='return'?{executive:'osas'}:{adviser:'chair',chair:'dean',dean:'guidance',guidance:'osas',osas:'executive'};let nextStage=next[r.stage]!;if(p.nextStage&&p.nextStage!==nextStage)throw conflict('This office cannot make that transfer.');/* An office where everyone is involved in the report cannot take it, so it is passed over, as when the report was filed. */while(next[nextStage]&&!db.users.some(u=>u.active&&canActCase(u,{...r,stage:nextStage})))nextStage=next[nextStage]!;if(!db.users.some(u=>u.active&&canActCase(u,{...r,stage:nextStage})))throw conflict('No office can take this report right now. Ask the CCS office for help.');if(r.stage==='guidance'&&!r.caseFileId)throw conflict('Open a Case File before transferring.');if(r.confidential)throw conflict('This concern is confidential. Remove the confidential mark before escalating it.');r.stage=nextStage;r.status=`Escalated to ${offices[nextStage]}`;action='Transferred'}else if(p.type==='respond'){addMessage(r.messages,p.update);action='Response sent'}else if(p.type==='milestone')action='Milestone added';else action='Action recorded';if(['escalate','transfer','resolve','close'].includes(p.type))releaseMeetingSlots(db,r.id);r.updatedAt=now();r.history.push({id:repo.nextId('HISTORY'),at:r.updatedAt,actorId:user.id,actorRole:stageRoles[previous],action,reason,update:p.update,public:true,stage:r.stage});audit(repo,user,'Case transition','cases',r.caseFileId??r.id);notify(repo,r.ownerId,'case',ownerPage(r),r.id);for(const handlerId of handlerIds(db,r))notify(repo,handlerId,'case','P22',r.id);for(const earlierId of earlierHandlerIds(db,r))if(earlierId!==user.id)notify(repo,earlierId,'case','P22',r.id);record=reportView(db,r,user, false);message=`${action}.`;break}
    case'addNote':{const p=actionPayloads.addNote.parse(request.payload);const r=getCase();const m=addMessage(r.notes,p.body);audit(repo,user,'Internal note recorded','cases',r.caseFileId??r.id);record=messageView(db,m);message='Internal note saved.';break}
    case'reviewCluster':{requirePermission(user,'cluster.review');const p=actionPayloads.reviewCluster.parse(request.payload);const reason=reasonOf(request);const c=find(db.clusters,id);if(c.program!==user.program)throw unavailable();c.status=p.decision==='confirmed'?'Confirmed':'Dismissed';c.history.push({at:now(),actorId:user.id,decision:c.status,reason});audit(repo,user,'Similarity group reviewed','cases',c.id);record=clusterViewFor(db,user,c);message='Group review recorded.';break}
    case'createConsultation':{requirePermission(user,'consultation.request');const p=actionPayloads.createConsultation.parse(request.payload);const appointmentIssue=appointmentProblem(p);if(appointmentIssue)throw new z.ZodError([{code:'custom',path:[appointmentIssue.path],message:appointmentIssue.message,input:undefined}]);const slot=find(db.slots,p.slotId);const faculty=find(db.users,slot.facultyId);if(!canReach(db,user,faculty))throw unavailable();const c=reserveSlot(repo,user.id,slot,p);record=consultationView(db,c,user);message='Request sent.';break}
    case'decideConsultation':{const p=actionPayloads.decideConsultation.parse(request.payload);const c=find(visibleConsultations(db,user),id);const student=c.studentId===user.id;const valid:Record<string,string[]>={Requested:['Approved','Declined','Cancelled'],Approved:['Booked','Cancelled'],Booked:['Completed','Cancelled'],Completed:[],Declined:[],Cancelled:[]};if(!valid[c.status]?.includes(p.decision)||student&&p.decision!=='Cancelled')throw conflict('That change is not available for this appointment.');if(!student)requirePermission(user,'consultation.decide');if(['Declined','Cancelled'].includes(p.decision)&&!(p.note?.trim()||request.reason?.trim()))throw new ApiError(400,'A reason is required.','VALIDATION_ERROR');const slot=find(db.slots,c.slotId);if(['Approved','Booked'].includes(p.decision)&&db.consultations.some(other=>other.id!==c.id&&other.slotId===slot.id&&['Approved','Booked'].includes(other.status)))throw conflict('This time is already booked.');c.status=p.decision;c.updatedAt=now();c.history.push({at:c.updatedAt,status:c.status,note:p.note??request.reason??'Status updated',actorId:user.id});slot.state=['Declined','Cancelled','Completed'].includes(c.status)?'open':c.status==='Booked'?'booked':'requested';notify(repo,student?c.facultyId:c.studentId,'consultation','P16',c.id);record=consultationView(db,c,user);message='Appointment updated.';break}
    case'saveAvailability':{requirePermission(user,'consultation.decide');const p=actionPayloads.saveAvailability.parse(request.payload);if(p.end<=p.start)throw new ApiError(400,'The end time must be later than the start time.','VALIDATION_ERROR');if(hasBegun(p.date,p.start))throw dateIssue('date','Choose a date and time from now on.');if(db.slots.some(s=>s.id!==id&&s.facultyId===user.id&&s.date===p.date&&s.start<p.end&&s.end>p.start))throw conflict('This time overlaps an existing slot.');const lesson=p.state==='open'?classAt(db,user.id,p.date,p.start,p.end):undefined;if(lesson)throw conflict(`This time overlaps your class ${lesson.subject} (${lesson.day} ${lesson.start} to ${lesson.end}). Choose a time outside your load.`);if(id){const s=find(db.slots,id);if(s.facultyId!==user.id)throw unavailable();if(['booked','requested'].includes(s.state))throw conflict('This time has a request. Cancel the appointment first.');delete s.reason;Object.assign(s,p);record=s}else{record={id:repo.nextId('SLOT'),facultyId:user.id,...p};db.slots.push(record as Database['slots'][number])}message='Availability saved.';break}
    case'deleteAvailability':{actionPayloads.deleteAvailability.parse(request.payload);requirePermission(user,'consultation.decide');const s=find(db.slots,id);if(s.facultyId!==user.id)throw unavailable();if(['booked','requested'].includes(s.state))throw conflict('Cancel the appointment before removing this time.');if(db.consultations.some(c=>c.slotId===s.id))throw conflict('This time has an appointment on record, so it stays. Mark it not available instead.');db.slots=db.slots.filter(slot=>slot.id!==s.id);message='Availability removed.';break}
    case'uploadLoadSchedule':{
      requirePermission(user,'load.manage')
      const p=actionPayloads.uploadLoadSchedule.parse(request.payload)
      if(p.endsOn<p.startsOn)throw new ApiError(400,'The term must end on or after the day it starts.','VALIDATION_ERROR')
      // All or nothing: a load with any bad row is not saved, and every problem is listed by row.
      const issues:z.core.$ZodIssue[]=[]
      const accepted:{facultyId:string;row:z.infer<typeof loadRowSchema>}[]=[]
      for(const [index,raw] of p.rows.entries()){
        const parsed=loadRowSchema.safeParse(raw)
        if(!parsed.success){for(const issue of parsed.error.issues)issues.push({...issue,path:['rows',index,...issue.path]});continue}
        const faculty=db.users.find(u=>isFaculty(u)&&u.email.toLowerCase()===parsed.data.facultyEmail)
        if(!faculty){issues.push({code:'custom',path:['rows',index,'facultyEmail'],message:'No active faculty account has this email.',input:undefined});continue}
        const clash=accepted.find(a=>a.facultyId===faculty.id&&a.row.day===parsed.data.day&&a.row.start<parsed.data.end&&parsed.data.start<a.row.end)
        if(clash){issues.push({code:'custom',path:['rows',index,'start'],message:`This class overlaps ${clash.row.subject} (${clash.row.day} ${clash.row.start} to ${clash.row.end}) for the same faculty member.`,input:undefined});continue}
        accepted.push({facultyId:faculty.id,row:parsed.data})
      }
      if(issues.length)throw new z.ZodError(issues)
      // Uploading again replaces each listed faculty member's classes for the term.
      const replaced=new Set(accepted.map(a=>a.facultyId))
      db.loadSchedules=db.loadSchedules.filter(c=>!(c.term===p.term&&replaced.has(c.facultyId)))
      const at=now()
      for(const {facultyId,row} of accepted)db.loadSchedules.push({id:repo.nextId('LOAD'),facultyId,term:p.term,startsOn:p.startsOn,endsOn:p.endsOn,day:row.day,start:row.start,end:row.end,subject:row.subject,...(row.section?{section:row.section}:{}),...(row.room?{room:row.room}:{}),uploadedBy:user.id,at})
      audit(repo,user,'Faculty load uploaded','scheduling',p.term)
      const conflicts=db.slots.filter(s=>replaced.has(s.facultyId)&&s.state!=='unavailable'&&classAt(db,s.facultyId,s.date,s.start,s.end)).length
      record={term:p.term,faculty:replaced.size,classes:accepted.length,conflicts}
      message=conflicts?`Load saved. ${conflicts} appointment ${conflicts===1?'time overlaps':'times overlap'} a class; see the list.`:'Load saved.'
      break
    }
    case'addMaterial':{
      const p=actionPayloads.addMaterial.parse(request.payload)
      const space=find(db.spaces,p.spaceId)
      if(!canSpace(user,space)||isSectionSpace(space))throw unavailable()
      if(!teachesSubject(user,space))throw deny()
      const at=now()
      const material:Material={id:repo.nextId('MATERIAL'),spaceId:space.id,kind:'link',title:p.title,url:p.url,...(p.note?{note:p.note}:{}),authorId:user.id,at,updatedAt:at}
      db.materials.push(material)
      audit(repo,user,'Class material added','academic',material.id)
      record=material
      message='Material added.'
      break
    }
    case'commentMaterial':case'deleteMaterialComment':{
      const material=find(db.materials,id)
      const space=find(db.spaces,material.spaceId)
      if(!opensMaterials(user,space)||material.kind==='file'&&material.status!=='ready')throw unavailable()
      if(request.action==='deleteMaterialComment'){
        const p=actionPayloads.deleteMaterialComment.parse(request.payload)
        const comment=(material.comments??[]).find(c=>c.id===p.commentId)
        if(!comment)throw unavailable()
        if(comment.authorId!==user.id&&!teachesSubject(user,space))throw deny()
        material.comments=(material.comments??[]).filter(c=>c.id!==comment.id)
        audit(repo,user,'Class material comment removed','academic',material.id)
        record={id:comment.id};message='Comment removed.';break
      }
      if(user.restrictions.includes('post.comment'))throw deny()
      const p=actionPayloads.commentMaterial.parse(request.payload)
      // Comments on materials are not held for review like forum comments, so a blocked word is refused outright.
      if(findFlaggedWord(p.body))throw new z.ZodError([{code:'custom',path:['body'],message:'Please rephrase: this comment has a word the portal does not allow.',input:undefined}])
      material.comments=material.comments??[]
      const added=addMessage(material.comments,p.body)
      record={...messageView(db,added),canDelete:true}
      message='Comment added.'
      break
    }
    case'updateMaterial':case'removeMaterial':{
      const material=find(db.materials,id)
      const space=find(db.spaces,material.spaceId)
      if(!opensMaterials(user,space))throw unavailable()
      if(!teachesSubject(user,space))throw deny()
      if(request.action==='removeMaterial'){actionPayloads.removeMaterial.parse(request.payload??{});db.materials=db.materials.filter(m=>m.id!==material.id);if(material.key)outbox.push({kind:'deleteFile',key:material.key});audit(repo,user,'Class material removed','academic',material.id);record={id:material.id};message='Material removed.';break}
      const p=actionPayloads.updateMaterial.parse(request.payload)
      if(material.kind==='link'&&!p.url)throw new z.ZodError([{code:'custom',path:['url'],message:'Enter the link.',input:undefined}])
      if(material.kind==='file'&&p.url)throw new z.ZodError([{code:'custom',path:['url'],message:'A file keeps its file. Remove it and add a link instead.',input:undefined}])
      delete material.note
      Object.assign(material,{title:p.title,...(p.url?{url:p.url}:{}),...(p.note?{note:p.note}:{}),updatedAt:now()})
      audit(repo,user,'Class material changed','academic',material.id)
      record=material
      message='Material saved.'
      break
    }
    case'createTodo':{requirePermission(user,'todo.manage');const p=actionPayloads.createTodo.parse(request.payload);if(p.date<campusNow().date)throw dateIssue('date','Choose today or a later date.');const todo={id:repo.nextId('TODO'),ownerId:user.id,...p,done:false};db.todos.push(todo);record=todo;message='To-do added.';break}
    case'toggleTodo':case'deleteTodo':{requirePermission(user,'todo.manage');const todo=find(db.todos,id);if(todo.ownerId!==user.id)throw unavailable();if(request.action==='toggleTodo')todo.done=actionPayloads.toggleTodo.parse(request.payload).done;else{actionPayloads.deleteTodo.parse(request.payload);db.todos=db.todos.filter(t=>t.id!==todo.id)}record=todo;message='To-do updated.';break}
    case 'createThread': {
      requirePermission(user, 'message.send')
      const payload = actionPayloads.createThread.parse(request.payload)
      const recipient = find(db.users, payload.recipientId)
      if (!canReach(db, user, recipient)) throw unavailable()
      const existing = db.threads.find(thread =>
        !thread.spaceId
        && !thread.group
        && thread.memberIds.includes(user.id)
        && thread.memberIds.includes(recipient.id),
      )
      const thread: Thread = existing ?? {
        id: repo.nextId('THREAD'),
        title: recipient.name,
        memberIds: [user.id, recipient.id],
        messages: [],
        mutedBy: [],
        readMessageCounts: {},
      }
      if (!existing) db.threads.push(thread)
      const first = addMessage(thread.messages, payload.body, payload.attachments)
      const held = !!payload.body && autoFlag(repo, { itemType: 'message', itemId: first.id, parentId: thread.id, authorId: user.id, text: payload.body })
      thread.readMessageCounts[user.id] = thread.messages.length
      // A message the word filter holds does not show its words in the notification.
      notify(repo, recipient.id, 'message', 'P12', thread.id, { body: messageNotice(user, thread, payload.body, held), itemId: first.id })
      record = { id: thread.id, title: threadTitle(db, thread, user) }
      message = 'Message sent.'
      break
    }
    case 'createGroupThread': {
      // Anyone who can message may start a group with people they can message (decided 16 November 2026).
      requirePermission(user, 'message.send')
      const payload = actionPayloads.createGroupThread.parse(request.payload)
      const memberIds = [...new Set(payload.memberIds.filter(memberId => memberId !== user.id))]
      if (memberIds.length < 2) throw new z.ZodError([{ code: 'custom', path: ['memberIds'], message: 'Add at least two other people.', input: undefined }])
      const members = memberIds.map(memberId => find(db.users, memberId))
      if (members.some(member => !canReach(db, user, member))) throw unavailable()
      const thread: Thread = { id: repo.nextId('THREAD'), title: payload.title, group: true, memberIds: [user.id, ...memberIds], messages: [], mutedBy: [], readMessageCounts: {} }
      db.threads.push(thread)
      const first = addMessage(thread.messages, payload.body, payload.attachments)
      const held = !!payload.body && autoFlag(repo, { itemType: 'message', itemId: first.id, parentId: thread.id, authorId: user.id, text: payload.body })
      thread.readMessageCounts[user.id] = thread.messages.length
      for (const member of members) notify(repo, member.id, 'message', 'P12', thread.id, { body: messageNotice(user, thread, payload.body, held), itemId: first.id })
      audit(repo, user, 'Group conversation started', 'messages', thread.id)
      record = { id: thread.id, title: thread.title }
      message = 'Group started.'
      break
    }
    case 'sendMessage': {
      const payload = actionPayloads.sendMessage.parse(request.payload)
      const thread = find(db.threads, id)
      if (!canThread(db, user, thread)) throw unavailable()
      const sent = addMessage(thread.messages, payload.body, payload.attachments)
      thread.readMessageCounts[user.id] = thread.messages.length
      const drafts = messageDraftsOf(db, user, false)
      if (drafts?.[thread.id]) delete drafts[thread.id]
      const held = !!payload.body && autoFlag(repo, { itemType: 'message', itemId: sent.id, parentId: thread.id, authorId: user.id, text: payload.body })
      for (const recipientId of thread.memberIds.filter(memberId => memberId !== user.id)) {
        notify(repo, recipientId, 'message', 'P12', thread.id, { body: messageNotice(user, thread, payload.body, held), itemId: sent.id })
      }
      record = messageView(db, sent)
      message = 'Message sent.'
      break
    }
    case 'addGroupMembers': {
      // A member adds people they can message to a group someone started (QA 17 November, V3). Class groups follow the
      // class list, and direct conversations stay between two people.
      requirePermission(user, 'message.send')
      const payload = actionPayloads.addGroupMembers.parse(request.payload)
      const thread = find(db.threads, id)
      if (!canThread(db, user, thread)) throw unavailable()
      if (!thread.group) throw conflict('People can only be added to a group someone started.')
      const added = [...new Set(payload.memberIds)].filter(memberId => !thread.memberIds.includes(memberId))
      if (!added.length) throw conflict('Everyone you chose is already in this group.')
      if (thread.memberIds.length + added.length > 50) throw conflict('A group can have at most 50 people.')
      const people = added.map(memberId => find(db.users, memberId))
      if (people.some(person => !canReach(db, user, person))) throw unavailable()
      thread.memberIds.push(...added)
      // They see the conversation from the start, as messages already in it are part of the group; none count as unread.
      for (const person of people) {
        thread.readMessageCounts[person.id] = thread.messages.length
        notify(repo, person.id, 'message', 'P12', thread.id, { body: `${user.name} added you to ${thread.title ?? 'a group'}.` })
      }
      audit(repo, user, 'People added to a group conversation', 'messages', thread.id)
      record = { id: thread.id, memberIds: thread.memberIds }
      message = added.length === 1 ? `${people[0]!.name} was added.` : `${added.length} people were added.`
      break
    }
    case 'saveMessageDraft': {
      const payload = actionPayloads.saveMessageDraft.parse(request.payload)
      const thread = find(db.threads, id)
      if (!canThread(db, user, thread)) throw unavailable()
      const drafts = messageDraftsOf(db, user)
      if (!payload.body.trim() && !payload.attachments.length) delete drafts[thread.id]
      else drafts[thread.id] = { body: payload.body, attachments: payload.attachments, at: now() }
      record = drafts[thread.id] ?? null
      message = 'Draft saved.'
      break
    }
    // The author edits or takes back their own message (decided 19 November 2026). A message under review stays as it is
    // until it is decided, so an edit cannot hide what was flagged. Notification previews of the old words are cleared.
    case 'editMessage': case 'deleteMessage': {
      const payload = request.action === 'editMessage' ? actionPayloads.editMessage.parse(request.payload) : { ...actionPayloads.deleteMessage.parse(request.payload), body: '' }
      const thread = find(db.threads, id)
      if (!canThread(db, user, thread)) throw unavailable()
      const own = find(thread.messages, payload.messageId)
      if (own.authorId !== user.id) throw deny()
      if (own.deleted) throw conflict('This message was deleted.')
      if (heldItem(db, 'message', own.id)) throw conflict('This message is being reviewed, so it cannot be changed now.')
      redactNotices(db, own.id)
      if (request.action === 'deleteMessage') {
        own.deleted = true
        own.body = ''
        own.attachments = undefined
        message = 'Message deleted.'
      } else {
        own.body = payload.body
        own.editedAt = now()
        autoFlag(repo, { itemType: 'message', itemId: own.id, parentId: thread.id, authorId: user.id, text: payload.body })
        message = 'Message edited.'
      }
      record = messageView(db, own)
      break
    }
    case 'muteThread': {
      const payload = actionPayloads.muteThread.parse(request.payload)
      const thread = find(db.threads, id)
      if (!canThread(db, user, thread)) throw unavailable()
      thread.mutedBy = payload.muted
        ? [...new Set([...thread.mutedBy, user.id])]
        : thread.mutedBy.filter(memberId => memberId !== user.id)
      message = 'Mute setting saved.'
      break
    }
    case 'markThreadRead': {
      actionPayloads.markThreadRead.parse(request.payload)
      const thread = find(db.threads, id)
      if (!canThread(db, user, thread)) throw unavailable()
      thread.readMessageCounts[user.id] = thread.messages.length
      message = 'Conversation marked as read.'
      break
    }
    case'markNotification':case'openNotification':{const n=find(db.notifications,id);if(n.recipientId!==user.id)throw unavailable();if(request.action==='openNotification'){actionPayloads.openNotification.parse(request.payload);readPage(repo,user,n.pageId,n.recordId?{id:n.recordId}:{});n.read=true;record={pageId:n.pageId,recordId:n.recordId}}else n.read=actionPayloads.markNotification.parse(request.payload).read;message='Notification updated.';break}
    case'markAllNotifications':actionPayloads.markAllNotifications.parse(request.payload);db.notifications.filter(n=>n.recipientId===user.id).forEach(n=>{n.read=true});message='Notifications marked as read.';break
    case'assistantAsk':{requirePermission(user,'assistant.use');const p=actionPayloads.assistantAsk.parse(request.payload);const started=Date.now();record=assistantAnswer(db,user,p.question);db.telemetry.push({id:repo.nextId('TELEMETRY'),at:now(),category:'assistant',durationMs:Date.now()-started,success:true});message='Answer ready.';break}
    case'submitEvaluation':{requirePermission(user,'evaluation.fill');const p=actionPayloads.submitEvaluation.parse(request.payload);const a=find(db.assignments,id);if(a.evaluatorId!==user.id)throw unavailable();const cycle=find(db.cycles,a.cycleId);if(cycle.status!=='Published')throw conflict('This evaluation is not open.');if(!isCycleForm(db,a)&&!a.submittedAt)throw conflict('This form is not part of this evaluation cycle.');if(a.submittedAt)throw conflict('This evaluation has already been submitted.');for(const q of cycle.questions){const value=p.answers[q.id];if(q.required&&(value===undefined||value===''))throw new ApiError(400,'Answer every required question.','VALIDATION_ERROR');if(value!==undefined&&(q.type==='rating'&&typeof value!=='number'||q.type==='text'&&typeof value!=='string'))throw new ApiError(400,'One answer is in the wrong format.','VALIDATION_ERROR')}if(Object.keys(p.answers).some(key=>!cycle.questions.some(q=>q.id===key)))throw new ApiError(400,'One answer does not belong to this form.','VALIDATION_ERROR');a.answers=p.answers;a.comment=p.comment;a.submittedAt=now();record=assignmentView(db,a,true);message='Evaluation submitted.';break}
    case'createCycle':{requirePermission(user,'evaluation.configure');const p=actionPayloads.createCycle.parse(request.payload);if(p.opens<campusNow().date)throw dateIssue('opens','Choose today or a later opening date.');if(p.closes<p.opens)throw new ApiError(400,'The closing date must be after the opening date.','VALIDATION_ERROR');const cycle={id:repo.nextId('CYCLE'),...p,status:'Draft' as const,instructions:'',questions:[],forms:[studentForm],resultsPublished:false,reviews:[]};db.cycles.push(cycle);record=cycle;message='Draft cycle created.';break}
    case'saveCycle':{requirePermission(user,'evaluation.configure');const p=actionPayloads.saveCycle.parse(request.payload);const c=find(db.cycles,id);if(!['Draft','In review'].includes(c.status))throw conflict('You cannot change questions after the form is published.');if(p.opens!==c.opens&&p.opens<campusNow().date)throw dateIssue('opens','Choose today or a later opening date.');if(p.closes<p.opens)throw new ApiError(400,'The closing date must be after the opening date.','VALIDATION_ERROR');Object.assign(c,p,{forms:[...new Set([studentForm,...(p.forms??c.forms)])]});/* Saving answers every Needs change: those professors review the edited questions again. */c.reviews=c.reviews.filter(r=>r.decision!=='changes');record=c;message='Cycle saved.';break}
    case'cycleAction':{requirePermission(user,'evaluation.configure');const p=actionPayloads.cycleAction.parse(request.payload);const c=find(db.cycles,id);const next:Record<string,string>={Draft:'In review','In review':'Published',Published:'Closed'};if(next[c.status]!==p.status)throw conflict('The cycle cannot move to that status.');if(p.status==='Published'){/* The same professors the cycle page lists and the In review notice reaches: every active professor (QA 17 November, V3: the count only had those with classes in the cycle, so it never matched). */const reviewers=db.users.filter(u=>u.active&&hasRole(u,'professor')).map(u=>u.id);const waiting=reviewers.filter(fid=>!c.reviews.some(r=>r.userId===fid)).length;if(waiting)throw conflict(`${waiting} faculty ${waiting===1?'member has':'members have'} not reviewed the questions yet. Publish once every review is in.`);const open=c.reviews.filter(r=>r.decision==='changes').length;if(open)throw conflict(`${open} faculty ${open===1?'member asked':'members asked'} for question changes. Edit the questions and save to resolve; they review again before you publish.`)}if(!c.title||!c.instructions||!c.questions.length||!c.forms.length||c.closes<c.opens)throw new ApiError(400,'Add a name, instructions, dates, forms, and questions first.','VALIDATION_ERROR');c.status=p.status;if(['In review','Published'].includes(p.status))ensureCycleAssignments(repo,c);if(p.status==='In review')for(const professor of db.users.filter(u=>u.active&&hasRole(u,'professor')))notify(repo,professor.id,'evaluation','P32',c.id,{body:`Review the questions for ${c.title} before it is published.`});if(p.status==='Published')for(const recipientId of [...new Set(db.assignments.filter(a=>a.cycleId===c.id).map(a=>a.evaluatorId))])notify(repo,recipientId,'evaluation','P26');if(p.publishResults&&p.status==='Closed')c.resultsPublished=true;audit(repo,user,'Evaluation cycle changed','evaluations',c.id);record=c;message='Cycle updated.';break}
    case'reviewQuestions':{requirePermission(user,'evaluation.review');const p=actionPayloads.reviewQuestions.parse(request.payload);if(p.decision==='changes'&&!p.note.trim())throw dateIssue('note','Say what should change.');const c=find(db.cycles,id);if(!hasRole(user,'professor'))throw unavailable();if(c.status!=='In review'||c.reviews.some(r=>r.userId===user.id))throw conflict('There are no questions to review right now.');c.reviews.push({userId:user.id,...p,at:now()});record={id:c.id,review:c.reviews.at(-1)};message='Review sent.';break}
    case'saveFollowUp':{requireRole(user,'chair','dean');const p=actionPayloads.saveFollowUp.parse(request.payload);const faculty=find(db.users,id);if(!canFacultyResult(user,faculty))throw unavailable();db.followUps.push({id:repo.nextId('FOLLOWUP'),facultyId:faculty.id,actorId:user.id,note:p.note,at:now()});audit(repo,user,'Evaluation follow-up recorded','evaluations',faculty.id);message='Follow-up note saved.';break}
    case'openRecord':{const p=actionPayloads.openRecord.parse(request.payload);record=readPage(repo,user,'P34',{id,...p}).data.record;message='Record opened and logged.';break}
    case'reviewGoodMoral':{requirePermission(user,'goodmoral.review');const p=actionPayloads.reviewGoodMoral.parse(request.payload);const student=find(db.users,id);if(!canStudentRecord(db,user,student))throw unavailable();const review={studentId:student.id,...p,actorId:user.id,at:now()};db.goodMoral=db.goodMoral.filter(g=>g.studentId!==student.id);db.goodMoral.push(review);audit(repo,user,'Good Moral prerequisite reviewed','records',student.studentId??student.id);record=review;message='Review saved.';break}
    case 'recommendStrike': {
      requirePermission(user, 'strike.recommend')
      const p = actionPayloads.recommendStrike.parse(request.payload)
      // The Dean recommends while the case is with the Dean, against a student the concern names, never the reporter.
      const r = find(db.reports, p.reportId)
      if (!canActCase(user, r) || r.stage !== 'dean') throw unavailable()
      const student = find(db.users, p.studentId)
      if (!hasRole(student, 'student')) throw unavailable()
      if (r.ownerId === student.id) throw conflict('A strike is recorded against the reported student, not the student who filed the concern.')
      if (!r.involvedUserIds.includes(student.id)) throw conflict('Recommend a strike only against a student named in the concern.')
      if (db.strikes.some(s => s.reportId === r.id && s.studentId === student.id && s.status !== 'rejected')) throw conflict('This case already has a strike for this student.')
      const s: Strike = { id: repo.nextId('STRIKE'), studentId: student.id, reportId: r.id, kind: 'report', note: p.note, actorId: user.id, at: now(), status: 'recommended' }
      db.strikes.push(s)
      // Written with the report, so two recommendations at once conflict on it and the second runs again and is refused.
      r.updatedAt = s.at
      audit(repo, user, 'Strike recommended', 'records', student.studentId ?? student.id)
      record = strikeView(db, s)
      message = 'Strike recommended. OSAS confirms it when the case reaches them.'
      break
    }
    case 'decideStrike': {
      requirePermission(user, 'strike.record')
      const p = actionPayloads.decideStrike.parse(request.payload)
      const s = find(db.strikes, p.strikeId)
      // OSAS decides on the case it is handling.
      const r = find(db.reports, s.reportId)
      if (!canActCase(user, r) || r.stage !== 'osas') throw unavailable()
      if (s.status !== 'recommended') throw conflict('This strike has already been decided.')
      if (p.decision === 'reject' && !p.note) throw new ApiError(400, 'Give a reason for rejecting the strike.', 'VALIDATION_ERROR')
      const student = find(db.users, s.studentId)
      const wasOnHold = clearanceOf(db, student.id).onHold
      Object.assign(s, { status: p.decision === 'confirm' ? 'confirmed' : 'rejected', decidedBy: user.id, decidedAt: now(), ...(p.note ? { decisionNote: p.note } : {}) })
      audit(repo, user, p.decision === 'confirm' ? 'Strike confirmed' : 'Strike rejected', 'records', student.studentId ?? student.id)
      const clearance = clearanceView(db, student.id)
      const placed = clearance.onHold && !wasOnHold
      if (placed) audit(repo, user, 'Clearance hold placed', 'records', student.studentId ?? student.id)
      record = { strike: strikeView(db, s), strikes: strikeViews(db, student.id), clearance }
      message = p.decision === 'reject' ? 'Strike rejected. It does not count.' : placed ? 'Strike confirmed. The student’s clearance is now on hold.' : 'Strike confirmed.'
      break
    }
    case 'settleStrikes': {
      requirePermission(user, 'strike.record')
      const p = actionPayloads.settleStrikes.parse(request.payload)
      const student = find(db.users, p.studentId)
      if (!hasRole(student, 'student') || !canStudentRecord(db, user, student)) throw unavailable()
      const before = clearanceOf(db, student.id)
      if (!before.onHold) throw conflict('This student has no clearance hold to settle.')
      db.strikeSettlements.push({ id: repo.nextId('SETTLE'), studentId: student.id, kind: p.kind, reference: p.reference, note: p.note, strikeIds: before.unsettled.map(s => s.id), actorId: user.id, at: now() })
      audit(repo, user, 'Clearance hold settled', 'records', student.studentId ?? student.id)
      record = { strikes: strikeViews(db, student.id), clearance: clearanceView(db, student.id) }
      message = 'Settlement recorded. The clearance hold is lifted; the strikes stay on the record.'
      break
    }
    case'applyRestriction':{requireRole(user,'administrator');const p=actionPayloads.applyRestriction.parse(request.payload);reasonOf(request);const student=find(db.users,p.studentId);if(!hasRole(student,'student'))throw unavailable();if(p.until<=campusNow().date)throw new ApiError(400,'Choose tomorrow or a later end date.','VALIDATION_ERROR');const {notifyStudent,...fields}=p;const r={id:repo.nextId('RST'),...fields,starts:now(),actorId:user.id,active:true};db.restrictions.push(r);closeReferrals(db,student.id,user,'restriction changed');audit(repo,user,'Restriction applied','restrictions',r.id);if(notifyStudent)notify(repo,student.id,'restriction','P36',undefined,{body:`Paused until ${p.until}: ${featureWords(p.features)}. Reason: ${p.basis}`});record=r;message='Selected features paused.';break}
    case'liftRestriction':{requireRole(user,'administrator');actionPayloads.liftRestriction.parse(request.payload);reasonOf(request);const r=find(db.restrictions,id);if(!r.active||r.until<now().slice(0,10))throw conflict('This restriction has already ended.');r.active=false;closeReferrals(db,r.studentId,user,'restriction lifted');audit(repo,user,'Restriction lifted','restrictions',r.id);notify(repo,r.studentId,'restriction','P36',undefined,{body:`Available again: ${featureWords(r.features)}.`});record=r;message='Restriction lifted.';break}
    // The administrator extends or shortens an active restriction, as OSAS and Guidance may ask (QA 17 November: only Lift was possible).
    case'changeRestrictionEnd':{requireRole(user,'administrator');const p=actionPayloads.changeRestrictionEnd.parse(request.payload);reasonOf(request);const r=find(db.restrictions,id);if(!r.active||r.until<campusNow().date)throw conflict('This restriction has already ended.');if(p.until<=campusNow().date)throw new ApiError(400,'Choose tomorrow or a later end date.','VALIDATION_ERROR');if(p.until===r.until)throw new ApiError(400,'Choose a different end date.','VALIDATION_ERROR');const longer=p.until>r.until;r.until=p.until;closeReferrals(db,r.studentId,user,longer?'restriction extended':'restriction shortened');audit(repo,user,longer?'Restriction extended':'Restriction shortened','restrictions',r.id);notify(repo,r.studentId,'restriction','P36',undefined,{body:`Now paused until ${p.until}: ${featureWords(r.features)}.`});record=r;message=longer?'Restriction extended.':'Restriction shortened.';break}
    case'declineReferral':{requireRole(user,'administrator');actionPayloads.declineReferral.parse(request.payload);const reason=reasonOf(request);const referral=find(db.referrals,id);if(referral.status!=='Awaiting administrator review')throw conflict('This request was already handled.');Object.assign(referral,{status:'Declined',handledAt:now(),handledBy:user.id});audit(repo,user,'Restriction change declined','restrictions',referral.id,undefined,reason);notify(repo,referral.actorId,'restriction','P35',undefined,{body:`Your request to ${referral.change.toLowerCase()} a restriction was declined. Reason: ${reason}`});record=referral;message='Request declined. The restriction is unchanged.';break}
    case'referRestriction':{requireRole(user,'guidance','osas');const p=actionPayloads.referRestriction.parse(request.payload);const reason=reasonOf(request);const student=find(db.users,p.studentId);if(!canStudentRecord(db,user,student))throw unavailable();const referral={id:repo.nextId('REF'),studentId:student.id,change:p.change,decisionReference:p.decisionReference??'',reason,actorId:user.id,at:now(),status:'Awaiting administrator review'};db.referrals.push(referral);audit(repo,user,'Restriction change requested','restrictions',referral.id);for(const admin of db.users.filter(u=>hasRole(u,'administrator')))notify(repo,admin.id,'restriction','P35');record=referral;message='Request sent. Existing restrictions are unchanged.';break}
    case'setProfilePhoto':{
      const p=actionPayloads.setProfilePhoto.parse(request.payload)
      // The data URL is checked again here for the decoded size: base64 is about four characters for three bytes.
      if(p.photo&&Math.floor((p.photo.length-p.photo.indexOf(',')-1)*3/4)>80_000)throw new ApiError(400,'Use a smaller image (at most 80 KB).','VALIDATION_ERROR')
      if(p.photo)db.photos[user.id]=p.photo;else delete db.photos[user.id]
      attachPhotos(db)
      record=person(find(db.users,user.id));message=p.photo?'Profile photo saved.':'Profile photo removed.';break}
    case'saveProfile':{const p=actionPayloads.saveProfile.parse(request.payload);/* Students hold no office hours (QA 17 November, V3). */if(hasRole(user,'student')&&p.officeHours)throw new ApiError(400,'Students have no office hours.','VALIDATION_ERROR');const saved=find(db.users,user.id);/* Once set, About and Office hours cannot be saved blank (QA v5, E6). */for(const[key,label]of[['bio','About'],['officeHours','Office hours']]as const){if(saved[key]&&!p[key]&&!(key==='officeHours'&&hasRole(user,'student')))throw new ApiError(400,`${label} cannot be left blank.`,'VALIDATION_ERROR')}Object.assign(saved,p);Object.assign(user,p);record=person(user);message='Profile saved.';break}
    case'saveSettings':{const p=actionPayloads.saveSettings.parse(request.payload);db.settings[user.id]={...(db.settings[user.id]??defaultSettings(user)),...p};record=db.settings[user.id];message='Settings saved.';break}
    case'saveNotificationPreferences':{const p=actionPayloads.saveNotificationPreferences.parse(request.payload);if(Object.keys(p.priorities).some(key=>!notificationCategories(user).includes(key)))throw new ApiError(400,'Your account does not have that notification category.','VALIDATION_ERROR');const mutedRequired=Object.entries(p.priorities).find(([key,value])=>value==='muted'&&requiredNotificationCategories.includes(key));if(mutedRequired)throw new ApiError(400,`${requiredCategoryLabels[mutedRequired[0]]} cannot be muted.`,'VALIDATION_ERROR');/* Saved preferences do not change source access. */db.settings[user.id]={...(db.settings[user.id]??defaultSettings(user)),priorities:p.priorities};record=db.settings[user.id];message='Notification priorities saved.';break}
    case'addOrganizationMember':case'removeOrganizationMember':case'setMemberPosition':{
      // Only the organization's own account manages its members (19 November 2026).
      const organization=find(db.organizations,id);if(organization.representativeId!==user.id)throw deny()
      if(request.action==='addOrganizationMember'){const p=actionPayloads.addOrganizationMember.parse(request.payload);const student=db.users.find(u=>u.id===p.studentId&&u.active&&hasRole(u,'student'));if(!student)throw unavailable();if(!organization.memberIds.includes(student.id))organization.memberIds.push(student.id);if(p.position)organization.positions={...organization.positions,[student.id]:p.position};notify(repo,student.id,'organization','P10',organization.id,{body:`You were added to ${organization.name}${p.position?` as ${p.position}`:''}.`});message=`${student.name} added.`}
      else if(request.action==='removeOrganizationMember'){const p=actionPayloads.removeOrganizationMember.parse(request.payload);if(!organization.memberIds.includes(p.studentId))throw unavailable();organization.memberIds=organization.memberIds.filter(m=>m!==p.studentId);if(organization.positions){const{[p.studentId]:_gone,...rest}=organization.positions;organization.positions=rest}message='Member removed.'}
      else{const p=actionPayloads.setMemberPosition.parse(request.payload);if(!organization.memberIds.includes(p.memberId))throw unavailable();const{[p.memberId]:_old,...rest}=organization.positions??{};organization.positions=p.position?{...rest,[p.memberId]:p.position}:rest;message=p.position?`Position set to ${p.position}.`:'Position cleared.'}
      audit(repo,user,request.action==='addOrganizationMember'?'Organization member added':request.action==='removeOrganizationMember'?'Organization member removed':'Organization position changed','community',organization.id)
      record={id:organization.id,memberIds:organization.memberIds,positions:organization.positions??{}};break}
    case'updateRoles':{requirePermission(user,'role.manage');const p=actionPayloads.updateRoles.parse(request.payload);reasonOf(request);const account=find(db.users,id);/* Nobody changes their own roles, and only the System Administrator touches the administrator, Dean and Secretary accounts: role assignment must not go around lockedPermissions (code review, 23 November 2026). */if(account.id===user.id)throw new ApiError(403,'Someone else has to change your own roles.','FORBIDDEN');if(!hasRole(user,'administrator')&&[...account.roles,...p.roles].some(r=>privilegedRoles.includes(r)))throw new ApiError(403,'Only the System Administrator changes the administrator, Dean and CCS Secretary accounts.','FORBIDDEN');const roleProblem=rolesProblem(p.roles,p.section,account.roles);if(roleProblem)throw new ApiError(400,roleProblem,'VALIDATION_ERROR');if(p.roles.some(r=>['student','chair'].includes(r))&&!p.program&&!account.program)throw new ApiError(400,'Choose a program for that role.','VALIDATION_ERROR');/* One Program Chair per program, inactive ones too (QA v5): reports go to the chair of the program. Only checked when the edit adds chair or moves it to another program, so legacy duplicates stay repairable. */const chairOf=p.roles.includes('chair')?p.program??account.program:undefined;const otherChair=chairOf&&!(hasRole(account,'chair')&&account.program===chairOf)?db.users.find(u=>u.id!==account.id&&hasRole(u,'chair')&&u.program===chairOf):undefined;if(otherChair)throw conflict(`${chairOf} already has a Program Chair, ${otherChair.name}. Replace them under Accounts, Program chairs, or take that role from them first.`);if(p.irregular!==undefined&&!p.roles.includes('student'))throw new ApiError(400,'Only students can be irregular.','VALIDATION_ERROR');if(p.year!==undefined){if(!p.roles.includes('student'))throw new ApiError(400,'Only students have a year level.','VALIDATION_ERROR');const yearIssue=campusYearProblem(account.campus??mainCampus,p.year);if(yearIssue)throw new ApiError(400,yearIssue,'VALIDATION_ERROR');account.year=p.year}account.roles=p.roles;if(p.irregular!==undefined)account.irregular=p.irregular;if(p.program)account.program=p.program;if(p.section)account.section=p.section.trim().toUpperCase();if(p.active!==undefined)account.active=p.active;audit(repo,user,'Role assignment changed','identity',account.id,undefined,reasonOf(request));notify(repo,account.id,'role','P43');record={...person(account),active:account.active,...(account.irregular!==undefined?{irregular:account.irregular}:{})};message='Assignment saved. The new roles apply to the user right away.';break}
    case'updatePermission':{
      // The Secretary owns the matrix: her change applies at once and is audited. The administrator's is a request she approves (QA v5 D2).
      requirePermission(user,'role.manage');const p=actionPayloads.updatePermission.parse(request.payload);const reason=reasonOf(request)
      if(!permissionRoles[p.permission])throw new ApiError(400,'That permission does not exist.','VALIDATION_ERROR')
      if(lockedPermissions.includes(p.permission))throw new ApiError(400,'Who manages roles, accounts, approvals and the audit trail cannot be changed by a request.','VALIDATION_ERROR')
      const key=`${p.role}:${p.permission}`
      const current=overrideOf(db.permissionOverrides[key])
      if(roleHas(p.role,p.permission)===p.allowed&&!current.proposal)throw conflict(p.allowed?'That role already has this permission.':'That role already does not have this permission.')
      if(hasRole(user,'secretary')){
        // Her direct edit settles a waiting administrator request: record it as a decision and tell the proposer.
        const waiting=current.proposal,decisions=[...current.decisions]
        if(waiting){const same=waiting.allowed===p.allowed,why=same?reason:'Changed directly by the CCS Secretary'
          decisions.push({at:now(),by:user.id,decision:same?'Approved':'Rejected',allowed:waiting.allowed,reason:why})
          if(waiting.by)notify(repo,waiting.by,'permission','P48',key,{body:`Your request to ${waiting.allowed?'give':'take'} "${p.permission}" was ${same?'approved':'rejected'}. Reason: ${why}`})}
        if(!waiting||waiting.allowed!==p.allowed)decisions.push({at:now(),by:user.id,decision:'Approved',allowed:p.allowed,reason})
        db.permissionOverrides[key]={approved:p.allowed,decisions}
        setApprovedOverrides(approvedOverrides(db))
        audit(repo,user,'Permission change applied','identity',key,undefined,reason)
        record={...p,key,status:'Applied'};message='Applied. The change is now in force.';break
      }
      db.permissionOverrides[key]={...current,proposal:{allowed:p.allowed,by:user.id,at:now(),reason}}
      audit(repo,user,'Permission change proposed','identity',key,undefined,reason)
      const deciders=permissionDeciders(db,user)
      for(const decider of deciders)notify(repo,decider.id,'permission','P48',key,{body:`${user.name} asked to ${p.allowed?'give':'take'} "${p.permission}" ${p.allowed?'to':'from'} ${roleLabels[p.role]}. Approve or reject it under Permissions.`})
      record={...p,status:'Waiting for approval'}
      message=deciders.some(d=>hasRole(d,'secretary'))?'Sent to the CCS Secretary for approval.':deciders.length?'Sent for approval.':'Saved, but no CCS Secretary is active to approve it yet.'
      break}
    case'decidePermission':{
      requirePermission(user,'permission.review');const p=actionPayloads.decidePermission.parse(request.payload);const reason=reasonOf(request)
      const current=db.permissionOverrides[p.key]===undefined?undefined:overrideOf(db.permissionOverrides[p.key])
      if(!current?.proposal)throw conflict('There is no request waiting for that permission.')
      const permission=p.key.slice(p.key.indexOf(':')+1)
      if(lockedPermissions.includes(permission))throw new ApiError(400,'Who manages roles, accounts, approvals and the audit trail cannot be changed by a request.','VALIDATION_ERROR')
      if(current.proposal.by===user.id)throw new ApiError(403,'Someone else has to decide your own request.','FORBIDDEN')
      const approve=p.decision==='approve'
      const allowed=current.proposal.allowed
      db.permissionOverrides[p.key]={...(approve?{approved:allowed}:current.approved===undefined?{}:{approved:current.approved}),decisions:[...current.decisions,{at:now(),by:user.id,decision:approve?'Approved':'Rejected',allowed,reason}]}
      setApprovedOverrides(approvedOverrides(db))
      audit(repo,user,approve?'Permission change approved':'Permission change rejected','identity',p.key,undefined,reason)
      if(current.proposal.by)notify(repo,current.proposal.by,'permission','P48',p.key,{body:`Your request to ${allowed?'give':'take'} "${permission}" was ${approve?'approved. It applies at each person\'s next page load.':'rejected.'} Reason: ${reason}`})
      record={key:p.key,decision:approve?'Approved':'Rejected'}
      message=approve?'Approved. The change is now in force.':'Rejected. Nothing changed.'
      break}
    case'moderate':{const reviewer=hasPermission(user,'moderation.review');if(!reviewer&&!hasPermission(user,'moderation.referral')&&!hasPermission(user,'moderation.osas'))throw deny();const p=actionPayloads.moderate.parse(request.payload);const reason=reasonOf(request);const m=find(db.moderation,id);if(!canSeeModeration(user,m))throw unavailable()
      // D-04 (decided 2026-11-10): a moderator refers user-reported content to the CCS Secretary, who makes the final decision on it.
      if(m.status===referredStatus){if(!hasPermission(user,'moderation.referral'))throw conflict('This item was referred to the CCS Secretary.');if(!['dismiss','osas'].includes(p.decision))throw conflict('The CCS Secretary dismisses the flag or sends it to OSAS.')}
      else if(m.status===osasStatus){if(!hasPermission(user,'moderation.osas'))throw conflict('This item was sent to OSAS.');if(!['keep','remove','warn'].includes(p.decision))throw conflict('OSAS keeps the content, removes it, or removes it with a warning.')}
      else if(!reviewer||m.status!=='Pending')throw conflict('This item has already been reviewed.')
      else if(['dismiss','osas'].includes(p.decision))throw conflict('Keep, remove, warn, or refer the item to the CCS Secretary.')
      const osasOfficers=p.decision==='osas'?db.users.filter(u=>u.active&&hasPermission(u,'moderation.osas')):[]
      if(p.decision==='osas'&&!osasOfficers.length)throw conflict('No OSAS account is active, so this cannot be sent to OSAS yet.')
      const secretaries=p.decision==='refer'?db.users.filter(u=>u.active&&hasPermission(u,'moderation.referral')):[]
      if(p.decision==='refer'&&m.source!=='User')throw deny()
      if(p.decision==='refer'&&!secretaries.length)throw conflict('The CCS Secretary account is not active, so this cannot be referred yet.')
      const wasHeldPost=m.itemType==='post'&&m.source==='Filter'&&m.status==='Pending'&&!db.moderation.some(other=>other!==m&&other.itemType==='post'&&other.itemId===m.itemId&&heldStatuses.includes(other.status));m.status=p.decision==='keep'?'Kept':p.decision==='dismiss'?'Dismissed':p.decision==='osas'?osasStatus:p.decision==='refer'?referredStatus:p.decision==='warn'?'Removed and warned':'Removed';m.history.push({at:now(),actorId:user.id,decision:p.decision,reason});if(['remove','warn'].includes(p.decision)){if(m.itemType==='post')find(db.posts,m.parentId).removed=true;else if(m.itemType==='comment'){const comment=find(find(db.posts,m.parentId).comments,m.itemId);comment.body='This content was removed after review.'}else{const message=find(find(db.threads,m.parentId).messages,m.itemId);message.body='This content was removed after review.';message.attachments=undefined;redactNotices(db,message.id)}}if(p.decision==='keep'&&wasHeldPost){const kept=db.posts.find(post=>post.id===m.itemId);if(kept&&!kept.removed){notifyAnnouncementMembers(repo,kept);notifyClassPost(repo,kept)}}audit(repo,user,'Moderation decision','moderation',m.id);for(const secretary of secretaries)notify(repo,secretary.id,'moderation','P50',m.id);for(const officer of osasOfficers)notify(repo,officer.id,'moderation','P50',m.id,{body:'The CCS Secretary sent a flagged item to OSAS for a decision.'});if(p.notifyAuthor){const kept=m.status==='Kept'||m.status==='Dismissed';const what=m.itemType==='message'?'message':m.itemType==='comment'?'comment':'post';const link:[string,string]|undefined=kept?(m.itemType==='message'?['P12',m.parentId]:['P06',m.itemType==='post'?m.itemId:m.parentId]):undefined;notify(repo,m.authorId,'moderation',link?.[0]??'P40',link?.[1],{body:kept?`A reviewer looked at your ${what} and kept it. Nothing changes.`:p.decision==='refer'||p.decision==='osas'?`A reviewer sent your ${what} to the office that handles it. You will hear from them if anything changes.`:`A reviewer removed your ${what}${p.decision==='warn'?' and recorded a warning':''}. Reason: ${reason}`})};record={id:m.id,status:m.status,history:m.history};message='Decision recorded.';break}
    default:throw new ApiError(400,'That action does not exist.','VALIDATION_ERROR')
  }
  return {...JSON.parse(JSON.stringify({ok:true,message,...(record===undefined?{}:{record})})) as {ok:true;message:string;record?:unknown},outbox}
}
// --- files in Messages -----------------------------------------------------------------------------------------------
/** Actions that can carry uploaded files: messages and posts. */
const fileActions=['sendMessage','createThread','createPost','updatePost']
/** A short-lived link to a file on a post, for people who can read the post. Pictures can open in the browser. */
export async function postFileUrl(repo:Repository,user:User,postId:string,fileId:string,inline:boolean,storage?:MaterialStorage){
  const file=await repo.view(unit=>{
    const db=unit.read()
    // A reviewer of this post's moderation item (a moderator, or the Secretary once it is referred) may open its files.
    const reviewing=db.moderation.some(m=>m.itemType==='post'&&m.itemId===postId&&canSeeModeration(user,m))
    const post=reviewing?db.posts.find(p=>p.id===postId):visiblePosts(db,user).find(p=>p.id===postId)
    const file=post&&!post.removed?post.attachments?.find(a=>a.id===fileId):undefined
    if(!file)throw unavailable()
    return file
  })
  if(!storage)throw filesNotSetUp()
  return storage.downloadUrl(file.key,file.fileName,inline&&file.contentType.startsWith('image/'))
}
/** Checks a file for a message or a post and returns a signed upload for exactly that type and size. */
export async function startMessageUpload(user:User,payload:unknown,storage?:MaterialStorage){
  if(!hasPermission(user,'message.send')&&!hasPermission(user,'post.create'))throw deny()
  const p=messageUploadSchema.parse(payload)
  const allowed=messageFileTypes[p.contentType]
  const extension=p.fileName.toLowerCase().split('.').pop()??''
  if(!allowed)throw new z.ZodError([{code:'custom',path:['contentType'],message:'Send a picture (PNG, JPG, WebP or GIF), a PDF, or a Word, PowerPoint, Excel or text file.',input:undefined}])
  if(!allowed.includes(extension))throw new z.ZodError([{code:'custom',path:['fileName'],message:`A ${allowed.map(e=>'.'+e).join(' or ')} file name is expected for this type.`,input:undefined}])
  if(p.size>messageFileMaxBytes)throw new z.ZodError([{code:'custom',path:['size'],message:'Send a file of at most 10 MB.',input:undefined}])
  if(!storage)throw filesNotSetUp()
  const id=ulid()
  const url=await storage.uploadUrl(messageFileKey(user.id,id,p.fileName),p.contentType,p.size)
  return {attachment:{id,fileName:p.fileName,contentType:p.contentType,size:p.size},upload:{url,method:'PUT',headers:{'Content-Type':p.contentType,'Content-Length':String(p.size)},expiresInSeconds:uploadUrlSeconds}}
}
/**
 * Before a message or post is saved, each file must be the sender's own upload, stored with the declared size and type.
 * New files are then copied to a key of their own: the signed upload URL stays usable for a while and cannot change a sent
 * file, and readers of an anonymous post get a signed link without the author's ID. Returns the new key of each file.
 */
async function checkMessageFiles(repo:Repository,user:User,request:ActionRequest,storage?:MaterialStorage){
  const keys=new Map<string,string>()
  const files=(request.payload as {attachments?:unknown}|undefined)?.attachments
  if(!Array.isArray(files)||!files.length)return keys
  const parsed=((actionPayloads[request.action as keyof typeof actionPayloads] as z.ZodType).parse(request.payload) as {attachments?:{id:string;fileName:string;contentType:string;size:number}[]}).attachments??[]
  if(!storage)throw filesNotSetUp()
  for(const f of parsed){
    const allowed=messageFileTypes[f.contentType]
    if(!allowed||!allowed.includes(f.fileName.toLowerCase().split('.').pop()??'')||f.size>messageFileMaxBytes)throw conflict('That file cannot be sent. Choose it again.')
    const stored=await storage.head(messageFileKey(user.id,f.id,f.fileName))
    if(!stored)throw conflict(`${f.fileName} has not finished uploading. Try again.`)
    if(stored.size!==f.size||stored.contentType!==undefined&&stored.contentType!==f.contentType)throw conflict(`${f.fileName} does not match what was uploaded. Choose it again.`)
  }
  const post=request.action==='createPost'||request.action==='updatePost'
  const kept=request.action==='updatePost'?await repo.view(unit=>unit.read().posts.find(p=>p.id===request.recordId)?.attachments?.map(a=>a.id)??[]):[]
  try {
    for(const f of parsed.filter(file=>!kept.includes(file.id))){
      const key=`materials/${post?'posts':'sent'}/${ulid()}/${safeFileName(f.fileName)}`
      keys.set(f.id,key)
      await storage.copy(messageFileKey(user.id,f.id,f.fileName),key)
      // Checked again on the copy: the upload could have changed between the check above and the copy.
      const copied=await storage.head(key)
      if(!copied||copied.size!==f.size||copied.contentType!==undefined&&copied.contentType!==f.contentType)throw conflict(`${f.fileName} does not match what was uploaded. Choose it again.`)
    }
  } catch(error) {
    // Copies made for this request before the failure are removed, so retries leave nothing behind.
    await Promise.all([...keys.values()].map(key=>storage.remove(key).catch(()=>undefined)))
    throw error
  }
  return keys
}
/** A short-lived link to a file in a conversation, for its members only. Pictures can open in the browser. */
export async function messageFileUrl(repo:Repository,user:User,threadId:string,messageId:string,fileId:string,inline:boolean,storage?:MaterialStorage){
  const file=await repo.view(unit=>{
    const db=unit.read()
    const thread=find(db.threads,threadId)
    const message=thread.messages.find(m=>m.id===messageId)
    // A reviewer of this message's moderation item may open its files, and nothing else in the conversation.
    const reviewing=!!message&&db.moderation.some(m=>m.itemType==='message'&&m.itemId===message.id&&m.parentId===thread.id&&canSeeModeration(user,m))
    if(!reviewing&&!canThread(db,user,thread))throw unavailable()
    if(!message||!reviewing&&!canSeeItem(db,user,'message',message.id,message.authorId))throw unavailable()
    const file=message.attachments?.find(a=>a.id===fileId)
    if(!file)throw unavailable()
    return file
  })
  if(!storage)throw filesNotSetUp()
  return storage.downloadUrl(file.key,file.fileName,inline&&file.contentType.startsWith('image/'))
}
// --- class material files (#44) -------------------------------------------------------------------------------------
const filesNotSetUp = () => conflict('File uploads are not set up yet. Share a link instead.')
/** Checks the file, records a pending material, and returns a signed upload for exactly that type and size. */
export async function startMaterialUpload(repo:Repository,user:User,payload:unknown,storage?:MaterialStorage){
  const p=materialUploadSchema.parse(payload)
  const extension=p.fileName.toLowerCase().split('.').pop()??''
  const allowed=materialFileTypes[p.contentType]
  if(!allowed)throw new z.ZodError([{code:'custom',path:['contentType'],message:'Use a PDF, Word, PowerPoint, Excel, text, PNG or JPG file.',input:undefined}])
  if(!allowed.includes(extension))throw new z.ZodError([{code:'custom',path:['fileName'],message:`A ${allowed.map(e=>'.'+e).join(' or ')} file name is expected for this type.`,input:undefined}])
  if(p.size>materialMaxBytes)throw new z.ZodError([{code:'custom',path:['size'],message:'Use a file of at most 25 MB.',input:undefined}])
  const material=await repo.transact(unit=>{
    const db=unit.read()
    const space=find(db.spaces,p.spaceId)
    if(!canSpace(user,space)||isSectionSpace(space))throw unavailable()
    if(!teachesSubject(user,space))throw deny()
    if(!storage)throw filesNotSetUp()
    const at=now();const id=unit.nextId('MATERIAL')
    const m:Material={id,spaceId:space.id,kind:'file',title:p.title,...(p.note?{note:p.note}:{}),fileName:p.fileName,contentType:p.contentType,size:p.size,key:`materials/${space.id}/${id}/${safeFileName(p.fileName)}`,status:'pending',authorId:user.id,at,updatedAt:at}
    db.materials.push(m)
    audit(unit,user,'Class material file upload started','academic',m.id)
    return m
  })
  const url=await storage!.uploadUrl(material.key!,material.contentType!,material.size!)
  const {key:_key,...shown}=material
  return {material:shown,upload:{url,method:'PUT',headers:{'Content-Type':material.contentType!,'Content-Length':String(material.size)},expiresInSeconds:uploadUrlSeconds}}
}
/** Confirms an upload once the stored file has the declared size and type; students see it from then on. */
export async function completeMaterialUpload(repo:Repository,user:User,id:string,storage?:MaterialStorage){
  if(!storage)throw filesNotSetUp()
  const pending=await repo.view(unit=>{const db=unit.read();const m=find(db.materials,id);const space=find(db.spaces,m.spaceId);if(!opensMaterials(user,space))throw unavailable();if(!teachesSubject(user,space))throw deny();if(m.kind!=='file')throw conflict('Only a file is uploaded.');return m})
  if(pending.status==='ready'){const {key:_k,...shown}=pending;return shown}
  const stored=await storage.head(pending.key!)
  if(!stored)throw conflict('The file has not been uploaded yet. Upload it, then try again.')
  if(stored.size!==pending.size||stored.size>materialMaxBytes||stored.contentType!==undefined&&stored.contentType!==pending.contentType){await storage.remove(pending.key!);throw conflict('The uploaded file does not match what was declared. Upload it again.')}
  // The confirmed file is a copy the upload URL cannot reach, checked again; the upload is removed after the save.
  const frozen=`materials/classes/${ulid()}/${safeFileName(pending.fileName!)}`
  await storage.copy(pending.key!,frozen)
  const copied=await storage.head(frozen)
  if(!copied||copied.size!==pending.size||copied.contentType!==undefined&&copied.contentType!==pending.contentType){await storage.remove(frozen);throw conflict('The uploaded file does not match what was declared. Upload it again.')}
  const shown=await repo.transact(unit=>{const m=find(unit.read().materials,id);m.key=frozen;m.status='ready';m.updatedAt=now();audit(unit,user,'Class material added','academic',m.id);const {key:_k,...shown}=m;return shown})
  // Removed only once the confirmation is saved, so a failed save can be retried from the upload.
  await storage.remove(pending.key!).catch(error=>console.error(JSON.stringify({level:'error',message:'Upload cleanup failed',materialId:id,error:error instanceof Error?error.name:String(error)})))
  return shown
}
/** A short-lived download link for a confirmed file, for the subject's professors and students only. */
export async function materialDownloadUrl(repo:Repository,user:User,id:string,storage?:MaterialStorage){
  const m=await repo.view(unit=>{const db=unit.read();const m=find(db.materials,id);const space=find(db.spaces,m.spaceId);if(!opensMaterials(user,space)||m.kind!=='file'||m.status!=='ready'&&!teachesSubject(user,space))throw unavailable();return m})
  if(!storage)throw filesNotSetUp()
  return storage.downloadUrl(m.key!,m.fileName!)
}
export interface AssistantProvider { answer(db:Database,user:User,question:string):{reply:string;sources:{title:string;href:string}[]} }
// Writing help is matched before report status, because a request for help writing a report says "report" too; status
// answers name a report by category and filing date, and by its ID only when the question gave it.
export const demoAssistant:AssistantProvider={answer(db,user,question){const q=question.toLowerCase();const fallback={reply:'I can explain ACCS pages, your schedule, and the milestones on your own reports. I cannot answer that one. Please ask the office that handles it.',sources:[{title:'Help',href:'/help'}]};if(/guilt|guilty|verdict|punish|decide|restrict|another student|reveal|identity|who reported/.test(q))return fallback;if(/^\s*(hi|hello|hey|good (morning|afternoon|evening)|kumusta|musta)\b/.test(q)&&q.trim().split(/\s+/).length<=4)return{reply:`Hello, ${user.name.split(' ')[0]}! I can explain ACCS pages and how appointments, reports and evaluations work. Try one of the suggestions below, or ask your own question.`,sources:[{title:'Help',href:'/help'}]};const mentioned:string[]=question.match(/RPT-[0-9A-Z]+/g)??[];
// A how, what, where or why question goes to the matching help answer before any summary of the person's own data (QA 17
// November, V3: "What does anonymous reporting mean?" listed the student's reports, and "How do I book" the calendar).
// Question words ("where", "which") say nothing about the topic, so they never make a match; a question about "my" own
// things is answered from the person's data below.
const faqStopWords=new Set(['where','which','there','about','would','could','should','their'])
// Casing and punctuation never matter, an exact FAQ question or the "what can you help me with" chip always matches,
// and words match by stem ("reporting" finds "reports"). Only a question about "my" own things or a status goes on.
const plain=(t:string)=>t.toLowerCase().replace(/[^a-z0-9]+/g,' ').trim()
const stem=(w:string)=>w.slice(0,5)
const qWords=plain(q).split(' ').map(stem)
const faqs=filteredFaq(user)
const sure=faqs.find(f=>plain(f.question)===plain(q))??(/help me with|what can (you|the assistant) do/.test(q)?faqs.find(f=>f.id==='FAQ-4'):undefined)
const entry=sure??faqs.find(f=>f.question.toLowerCase().split(/\W+/).filter(w=>w.length>4&&!faqStopWords.has(w)).some(w=>qWords.includes(stem(w))));
if(entry&&(sure||/^\s*(how|what|where|why|who|can|does|do|is)\b/.test(q)&&!/\bmy\b|\bstatus\b|\bmilestones?\b|\bhave i\b|\bi filed\b|rpt-/.test(q)))return{reply:entry.answer,sources:[{title:entry.question,href:entry.href}]};
// Evaluation dates come from the cycles themselves (QA 17 November, V3: "When is the next evaluation?" got the fallback).
if(/evaluat/.test(q)&&/when|next|open|close|due|deadline|until/.test(q)){const day=(d:string)=>new Date(d+'T00:00:00Z').toLocaleDateString('en-US',{month:'long',day:'numeric',year:'numeric',timeZone:'UTC'});const today=campusNow().date;const open=db.cycles.find(c=>c.status==='Published'&&c.opens<=today&&c.closes>=today);const next=db.cycles.filter(c=>c.status!=='Closed'&&c.opens>today).sort((a,b)=>a.opens.localeCompare(b.opens))[0];return{reply:open?`${open.title} is open until ${day(open.closes)}.${next?` The next one, ${next.title}, opens on ${day(next.opens)}.`:''}`:next?`The next evaluation, ${next.title}, opens on ${day(next.opens)}.`:'No evaluation is scheduled yet. The Dean opens each one, and you get a notification when it starts.',sources:[{title:'Evaluations',href:'/evaluations'}]}}if(mentioned.some(id=>!db.reports.some(r=>r.id===id&&r.ownerId===user.id)))return fallback;if(/schedule|calendar|appointment|consultation/.test(q)){if(!canPage(user,'P13'))return fallback;const own=visibleConsultations(db,user);const tasks=db.todos.filter(t=>t.ownerId===user.id);return {reply:`Your calendar has ${visibleEvents(db,user).length} college events${hasRole(user,'student')?`, ${tasks.length} to-do${tasks.length===1?"":"s"}`:''} and ${own.length} appointment request${own.length===1?'':'s'}. Open the calendar or Consultations for dates and status.`,sources:[{title:'Calendar',href:'/calendar'},...(canPage(user,'P14')?[{title:'Appointments',href:'/consultations'}]:[])]}}if(/draft|write|word|organi[sz]e|phrase/.test(q)){return{reply:'Say what happened, when, and where, and what you want the office to look at. Name only the people the office needs to know about. Read it over before you submit. The assistant does not decide what happened.',sources:[{title:'Help',href:'/help'}]}}if(/report|milestone|stage/.test(q)&&hasRole(user,'student')){const reports=db.reports.filter(r=>r.ownerId===user.id&&(!mentioned.length||mentioned.includes(r.id)));return {reply:reports.length?reports.map(r=>`${mentioned.includes(r.id)?r.id:`${r.category}, filed ${r.createdAt.slice(0,10)}`}: ${statusFor(r)}. ${r.history.filter(h=>h.public).at(-1)?.update??'No update yet.'}`).join('\n'):'You have not filed a report yet. File one from My reports.',sources:[{title:'My reports',href:'/reports'}]}}if(entry)return{reply:entry.answer,sources:[{title:entry.question,href:entry.href}]};if(/help|can you|what can/.test(q))return{reply:'I can explain ACCS pages and how reports, appointments, and evaluations work. Staff decide case outcomes and restrictions.',sources:[{title:'Help',href:'/help'}]};return fallback}}
function assistantAnswer(db:Database,user:User,question:string){return demoAssistant.answer(db,user,question)}
