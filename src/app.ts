import { randomBytes, randomInt } from 'node:crypto'
import cors from 'cors'
import express, { type ErrorRequestHandler, type Request, type Response } from 'express'
import helmet from 'helmet'
import { z } from 'zod'

import { type AuthData, type AuthStore, createAuthStore, defaultHash, hashPassword, verifyPassword } from './auth.js'
import { env, onLambda, tableName } from './env.js'
import { actionRequestSchema, actionResponseSchema, changePasswordSchema, emptyBodySchema, errorResponseSchema, forgotPasswordSchema, healthResponseSchema, idParamsSchema, pageQuerySchema, pageResponseSchema, registerSchema, resetPasswordSchema, sessionResponseSchema, signInSchema, type User } from './schemas.js'
import { hasPermission } from './access.js'
import { ApiError, getPage, performAction, refreshRestrictions, sessionView, unavailable } from './services.js'
import { createResetStore, resetPolicy, type ResetStore } from './resets.js'
import { createSessionStore, isWellFormedToken, newSessionToken, sessionIdOf, sessionPolicy, sessionState, type SessionStore } from './sessions.js'
import { createMemoryRepository, type Repository } from './store.js'

function send<T>(res:Response,schema:z.ZodType<T>,value:unknown,status=200){const parsed=schema.safeParse(value);if(!parsed.success)throw new Error('API response did not match its schema');res.status(status).json(parsed.data)}
export function createApp(repository:Repository=createMemoryRepository(),options:{authStore?:AuthStore;sessionStore?:SessionStore;resetStore?:ResetStore}={}){
  const app=express()
  const authStore=options.authStore??createAuthStore()
  const sessions=options.sessionStore??createSessionStore({nodeEnv:env.NODE_ENV,tableName:tableName('ccs_identity'),onLambda})
  const resets=options.resetStore??createResetStore({nodeEnv:env.NODE_ENV,tableName:tableName('ccs_identity'),onLambda})
  // The deployed app and API sit on different domains, so the session cookie must be cross-site there.
  const cookieOptions={httpOnly:true,sameSite:env.NODE_ENV==='production'?'none' as const:'lax' as const,secure:env.NODE_ENV==='production',path:'/'}
  app.use(helmet());app.use(cors({origin:env.CORS_ORIGIN,credentials:true}));app.use(express.json({limit:'128kb'}))
  app.get(['/health','/api/health'],(_req,res)=>send(res,healthResponseSchema,{status:'ok'}))
  const cookieValue=(req:Request)=>req.headers.cookie?.split(';').map(part=>part.trim()).find(part=>part.startsWith('accs_session='))?.slice('accs_session='.length)
  // Resolves the session cookie to a live SESSION item, then to the account. Roles are read from the
  // account on every request, so a role change or deactivation applies to existing sessions at once.
  const sessionUser=async(req:Request,res:Response)=>{
    const token=cookieValue(req);if(!isWellFormedToken(token))return undefined
    const sessionId=sessionIdOf(token);const session=await sessions.get(sessionId);const now=Date.now()
    if(!session||sessionState(session,now)!=='live')return undefined
    const account=repository.read().users.find(u=>u.id===session.userId&&u.active);if(!account)return undefined
    if(now-Date.parse(session.lastSeenAt)>=sessionPolicy.touchIntervalMs)await sessions.touch(sessionId,new Date(now).toISOString())
    res.locals.sessionId=sessionId;return refreshRestrictions(repository.read(),structuredClone(account))
  }
  const startSession=async(req:Request,res:Response,user:User,remember=false)=>{
    const token=newSessionToken();const issued=new Date();const {absoluteMs}=remember?sessionPolicy.remember:sessionPolicy.normal
    await sessions.create({sessionId:sessionIdOf(token),userId:user.id,activeRoleId:user.roles[0]??'',issuedAt:issued.toISOString(),expiresAt:new Date(issued.getTime()+absoluteMs).toISOString(),lastSeenAt:issued.toISOString(),remember,ipAddress:req.ip??'',userAgent:String(req.headers['user-agent']??'').slice(0,512),status:'active'})
    res.cookie('accs_session',token,remember?{...cookieOptions,maxAge:absoluteMs}:cookieOptions)
  }
  // Registered users live in the auth store; merge them into the repository (and their class spaces) before any lookup.
  const syncUsers=async()=>{const db=repository.read();const known=new Set(db.users.map(u=>u.id));for(const u of (await authStore.load()).users)if(!known.has(u.id)){db.users.push(structuredClone(u));for(const space of db.spaces)if(u.spaceIds.includes(space.id)&&!space.studentIds.includes(u.id))space.studentIds.push(u.id)}}
  const findUser=(ident:string)=>{const key=ident.trim().toLowerCase();return repository.read().users.find(u=>u.active&&(u.email.toLowerCase()===key||u.id.toLowerCase()===key||u.studentId?.toLowerCase()===key))}
  // Seeded users have no stored credential until they set one; registered users always do.
  const credentialFor=(user:User,data:AuthData)=>data.credentials[user.id]??(data.users.some(u=>u.id===user.id)?undefined:defaultHash())
  // ponytail: in-memory per instance, shared store needed if throttling must hold across Lambda instances
  const attempts=new Map<string,{n:number;until:number}>()
  const blocked=(key:string)=>{const a=attempts.get(key);if(a&&a.until<=Date.now()){attempts.delete(key);return false}return !!a&&a.n>=5}
  const bump=(key:string)=>{const a=attempts.get(key);if(!a||a.until<=Date.now()){if(attempts.size>5000)for(const [k,v] of attempts)if(v.until<=Date.now())attempts.delete(k);attempts.set(key,{n:1,until:Date.now()+15*60*1000})}else a.n++}
  const tooMany=()=>new ApiError(429,'Too many attempts. Try again in 15 minutes.','TOO_MANY_ATTEMPTS')
  const sessionOut=(res:Response,user:User,status=200)=>send(res,sessionResponseSchema,sessionView(refreshRestrictions(repository.read(),structuredClone(user))),status)
  app.use('/api',async(_req,_res,next)=>{await syncUsers();next()})
  app.post('/api/auth/register',async(req,res)=>{
    const body=registerSchema.parse(req.body);const email=body.email.toLowerCase();const student=body.role==='student'
    const spaces=student?repository.read().spaces.filter(s=>s.program===body.program&&s.section===body.section):[]
    // The employee ID is kept in studentId too: it is the only identifier field a user has.
    const created:User={id:`USR-${randomBytes(5).toString('hex').toUpperCase()}`,name:body.fullName,email,roles:[body.role],...(student?{program:body.program,section:body.section,year:body.yearLevel,adviserId:spaces[0]?.professorIds[0]}:{}),studentId:body.identifier,restrictions:[],title:'',bio:'',education:'',officeHours:'',spaceIds:spaces.map(s=>s.id),organizationIds:[],active:true}
    await authStore.update(data=>{const taken=[...repository.read().users,...data.users];if(taken.some(u=>u.email.toLowerCase()===email))throw new ApiError(409,'An account with this email already exists.','CONFLICT');if(taken.some(u=>u.studentId?.toLowerCase()===body.identifier.toLowerCase()))throw new ApiError(409,'An account with this ID already exists.','CONFLICT');data.users.push(created);data.credentials[created.id]=hashPassword(body.password)})
    await syncUsers();await startSession(req,res,created);sessionOut(res,created,201)
  })
  app.post('/api/auth/sign-in',async(req,res)=>{
    const {emailOrId,password,remember}=signInSchema.parse(req.body);const key=emailOrId.trim().toLowerCase()
    if(blocked(key))throw tooMany()
    const user=findUser(emailOrId);const stored=user&&credentialFor(user,await authStore.load())
    // Always run one scrypt verification so unknown accounts and wrong passwords cost the same.
    const matches=verifyPassword(password,stored||defaultHash())
    if(!user||!stored||!matches){bump(key);throw new ApiError(401,'The email, ID, or password is incorrect.','INVALID_CREDENTIALS')}
    attempts.delete(key);await startSession(req,res,user,remember);sessionOut(res,user)
  })
  // TBD(SES): no email channel yet. Outside production the code is logged; in production an administrator
  // issues it (POST /api/admin/accounts/:id/reset-code) and hands it over, so self-service issues nothing.
  const deliverResetCode=(user:User,code:string)=>{if(env.NODE_ENV==='production')return false;console.log(`[accs] password reset code for ${user.id}: ${code}`);return true}
  const selfServiceReset=env.NODE_ENV!=='production'
  const newResetCode=()=>{const code=String(randomInt(100000,1000000));return {code,codeHash:hashPassword(code)}}
  app.post('/api/auth/forgot-password',async(req,res)=>{
    const {emailOrId}=forgotPasswordSchema.parse(req.body);const user=findUser(emailOrId)
    // Hash a code whether or not the account exists, so the response time does not reveal it.
    const {code,codeHash}=newResetCode()
    if(user&&selfServiceReset&&await resets.issue({userId:user.id,codeHash,now:Date.now()})==='issued')deliverResetCode(user,code)
    send(res,actionResponseSchema,{ok:true,message:selfServiceReset?'If an account matches, a reset code has been issued. Ask an ACCS administrator if you do not receive it.':'To reset your password, ask an ACCS administrator for a reset code, then enter it here with your new password.'})
  })
  app.post('/api/auth/reset-password',async(req,res)=>{
    const {emailOrId,code,password}=resetPasswordSchema.parse(req.body);const key=`reset:${emailOrId.trim().toLowerCase()}`
    if(blocked(key))throw tooMany()
    const user=findUser(emailOrId)
    // The guess is counted before the code is checked, so parallel requests cannot exceed the per-code limit.
    const claimed=user?await resets.claimAttempt(user.id,Date.now()):undefined
    const matches=verifyPassword(code,claimed?.codeHash??defaultHash())
    if(!user||!claimed||!matches){bump(key);throw new ApiError(400,'The code is incorrect or has expired.','INVALID_CODE')}
    // Single use: only one request can delete this code, even if two arrive with it at once.
    if(!await resets.consume(user.id,claimed.codeHash)){bump(key);throw new ApiError(400,'The code is incorrect or has expired.','INVALID_CODE')}
    await authStore.update(data=>{data.credentials[user.id]=hashPassword(password)})
    // A reset means the old password may be known to someone else: end every session.
    await sessions.revokeUser(user.id)
    attempts.delete(key);send(res,actionResponseSchema,{ok:true,message:'Password updated. Sign in with your new password.'})
  })
  app.post('/api/auth/sign-out',async(req,res)=>{emptyBodySchema.parse(req.body??{});const token=cookieValue(req);if(isWellFormedToken(token))await sessions.revoke(sessionIdOf(token));res.clearCookie('accs_session',cookieOptions);send(res,actionResponseSchema,{ok:true,message:'Signed out.'})})
  app.use('/api',async(req,res,next)=>{const user=await sessionUser(req,res);if(!user)return send(res,errorResponseSchema,{error:'Sign in to continue.',code:'UNAUTHENTICATED'},401);res.locals.user=user;next()})
  app.post('/api/auth/change-password',async(req,res)=>{
    const user=res.locals.user as User;const {currentPassword,password}=changePasswordSchema.parse(req.body);const key=`change:${user.id}`
    if(blocked(key))throw tooMany()
    const stored=credentialFor(user,await authStore.load())
    if(!stored||!verifyPassword(currentPassword,stored)){bump(key);throw new ApiError(400,'Your current password is incorrect.','INVALID_CREDENTIALS')}
    await authStore.update(data=>{data.credentials[user.id]=hashPassword(password)})
    // Keep this session; sign out every other device.
    await sessions.revokeUser(user.id,res.locals.sessionId as string)
    attempts.delete(key);send(res,actionResponseSchema,{ok:true,message:'Password changed.'})
  })
  // Office-assisted reset: an administrator issues a code, shown once, and gives it to the account holder.
  app.post('/api/admin/accounts/:id/reset-code',async(req,res)=>{
    const admin=res.locals.user as User;const id=z.string().trim().min(1).max(64).parse(req.params.id);emptyBodySchema.parse(req.body??{})
    if(!hasPermission(admin,'role.manage'))throw new ApiError(403,'You do not have access to this action.','FORBIDDEN')
    const account=repository.read().users.find(u=>u.id===id&&u.active);if(!account)throw unavailable()
    const {code,codeHash}=newResetCode();const now=Date.now()
    await resets.issue({userId:account.id,codeHash,now,issuedBy:admin.id})
    const db=repository.read();db.audit.push({id:repository.nextId('AUDIT'),at:new Date(now).toISOString(),actorId:admin.id,action:'Password reset code issued','module':'identity',reference:account.id,result:'Recorded'})
    send(res,actionResponseSchema,{ok:true,message:'Reset code issued. Give it to the account holder; it expires in 15 minutes and is not shown again.',record:{code,expiresAt:new Date(now+resetPolicy.codeTtlMs).toISOString()}})
  })
  app.get('/api/session',(_req,res)=>send(res,sessionResponseSchema,sessionView(res.locals.user as User)))
  app.get('/api/pages/:pageId',(req,res)=>{const {pageId}=idParamsSchema.parse(req.params);const query=pageQuerySchema.parse(req.query);send(res,pageResponseSchema,getPage(repository,res.locals.user as User,pageId,query))})
  app.post('/api/pages/:pageId/actions',(req,res)=>{const {pageId}=idParamsSchema.parse(req.params);const body=actionRequestSchema.parse(req.body);send(res,actionResponseSchema,performAction(repository,res.locals.user as User,pageId,body))})
  app.use('/api',(_req,res)=>send(res,errorResponseSchema,{error:'This API resource is not available.',code:'NOT_FOUND'},404))
  const errors:ErrorRequestHandler=(error,_req,res,_next)=>{if(error instanceof z.ZodError)return send(res,errorResponseSchema,{error:'Check the required fields.',code:'VALIDATION_ERROR',fields:error.issues.map(issue=>({path:issue.path.map(String).join('.'),message:issue.message}))},400);if(error instanceof ApiError)return send(res,errorResponseSchema,{error:error.message,code:error.code},error.status);if(error instanceof SyntaxError)return send(res,errorResponseSchema,{error:'The request must contain valid JSON.',code:'VALIDATION_ERROR'},400);send(res,errorResponseSchema,{error:'The request could not be completed.',code:'INTERNAL_ERROR'},500)}
  app.use(errors);return app
}
export const app=createApp()

