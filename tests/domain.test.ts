import request from 'supertest'
import { beforeEach, describe, expect, it } from 'vitest'
import { createApp } from '../src/app.js'
import { createMemoryRepository } from '../src/store.js'
import { concernChoices } from './helpers.js'

let repo=createMemoryRepository();let app=createApp(repo)
beforeEach(()=>{repo=createMemoryRepository();app=createApp(repo)})
async function login(id:string){const agent=request.agent(app);expect((await agent.post('/api/auth/sign-in').send({emailOrId:id,password:'Accs@Qcu2026!'})).status).toBe(200);return agent}
const reportPayload={narrative:'A laboratory timetable change needs review.',category:'General concern',severity:'medium',identity:'anonymous',...concernChoices}
describe('report and case workflow',()=>{
 it('STU-06-V/I and GUD-01-B validates submission without partial writes and begins as a Report',async()=>{const student=await login('QCU-STU-IT-A');const before=repo.read().reports.length;expect((await student.post('/api/pages/P19/actions').send({action:'createReport',payload:{...reportPayload,narrative:''}})).status).toBe(400);expect(repo.read().reports).toHaveLength(before);const result=await student.post('/api/pages/P19/actions').send({action:'createReport',payload:reportPayload});expect(result.status).toBe(200);expect(result.body.record.type).toBe('Report');expect(result.body.record.stage).toBe('adviser');expect(result.body.record).not.toHaveProperty('caseFileId')})
 it('PRO-06-B / CHR-02-V/B bypasses a named adviser without disclosing the report to them',async()=>{const student=await login('QCU-STU-IT-A');const created=await student.post('/api/pages/P19/actions').send({action:'createReport',payload:{...reportPayload,involvedUserIds:['QCU-PROF-IT']}});const id=created.body.record.id;expect(created.body.record.stage).toBe('chair');const prof=await login('QCU-PROF-IT');expect((await prof.get(`/api/pages/P22?id=${id}`)).status).toBe(404);expect((await prof.post('/api/pages/P22/actions').send({action:'caseAction',recordId:id,reason:'Should be rejected',payload:{type:'resolve',update:'Invalid action'}})).status).toBe(404);const chair=await login('QCU-CHAIR-IT');const r=await chair.get(`/api/pages/P22?id=${id}`);expect(r.body.data.record.bypassed).toBe(true);expect(JSON.stringify(created.body.record)).not.toContain('Adviser involvement declared')})
 it('PRO-06-V / DEAN-02-V / GUD-01-V / OSAS-01-V follows the fixed order to OSAS, the last stage, with audit and milestones',async()=>{const chain=[['QCU-PROF-IT','escalate','chair'],['QCU-CHAIR-IT','escalate','dean'],['CCS-DEAN','transfer','guidance'],['QCU-GUIDANCE','convert','guidance'],['QCU-GUIDANCE','transfer','osas'],['QCU-OSAS','resolve','osas']] as const;for(const[accountId,type,stage]of chain){const actor=await login(accountId);const result=await actor.post('/api/pages/P22/actions').send({action:'caseAction',recordId:'RPT-0241',reason:'Reviewed the available information',payload:{type,update:'The responsible office recorded an update.'}});expect(result.status).toBe(200);expect(repo.read().reports.find(r=>r.id==='RPT-0241')!.stage).toBe(stage)}const r=repo.read().reports.find(r=>r.id==='RPT-0241')!;expect(r.caseFileId).toMatch(/^CF-/);expect(r.status).toBe('Resolved');expect(repo.read().audit.filter(a=>a.action==='Case transition'&&['RPT-0241',r.caseFileId].includes(a.reference))).toHaveLength(chain.length);expect(repo.read().notifications.some(n=>n.kind==='case'&&n.recipientId==='QCU-STU-IT-A')).toBe(true)})
 it('GUD-02-I / OSAS-01-B rejects unsupported transfers or a missing reason atomically',async()=>{const prof=await login('QCU-PROF-IT');const before=structuredClone(repo.read().reports.find(r=>r.id==='RPT-0241'));const bad=await prof.post('/api/pages/P22/actions').send({action:'caseAction',recordId:'RPT-0241',reason:'Invalid bypass',payload:{type:'escalate',nextStage:'guidance',update:'Should not save'}});expect(bad.status).toBe(409);expect(repo.read().reports.find(r=>r.id==='RPT-0241')).toEqual(before);expect((await prof.post('/api/pages/P22/actions').send({action:'caseAction',recordId:'RPT-0241',payload:{type:'resolve',update:'Should not save'}})).status).toBe(400)})
 it('STU-07-V/I/B and GUD-02-B protects alias identity and internal notes until explicit per-office disclosure',async()=>{const guidance=await login('QCU-GUIDANCE');const before=(await guidance.get('/api/pages/P22?id=RPT-0245')).body.data.record;expect(before.reporter.name).toMatch(/^Reporter/);expect(JSON.stringify(before)).not.toContain('Mira Solis');const student=await login('QCU-STU-IT-A');const own=(await student.get('/api/pages/P20?id=RPT-0245')).body.data.record;expect(own).not.toHaveProperty('notes');expect(JSON.stringify(own)).not.toContain('lab coordinator');expect((await student.post('/api/pages/P20/actions').send({action:'discloseIdentity',recordId:'RPT-0245',payload:{office:'guidance'}})).status).toBe(200);const after=(await guidance.get('/api/pages/P22?id=RPT-0245')).body.data.record;expect(after.reporter.name).toBe('Mira Solis');expect(repo.read().audit.some(a=>a.action==='Identity disclosed')).toBe(true);const osas=await login('QCU-OSAS');const elsewhere=(await osas.get('/api/pages/P22?id=RPT-0246')).body.data.record;expect(elsewhere.reporter.name).toMatch(/^Reporter/)})
 it('STU-02-B / ALL-03-B never serializes anonymous verified author identifiers',async()=>{const other=await login('QCU-STU-IT-B');const result=(await other.get('/api/pages/P06?id=POST-0102')).body.data.record;expect(result.author).toEqual({name:'Student A-12',roles:['student'],anonymous:true});expect(JSON.stringify(result)).not.toContain('QCU-STU-IT-A')})
})
describe('restricted access, records, and moderation',()=>{
 it('STU-11-V/I/B / ADM-03-B blocks only selected features and preserves essential access',async()=>{const student=await login('QCU-STU-RESTRICTED');expect((await student.get('/api/pages/P05')).status).toBe(403);expect((await student.post('/api/pages/P06/actions').send({action:'comment',recordId:'POST-0101',payload:{body:'A comment'}})).status).toBe(403);expect((await student.post('/api/pages/P19/actions').send({action:'createReport',payload:reportPayload})).status).toBe(403);expect((await student.post('/api/pages/P19/actions').send({action:'createReport',payload:{...reportPayload,identity:'named'}})).status).toBe(200);for(const page of ['P04','P07','P11','P36','P41'])expect((await student.get(`/api/pages/${page}`)).status).toBe(200);expect((await student.post('/api/pages/P11/actions').send({action:'createThread',payload:{recipientId:'QCU-PROF-IT',body:'A permitted academic question.'}})).status).toBe(200)})
 it('CHR-05-V / DEAN-05-V / OSAS-02-V requires purpose before record data, then logs every opening',async()=>{const dean=await login('CCS-DEAN');const before=await dean.get('/api/pages/P34?id=QCU-STU-RESTRICTED');expect(before.body.data).toEqual({purposeRequired:true});expect(repo.read().audit.some(a=>a.action==='Record opened')).toBe(false);const opened=await dean.get('/api/pages/P34?id=QCU-STU-RESTRICTED&purpose=Program%20oversight');expect(opened.status).toBe(200);expect(opened.body.data.record.offenses).toHaveLength(1);expect(opened.body.data.record.accessHistory).toHaveLength(1);expect(repo.read().audit.at(-1)?.purpose).toBe('Program oversight');const admin=await login('ACCS-ADMIN');expect((await admin.get('/api/pages/P34?id=QCU-STU-RESTRICTED&purpose=Restriction%20review')).status).toBe(403)})
 it('ADM-03-V/I / GUD-04-B keeps restrictions human-applied and feature-specific',async()=>{const guidance=await login('QCU-GUIDANCE');const payload={studentId:'QCU-STU-IT-A',features:['post.create'],basis:'Approved demo review',decisionReference:'QCU-DEC-002',until:'2027-01-01'};expect((await guidance.post('/api/pages/P35/actions').send({action:'applyRestriction',reason:'Human decision',payload})).status).toBe(403);const admin=await login('ACCS-ADMIN');expect((await admin.post('/api/pages/P35/actions').send({action:'applyRestriction',reason:'Human decision',payload:{...payload,features:['assistant.use']}})).status).toBe(400);const created=await admin.post('/api/pages/P35/actions').send({action:'applyRestriction',reason:'Human decision',payload});expect(created.status).toBe(200);const student=await login('QCU-STU-IT-A');expect((await student.get('/api/pages/P05')).status).toBe(403);expect((await student.get('/api/pages/P41')).status).toBe(200);expect((await admin.post('/api/pages/P35/actions').send({action:'liftRestriction',recordId:created.body.record.id,reason:'Review complete',payload:{}})).status).toBe(200);expect((await student.get('/api/pages/P05')).status).toBe(200);expect(repo.read().audit.filter(a=>a.action.startsWith('Restriction'))).toHaveLength(2)})
 it('GUD-04-V / OSAS-03-I records referrals without silently applying a restriction',async()=>{const guidance=await login('QCU-GUIDANCE');const before=repo.read().restrictions.length;expect((await guidance.post('/api/pages/P35/actions').send({action:'referRestriction',payload:{studentId:'QCU-STU-IT-A',change:'Review'}})).status).toBe(400);expect((await guidance.post('/api/pages/P35/actions').send({action:'referRestriction',reason:'Review the current feature status',payload:{studentId:'QCU-STU-IT-A',change:'Review'}})).status).toBe(200);expect(repo.read().restrictions).toHaveLength(before);expect(repo.read().referrals).toHaveLength(1)})
 it('ADM-02-V/I/B / ADM-06-I/B audits a human moderation decision without punishment from a flag',async()=>{const admin=await login('ACCS-ADMIN');const before={reports:repo.read().reports.length,restrictions:repo.read().restrictions.length};const result=await admin.post('/api/pages/P50/actions').send({action:'moderate',recordId:'MOD-0101',reason:'Context does not require removal',payload:{decision:'keep',notifyAuthor:true}});expect(result.status).toBe(200);expect(repo.read().reports).toHaveLength(before.reports);expect(repo.read().restrictions).toHaveLength(before.restrictions);expect(repo.read().audit.some(a=>a.action==='Moderation decision')).toBe(true)})
 it('ADM-04-B / ADM-05-B returns reference-only audit and content-free telemetry',async()=>{const admin=await login('ACCS-ADMIN');const audit=(await admin.get('/api/pages/P51')).body;expect(JSON.stringify(audit)).not.toContain('narrative');const monitoring=(await admin.get('/api/pages/P52')).body;expect(monitoring.data).not.toHaveProperty('messages');expect(monitoring.data).not.toHaveProperty('conversations')})
})
describe('schedule, messaging, evaluation, and assistant',()=>{
 it('STU-05-V/I/B allows at most one reservation for a slot',async()=>{const a=await login('QCU-STU-IT-A');const b=await login('QCU-STU-RESTRICTED');const responses=await Promise.all([a,b].map(agent=>agent.post('/api/pages/P15/actions').send({action:'createConsultation',payload:{slotId:'SLOT-0101',purpose:'Academic question'}})));expect(responses.map(r=>r.status).sort()).toEqual([200,409]);expect(repo.read().consultations.filter(c=>c.slotId==='SLOT-0101')).toHaveLength(1)})
 it('PRO-04-I/B prevents overlap and silent changes to reserved slots',async()=>{const prof=await login('QCU-PROF-IT');expect((await prof.post('/api/pages/P17/actions').send({action:'saveAvailability',payload:{date:'2026-10-29',start:'10:15',end:'10:45',state:'open'}})).status).toBe(409);expect((await prof.post('/api/pages/P17/actions').send({action:'deleteAvailability',recordId:'SLOT-0102',payload:{}})).status).toBe(409)})
 it('PRO-05-V/I/B validates consultation lifecycle and ownership',async()=>{const prof=await login('QCU-PROF-IT');for(const decision of ['Approved','Booked','Completed'])expect((await prof.post('/api/pages/P16/actions').send({action:'decideConsultation',recordId:'CONSULT-0101',payload:{decision}})).status).toBe(200);expect((await prof.post('/api/pages/P16/actions').send({action:'decideConsultation',recordId:'CONSULT-0101',payload:{decision:'Approved'}})).status).toBe(409);const other=await login('QCU-PROF-OTHER');expect((await other.get('/api/pages/P16?id=CONSULT-0101')).status).toBe(404)})
 it('STU-03-V/I / PRO-03-I blocks unrelated recipients and preserves permitted messages',async()=>{const student=await login('QCU-STU-IT-A');expect((await student.post('/api/pages/P11/actions').send({action:'createThread',payload:{recipientId:'QCU-PROF-CS',body:'A message'}})).status).toBe(404);const result=await student.post('/api/pages/P12/actions').send({action:'sendMessage',recordId:'THREAD-DIRECT-1',payload:{body:'A new academic question'}});expect(result.status).toBe(200);const prof=await login('QCU-PROF-IT');expect((await prof.get('/api/pages/P12?id=THREAD-DIRECT-1')).body.data.record.messages.at(-1).body).toBe('A new academic question')})
 it('STU-04-V/B keeps personal tasks owned and denies institutional event edits',async()=>{const student=await login('QCU-STU-IT-A');const todo=await student.post('/api/pages/P13/actions').send({action:'createTodo',payload:{title:'Read consultation notes',date:'2026-11-01'}});expect(todo.status).toBe(200);const other=await login('QCU-STU-IT-B');expect((await other.get('/api/pages/P13')).body.data.todos).toEqual([]);expect((await other.post('/api/pages/P13/actions').send({action:'toggleTodo',recordId:todo.body.record.id,payload:{done:true}})).status).toBe(404);expect((await student.post('/api/pages/P13/actions').send({action:'saveEvent',recordId:'EVENT-0101',payload:{}})).status).toBe(403)})
 it('STU-10-V/I/B / PRO-07-V/I persists each evaluation once and rejects missing/unassigned answers',async()=>{const student=await login('QCU-STU-IT-A');expect((await student.post('/api/pages/P27/actions').send({action:'submitEvaluation',recordId:'EVAL-STU-IT-1',payload:{answers:{Q1:4}}})).status).toBe(400);const payload={answers:{Q1:4,Q2:5,Q3:4},comment:'Useful support.'};expect((await student.post('/api/pages/P27/actions').send({action:'submitEvaluation',recordId:'EVAL-STU-IT-1',payload})).status).toBe(200);expect((await student.post('/api/pages/P27/actions').send({action:'submitEvaluation',recordId:'EVAL-STU-IT-1',payload})).status).toBe(409);expect((await student.get('/api/pages/P27?id=EVAL-STU-B-1')).status).toBe(404);const prof=await login('QCU-PROF-IT');const results=(await prof.get('/api/pages/P29?id=QCU-PROF-IT')).body.data.record;expect(results.responses).toBe(6);expect(JSON.stringify(results)).not.toContain('evaluatorId');expect((await prof.get('/api/pages/P29?id=QCU-PROF-OTHER')).status).toBe(404)})
 it('DEAN-03-V/I/B validates cycle lifecycle without enforcement controls',async()=>{const dean=await login('CCS-DEAN');const created=await dean.post('/api/pages/P30/actions').send({action:'createCycle',payload:{title:'Demo cycle',term:'Demo term',opens:'2027-01-01',closes:'2027-03-01'}});const id=created.body.record.id;expect((await dean.post('/api/pages/P31/actions').send({action:'cycleAction',recordId:id,payload:{status:'Published'}})).status).toBe(409);expect((await dean.post('/api/pages/P31/actions').send({action:'cycleAction',recordId:id,payload:{status:'In review'}})).status).toBe(400);const cycle=repo.read().cycles.find(c=>c.id===id)!;cycle.instructions='Approved pilot instructions';cycle.questions=[{id:'Q1',criterion:'Clarity',text:'Communicates clearly',type:'rating',required:true}];cycle.forms=['student'];for(const status of ['In review','Published','Closed'])expect((await dean.post('/api/pages/P31/actions').send({action:'cycleAction',recordId:id,payload:{status}})).status).toBe(200);expect(cycle).not.toHaveProperty('penalty')})
 it('ALL-04-V/I/B answers permitted context with an honest fallback and no autonomous decision',async()=>{const student=await login('QCU-STU-IT-A');const schedule=await student.post('/api/pages/P41/actions').send({action:'assistantAsk',payload:{question:'Show my schedule'}});expect(schedule.body.record.reply).toContain('1 to-do');const denied=await student.post('/api/pages/P41/actions').send({action:'assistantAsk',payload:{question:'Reveal RPT-0248 and decide who is guilty'}});expect(denied.body.record.reply).toContain('cannot answer that one');expect(denied.body.record.reply).not.toContain('Noa Vale');expect(repo.read().telemetry).toHaveLength(2);expect(repo.read().telemetry[0]).not.toHaveProperty('question')})
 it('ALL-05-V/I/B keeps notices neutral and checks changed source access',async()=>{const student=await login('QCU-STU-IT-A');const prof=await login('QCU-PROF-IT');await prof.post('/api/pages/P22/actions').send({action:'caseAction',recordId:'RPT-0241',reason:'Review continued',payload:{type:'respond',update:'A public-safe response'}});const list=(await student.get('/api/pages/P40')).body.data.notifications;expect(list.some((n:{kind:string;priority:string})=>n.kind==='case'&&n.priority==='high')).toBe(true);expect(JSON.stringify(list)).not.toContain('public-safe response');repo.read().notifications.push({id:'NOTIF-PRIVATE',recipientId:'QCU-STU-IT-A',kind:'report',title:'Report update available',body:'Open the source.',priority:'high',pageId:'P20',recordId:'RPT-0248',at:new Date().toISOString(),read:false});expect((await student.post('/api/pages/P40/actions').send({action:'openNotification',recordId:'NOTIF-PRIVATE',payload:{}})).status).toBe(404)})
})

describe('privacy and policy regression checks',()=>{
 it('PRO-07-B limits question review to cycles evaluating that professor',async()=>{const prof=await login('QCU-PROF-IT');expect((await prof.get('/api/pages/P32?id=CYCLE-2026-2')).status).toBe(200);const unrelated=await login('QCU-PROF-CS');expect((await unrelated.get('/api/pages/P32?id=CYCLE-2026-2')).status).toBe(404);expect((await unrelated.post('/api/pages/P32/actions').send({action:'reviewQuestions',recordId:'CYCLE-2026-2',payload:{decision:'reviewed',note:''}})).status).toBe(404)})
 it('ADM-04-B returns moderation status without excerpts on the overview',async()=>{const admin=await login('ACCS-ADMIN');const overview=(await admin.get('/api/pages/P45')).body;expect(overview.data.moderation[0]).not.toHaveProperty('excerpt');expect(overview.data.moderation[0]).not.toHaveProperty('authorId');expect(JSON.stringify(overview)).not.toContain('A posted lab schedule would help us plan.')})
 it('ALL-02-B excludes institutional student identifiers from a public profile',async()=>{const student=await login('QCU-STU-IT-B');const profile=(await student.get('/api/pages/P38?id=QCU-STU-IT-A')).body.data.record;expect(profile).not.toHaveProperty('studentId');expect(JSON.stringify(profile)).not.toContain('QCU-2024-0101')})
 it('ALL-04-B does not answer schedule data or link a calendar for roles without access',async()=>{const admin=await login('ACCS-ADMIN');const result=await admin.post('/api/pages/P41/actions').send({action:'assistantAsk',payload:{question:'Show my schedule'}});expect(result.body.record.reply).toContain('cannot answer that one');expect(result.body.record.sources.some((s:{href:string})=>s.href==='/calendar')).toBe(false)})
 it('STU-12-V/I/B honors permitted priority choices, refuses muting reports, and leaves report access unchanged',async()=>{const student=await login('QCU-STU-IT-A');expect((await student.post('/api/pages/P44/actions').send({action:'saveNotificationPreferences',payload:{priorities:{moderation:'high'}}})).status).toBe(400);const mute=await student.post('/api/pages/P44/actions').send({action:'saveNotificationPreferences',payload:{priorities:{report:'muted',case:'normal'}}});expect(mute.status).toBe(400);expect(mute.body).toEqual({error:'Report updates cannot be muted.',code:'VALIDATION_ERROR'});expect((await student.post('/api/pages/P44/actions').send({action:'saveNotificationPreferences',payload:{priorities:{report:'normal',case:'normal'}}})).status).toBe(200);const before=repo.read().notifications.filter(n=>n.recipientId==='QCU-STU-IT-A'&&n.kind==='report').length;const prof=await login('QCU-PROF-IT');await prof.post('/api/pages/P22/actions').send({action:'sendReportMessage',recordId:'RPT-0241',payload:{body:'A new public-safe message'}});const reportNotices=repo.read().notifications.filter(n=>n.recipientId==='QCU-STU-IT-A'&&n.kind==='report');expect(reportNotices).toHaveLength(before+1);expect(reportNotices.at(-1)!.priority).toBe('normal');expect((await student.get('/api/pages/P20?id=RPT-0241')).status).toBe(200)})
 it('ALL-01-B denies a reporter handler access to their own case through role union',async()=>{repo.read().users.find(u=>u.id==='QCU-STU-IT-A')!.roles.push('professor');const student=await login('QCU-STU-IT-A');const created=await student.post('/api/pages/P19/actions').send({action:'createReport',payload:reportPayload});repo.read().reports.find(r=>r.id===created.body.record.id)!.adviserId='QCU-STU-IT-A';expect((await student.get(`/api/pages/P22?id=${created.body.record.id}`)).status).toBe(404)})
 it('ADM-01-V persists the required permission-change reason in the audit trail',async()=>{const admin=await login('ACCS-ADMIN');expect((await admin.post('/api/pages/P48/actions').send({action:'updatePermission',reason:'Proposal for CCS approval',payload:{role:'administrator',permission:'post.create',allowed:true}})).status).toBe(200);expect(repo.read().audit.at(-1)?.reason).toBe('Proposal for CCS approval');const unchanged=await login('ACCS-ADMIN');expect((await unchanged.get('/api/pages/P05')).status).toBe(403)})
})

describe('publication scope and new-report anonymity regressions',()=>{
 it('ORG-02-B denies college-wide organization publication and offers only its own audience',async()=>{const org=await login('QCU-ORG');const options=(await org.get('/api/pages/P05')).body.data;expect(options.audiences).toEqual(['organization:ORG-COMPUTING']);expect((await org.post('/api/pages/P05/actions').send({action:'createPost',payload:{title:'An organization update',body:'A sample update.',audience:'college',label:'Discussion',kind:'discussion'}})).status).toBe(403)})
 it('CHR-06-I keeps program-class publication read-only unless the Chair also teaches that class',async()=>{const chair=await login('QCU-CHAIR-CS');const result=await chair.post('/api/pages/P05/actions').send({action:'createPost',payload:{title:'A class update',body:'A sample update.',audience:'space:SPACE-CS-A',label:'Discussion',kind:'discussion'}});expect(result.status).toBe(403);const teachingChair=await login('QCU-CHAIR-IT');expect((await teachingChair.post('/api/pages/P05/actions').send({action:'createPost',payload:{title:'A taught-class update',body:'A sample update.',audience:'space:SUBJECT-IT-DS',label:'Discussion',kind:'discussion'}})).status).toBe(200)})
 it('PRO-02-V/B supports faculty-only posts and denies students even by direct ID',async()=>{const professor=await login('QCU-PROF-IT');expect((await professor.get('/api/pages/P05')).body.data.audiences).toContain('faculty');expect((await professor.get('/api/pages/P06?id=POST-0106')).status).toBe(200);const student=await login('QCU-STU-IT-A');expect((await student.get('/api/pages/P06?id=POST-0106')).status).toBe(404);expect((await student.get('/api/pages/P04')).body.data.posts.some((p:{id:string})=>p.id==='POST-0106')).toBe(false)})
 it('STU-07-B masks every submitted-history account link until disclosure to the current office',async()=>{const student=await login('QCU-STU-IT-A');const created=await student.post('/api/pages/P19/actions').send({action:'createReport',payload:reportPayload});const id=created.body.record.id;const handler=await login('QCU-PROF-IT');const before=await handler.get(`/api/pages/P22?id=${id}`);expect(before.status).toBe(200);const serialized=JSON.stringify(before.body);for(const secret of ['QCU-STU-IT-A','Mira Solis','stu.it.a@qcu.edu.ph','QCU-2024-0101'])expect(serialized).not.toContain(secret);expect(before.body.data.record.history[0].actor.anonymous).toBe(true);expect(before.body.data.record.history[0]).not.toHaveProperty('actorId');await student.post('/api/pages/P20/actions').send({action:'discloseIdentity',recordId:id,payload:{office:'adviser'}});const after=(await handler.get(`/api/pages/P22?id=${id}`)).body.data.record;expect(after.reporter.name).toBe('Mira Solis');expect(after.history[0].actor.name).toBe('Mira Solis')})
})

it('ALL-01-V / PRO-06-V includes assigned Professor cases in a multi-role Chair queue',async()=>{
 const report=repo.read().reports.find(r=>r.id==='RPT-0241')!;report.adviserId='QCU-CHAIR-IT'
 const chair=await login('QCU-CHAIR-IT');const queue=(await chair.get('/api/pages/P21')).body.data.cases
 expect(queue.some((r:{id:string})=>r.id==='RPT-0241')).toBe(true)
 const detail=(await chair.get('/api/pages/P22?id=RPT-0241')).body.data.record
 expect(detail.allowedActions).toContain('escalate')
 const home=(await chair.get('/api/pages/P03')).body.data.roleSections
 expect(home.find((section:{role:string})=>section.role==='professor').cases.some((r:{id:string})=>r.id==='RPT-0241')).toBe(true)
})

it('ADM-03-V/B pauses Posting and Commenting independently while retaining essential access',async()=>{
 const admin=await login('ACCS-ADMIN');const student=await login('QCU-STU-IT-A')
 const restriction=await admin.post('/api/pages/P35/actions').send({action:'applyRestriction',reason:'Approved demo feature decision',payload:{studentId:'QCU-STU-IT-A',features:['post.create'],basis:'Approved demo basis',decisionReference:'QCU-DEC-INDEPENDENT',until:'2027-01-01'}})
 expect(restriction.status).toBe(200);expect((await student.get('/api/pages/P05')).status).toBe(403)
 expect((await student.get('/api/pages/P06?id=POST-0101')).body.data.canComment).toBe(true)
 expect((await student.post('/api/pages/P06/actions').send({action:'comment',recordId:'POST-0101',payload:{body:'A permitted academic comment.'}})).status).toBe(200)
 expect((await student.post('/api/pages/P06/actions').send({action:'react',recordId:'POST-0101',payload:{}})).status).toBe(200)
 for(const pageId of ['P04','P07','P11','P41'])expect((await student.get(`/api/pages/${pageId}`)).status).toBe(200)
 await admin.post('/api/pages/P35/actions').send({action:'liftRestriction',recordId:restriction.body.record.id,reason:'Demo posting review complete',payload:{}})
 await admin.post('/api/pages/P35/actions').send({action:'applyRestriction',reason:'Separate commenting decision',payload:{studentId:'QCU-STU-IT-A',features:['post.comment'],basis:'Approved demo basis',decisionReference:'QCU-DEC-COMMENT',until:'2027-01-01'}})
 expect((await student.get('/api/pages/P05')).status).toBe(200)
 expect((await student.post('/api/pages/P06/actions').send({action:'comment',recordId:'POST-0101',payload:{body:'A blocked comment.'}})).status).toBe(403)
})

describe('community publication and roster contracts', () => {
  const eventDetails = {
    eventDate: '2026-11-12',
    eventTime: '13:00',
    eventPlace: 'Demo computer laboratory',
    eventContact: 'Computing Society office',
  }

  it('STU-02-V/I uses the required labels and accepts a 5,000-character post body', async () => {
    const student = await login('QCU-STU-IT-A')
    const options = (await student.get('/api/pages/P05')).body.data
    expect(options.labels).toEqual(['Discussion', 'Rant', 'Assistance', 'Support'])
    expect(options.priorities).toEqual(['general', 'important', 'urgent'])
    const payload = {
      title: 'A complete discussion',
      body: 'a'.repeat(5000),
      audience: 'college',
      kind: 'discussion',
      label: 'Support',
    }
    const created = await student.post('/api/pages/P05/actions').send({ action: 'createPost', payload })
    expect(created.status).toBe(200)
    expect(created.body.record.body).toHaveLength(5000)
    const before = repo.read().posts.length
    expect((await student.post('/api/pages/P05/actions').send({
      action: 'createPost',
      payload: { ...payload, label: 'Question' },
    })).status).toBe(400)
    const { audience: _audience, ...withoutAudience } = payload
    expect((await student.post('/api/pages/P05/actions').send({
      action: 'createPost',
      payload: withoutAudience,
    })).status).toBe(400)
    expect(repo.read().posts).toHaveLength(before)
  })

  it('ORG-02-I / PRO-02-I rejects incomplete organization and class event announcements without partial writes', async () => {
    const organization = await login('QCU-ORG')
    const professor = await login('QCU-PROF-IT')
    const before = {
      posts: repo.read().posts.length,
      events: repo.read().events.length,
      notifications: repo.read().notifications.length,
    }
    for (const [agent, audience] of [
      [organization, 'organization:ORG-COMPUTING'],
      [professor, 'space:SUBJECT-IT-DS'],
    ] as const) {
      const result = await agent.post('/api/pages/P05/actions').send({
        action: 'createPost',
        payload: { title: 'An event announcement', body: 'Review the event details.', audience, kind: 'announcement', priority: 'urgent' },
      })
      expect(result.status).toBe(400)
      expect(result.body.fields.map((field: { path: string }) => field.path)).toEqual(expect.arrayContaining(['eventDate', 'eventTime', 'eventPlace', 'eventContact']))
    }
    expect(repo.read().posts).toHaveLength(before.posts)
    expect(repo.read().events).toHaveLength(before.events)
    expect(repo.read().notifications).toHaveLength(before.notifications)
  })

  it('ORG-02-V/B creates a scoped event and sends neutral member notices only when selected', async () => {
    const organization = await login('QCU-ORG')
    const payload = {
      title: 'A member workshop',
      body: 'A private planning session for verified members.',
      audience: 'organization:ORG-COMPUTING',
      kind: 'announcement',
      priority: 'urgent',
      private: true,
      ...eventDetails,
    }
    const before = repo.read().notifications.length
    const quiet = await organization.post('/api/pages/P05/actions').send({ action: 'createPost', payload })
    expect(quiet.status).toBe(200)
    expect(quiet.body.record.priority).toBe('urgent')
    expect(repo.read().notifications).toHaveLength(before)
    const announced = await organization.post('/api/pages/P05/actions').send({
      action: 'createPost',
      payload: { ...payload, title: 'A notified member workshop', notifyMembers: true },
    })
    expect(announced.status).toBe(200)
    const notices = repo.read().notifications.slice(before)
    expect(notices.map(notice => notice.recipientId).sort()).toEqual(['QCU-ORG', 'QCU-STU-IT-A'])
    expect(JSON.stringify(notices)).not.toContain(payload.body)
    const member = await login('QCU-STU-IT-A')
    const outsider = await login('QCU-STU-IT-B')
    const memberEvents = (await member.get('/api/pages/P13')).body.data.events
    expect(memberEvents.find((event: { postId: string }) => event.postId === announced.body.record.id)).toMatchObject({
      date: eventDetails.eventDate,
      start: eventDetails.eventTime,
      place: eventDetails.eventPlace,
      contact: eventDetails.eventContact,
    })
    const outsiderEvents = (await outsider.get('/api/pages/P13')).body.data.events
    expect(outsiderEvents.some((event: { postId: string }) => event.postId === announced.body.record.id)).toBe(false)
  })

  it('PRO-02-V/B scopes class events and restricts post edits and deletion to the current author', async () => {
    const professor = await login('QCU-PROF-IT')
    const created = await professor.post('/api/pages/P05/actions').send({
      action: 'createPost',
      payload: {
        title: 'A class review',
        body: 'Review the sample practice set.',
        audience: 'space:SUBJECT-IT-DS',
        kind: 'announcement',
        priority: 'important',
        ...eventDetails,
      },
    })
    expect(created.status).toBe(200)
    const id = created.body.record.id
    const student = await login('QCU-STU-IT-A')
    const outsider = await login('QCU-STU-IT-B')
    expect((await student.get('/api/pages/P13')).body.data.events.some((event: { postId: string }) => event.postId === id)).toBe(true)
    expect((await outsider.get('/api/pages/P13')).body.data.events.some((event: { postId: string }) => event.postId === id)).toBe(false)
    const edit = { title: 'An updated class review', body: 'b'.repeat(5000), priority: 'urgent' }
    expect((await student.post('/api/pages/P06/actions').send({ action: 'updatePost', recordId: id, payload: edit })).status).toBe(404)
    expect((await student.post('/api/pages/P06/actions').send({ action: 'deletePost', recordId: id, payload: {} })).status).toBe(404)
    expect((await professor.post('/api/pages/P06/actions').send({ action: 'updatePost', recordId: id, payload: { ...edit, audience: 'college' } })).status).toBe(400)
    const updated = await professor.post('/api/pages/P06/actions').send({ action: 'updatePost', recordId: id, payload: edit })
    expect(updated.status).toBe(200)
    expect(updated.body.record).toMatchObject({ title: edit.title, priority: 'urgent', audience: 'space:SUBJECT-IT-DS' })
    expect(repo.read().events.find(event => event.postId === id)?.title).toBe(edit.title)
    expect((await professor.post('/api/pages/P06/actions').send({ action: 'deletePost', recordId: id, payload: {} })).status).toBe(200)
    expect(repo.read().events.some(event => event.postId === id)).toBe(false)
    expect((await student.get(`/api/pages/P06?id=${id}`)).body.data.record.removed).toBe(true)
  })

  it('ALL-03-I/B rejects private and unknown feed scopes and applies multi-label URL filters', async () => {
    const student = await login('QCU-STU-IT-B')
    for (const scope of ['organization:ORG-COMPUTING', 'space:SPACE-IT-A', 'space:UNKNOWN', 'faculty']) {
      const result = await student.get('/api/pages/P04').query({ scope })
      expect(result.status).toBe(404)
      expect(result.body).not.toHaveProperty('data')
    }
    const created = await student.post('/api/pages/P05/actions').send({
      action: 'createPost',
      payload: { title: 'A support discussion', body: 'Help with academic planning.', audience: 'college', label: 'Support' },
    })
    expect(created.status).toBe(200)
    const selected = (await student.get('/api/pages/P04').query({ label: 'Discussion,Support' })).body.data.posts
    expect(selected.some((post: { id: string }) => post.id === created.body.record.id)).toBe(true)
    expect(selected.every((post: { label: string; kind: string }) => ['Discussion', 'Support'].includes(post.label) && post.kind === 'discussion')).toBe(true)
    const announcements = (await student.get('/api/pages/P04').query({ label: 'Announcements' })).body.data.posts
    expect(announcements.length).toBeGreaterThan(0)
    expect(announcements.every((post: { kind: string }) => post.kind === 'announcement')).toBe(true)
  })

  it('STU-02-B rechecks current space membership before editing or deleting an authored post', async () => {
    const student = await login('QCU-STU-IT-A')
    const created = await student.post('/api/pages/P05/actions').send({
      action: 'createPost',
      payload: { title: 'A class discussion', body: 'A class planning question.', audience: 'space:SPACE-IT-A', label: 'Discussion' },
    })
    expect(created.status).toBe(200)
    repo.read().spaces.find(space => space.id === 'SPACE-IT-A')!.studentIds = []
    expect((await student.post('/api/pages/P06/actions').send({
      action: 'updatePost',
      recordId: created.body.record.id,
      payload: { title: 'A changed discussion', body: 'A changed question.', label: 'Discussion', priority: 'general' },
    })).status).toBe(404)
    expect((await student.post('/api/pages/P06/actions').send({
      action: 'deletePost',
      recordId: created.body.record.id,
      payload: {},
    })).status).toBe(404)
    expect(repo.read().posts.find(post => post.id === created.body.record.id)?.removed).toBe(false)
  })

  it('STU-01-B / ORG-01-B limits member fields and exposes only permitted group-thread links', async () => {
    const student = await login('QCU-STU-IT-A')
    const spaces = (await student.get('/api/pages/P07')).body.data.spaces
    expect(spaces.find((space: { id: string }) => space.id === 'SPACE-IT-A').threadId).toBe('THREAD-IT-A')
    expect(spaces[0]).not.toHaveProperty('studentIds')
    const members = (await student.get('/api/pages/P08?id=SPACE-IT-A')).body.data.record.students
    expect(members[0]).toHaveProperty('name')
    for (const member of members) {
      expect(Object.keys(member).sort()).toEqual(['name', 'roles'])
    }
    const professor = await login('QCU-PROF-IT')
    expect((await professor.get('/api/pages/P08?id=SPACE-IT-A')).body.data.record.students[0].studentId).toBe('QCU-2024-0101')
    const dean = await login('CCS-DEAN')
    expect((await dean.get('/api/pages/P08?id=SPACE-IT-A')).body.data.record).not.toHaveProperty('threadId')
    const organizationMembers = (await student.get('/api/pages/P10?id=ORG-COMPUTING')).body.data.record.members
    expect(organizationMembers.every((member: object) => Object.keys(member).sort().join(',') === 'name,organizationRole')).toBe(true)
    expect(JSON.stringify(organizationMembers)).not.toContain('@qcu.edu.ph')
    expect(JSON.stringify(organizationMembers)).not.toContain('QCU-2024-0101')
  })
})
