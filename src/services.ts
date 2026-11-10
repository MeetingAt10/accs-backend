import { z } from 'zod'
import { actionPayloads, announcementPriorities, postLabels, programs, roleLabels, roles, type ActionRequest, type PageQuery, type User } from './schemas.js'
import { allowedPages, canActCase, canAudience, canReadCase, overseesCase, canCountCase, canFacultyResult, canPage, canPublish, canReach, canSpace, canStudentRecord, canThread, canViewCase, hasPermission, hasRole, isOrganizationMember, pageTitles, permissionRoles, permissions, scopeLabel } from './access.js'
import { consentWording } from './consent.js'
import type { Assignment, Consultation, Cycle, Database, Message, Post, Report, Repository, Slot, Stage, Thread, UnitOfWork } from './store.js'

export class ApiError extends Error { constructor(public status: number, message: string, public code = 'FORBIDDEN') { super(message) } }
export const unavailable = () => new ApiError(404, "This record isn't available to you.", 'UNAVAILABLE')
export const deny = () => new ApiError(403, "This action isn't available to your role.", 'FORBIDDEN')
export const conflict = (message: string) => new ApiError(409, message, 'CONFLICT')
const now = () => new Date().toISOString()
const offices: Record<Stage,string> = { adviser:'Adviser',chair:'Program Chair',dean:'Dean',guidance:'Guidance Office',osas:'OSAS' }
const stageRoles: Record<Stage,string> = { adviser:'professor',chair:'chair',dean:'dean',guidance:'guidance',osas:'osas' }
const statusFor = (report: Report) => ['Resolved','Closed','Draft'].includes(report.status) ? report.status : report.stage === 'guidance' && report.caseFileId ? 'Case File at Guidance' : `With ${offices[report.stage]}`
function requirePermission(user: User, key: string) { if (!hasPermission(user,key)) throw deny() }
const referredStatus = 'Referred to the CCS Secretary'
/** Moderators see every item; the CCS Secretary sees only items referred to them, including ones they have decided. */
const canSeeModeration = (user: User, m: { history: { decision: string }[] }) =>
  hasPermission(user,'moderation.review') || hasPermission(user,'moderation.referral') && m.history.some(entry => entry.decision === 'refer')
function requireRole(user: User, ...roleNames: User['roles']) { if (!hasRole(user,...roleNames)) throw deny() }
function find<T extends {id:string}>(items:T[], id:string|undefined):T { const item = items.find(entry=>entry.id===id); if (!item) throw unavailable(); return item }
function pick<T extends {id:string}>(items:T[], id?:string):T|undefined { return id ? find(items,id) : items[0] }
function reasonOf(request:ActionRequest) { return z.string().trim().min(1,'A reason is required.').max(2000).parse(request.reason) }
export function refreshRestrictions(db: Database, user: User): User { const date = now().slice(0,10); return { ...user, restrictions:[...new Set(db.restrictions.filter(r=>r.studentId===user.id&&r.active&&r.until>=date).flatMap(r=>r.features))] } }
export function sessionView(user:User) { return { user, permissions:permissions(user),allowedPages:allowedPages(user),roleLabels,sampleData:true as const } }
function person(user:User) { return { id:user.id,name:user.name,email:user.email,roles:user.roles,program:user.program,section:user.section,office:user.office,title:user.title,bio:user.bio,education:user.education,officeHours:user.officeHours,studentId:user.studentId,year:user.year,standing:user.restrictions.length?'Some features paused':'Good standing' } }
function author(db:Database,id:string,anonymous=false,alias='Student A-12') { const u=db.users.find(item=>item.id===id); return anonymous ? {name:alias,roles:['student'],anonymous:true} : u?{id:u.id,name:u.name,roles:u.roles,email:u.email}:{name:'College office',roles:[]} }
function messageView(db:Database,message:Message,report?:Report) { return {id:message.id,body:message.body,at:message.at,author:author(db,message.authorId,!!report&&message.authorId===report.ownerId&&report.identity==='anonymous'&&!report.disclosedTo.includes(report.stage),report?.alias)} }
function postView(db: Database, post: Post, user: User) {
  return {
    id: post.id,
    title: post.title,
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
    author: author(db, post.authorId, post.anonymous),
    owned: post.authorId === user.id,
    reactionCount: post.reactions.length,
    reacted: post.reactions.includes(user.id),
    commentCount: post.comments.length,
    comments: post.removed ? [] : post.comments.map(comment => ({
      ...messageView(db, comment),
      author: author(db, comment.authorId, comment.anonymous),
    })),
    removed: post.removed,
  }
}
function reportView(db:Database,report:Report,user:User,owner=false) {
  const current=canActCase(user,report)
  // The Program Chair and the Dean see a confidential concern's status only: no statement, reporter, messages or notes.
  if(!owner&&!current&&overseesCase(user,report)&&!canReadCase(user,report)) return {id:report.id,caseFileId:report.caseFileId,status:statusFor(report),stage:report.stage,office:offices[report.stage],program:report.program,createdAt:report.createdAt,updatedAt:report.updatedAt,confidential:true,statusOnly:true,timeline:report.history.filter(h=>h.public).map(h=>({at:h.at,action:h.action,office:offices[h.stage]})),statusNotice:'The adviser marked this concern confidential. You can see its status only.'}
  if(!owner&&!current&&!canReadCase(user,report)) return {id:report.id,caseFileId:report.caseFileId,category:report.category,severity:report.severity,status:statusFor(report),stage:report.stage,office:offices[report.stage],program:report.program,createdAt:report.createdAt,updatedAt:report.updatedAt,historyOnly:true,history:report.history.filter(h=>h.actorId===user.id).map(h=>({...h,actor:author(db,h.actorId)})),historyNotice:'You can see only your own entries on this report.'}
  // A reader who is not the current handler sees the name only if the student shared it with the reader's own office.
  const viewerStage=current?report.stage:hasRole(user,'dean')?'dean':'chair'
  const showName=report.identity==='named'||!owner&&report.disclosedTo.includes(viewerStage)
  return {id:report.id,caseFileId:report.caseFileId,type:report.caseFileId?'Case File':'Report',category:report.category,severity:report.severity,status:statusFor(report),stage:report.stage,office:offices[report.stage],program:report.program,narrative:report.narrative,identity:report.identity,alias:report.alias,reporter:showName?author(db,report.ownerId):{name:report.alias,roles:['student'],anonymous:true},createdAt:report.createdAt,updatedAt:report.updatedAt,sourcePostId:report.sourcePostId,location:report.location,occurredOn:report.occurredOn,disclosedTo:owner?report.disclosedTo:undefined,bypassed:owner?undefined:report.bypassed,consent:report.consent&&{readStatement:true,at:report.consent.at,version:report.consent.version,wording:report.consent.wording},allowChair:true,allowDean:true,confidential:report.confidential===true,readOnly:!owner&&!current,aboutAdvisor:report.aboutAdvisor===true,talk:report.talk,history:report.history.filter(h=>!owner||h.public).map(h=>owner?{id:h.id,at:h.at,action:h.action,update:h.update,stage:h.stage,office:offices[h.stage],state:h.stage===report.stage?'current':'done'}:{...h,actorId:h.actorId===report.ownerId&&!showName?undefined:h.actorId,actor:author(db,h.actorId,h.actorId===report.ownerId&&!showName,report.alias)}),messages:report.messages.map(m=>messageView(db,m,report)),notes:owner?undefined:report.notes.map(m=>messageView(db,m)),allowedActions:owner?[]:caseActions(user,report)}
}
function caseActions(user:User,r:Report) { if(!canActCase(user,r))return[]; if(r.status==='Closed')return[]; if(r.status==='Resolved')return['close'];if(r.stage==='guidance'&&!r.caseFileId)return['convert'];return ['respond','recordAction',...(['guidance','osas'].includes(r.stage)?['milestone']:[]),'resolve',...(r.stage==='adviser'||r.stage==='chair'?['escalate']:r.stage==='dean'||r.stage==='guidance'?['transfer']:[])] }
function consultationView(db:Database,c:Database['consultations'][number]) { return {...c,student:person(find(db.users,c.studentId)),faculty:person(find(db.users,c.facultyId)),slot:find(db.slots,c.slotId)} }
function assignmentView(db:Database,a:Assignment,receipt=false) { const cycle=find(db.cycles,a.cycleId); return {id:a.id,faculty:person(find(db.users,a.facultyId)),cycleId:a.cycleId,cycleTitle:cycle.title,relation:a.relation,subject:a.subject,due:cycle.closes,status:a.submittedAt?'Submitted':'Not started',submittedAt:a.submittedAt,questions:receipt?cycle.questions:undefined,instructions:receipt?cycle.instructions:undefined,cycleStatus:cycle.status,answers:receipt?a.answers:undefined,comment:receipt?a.comment:undefined} }
function resultViews(db:Database,user:User,cycleId?:string) { return db.users.filter(u=>hasRole(u,'professor','chair','dean')&&canFacultyResult(user,u)).map(faculty=>{const entries=db.assignments.filter(a=>a.facultyId===faculty.id&&a.submittedAt&&(!cycleId||a.cycleId===cycleId)&&find(db.cycles,a.cycleId).resultsPublished);const ratings=entries.flatMap(a=>Object.values(a.answers??{}).filter((v):v is number=>typeof v==='number'));const criteria=['Q1','Q2','Q3'].map((id,index)=>{const values=entries.map(a=>a.answers?.[id]).filter((v):v is number=>typeof v==='number');return {label:['Clarity','Support','Fairness'][index],value:values.length?Number((values.reduce((s,n)=>s+n,0)/values.length).toFixed(2)):0}});return {id:faculty.id,faculty:person(faculty),responses:entries.length,average:ratings.length?Number((ratings.reduce((s,n)=>s+n,0)/ratings.length).toFixed(2)):0,completion:entries.length?100:0,criteria,themes:entries.length?[{title:'Clear guidance',count:entries.length,summary:'Students describe the requirements as clear and say they get help when they ask.'}]:[]}}) }
/** Every evaluation assigned to the program's faculty in the published cycles in scope, submitted or not. */
function programAssignments(db:Database,program?:string,cycleId?:string) {
  const facultyIds = db.users
    .filter(user => hasRole(user,'professor','chair','dean') && (!program || user.program === program))
    .map(user => user.id)
  return db.assignments.filter(assignment =>
    facultyIds.includes(assignment.facultyId)
    && (!cycleId || assignment.cycleId === cycleId)
    && find(db.cycles,assignment.cycleId).resultsPublished,
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
export const requiredNotificationCategories: readonly string[] = ['report']
/** `urgent` (an urgent announcement) reaches the recipient even if they muted its category. */
function notify(repo:UnitOfWork,recipientId:string,kind:string,pageId:string,recordId?:string,options:{urgent?:boolean}={}) {
  const db = repo.read()
  const stored = db.settings[recipientId]?.priorities[kind]
  // A mute saved before a category became required is ignored, not obeyed.
  const preference = stored === 'muted' && requiredNotificationCategories.includes(kind) ? undefined : stored
  if (preference === 'muted' && !options.urgent) return
  if (kind === 'message' && db.threads.find(thread => thread.id === recordId)?.mutedBy.includes(recipientId)) return
  const titles:Record<string,string> = {
    announcement: 'New college announcement',
    message: 'New message',
    consultation: 'Consultation request updated',
    report: 'Report update',
    case: 'Case update',
    evaluation: 'Evaluation update',
    restriction: 'Account features changed',
    role: 'Your role assignment changed',
    moderation: 'Content review update',
  }
  db.notifications.push({
    id: repo.nextId('NOTIF'),
    recipientId,
    kind,
    title: titles[kind] ?? 'New update',
    body: 'Open this update to see the details.',
    priority: options.urgent ? 'high' : preference && preference !== 'muted' ? preference : (['report', 'case', 'restriction'].includes(kind) ? 'high' : 'normal'),
    pageId,
    recordId,
    at: now(),
    read: false,
  })
}
function unreadMessages(thread:Thread,userId:string) {
  const readCount = Math.min(thread.messages.length, thread.readMessageCounts[userId] ?? 0)
  return thread.messages.slice(readCount).filter(message => message.authorId !== userId).length
}
function handlerIds(db:Database,r:Report) { return db.users.filter(u=>u.active&&canActCase(u,r)).map(u=>u.id) }
const faq=[{id:'FAQ-1',question:'How do I request a consultation?',answer:'Open Consultations, pick one of your professors, and request an open time. The professor confirms or declines.',href:'/consultations',roles:['student']},{id:'FAQ-2',question:'What does anonymous reporting mean?',answer:'Your report stays linked to your verified account. Handlers see an alias until you choose to share your name with their office.',href:'/reports/new',roles:['student']},{id:'FAQ-3',question:'How are reports routed?',answer:'A report goes to the student\'s adviser first. If the report involves that adviser, it goes to the program chair instead. The program chair and the Dean can read a report only if the student allowed it. Each office decides the next step.',href:'/cases',roles:['professor','chair','dean','guidance','osas']},{id:'FAQ-4',question:'What can the assistant do?',answer:'It explains ACCS pages, your schedule, and the milestones on your own reports. It cannot decide cases or restrictions. Staff do that.',href:'/assistant',roles:roles as readonly string[]},{id:'FAQ-5',question:'Where do I find official contact details?',answer:'The directory lists faculty and staff offices and their QCU email addresses.',href:'/directory',roles:roles as readonly string[]},{id:'FAQ-6',question:'What still works when features are paused?',answer:'You can still read announcements and class information, use the assistant, and message your professors.',href:'/standing',roles:['student']},{id:'FAQ-7',question:'What does a moderation flag mean?',answer:'A flag asks a moderator to read the post in context. It does not mean anyone did something wrong, and it does not restrict anyone.',href:'/admin/moderation',roles:['administrator']}]
function notificationCategories(user:User){return ['announcement',...(hasPermission(user,'message.send')?['message']:[]),...(hasRole(user,'student','professor')?['consultation']:[]),...(hasRole(user,'student','professor','chair','dean','guidance','osas')?['report','case']:[]),...(hasPermission(user,'evaluation.fill')||hasPermission(user,'evaluation.configure')?['evaluation']:[]),...(hasRole(user,'administrator')||hasPermission(user,'moderation.referral')?['moderation']:[])]}
function filteredFaq(user:User){return faq.filter(entry=>entry.roles.some(role=>user.roles.includes(role as User['roles'][number])))}
function restrictionViews(db:Database,user:User,studentId?:string) {
  const today = now().slice(0, 10)
  return db.restrictions
    .filter(r => (!studentId || r.studentId === studentId) && (hasRole(user,'administrator') || r.studentId === user.id || canStudentRecord(db,user,find(db.users,r.studentId))))
    .map(r => ({ ...r, active: r.active && r.until >= today, student: person(find(db.users,r.studentId)), authorizer: author(db,r.actorId) }))
}
// Entries whose actor is the reporting student, who may be anonymous to the people reading the trail.
const studentActions=['Identity disclosed','Report submitted','Report consent recorded','Talk consent recorded','Reporter message sent']
function safeAudit(db:Database,entries:Database['audit']) {return entries.map(entry=>{const confidentialStudent=studentActions.includes(entry.action);return {...entry,actorId:confidentialStudent?undefined:entry.actorId,reason:['cases','reports','records'].includes(entry.module)?undefined:entry.reason,actor:confidentialStudent?{name:'Verified student',roles:['student']}:author(db,entry.actorId)}})}
function defaultSettings(user: User) {
  const compactRoles: User['roles'] = ['administrator', 'chair', 'dean', 'guidance', 'osas']
  return {
    theme: 'system',
    density: hasRole(user, ...compactRoles) ? 'compact' : 'comfortable',
    priorities: { report: 'high', case: 'high', message: 'normal', consultation: 'normal', evaluation: 'normal', announcement: 'normal' },
  }
}
function visiblePosts(db:Database,user:User,q?:string) { return db.posts.filter(post=>canAudience(db,user,post.audience,post.private)&&(!q||`${post.title} ${post.body}`.toLowerCase().includes(q.toLowerCase()))) }
function visibleEvents(db: Database, user: User) {
  return db.events.filter(event => {
    const source = event.postId ? db.posts.find(post => post.id === event.postId) : undefined
    return (!event.postId || !!source && !source.removed)
      && (!event.audience || canAudience(db, user, event.audience, event.private))
  })
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
function notifyAnnouncementMembers(repo: UnitOfWork, post: Post) {
  if (post.kind !== 'announcement' || !post.notifyMembers) return
  const db = repo.read()
  const [kind, id] = post.audience.split(':')
  const space = db.spaces.find(item => item.id === id)
  for (const recipient of db.users.filter(user => user.active)) {
    const member = post.audience === 'college'
      || post.audience === 'faculty' && hasRole(recipient, 'professor', 'chair', 'dean')
      || kind === 'program' && recipient.program === id
      || kind === 'space' && !!space && [...space.studentIds, ...space.professorIds].includes(recipient.id)
      || kind === 'organization' && isOrganizationMember(db, recipient, id!)
    if (member && canAudience(db, recipient, post.audience, post.private)) {
      notify(repo, recipient.id, 'announcement', 'P06', post.id, { urgent: post.priority === 'urgent' })
    }
  }
}
function queuePostReview(repo: UnitOfWork, post: Post) {
  if (!/\b(idiot|stupid|hate)\b/i.test(post.body)) return
  const db = repo.read()
  if (db.moderation.some(item => item.itemId === post.id && item.status === 'Pending')) return
  db.moderation.push({
    id: repo.nextId('MOD'),
    itemType: 'post',
    itemId: post.id,
    parentId: post.id,
    authorId: post.authorId,
    source: 'Filter',
    reason: 'Word filter match. A moderator must review it.',
    excerpt: post.body.slice(0, 160),
    status: 'Pending',
    at: now(),
    history: [],
  })
}
function visibleConsultations(db:Database,user:User){return db.consultations.filter(c=>c.studentId===user.id&&hasRole(user,'student')||c.facultyId===user.id&&hasRole(user,'professor'))}
function visibleSlots(db:Database,user:User){return db.slots.filter(s=>s.facultyId===user.id||hasRole(user,'dean','chair')||canReach(db,user,find(db.users,s.facultyId)))}
/** One request per time: the rule for a student's consultation request and for a time booked to talk about a concern. */
function reserveSlot(repo:UnitOfWork,studentId:string,slot:Slot,purpose:string,reportId?:string):Consultation {
  const db=repo.read()
  if(slot.state!=='open'||db.consultations.some(c=>c.slotId===slot.id&&!['Declined','Cancelled','Completed'].includes(c.status)))throw conflict('That time was just taken. Pick another time.')
  slot.state='requested'
  const at=now()
  const c:Consultation={id:repo.nextId('CONSULT'),studentId,facultyId:slot.facultyId,slotId:slot.id,...(reportId?{reportId}:{}),purpose,status:'Requested',createdAt:at,updatedAt:at,history:[{at,status:'Requested',note:'Request received',actorId:studentId}]}
  db.consultations.push(c)
  notify(repo,slot.facultyId,'consultation','P16',c.id)
  return c
}
// P34 records every opening of a student record in the audit trail, so that one read has to commit.
export function getPage(repo:Repository,user:User,pageId:string,query:PageQuery={}) {
  const work=(unit:UnitOfWork)=>readPage(unit,user,pageId,query)
  return pageId==='P34'?repo.transact(work):repo.view(work)
}
function readPage(repo:UnitOfWork,user:User,pageId:string,query:PageQuery={},internalRole=false) {
  if(!canPage(user,pageId))throw new ApiError(403,"This page isn't available to your role.")
  const db=repo.read(); const data:Record<string,unknown>={}; const ownReports=db.reports.filter(r=>r.ownerId===user.id);const cases=db.reports.filter(r=>canViewCase(user,r));
  if (pageId === 'P04') validateFeedScope(db, user, query.scope)
  const labels = query.label?.split(',').map(label => label.trim()).filter(Boolean) ?? []
  const posts = visiblePosts(db, user, query.q).filter(post => (
    (!labels.length || labels.includes(post.label) || labels.includes('Announcements') && post.kind === 'announcement')
    && (!query.scope || post.audience === query.scope)
    && (!query.type || post.kind === query.type)
  ))
  const spaces=db.spaces.filter(s=>canSpace(user,s));const faculty=db.users.filter(u=>hasRole(u,'professor')&&canReach(db,user,u));
  const match=(value:string)=>!query.q||value.toLowerCase().includes(query.q.toLowerCase())
  switch(pageId){
    case'P01':data.redirect='/home';break
    case'P02':data.redirect='/home';break
    case'P03':{
      if(hasRole(user,'administrator'))data.redirect='/admin'
      const consultations=visibleConsultations(db,user);const assignments=db.assignments.filter(a=>a.evaluatorId===user.id&&['Published','Closed'].includes(find(db.cycles,a.cycleId).status))
      data.stats=[{label:hasRole(user,'student')?'Active reports':'Reports in your queue',value:(hasRole(user,'student')?ownReports:cases).filter(r=>!['Resolved','Closed'].includes(r.status)).length,note:'Reports you can see'},{label:'Consultations',value:consultations.filter(c=>!['Completed','Declined','Cancelled'].includes(c.status)).length,note:'Requests and booked times'},{label:'Evaluations due',value:assignments.filter(a=>!a.submittedAt).length,note:'Forms assigned to you'},{label:'Unread updates',value:db.notifications.filter(n=>n.recipientId===user.id&&!n.read).length,note:'In your notifications'}]
      Object.assign(data,{announcements:posts.filter(p=>p.kind==='announcement').slice(0,3).map(p=>postView(db,p,user)),posts:posts.slice(0,3).map(p=>postView(db,p,user)),events:visibleEvents(db,user), reports:hasRole(user,'student')?ownReports.slice(0,4).map(r=>reportView(db,r,user,true)):[],cases:cases.slice(0,4).map(r=>reportView(db,r,user)),consultations:consultations.map(c=>consultationView(db,c)),assignments:assignments.map(a=>assignmentView(db,a)),todos:db.todos.filter(t=>t.ownerId===user.id),notifications:db.notifications.filter(n=>n.recipientId===user.id).slice(0,5),sections:spaces.map(s=>({id:s.id,title:s.title,program:s.program,subject:s.subject})),roleSections:internalRole?[]:user.roles.map(role=>({role,title:roleLabels[role],description:scopeLabel({...user,roles:[role]}),...readPage(repo,{...user,roles:[role]},'P03',{},true).data}))});break}
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
        }
        data.posts = posts.filter(post => post.audience === `space:${space.id}`).map(post => postView(db, post, user))
        data.canPost = canPublish(db, user, `space:${space.id}`, false)
      }
      break
    }
    case'P09':data.organizations=db.organizations.filter(o=>match(o.name)).map(o=>({id:o.id,name:o.name,description:o.description,member:isOrganizationMember(db,user,o.id),memberCount:o.memberIds.length}));break
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
          members: member ? [
            { name: find(db.users, organization.representativeId).name, organizationRole: 'Officer' },
            ...organization.memberIds.map(id => ({ name: find(db.users, id).name, organizationRole: 'Member' })),
          ] : [],
        }
        data.posts = posts.filter(post => post.audience === `organization:${organization.id}` || post.authorId === organization.representativeId && !post.private).map(post => postView(db, post, user))
        data.events = visibleEvents(db, user).filter(event => event.organizationId === organization.id)
        data.canPublish = organization.representativeId === user.id
        data.canPost = canPublish(db, user, `organization:${organization.id}`, false)
      }
      break
    }
    case 'P11':
    case 'P12': {
      const threads = db.threads.filter(thread => canThread(db, user, thread))
      data.threads = threads
        .filter(thread => match(thread.title))
        .map(thread => ({
          id: thread.id,
          title: thread.title,
          kind: thread.spaceId ? 'group' : 'direct',
          members: thread.memberIds.map(memberId => person(find(db.users, memberId))),
          lastMessage: thread.messages.at(-1)?.body ?? '',
          updatedAt: thread.messages.at(-1)?.at,
          unread: unreadMessages(thread, user.id),
        }))
      data.recipients = db.users.filter(target => canReach(db, user, target)).map(person)
      if (pageId === 'P12') {
        const thread = pick(threads, query.id)
        if (thread) {
          data.record = {
            id: thread.id,
            title: thread.title,
            members: thread.memberIds.map(memberId => person(find(db.users, memberId))),
            messages: thread.messages.map(message => messageView(db, message)),
            muted: thread.mutedBy.includes(user.id),
            unread: unreadMessages(thread, user.id),
            kind: thread.spaceId ? 'group' : 'direct',
          }
        }
      }
      break
    }
    case'P13':Object.assign(data,{events:visibleEvents(db,user).filter(e=>!hasRole(user,'organization')||!e.organizationId||e.organizationId===user.organizationId),slots:hasRole(user,'organization')?[]:visibleSlots(db,user),todos:db.todos.filter(t=>t.ownerId===user.id),consultations:visibleConsultations(db,user).map(c=>consultationView(db,c))});break
    case'P14':Object.assign(data,{consultations:visibleConsultations(db,user).map(c=>consultationView(db,c)),faculty:faculty.filter(u=>match(u.name)).map(u=>({...person(u),nextSlot:db.slots.find(s=>s.facultyId===u.id&&s.state==='open')}))});break
    case'P15':{const f=pick(faculty,query.id);if(f){data.record=person(f);data.slots=db.slots.filter(s=>s.facultyId===f.id)}break}
    case'P16':{const c=pick(visibleConsultations(db,user),query.id);if(c)data.record=consultationView(db,c);break}
    case'P17':data.slots=db.slots.filter(s=>s.facultyId===user.id);break
    case'P18':data.reports=ownReports.map(r=>reportView(db,r,user,true));break
    case'P19':Object.assign(data,{categories:['General concern','Academic process','Facilities','Communication'],adviser:user.adviserId?person(find(db.users,user.adviserId)):null,anonymityAllowed:!user.restrictions.includes('report.anonymous'),consentWording,draft:db.drafts[user.id]??null,sourcePost:query.from?(()=>{const p=posts.find(p=>p.id===query.from&&p.authorId===user.id);if(!p)throw unavailable();return postView(db,p,user)})():null});break
    case'P20':{const r=pick(ownReports,query.id);if(r)data.record=reportView(db,r,user,true);data.consentWording=consentWording;break}
    case'P21':data.cases=cases.filter(r=>(!query.q||r.id.toLowerCase().includes(query.q.toLowerCase()))&&(!query.status||r.status===query.status)&&(!query.category||r.category===query.category)&&(!query.severity||r.severity===query.severity)).map(r=>reportView(db,r,user));break
    case'P22':{const r=pick(cases,query.id);if(r)data.record=reportView(db,r,user);break}
    case'P23':case'P24':{const clusters=db.clusters.filter(c=>c.program===user.program);data.clusters=clusters.map(c=>({...c,reportIds:undefined,reportCount:db.reports.filter(r=>c.reportIds.includes(r.id)&&canViewCase(user,r)).length}));data.threshold=80;if(pageId==='P24'){const c=pick(clusters,query.id);if(c){data.record={...c,reportIds:undefined};data.reports=db.reports.filter(r=>c.reportIds.includes(r.id)&&canViewCase(user,r)).map(r=>reportView(db,r,user))}}break}
    case 'P25': {
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
      data.stats = [
        { label: 'Open', value: records.filter((report) => !['Resolved', 'Closed'].includes(report.status)).length, note: 'Not yet resolved' },
        { label: 'Escalated', value: records.filter((report) => report.stage !== 'adviser').length, note: 'Past the adviser' },
        { label: 'Resolved', value: records.filter((report) => ['Resolved', 'Closed'].includes(report.status)).length, note: 'Resolved or closed' },
        { label: 'Median days to resolve', value: 0, note: 'No resolved reports yet' },
        { label: 'Adviser bypassed', value: records.filter((report) => report.bypassed).length, note: 'Sent straight to the chair' },
      ]
      data.byStage = Object.keys(offices).map((stage) => ({
        label: offices[stage as Stage],
        value: records.filter((report) => report.stage === stage).length,
      }))
      data.trend = [{
        label: '20 Oct',
        opened: records.length,
        resolved: records.filter((report) => ['Resolved', 'Closed'].includes(report.status)).length,
      }]
      data.byCategory = [...new Set(records.map((report) => report.category))].map((label) => {
        const count = records.filter((report) => report.category === label).length
        return { label, value: count >= 5 ? count : null, suppressed: count < 5 }
      })
      data.cases = records.filter((report) => canViewCase(user, report)).map((report) => ({
        id: report.id,
        stage: report.stage,
        status: statusFor(report),
        createdAt: report.createdAt,
      }))
      break
    }
    case'P26':Object.assign(data,{assignments:db.assignments.filter(a=>a.evaluatorId===user.id&&['Published','Closed'].includes(find(db.cycles,a.cycleId).status)).map(a=>assignmentView(db,a)),reviewCycles:hasRole(user,'professor')?db.cycles.filter(c=>c.status==='In review'&&db.assignments.some(a=>a.cycleId===c.id&&a.facultyId===user.id)):[],canConfigure:hasRole(user,'dean'),canViewResults:hasPermission(user,'evaluation.results')});break
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
          value: results.length
            ? Number((results.reduce((total,result) => total + result.average,0) / results.length).toFixed(2))
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
        data.facultyReviews = db.users
          .filter(faculty => hasRole(faculty,'professor') && db.assignments.some(assignment =>
            assignment.cycleId === cycle.id && assignment.facultyId === faculty.id,
          ))
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
    case'P32':{const c=pick(db.cycles.filter(c=>db.assignments.some(a=>a.cycleId===c.id&&a.facultyId===user.id)),query.id);if(c){data.record={...c,reviews:c.reviews.filter(r=>r.userId===user.id)};data.canReview=c.status==='In review'&&!c.reviews.some(r=>r.userId===user.id)}break}
    case'P33':data.students=db.users.filter(u=>canStudentRecord(db,user,u)&&match(`${u.name} ${u.studentId}`)).map(u=>person(refreshRestrictions(db,u)));break
    case'P34':{if(!query.purpose){data.purposeRequired=true;break}const students=db.users.filter(u=>canStudentRecord(db,user,u));const s=pick(students,query.id);if(s){const entry=audit(repo,user,'Record opened','records',s.studentId??s.id,query.purpose);data.record={...person(refreshRestrictions(db,s)),offenses:db.offenses.filter(o=>o.studentId===s.id),restrictions:restrictionViews(db,user,s.id),goodMoral:hasPermission(user,'goodmoral.review')?db.goodMoral.find(g=>g.studentId===s.id):undefined,openedAt:entry.at,accessHistory:hasRole(user,'dean')?safeAudit(db,db.audit.filter(a=>a.action==='Record opened'&&a.reference===(s.studentId??s.id))):undefined}}break}
    case'P35':{const students=db.users.filter(u=>hasRole(u,'student')&&(hasRole(user,'administrator')||canStudentRecord(db,user,u)));data.students=students.map(u=>person(refreshRestrictions(db,u)));data.restrictions=restrictionViews(db,user);data.referrals=db.referrals.filter(r=>hasRole(user,'administrator')||r.actorId===user.id).map(r=>({...r,student:person(find(db.users,r.studentId)),actor:author(db,r.actorId)}));data.canApply=hasRole(user,'administrator');break}
    case 'P36': {
      const activeRestrictions = restrictionViews(db, user, user.id).filter(restriction => restriction.active)
      const standing = refreshRestrictions(db, user).restrictions.length ? 'Some features paused' : 'Good standing'
      data.record = {
        standing,
        restrictions: activeRestrictions.map(restriction => ({ id: restriction.id, features: restriction.features, until: restriction.until, starts: restriction.starts })),
        essentialAccess: ['Announcements', 'Classes and academic information', 'Assistant', 'Messages with your professors'],
      }
      break
    }
    case'P37':data.people=db.users.filter(u=>u.active&&!hasRole(u,'student','organization')&&match(`${u.name} ${u.office} ${u.program} ${u.email}`)).map(person);break
    case'P38':{const u=pick(db.users.filter(u=>u.active),query.id);if(u){const {studentId: _studentId,...profile}=person(refreshRestrictions(db,u));data.record=profile}break}
    case'P39':data.record=person(user);break
    case'P40':data.notifications=db.notifications.filter(n=>n.recipientId===user.id);break
    case'P41':data.faq=filteredFaq(user);data.suggestions=['What can you help me with?',...(hasRole(user,'student')?['Show my schedule','Explain my report milestones']:[])];break
    case'P42':data.faq=filteredFaq(user).filter(f=>match(`${f.question} ${f.answer}`));break
    case 'P43':
    case 'P44': {
      data.settings = db.settings[user.id] ?? defaultSettings(user)
      data.record = person(user)
      data.categories = notificationCategories(user)
      data.requiredCategories = notificationCategories(user).filter(category => requiredNotificationCategories.includes(category))
      break
    }
    case'P45':data.stats=[{label:'Active accounts',value:db.users.filter(u=>u.active).length,note:'Can sign in'},{label:'Pending reviews',value:db.moderation.filter(m=>m.status==='Pending').length,note:'Waiting for a moderator'},{label:'Active restrictions',value:db.restrictions.filter(r=>r.active&&r.until>=now().slice(0,10)).length,note:'Features currently paused'},{label:'Assistant sessions',value:db.telemetry.length,note:'Questions are not stored'}];data.moderation=db.moderation.slice(0,5).map(m=>({id:m.id,itemType:m.itemType,source:m.source,status:m.status,at:m.at}));data.audit=safeAudit(db,db.audit.slice(-5).reverse());data.systemStatus={api:'Operational',assistant:'Built-in help assistant',storage:'Application store'};data.adoption=roles.map(role=>({label:roleLabels[role],value:db.users.filter(u=>u.roles.includes(role)).length}));break
    case'P46':data.users=db.users.filter(u=>match(`${u.name} ${u.email} ${u.id}`)).map(u=>({...person(refreshRestrictions(db,u)),active:u.active}));break
    case'P47':{const u=pick(db.users,query.id);if(u){data.record={...person(refreshRestrictions(db,u)),active:u.active};data.audit=safeAudit(db,db.audit.filter(a=>a.reference===u.id))}data.roles=roles.map(role=>({id:role,label:roleLabels[role]}));break}
    case'P48':data.permissionMatrix=Object.entries(permissionRoles).map(([key,grantedRoles])=>({key,roles:grantedRoles}));data.permissionProposals=db.permissionOverrides;data.roles=roles.map(role=>({id:role,label:roleLabels[role]}));break
    case'P49':data.moderation=db.moderation.filter(m=>canSeeModeration(user,m)&&(!query.status||m.status===query.status)).map(m=>({...m,authorId:undefined,reporterId:undefined}));break
    case'P50':{const m=pick(db.moderation.filter(item=>canSeeModeration(user,item)),query.id);if(m){data.record={...m,authorId:undefined,reporterId:undefined,reporter:m.reporterId?{name:'Verified community member'}:undefined};const p=db.posts.find(p=>p.id===m.parentId);if(p)data.post=postView(db,p,user);if(m.itemType==='message'){const thread=db.threads.find(t=>t.id===m.parentId);data.messages=thread?.messages.filter(message=>message.id===m.itemId).map(message=>messageView(db,message))??[]}}break}
    case'P51':data.audit=safeAudit(db,db.audit.filter(a=>(!query.from||a.at>=query.from)&&(!query.to||a.at<=`${query.to}T23:59:59.999Z`)&&(!query.q||`${a.reference} ${a.action} ${a.module}`.toLowerCase().includes(query.q.toLowerCase()))));break
    case'P52':{const telemetry=query.period==='none'?[]:db.telemetry;data.stats=[{label:'Assistant sessions',value:telemetry.length,note:'Help assistant'},{label:'Failures',value:telemetry.filter(t=>!t.success).length,note:'Counts only'},{label:'Median response time',value:telemetry.length?`${telemetry.map(t=>t.durationMs).sort((a,b)=>a-b)[Math.floor(telemetry.length/2)]} ms`:'No data',note:'Since the server started'}];data.systemStatus={api:'Operational',assistant:'Built-in help assistant',storage:'Application store'};data.telemetry=telemetry;data.incidents=[];data.trend=telemetry.length?[{label:now().slice(0,10),value:telemetry.length}]:[];break}
  }
  return JSON.parse(JSON.stringify({pageId,title:pageTitles[pageId],scope:scopeLabel(user),sampleData:true,data})) as {pageId:string;title:string;scope:string;sampleData:true;data:Record<string,unknown>}
}

function ensureCycleAssignments(repo:UnitOfWork,cycle:Cycle){
  const db=repo.read()
  const add=(evaluatorId:string,facultyId:string,relation:string,subject:string)=>{if(!db.assignments.some(a=>a.cycleId===cycle.id&&a.evaluatorId===evaluatorId&&a.facultyId===facultyId&&a.relation===relation))db.assignments.push({id:repo.nextId('EVAL'),evaluatorId,facultyId,cycleId:cycle.id,relation,subject})}
  for(const student of db.users.filter(u=>hasRole(u,'student'))){if(cycle.forms.includes('student'))for(const facultyId of [...new Set(db.spaces.filter(s=>s.studentIds.includes(student.id)).flatMap(s=>s.professorIds))])add(student.id,facultyId,'Student to faculty',student.program??'CCS')}
  for(const professor of db.users.filter(u=>hasRole(u,'professor'))){if(cycle.forms.includes('peer')){const target=db.users.find(u=>u.id!==professor.id&&hasRole(u,'professor')&&u.program===professor.program);if(target)add(professor.id,target.id,'Peer','Faculty peer review')}for(const[form,role]of [['upward-chair','chair'],['upward-dean','dean']] as const){const target=db.users.find(u=>hasRole(u,role)&&(role==='dean'||u.program===professor.program));if(cycle.forms.includes(form)&&target&&target.id!==professor.id)add(professor.id,target.id,form,'Leadership feedback')}}
}
const actionPages: Record<string, string[]> = {
  createPost: ['P05', 'P08', 'P10'],
  updatePost: ['P06'],
  deletePost: ['P06'],
  comment: ['P06'],
  react: ['P06'],
  flag: ['P06', 'P12'],
  createReport: ['P19'],
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
  deleteAvailability: ['P17'],
  createTodo: ['P13'],
  toggleTodo: ['P13'],
  deleteTodo: ['P13'],
  createThread: ['P11'],
  sendMessage: ['P12'],
  muteThread: ['P12'],
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
  applyRestriction: ['P35'],
  liftRestriction: ['P35'],
  referRestriction: ['P34', 'P35'],
  saveProfile: ['P39'],
  saveSettings: ['P43'],
  saveNotificationPreferences: ['P44'],
  updateRoles: ['P46', 'P47'],
  updatePermission: ['P48'],
  moderate: ['P50'],
}
/** The fields `updateRoles` changes, as the auth store keeps them. */
export type AccountChange = Pick<User,'id'|'roles'|'active'> & Partial<Pick<User,'program'|'section'>>
/** The fields `saveProfile` changes. */
export type ProfileChange = { title: string; bio: string; education: string; officeHours: string }
// Accounts live in the auth store, shared by every instance, so a role or profile change is saved there once the action has committed.
export async function performAction(repo:Repository,user:User,pageId:string,request:ActionRequest,saveAccount?:(change:AccountChange)=>Promise<void>,saveProfile?:(id:string,change:ProfileChange)=>Promise<void>){
  const result=await repo.transact(unit=>runAction(unit,user,pageId,request))
  if(request.action==='updateRoles')await saveAccount?.(result.record as AccountChange)
  if(request.action==='saveProfile')await saveProfile?.(user.id,actionPayloads.saveProfile.parse(request.payload))
  return result
}
function runAction(repo:UnitOfWork,user:User,pageId:string,request:ActionRequest){
  if(!canPage(user,pageId)||!actionPages[request.action]?.includes(pageId))throw deny()
  const db=repo.read();const id=request.recordId;let record:unknown;let message='Changes saved.'
  // The report is named by the record ID, or by `reportId` in the payload for the talk actions.
  const getOwnReport=(reportId=id)=>{const r=find(db.reports,reportId);if(r.ownerId!==user.id||!hasRole(user,'student'))throw unavailable();return r}
  const getCase=(reportId=id)=>{const r=find(db.reports,reportId);if(!canActCase(user,r))throw unavailable();return r}
  const addMessage=(list:Message[],body:string)=>{const m={id:repo.nextId('MESSAGE'),authorId:user.id,body,at:now()};list.push(m);return m}
  switch(request.action){
    case 'createPost': {
      const payload = actionPayloads.createPost.parse(request.payload)
      if (!canPublish(db, user, payload.audience, payload.kind === 'announcement')) throw deny()
      if (payload.anonymous && (!hasRole(user, 'student') || payload.kind === 'announcement' || user.restrictions.includes('post.create'))) throw deny()
      const post: Post = {
        ...payload,
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
      notifyAnnouncementMembers(repo, post)
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
      Object.assign(post, payload, { label, updatedAt: now() })
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
    case'comment':{if(!permissionRoles['post.create']!.some(role=>user.roles.includes(role)))throw deny();if(user.restrictions.includes('post.comment'))throw deny();const p=actionPayloads.comment.parse(request.payload);const post=find(db.posts,id);if(!canAudience(db,user,post.audience,post.private)||post.removed)throw unavailable();if(!canPublish(db,user,post.audience,false,'comment'))throw deny();if(p.anonymous&&!hasRole(user,'student'))throw deny();post.comments.push({...addMessage([],p.body),anonymous:p.anonymous});record=postView(db,post,user);message='Comment added.';break}
    case'react':{actionPayloads.react.parse(request.payload);if(!permissionRoles['post.create']!.some(role=>user.roles.includes(role)))throw deny();const post=find(db.posts,id);if(!canAudience(db,user,post.audience,post.private)||post.removed)throw unavailable();if(!canPublish(db,user,post.audience,false,'react'))throw deny();post.reactions=post.reactions.includes(user.id)?post.reactions.filter(v=>v!==user.id):[...post.reactions,user.id];record=postView(db,post,user);message='Reaction updated.';break}
    case'flag':{const p=actionPayloads.flag.parse(request.payload);let authorId:string,body:string,parentId:string,itemId:string;if(p.itemType==='message'){const thread=find(db.threads,id);if(!canThread(db,user,thread))throw unavailable();const m=find(thread.messages,p.itemId);authorId=m.authorId;body=m.body;parentId=thread.id;itemId=m.id}else{const post=find(db.posts,id);if(!canAudience(db,user,post.audience,post.private))throw unavailable();const item=p.itemType==='comment'?find(post.comments,p.itemId):post;authorId=item.authorId;body=item.body;parentId=post.id;itemId=item.id}const mod={id:repo.nextId('MOD'),itemType:p.itemType,itemId,parentId,authorId,reporterId:user.id,source:'User' as const,reason:p.reason,excerpt:body.slice(0,160),status:'Pending',at:now(),history:[]};db.moderation.push(mod);audit(repo,user,'Content reported','moderation',mod.id);record={id:mod.id,status:mod.status};message='Sent to a moderator.';break}
    case 'createReport': {
      requirePermission(user, 'report.create')
      const p = actionPayloads.createReport.parse(request.payload)
      if (p.identity === 'anonymous' && user.restrictions.includes('report.anonymous')) throw deny()
      // The adviser is a professor set as the student's adviser. Without one a concern can still go to the chair, if it is about the adviser.
      const adviser = db.users.find(u => u.id === user.adviserId && u.active && hasRole(u, 'professor'))
      if (!adviser && !p.aboutAdvisor) throw conflict('You do not have an active adviser, so this concern cannot be sent. Ask the CCS office to set your adviser, then try again.')
      const bypassed = p.aboutAdvisor || p.conflictedAdviser || !!adviser && (p.involvedUserIds.includes(adviser.id) || p.narrative.toLowerCase().includes(adviser.name.toLowerCase()))
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
        stage: bypassed ? 'chair' : 'adviser',
        status: 'Submitted',
        narrative: p.narrative,
        category: p.category,
        severity: p.severity,
        identity: p.identity,
        alias: `Reporter A-${repo.nextId('ALIAS').slice(-4)}`,
        disclosedTo: [],
        involvedUserIds: [...new Set([...p.involvedUserIds, ...(bypassed && adviser ? [adviser.id] : [])])],
        bypassed,
        // A concern that goes around the adviser is "about the adviser" for every rule that keeps the adviser out.
        aboutAdvisor: bypassed,
        consent: { readStatement: true, at, userId: user.id, version: consentWording.version, wording: consentWording.report },
        createdAt: at,
        updatedAt: at,
        sourcePostId: p.sourcePostId,
        location: p.location,
        occurredOn: p.occurredOn,
        history: [{ id: repo.nextId('HISTORY'), at, actorId: user.id, actorRole: 'student', action: 'Submitted', reason: bypassed ? 'Adviser named in the report. Sent to the chair for review.' : 'Sent to the student\'s adviser.', update: 'Your report was sent to the office handling it.', public: true, stage: bypassed ? 'chair' : 'adviser' }],
        notes: [],
        messages: [],
      }
      // Nothing is stored or sent when no one can receive it.
      if (!handlerIds(db, r).length) throw conflict(bypassed ? 'Your concern goes to your Program Chair, and your program does not have a Program Chair who can receive it yet. Ask the CCS office to set one, then try again.' : 'Your adviser cannot receive concerns right now. Ask the CCS office to check your adviser, then try again.')
      db.reports.push(r)
      delete db.drafts[user.id]
      audit(repo, user, 'Report submitted', 'reports', r.id)
      audit(repo, user, 'Report consent recorded', 'reports', r.id)
      notify(repo, user.id, 'report', 'P20', r.id)
      for (const handlerId of handlerIds(db, r)) notify(repo, handlerId, 'report', 'P22', r.id)
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
        if (db.consultations.some(c => c.id === r.talk?.consultationId && !['Declined', 'Cancelled', 'Completed'].includes(c.status))) throw conflict('You already asked for a time for this concern. Cancel that request under Consultations first.')
        consultation = reserveSlot(repo, user.id, slot, 'Talk about a concern', r.id)
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
      if (['Resolved', 'Closed'].includes(r.status)) throw conflict('This concern is closed.')
      if (!r.talk) throw conflict('The student has not chosen how to talk yet.')
      if (p.meetingLink && r.talk.mode !== 'video' && r.talk.mode !== 'voice') throw conflict('A meeting link only applies to video and voice calls.')
      if (p.place && r.talk.mode !== 'face_to_face') throw conflict('A place only applies to meeting in person.')
      const { reportId: _reportId, ...details } = p
      r.talk = { ...r.talk, ...details, updatedAt: now() }
      r.updatedAt = r.talk.updatedAt
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
      notify(repo, r.ownerId, 'case', 'P20', r.id)
      record = reportView(db, r, user)
      message = `${action}.`
      break
    }
    case'discloseIdentity':{const p=actionPayloads.discloseIdentity.parse(request.payload);const r=getOwnReport();if(p.office&&p.office!==r.stage&&p.office!==offices[r.stage])throw deny();if(!r.disclosedTo.includes(r.stage)){r.disclosedTo.push(r.stage);audit(repo,user,'Identity disclosed','reports',r.id);for(const handlerId of handlerIds(db,r))notify(repo,handlerId,'report','P22',r.id)}record=reportView(db,r,user,true);message=`Your name is shared with ${offices[r.stage]}.`;break}
    case'caseAction':{const p=actionPayloads.caseAction.parse(request.payload);const reason=reasonOf(request);const r=getCase();if(!caseActions(user,r).includes(p.type))throw conflict('That action is not available at this stage.');const previous=r.stage;let action=p.type as string;if(p.type==='convert'){requirePermission(user,'case.convert');r.caseFileId=repo.nextId('CF');r.status='Case File at Guidance';action='Case File opened'}else if(p.type==='resolve'){r.status='Resolved';action='Resolved'}else if(p.type==='close'){r.status='Closed';action='Closed'}else if(['escalate','transfer'].includes(p.type)){/* Fixed order, decided 2026-11-10: Dean to Guidance, Guidance to OSAS. OSAS is the last stage. */const next:Partial<Record<Stage,Stage>>={adviser:'chair',chair:'dean',dean:'guidance',guidance:'osas'};const nextStage=next[r.stage]!;if(p.nextStage&&p.nextStage!==nextStage)throw conflict('This office cannot make that transfer.');if(r.stage==='guidance'&&!r.caseFileId)throw conflict('Open a Case File before transferring.');if(r.confidential)throw conflict('This concern is confidential. Remove the confidential mark before escalating it.');r.stage=nextStage;r.status=`With ${offices[nextStage]}`;action='Transferred'}else if(p.type==='respond'){addMessage(r.messages,p.update);action='Response sent'}else if(p.type==='milestone')action='Milestone added';else action='Action recorded';r.updatedAt=now();r.history.push({id:repo.nextId('HISTORY'),at:r.updatedAt,actorId:user.id,actorRole:stageRoles[previous],action,reason,update:p.update,public:true,stage:r.stage});audit(repo,user,'Case transition','cases',r.caseFileId??r.id);notify(repo,r.ownerId,'case','P20',r.id);for(const handlerId of handlerIds(db,r))notify(repo,handlerId,'case','P22',r.id);record=reportView(db,r,user, false);message=`${action}.`;break}
    case'addNote':{const p=actionPayloads.addNote.parse(request.payload);const r=getCase();const m=addMessage(r.notes,p.body);audit(repo,user,'Internal note recorded','cases',r.caseFileId??r.id);record=messageView(db,m);message='Internal note saved.';break}
    case'reviewCluster':{requirePermission(user,'cluster.review');const p=actionPayloads.reviewCluster.parse(request.payload);const reason=reasonOf(request);const c=find(db.clusters,id);if(c.program!==user.program)throw unavailable();c.status=p.decision==='confirmed'?'Confirmed':'Dismissed';c.history.push({at:now(),actorId:user.id,decision:c.status,reason});audit(repo,user,'Similarity group reviewed','cases',c.id);record={...c,reportIds:undefined};message='Group review recorded.';break}
    case'createConsultation':{requirePermission(user,'consultation.request');const p=actionPayloads.createConsultation.parse(request.payload);const slot=find(db.slots,p.slotId);const faculty=find(db.users,slot.facultyId);if(!canReach(db,user,faculty))throw unavailable();const c=reserveSlot(repo,user.id,slot,p.purpose);record=consultationView(db,c);message='Request sent.';break}
    case'decideConsultation':{const p=actionPayloads.decideConsultation.parse(request.payload);const c=find(visibleConsultations(db,user),id);const student=c.studentId===user.id;const valid:Record<string,string[]>={Requested:['Approved','Declined','Cancelled'],Approved:['Booked','Cancelled'],Booked:['Completed','Cancelled'],Completed:[],Declined:[],Cancelled:[]};if(!valid[c.status]?.includes(p.decision)||student&&p.decision!=='Cancelled')throw conflict('That change is not available for this consultation.');if(!student)requirePermission(user,'consultation.decide');if(['Declined','Cancelled'].includes(p.decision)&&!(p.note?.trim()||request.reason?.trim()))throw new ApiError(400,'A reason is required.','VALIDATION_ERROR');const slot=find(db.slots,c.slotId);if(['Approved','Booked'].includes(p.decision)&&db.consultations.some(other=>other.id!==c.id&&other.slotId===slot.id&&['Approved','Booked'].includes(other.status)))throw conflict('This time is already booked.');c.status=p.decision;c.updatedAt=now();c.history.push({at:c.updatedAt,status:c.status,note:p.note??request.reason??'Status updated',actorId:user.id});slot.state=['Declined','Cancelled','Completed'].includes(c.status)?'open':c.status==='Booked'?'booked':'requested';notify(repo,student?c.facultyId:c.studentId,'consultation','P16',c.id);record=consultationView(db,c);message='Consultation updated.';break}
    case'saveAvailability':{requirePermission(user,'consultation.decide');const p=actionPayloads.saveAvailability.parse(request.payload);if(p.end<=p.start)throw new ApiError(400,'The end time must be later than the start time.','VALIDATION_ERROR');if(db.slots.some(s=>s.id!==id&&s.facultyId===user.id&&s.date===p.date&&s.start<p.end&&s.end>p.start))throw conflict('This time overlaps an existing slot.');if(id){const s=find(db.slots,id);if(s.facultyId!==user.id)throw unavailable();if(['booked','requested'].includes(s.state))throw conflict('This time has a request. Cancel the consultation first.');Object.assign(s,p);record=s}else{record={id:repo.nextId('SLOT'),facultyId:user.id,...p};db.slots.push(record as Database['slots'][number])}message='Availability saved.';break}
    case'deleteAvailability':{actionPayloads.deleteAvailability.parse(request.payload);requirePermission(user,'consultation.decide');const s=find(db.slots,id);if(s.facultyId!==user.id)throw unavailable();if(['booked','requested'].includes(s.state))throw conflict('Cancel the consultation before removing this time.');db.slots=db.slots.filter(slot=>slot.id!==s.id);message='Availability removed.';break}
    case'createTodo':{requirePermission(user,'todo.manage');const p=actionPayloads.createTodo.parse(request.payload);const todo={id:repo.nextId('TODO'),ownerId:user.id,...p,done:false};db.todos.push(todo);record=todo;message='To-do added.';break}
    case'toggleTodo':case'deleteTodo':{requirePermission(user,'todo.manage');const todo=find(db.todos,id);if(todo.ownerId!==user.id)throw unavailable();if(request.action==='toggleTodo')todo.done=actionPayloads.toggleTodo.parse(request.payload).done;else{actionPayloads.deleteTodo.parse(request.payload);db.todos=db.todos.filter(t=>t.id!==todo.id)}record=todo;message='To-do updated.';break}
    case 'createThread': {
      requirePermission(user, 'message.send')
      const payload = actionPayloads.createThread.parse(request.payload)
      const recipient = find(db.users, payload.recipientId)
      if (!canReach(db, user, recipient)) throw unavailable()
      const existing = db.threads.find(thread =>
        !thread.spaceId
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
      addMessage(thread.messages, payload.body)
      thread.readMessageCounts[user.id] = thread.messages.length
      notify(repo, recipient.id, 'message', 'P12', thread.id)
      record = { id: thread.id, title: thread.title }
      message = 'Message sent.'
      break
    }
    case 'sendMessage': {
      const payload = actionPayloads.sendMessage.parse(request.payload)
      const thread = find(db.threads, id)
      if (!canThread(db, user, thread)) throw unavailable()
      const sent = addMessage(thread.messages, payload.body)
      thread.readMessageCounts[user.id] = thread.messages.length
      for (const recipientId of thread.memberIds.filter(memberId => memberId !== user.id)) {
        notify(repo, recipientId, 'message', 'P12', thread.id)
      }
      if (/\b(idiot|stupid|hate)\b/i.test(payload.body)) {
        db.moderation.push({
          id: repo.nextId('MOD'),
          itemType: 'message',
          itemId: sent.id,
          parentId: thread.id,
          authorId: user.id,
          source: 'Filter',
          reason: 'Word filter match. A moderator must review it.',
          excerpt: payload.body.slice(0, 160),
          status: 'Pending',
          at: now(),
          history: [],
        })
      }
      record = messageView(db, sent)
      message = 'Message sent.'
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
    case'submitEvaluation':{requirePermission(user,'evaluation.fill');const p=actionPayloads.submitEvaluation.parse(request.payload);const a=find(db.assignments,id);if(a.evaluatorId!==user.id)throw unavailable();const cycle=find(db.cycles,a.cycleId);if(cycle.status!=='Published')throw conflict('This evaluation is not open.');if(a.submittedAt)throw conflict('This evaluation has already been submitted.');for(const q of cycle.questions){const value=p.answers[q.id];if(q.required&&(value===undefined||value===''))throw new ApiError(400,'Answer every required question.','VALIDATION_ERROR');if(value!==undefined&&(q.type==='rating'&&typeof value!=='number'||q.type==='text'&&typeof value!=='string'))throw new ApiError(400,'One answer is in the wrong format.','VALIDATION_ERROR')}if(Object.keys(p.answers).some(key=>!cycle.questions.some(q=>q.id===key)))throw new ApiError(400,'One answer does not belong to this form.','VALIDATION_ERROR');a.answers=p.answers;a.comment=p.comment;a.submittedAt=now();record=assignmentView(db,a,true);message='Evaluation submitted.';break}
    case'createCycle':{requirePermission(user,'evaluation.configure');const p=actionPayloads.createCycle.parse(request.payload);if(p.closes<p.opens)throw new ApiError(400,'The closing date must be after the opening date.','VALIDATION_ERROR');const cycle={id:repo.nextId('CYCLE'),...p,status:'Draft' as const,instructions:'',questions:[],forms:[],resultsPublished:false,reviews:[]};db.cycles.push(cycle);record=cycle;message='Draft cycle created.';break}
    case'saveCycle':{requirePermission(user,'evaluation.configure');const p=actionPayloads.saveCycle.parse(request.payload);const c=find(db.cycles,id);if(!['Draft','In review'].includes(c.status))throw conflict('You cannot change questions after the form is published.');if(p.closes<p.opens)throw new ApiError(400,'The closing date must be after the opening date.','VALIDATION_ERROR');Object.assign(c,p);record=c;message='Cycle saved.';break}
    case'cycleAction':{requirePermission(user,'evaluation.configure');const p=actionPayloads.cycleAction.parse(request.payload);const c=find(db.cycles,id);const next:Record<string,string>={Draft:'In review','In review':'Published',Published:'Closed'};if(next[c.status]!==p.status)throw conflict('The cycle cannot move to that status.');if(!c.title||!c.instructions||!c.questions.length||!c.forms.length||c.closes<c.opens)throw new ApiError(400,'Add a name, instructions, dates, forms, and questions first.','VALIDATION_ERROR');c.status=p.status;if(['In review','Published'].includes(p.status))ensureCycleAssignments(repo,c);if(p.status==='Published')for(const recipientId of [...new Set(db.assignments.filter(a=>a.cycleId===c.id).map(a=>a.evaluatorId))])notify(repo,recipientId,'evaluation','P26');if(p.publishResults&&p.status==='Closed')c.resultsPublished=true;audit(repo,user,'Evaluation cycle changed','evaluations',c.id);record=c;message='Cycle updated.';break}
    case'reviewQuestions':{requirePermission(user,'evaluation.review');const p=actionPayloads.reviewQuestions.parse(request.payload);const c=find(db.cycles,id);if(!db.assignments.some(a=>a.cycleId===c.id&&a.facultyId===user.id))throw unavailable();if(c.status!=='In review'||c.reviews.some(r=>r.userId===user.id))throw conflict('There are no questions to review right now.');c.reviews.push({userId:user.id,...p,at:now()});record={id:c.id,review:c.reviews.at(-1)};message='Review sent.';break}
    case'saveFollowUp':{requireRole(user,'chair','dean');const p=actionPayloads.saveFollowUp.parse(request.payload);const faculty=find(db.users,id);if(!canFacultyResult(user,faculty))throw unavailable();db.followUps.push({id:repo.nextId('FOLLOWUP'),facultyId:faculty.id,actorId:user.id,note:p.note,at:now()});audit(repo,user,'Evaluation follow-up recorded','evaluations',faculty.id);message='Follow-up note saved.';break}
    case'openRecord':{const p=actionPayloads.openRecord.parse(request.payload);record=readPage(repo,user,'P34',{id,...p}).data.record;message='Record opened and logged.';break}
    case'reviewGoodMoral':{requirePermission(user,'goodmoral.review');const p=actionPayloads.reviewGoodMoral.parse(request.payload);const student=find(db.users,id);if(!canStudentRecord(db,user,student))throw unavailable();const review={studentId:student.id,...p,actorId:user.id,at:now()};db.goodMoral=db.goodMoral.filter(g=>g.studentId!==student.id);db.goodMoral.push(review);audit(repo,user,'Good Moral prerequisite reviewed','records',student.studentId??student.id);record=review;message='Review saved.';break}
    case'applyRestriction':{requireRole(user,'administrator');const p=actionPayloads.applyRestriction.parse(request.payload);reasonOf(request);const student=find(db.users,p.studentId);if(!hasRole(student,'student'))throw unavailable();if(p.until<now().slice(0,10))throw new ApiError(400,'The end date must be today or later.','VALIDATION_ERROR');const r={id:repo.nextId('RST'),...p,starts:now(),actorId:user.id,active:true};db.restrictions.push(r);audit(repo,user,'Restriction applied','restrictions',r.id);notify(repo,student.id,'restriction','P36');record=r;message='Selected features paused.';break}
    case'liftRestriction':{requireRole(user,'administrator');actionPayloads.liftRestriction.parse(request.payload);reasonOf(request);const r=find(db.restrictions,id);if(!r.active||r.until<now().slice(0,10))throw conflict('This restriction has already ended.');r.active=false;audit(repo,user,'Restriction lifted','restrictions',r.id);notify(repo,r.studentId,'restriction','P36');record=r;message='Restriction lifted.';break}
    case'referRestriction':{requireRole(user,'guidance','osas');const p=actionPayloads.referRestriction.parse(request.payload);const reason=reasonOf(request);const student=find(db.users,p.studentId);if(!canStudentRecord(db,user,student))throw unavailable();const referral={id:repo.nextId('REF'),studentId:student.id,change:p.change,decisionReference:p.decisionReference??'',reason,actorId:user.id,at:now(),status:'Awaiting administrator review'};db.referrals.push(referral);audit(repo,user,'Restriction change requested','restrictions',referral.id);for(const admin of db.users.filter(u=>hasRole(u,'administrator')))notify(repo,admin.id,'restriction','P35');record=referral;message='Request sent. Existing restrictions are unchanged.';break}
    case'saveProfile':{const p=actionPayloads.saveProfile.parse(request.payload);const saved=find(db.users,user.id);Object.assign(saved,p);Object.assign(user,p);record=person(user);message='Profile saved.';break}
    case'saveSettings':{const p=actionPayloads.saveSettings.parse(request.payload);db.settings[user.id]={...(db.settings[user.id]??defaultSettings(user)),...p};record=db.settings[user.id];message='Settings saved.';break}
    case'saveNotificationPreferences':{const p=actionPayloads.saveNotificationPreferences.parse(request.payload);if(Object.keys(p.priorities).some(key=>!notificationCategories(user).includes(key)))throw new ApiError(400,'Your account does not have that notification category.','VALIDATION_ERROR');if(Object.entries(p.priorities).some(([key,value])=>value==='muted'&&requiredNotificationCategories.includes(key)))throw new ApiError(400,'Report updates cannot be muted.','VALIDATION_ERROR');/* Saved preferences do not change source access. */db.settings[user.id]={...(db.settings[user.id]??defaultSettings(user)),priorities:p.priorities};record=db.settings[user.id];message='Notification priorities saved.';break}
    case'updateRoles':{requirePermission(user,'role.manage');const p=actionPayloads.updateRoles.parse(request.payload);reasonOf(request);const account=find(db.users,id);if(p.roles.some(r=>['student','chair'].includes(r))&&!p.program&&!account.program)throw new ApiError(400,'Choose a program for that role.','VALIDATION_ERROR');account.roles=p.roles;if(p.program)account.program=p.program;if(p.section)account.section=p.section;if(p.active!==undefined)account.active=p.active;audit(repo,user,'Role assignment changed','identity',account.id,undefined,reasonOf(request));notify(repo,account.id,'role','P43');record={...person(account),active:account.active};message='Assignment saved. The new roles apply to the user right away.';break}
    case'updatePermission':{requirePermission(user,'role.manage');const p=actionPayloads.updatePermission.parse(request.payload);reasonOf(request);if(!permissionRoles[p.permission])throw new ApiError(400,'That permission does not exist.','VALIDATION_ERROR');/* TBD(D-06): approval workflow is undefined; save proposed cells without granting new runtime powers. */db.permissionOverrides[`${p.role}:${p.permission}`]=p.allowed;audit(repo,user,'Permission change proposed','identity',`${p.role}:${p.permission}`,undefined,reasonOf(request));record={...p,status:'Pending CCS approval'};message='Permission change saved for review.';break}
    case'moderate':{const reviewer=hasPermission(user,'moderation.review');if(!reviewer&&!hasPermission(user,'moderation.referral'))throw deny();const p=actionPayloads.moderate.parse(request.payload);const reason=reasonOf(request);const m=find(db.moderation,id);if(!canSeeModeration(user,m))throw unavailable()
      // D-04 (decided 2026-11-10): a moderator refers user-reported content to the CCS Secretary, who makes the final decision on it.
      if(m.status===referredStatus){if(!hasPermission(user,'moderation.referral'))throw conflict('This item was referred to the CCS Secretary.');if(p.decision==='refer')throw conflict('This item is already with the CCS Secretary.')}
      else if(!reviewer||m.status!=='Pending')throw conflict('This item has already been reviewed.')
      const secretaries=p.decision==='refer'?db.users.filter(u=>u.active&&hasPermission(u,'moderation.referral')):[]
      if(p.decision==='refer'&&m.source!=='User')throw deny()
      if(p.decision==='refer'&&!secretaries.length)throw conflict('The CCS Secretary account is not active, so this cannot be referred yet.')
      m.status=p.decision==='keep'?'Kept':p.decision==='refer'?referredStatus:p.decision==='warn'?'Removed and warned':'Removed';m.history.push({at:now(),actorId:user.id,decision:p.decision,reason});if(['remove','warn'].includes(p.decision)){if(m.itemType==='post')find(db.posts,m.parentId).removed=true;else if(m.itemType==='comment'){const comment=find(find(db.posts,m.parentId).comments,m.itemId);comment.body='This content was removed after review.'}else{const message=find(find(db.threads,m.parentId).messages,m.itemId);message.body='This content was removed after review.'}}audit(repo,user,'Moderation decision','moderation',m.id);for(const secretary of secretaries)notify(repo,secretary.id,'moderation','P50',m.id);if(p.notifyAuthor)notify(repo,m.authorId,'moderation','P40');record={id:m.id,status:m.status,history:m.history};message='Decision recorded.';break}
    default:throw new ApiError(400,'That action does not exist.','VALIDATION_ERROR')
  }
  return JSON.parse(JSON.stringify({ok:true,message,...(record===undefined?{}:{record})})) as {ok:true;message:string;record?:unknown}
}
export interface AssistantProvider { answer(db:Database,user:User,question:string):{reply:string;sources:{title:string;href:string}[]} }
export const demoAssistant:AssistantProvider={answer(db,user,question){const q=question.toLowerCase();const fallback={reply:'I can explain ACCS pages, your schedule, and the milestones on your own reports. I cannot answer that one. Please ask the office that handles it.',sources:[{title:'Help',href:'/help'}]};if(/guilt|guilty|verdict|punish|decide|restrict|another student|reveal|identity|who reported/.test(q))return fallback;const mentioned:string[]=question.match(/RPT-[0-9A-Z]+/g)??[];if(mentioned.some(id=>!db.reports.some(r=>r.id===id&&r.ownerId===user.id)))return fallback;if(/schedule|calendar|appointment|consultation/.test(q)){if(!canPage(user,'P13'))return fallback;const own=visibleConsultations(db,user);const tasks=db.todos.filter(t=>t.ownerId===user.id);return {reply:`Your calendar has ${visibleEvents(db,user).length} college events${hasRole(user,'student')?`, ${tasks.length} to-do${tasks.length===1?"":"s"}`:''} and ${own.length} consultation request${own.length===1?'':'s'}. Open the calendar or Consultations for dates and status.`,sources:[{title:'Calendar',href:'/calendar'},...(canPage(user,'P14')?[{title:'Consultations',href:'/consultations'}]:[])]}}if(/report|milestone|stage/.test(q)&&hasRole(user,'student')){const reports=db.reports.filter(r=>r.ownerId===user.id&&(!mentioned.length||mentioned.includes(r.id)));return {reply:reports.length?reports.map(r=>`${r.id}: ${statusFor(r)}. ${r.history.filter(h=>h.public).at(-1)?.update??'No update yet.'}`).join('\n'):'You have no submitted reports.',sources:[{title:'My reports',href:'/reports'}]}}if(/draft|write|word/.test(q)){return{reply:'Say what happened, when, and where, and what you want the office to look at. Name only the people the office needs to know about. Read it over before you submit. The assistant does not decide what happened.',sources:[{title:'Help',href:'/help'}]}}const entry=filteredFaq(user).find(f=>f.question.toLowerCase().split(/\W+/).filter(w=>w.length>4).some(w=>q.includes(w)));if(entry)return{reply:entry.answer,sources:[{title:entry.question,href:entry.href}]};if(/help|can you|what can/.test(q))return{reply:'I can explain ACCS pages and how reports, consultations, and evaluations work. Staff decide case outcomes and restrictions.',sources:[{title:'Help',href:'/help'}]};return fallback}}
function assistantAnswer(db:Database,user:User,question:string){return demoAssistant.answer(db,user,question)}
