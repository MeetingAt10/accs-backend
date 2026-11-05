import { randomInt } from 'node:crypto'
import cors from 'cors'
import express, { type ErrorRequestHandler, type Request, type Response } from 'express'
import helmet from 'helmet'
import { z } from 'zod'

import { type AuthData, type AuthStore, createAuthStore, defaultHash, hashPassword, verifyPassword } from './auth.js'
import { env, onLambda, tableName } from './env.js'
import { actionRequestSchema, actionResponseSchema, changePasswordSchema, completeFirstLoginSchema, emptyBodySchema, errorResponseSchema, forgotPasswordSchema, healthResponseSchema, idParamsSchema, pageQuerySchema, pageResponseSchema, resetPasswordSchema, sessionResponseSchema, signInSchema, type User } from './schemas.js'
import { accountRouter, applyAccounts, recordAudit, saveAccountChange, setOwnCredentials, unsentMailer, type InviteMailer } from './accounts.js'
import { hasPermission } from './access.js'
import { devRouter, devToolboxEnabled, isDevToolboxCall, type Stack } from './dev.js'
import { send } from './http.js'
import { createRepository } from './persist.js'
import { ApiError, getPage, performAction, refreshRestrictions, sessionView, unavailable, type AccountChange } from './services.js'
import { createResetStore, resetPolicy, type ResetStore } from './resets.js'
import { createSessionStore, isWellFormedToken, newSessionToken, sessionIdOf, sessionPolicy, sessionState, type SessionStore } from './sessions.js'
import { demoUserIds, type Repository } from './store.js'

export function createApp(repository:Repository=createRepository({nodeEnv:env.NODE_ENV,tableName}),options:{authStore?:AuthStore;sessionStore?:SessionStore;resetStore?:ResetStore;mailer?:InviteMailer;stack?:Stack}={}){
  const app=express()
  // The account switcher for testers exists only on the development stack and on local runs (src/dev.ts).
  const devToolbox=devToolboxEnabled(options.stack??{tablePrefix:env.TABLE_PREFIX,nodeEnv:env.NODE_ENV})
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
    const user=await repository.view(unit=>{const db=unit.read();const account=db.users.find(u=>u.id===session.userId&&u.active);return account&&refreshRestrictions(db,account)},[]);if(!user)return undefined
    if(now-Date.parse(session.lastSeenAt)>=sessionPolicy.touchIntervalMs)await sessions.touch(sessionId,new Date(now).toISOString())
    res.locals.sessionId=sessionId;return user
  }
  const startSession=async(req:Request,res:Response,user:User,remember=false)=>{
    const token=newSessionToken();const issued=new Date();const {absoluteMs}=remember?sessionPolicy.remember:sessionPolicy.normal
    await sessions.create({sessionId:sessionIdOf(token),userId:user.id,activeRoleId:user.roles[0]??'',issuedAt:issued.toISOString(),expiresAt:new Date(issued.getTime()+absoluteMs).toISOString(),lastSeenAt:issued.toISOString(),remember,ipAddress:req.ip??'',userAgent:String(req.headers['user-agent']??'').slice(0,512),status:'active'})
    res.cookie('accs_session',token,remember?{...cookieOptions,maxAge:absoluteMs}:cookieOptions)
  }
  // Accounts live in the auth store, the one source of truth across instances. Lay them over this instance's repository
  // (and their class spaces) before any lookup. The store returns the same object until it changes, so a request that finds
  // nothing new costs no repository work.
  let synced:AuthData|undefined
  const syncUsers=async()=>{
    const data=await authStore.load();if(data===synced)return
    await repository.transact(unit=>applyAccounts(unit.read(),data.users),[]);synced=data
  }
  const findUser=(ident:string)=>{const key=ident.trim().toLowerCase();return repository.view(unit=>unit.read().users.find(u=>u.active&&(u.email.toLowerCase()===key||u.id.toLowerCase()===key||u.studentId?.toLowerCase()===key||u.username?.toLowerCase()===key)),[])}
  // A role change made on the administrator's pages is saved to the auth store too, so it holds on every instance.
  const saveAccount=async(change:AccountChange)=>saveAccountChange(authStore,await repository.view(unit=>unit.read().users,[]),change)
  // Only the seeded demo accounts fall back to the shared seed password, until they set their own. Every other account has a stored credential.
  const credentialFor=(user:User,data:AuthData)=>data.credentials[user.id]??(demoUserIds.has(user.id)?defaultHash():undefined)
  // ponytail: in-memory per instance, shared store needed if throttling must hold across Lambda instances
  const attempts=new Map<string,{n:number;until:number}>()
  const blocked=(key:string)=>{const a=attempts.get(key);if(a&&a.until<=Date.now()){attempts.delete(key);return false}return !!a&&a.n>=5}
  const bump=(key:string)=>{const a=attempts.get(key);if(!a||a.until<=Date.now()){if(attempts.size>5000)for(const [k,v] of attempts)if(v.until<=Date.now())attempts.delete(k);attempts.set(key,{n:1,until:Date.now()+15*60*1000})}else a.n++}
  const tooMany=()=>new ApiError(429,'Too many attempts. Try again in 15 minutes.','TOO_MANY_ATTEMPTS')
  const sessionOut=async(res:Response,user:User,status=200)=>send(res,sessionResponseSchema,sessionView(await repository.view(unit=>refreshRestrictions(unit.read(),user),[])),status)
  app.use('/api',async(_req,_res,next)=>{await syncUsers();next()})
  app.post('/api/auth/sign-in',async(req,res)=>{
    // Per client as well as per identifier, so guesses from elsewhere cannot lock the owner out. On Lambda, serverless-http sets req.ip to API Gateway's source IP; elsewhere trust proxy stays off. Either way X-Forwarded-For cannot change it.
    const {emailOrId,password,remember}=signInSchema.parse(req.body);const key=`${req.ip}|${emailOrId.trim().toLowerCase()}`
    if(blocked(key))throw tooMany()
    const user=await findUser(emailOrId);const stored=user&&credentialFor(user,await authStore.load())
    // Always run one scrypt verification so unknown accounts and wrong passwords cost the same.
    const matches=verifyPassword(password,stored||defaultHash())
    if(!user||!stored||!matches){bump(key);throw new ApiError(401,'The email, ID, or password is incorrect.','INVALID_CREDENTIALS')}
    attempts.delete(key);await startSession(req,res,user,remember);await sessionOut(res,user)
  })
  // TBD(SES): no email channel yet. Outside production the code is logged; in production an administrator
  // issues it (POST /api/admin/accounts/:id/reset-code) and hands it over, so self-service issues nothing.
  const deliverResetCode=(user:User,code:string)=>{if(env.NODE_ENV==='production')return false;console.log(`[accs] password reset code for ${user.id}: ${code}`);return true}
  const selfServiceReset=env.NODE_ENV!=='production'
  const newResetCode=()=>{const code=String(randomInt(100000,1000000));return {code,codeHash:hashPassword(code)}}
  app.post('/api/auth/forgot-password',async(req,res)=>{
    const {emailOrId}=forgotPasswordSchema.parse(req.body);const user=await findUser(emailOrId)
    // Hash a code whether or not the account exists, so the response time does not reveal it.
    const {code,codeHash}=newResetCode()
    if(user&&selfServiceReset&&await resets.issue({userId:user.id,codeHash,now:Date.now()})==='issued')deliverResetCode(user,code)
    send(res,actionResponseSchema,{ok:true,message:selfServiceReset?'If an account matches, a reset code has been issued. Ask an ACCS administrator if you do not receive it.':'To reset your password, ask an ACCS administrator for a reset code, then enter it here with your new password.'})
  })
  app.post('/api/auth/reset-password',async(req,res)=>{
    const {emailOrId,code,password}=resetPasswordSchema.parse(req.body);const key=`reset:${emailOrId.trim().toLowerCase()}`
    if(blocked(key))throw tooMany()
    const user=await findUser(emailOrId)
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
  app.use('/api',async(req,res,next)=>{const user=await sessionUser(req,res);if(!user)return send(res,errorResponseSchema,{error:'Sign in to continue.',code:'UNAUTHENTICATED'},401);res.locals.user=user
    // Temporary credentials open only the call that replaces them, reading the session, and signing out (registered above).
    // Where the account switcher exists, its two calls stay open too, so a tester can leave an account that is still on temporary details.
    const setting=req.method==='GET'&&req.path==='/session'||req.method==='POST'&&req.path==='/auth/complete-first-login'||devToolbox&&isDevToolboxCall(req.method,req.path)
    if(user.mustChangeCredentials&&!setting)return send(res,errorResponseSchema,{error:'Set your own username and password to continue.',code:'CREDENTIALS_CHANGE_REQUIRED'},403)
    next()})
  app.post('/api/auth/complete-first-login',async(req,res)=>{
    const user=res.locals.user as User;const {currentPassword,username,password}=completeFirstLoginSchema.parse(req.body);const key=`first:${user.id}`
    if(blocked(key))throw tooMany()
    if(!user.mustChangeCredentials)throw new ApiError(409,'Your sign-in details are already set.','CONFLICT')
    const stored=credentialFor(user,await authStore.load())
    if(!stored||!verifyPassword(currentPassword,stored)){bump(key);throw new ApiError(400,'Your current password is incorrect.','INVALID_CREDENTIALS')}
    if(password===currentPassword)throw new ApiError(400,'Choose a password that is different from the temporary one.','VALIDATION_ERROR')
    if(username===user.username?.toLowerCase())throw new ApiError(400,'Choose a username that is different from the temporary one.','VALIDATION_ERROR')
    await setOwnCredentials(authStore,await repository.view(unit=>unit.read().users,[]),user,username,hashPassword(password))
    // Keep this session; the temporary credentials may be on other devices.
    await sessions.revokeUser(user.id,res.locals.sessionId as string);attempts.delete(key)
    await recordAudit(repository,user,[{action:'Sign-in details set',reference:user.id}])
    await sessionOut(res,{...user,username,mustChangeCredentials:false})
  })
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
    const account=await repository.view(unit=>unit.read().users.find(u=>u.id===id&&u.active),[]);if(!account)throw unavailable()
    const {code,codeHash}=newResetCode();const now=Date.now()
    await resets.issue({userId:account.id,codeHash,now,issuedBy:admin.id})
    await repository.transact(unit=>{unit.read().audit.push({id:unit.nextId('AUDIT'),at:new Date(now).toISOString(),actorId:admin.id,action:'Password reset code issued','module':'identity',reference:account.id,result:'Recorded'})},['audit'])
    send(res,actionResponseSchema,{ok:true,message:'Reset code issued. Give it to the account holder; it expires in 15 minutes and is not shown again.',record:{code,expiresAt:new Date(now+resetPolicy.codeTtlMs).toISOString()}})
  })
  app.get('/api/session',(_req,res)=>send(res,sessionResponseSchema,sessionView(res.locals.user as User)))
  app.get('/api/pages/:pageId',async(req,res)=>{const {pageId}=idParamsSchema.parse(req.params);const query=pageQuerySchema.parse(req.query);send(res,pageResponseSchema,await getPage(repository,res.locals.user as User,pageId,query))})
  app.post('/api/pages/:pageId/actions',async(req,res)=>{const {pageId}=idParamsSchema.parse(req.params);const body=actionRequestSchema.parse(req.body);send(res,actionResponseSchema,await performAction(repository,res.locals.user as User,pageId,body,saveAccount))})
  app.use('/api/accounts',accountRouter({repository,authStore,sessions,mailer:options.mailer??unsentMailer}))
  if(devToolbox)app.use('/api/dev',devRouter({repository,sessions,start:startSession,out:sessionOut}))
  app.use('/api',(_req,res)=>send(res,errorResponseSchema,{error:'This API resource is not available.',code:'NOT_FOUND'},404))
  const errors:ErrorRequestHandler=(error,req,res,_next)=>{if(error instanceof z.ZodError)return send(res,errorResponseSchema,{error:'Check the required fields.',code:'VALIDATION_ERROR',fields:error.issues.map(issue=>({path:issue.path.map(String).join('.'),message:issue.message}))},400);if(error instanceof ApiError)return send(res,errorResponseSchema,{error:error.message,code:error.code},error.status);if(error instanceof SyntaxError)return send(res,errorResponseSchema,{error:'The request must contain valid JSON.',code:'VALIDATION_ERROR'},400)
    // body-parser errors carry their own 4xx status (for example 413 for a body over the 128 KB limit).
    const status=(error as {status?:unknown}).status;if(typeof status==='number'&&status>=400&&status<500)return send(res,errorResponseSchema,{error:status===413?'The request is too large.':'The request could not be read.',code:'VALIDATION_ERROR'},status)
    logUnexpected(req,error);send(res,errorResponseSchema,{error:'The request could not be completed.',code:'INTERNAL_ERROR'},500)}
  app.use(errors);return app
}
export const app=createApp()

/**
 * Writes one JSON line per unexpected error, so 500s are visible in CloudWatch (the Lambda runtime adds the
 * timestamp and request ID). Only the method, path, and error are logged: never the body, query, headers, or
 * cookies, which can carry passwords, reset codes, and session tokens.
 */
export function logUnexpected(req: Request, error: unknown) {
  const err = error instanceof Error ? error : new Error(String(error))
  console.error(JSON.stringify({
    level: 'error',
    msg: 'Unhandled error',
    method: req.method,
    path: req.path,
    status: 500,
    error: { name: err.name, message: err.message, stack: err.stack },
  }))
}

