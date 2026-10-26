import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import cors from 'cors'
import express, { type ErrorRequestHandler, type Response } from 'express'
import helmet from 'helmet'
import { z } from 'zod'

import { env } from './env.js'
import { accountsResponseSchema, actionRequestSchema, actionResponseSchema, emptyBodySchema, errorResponseSchema, healthResponseSchema, idParamsSchema, pageQuerySchema, pageResponseSchema, sessionResponseSchema, signInSchema, type User } from './schemas.js'
import { ApiError, getPage, performAction, refreshRestrictions, sessionView } from './services.js'
import { createMemoryRepository, type Repository } from './store.js'

function send<T>(res:Response,schema:z.ZodType<T>,value:unknown,status=200){const parsed=schema.safeParse(value);if(!parsed.success)throw new Error('API response did not match its schema');res.status(status).json(parsed.data)}
export function createApp(repository:Repository=createMemoryRepository()){
  const app=express();const signingKey=env.SESSION_SECRET??randomBytes(32).toString('hex')
  const signature=(value:string)=>createHmac('sha256',signingKey).update(value).digest('base64url')
  // The deployed app and API sit on different domains, so the session cookie must be cross-site there.
  const cookieOptions={httpOnly:true,sameSite:env.NODE_ENV==='production'?'none' as const:'lax' as const,secure:env.NODE_ENV==='production',path:'/'}
  app.use(helmet());app.use(cors({origin:env.CORS_ORIGIN,credentials:true}));app.use(express.json({limit:'128kb'}))
  app.get(['/health','/api/health'],(_req,res)=>send(res,healthResponseSchema,{status:'ok'}))
  app.get('/api/demo-accounts',(_req,res)=>send(res,accountsResponseSchema,{accounts:repository.read().users.filter(u=>u.active).map(u=>({id:u.id,name:u.name,email:u.email,roles:u.roles,description:u.id==='DEMO-STU-RESTRICTED'?'Posting, commenting, and anonymous reporting paused. Essential access remains available.':u.roles.length>1?'Multi-role account: permissions combine across roles.':u.program??u.office??'CCS pilot account'})),sampleData:true}))
  app.post('/api/auth/sign-in',(req,res)=>{const {accountId}=signInSchema.parse(req.body);const user=repository.read().users.find(u=>u.id===accountId&&u.active&&u.email.endsWith('@qcu.edu.ph'));if(!user)throw new ApiError(401,'Sign-in could not be completed. Choose an available demo account.','UNAUTHENTICATED');const snapshot=structuredClone(user);const id=encodeSession(snapshot);res.cookie('accs_session',`${id}.${signature(id)}`,cookieOptions);send(res,sessionResponseSchema,sessionView(refreshRestrictions(repository.read(),snapshot)))})
  app.post('/api/auth/sign-out',(req,res)=>{emptyBodySchema.parse(req.body??{});const value=req.headers.cookie?.split(';').map(part=>part.trim()).find(part=>part.startsWith('accs_session='))?.slice('accs_session='.length);res.clearCookie('accs_session',cookieOptions);send(res,actionResponseSchema,{ok:true,message:'Signed out.'})})
  app.use('/api',(req,res,next)=>{const value=req.headers.cookie?.split(';').map(part=>part.trim()).find(part=>part.startsWith('accs_session='))?.slice('accs_session='.length);const [id,signed]=value?.split('.')??[];let valid=false;if(id&&signed){const expected=Buffer.from(signature(id));const actual=Buffer.from(signed);valid=actual.length===expected.length&&timingSafeEqual(actual,expected)}const claims=valid&&id?decodeSession(id):undefined;const account=claims?repository.read().users.find(u=>u.id===claims.id&&u.active):undefined;const snapshot=account&&claims?{...account,roles:claims.roles}:undefined;if(!snapshot||!account)return send(res,errorResponseSchema,{error:'Sign in to continue.',code:'UNAUTHENTICATED'},401);res.locals.user=refreshRestrictions(repository.read(),{...snapshot,name:account.name,email:account.email,title:account.title,bio:account.bio,education:account.education,officeHours:account.officeHours});next()})
  app.get('/api/session',(_req,res)=>send(res,sessionResponseSchema,sessionView(res.locals.user as User)))
  app.get('/api/pages/:pageId',(req,res)=>{const {pageId}=idParamsSchema.parse(req.params);const query=pageQuerySchema.parse(req.query);send(res,pageResponseSchema,getPage(repository,res.locals.user as User,pageId,query))})
  app.post('/api/pages/:pageId/actions',(req,res)=>{const {pageId}=idParamsSchema.parse(req.params);const body=actionRequestSchema.parse(req.body);send(res,actionResponseSchema,performAction(repository,res.locals.user as User,pageId,body))})
  app.use('/api',(_req,res)=>send(res,errorResponseSchema,{error:'This API resource is not available.',code:'NOT_FOUND'},404))
  const errors:ErrorRequestHandler=(error,_req,res,_next)=>{if(error instanceof z.ZodError)return send(res,errorResponseSchema,{error:'Check the required fields.',code:'VALIDATION_ERROR',fields:error.issues.map(issue=>({path:issue.path.map(String).join('.'),message:issue.message}))},400);if(error instanceof ApiError)return send(res,errorResponseSchema,{error:error.message,code:error.code},error.status);if(error instanceof SyntaxError)return send(res,errorResponseSchema,{error:'The request must contain valid JSON.',code:'VALIDATION_ERROR'},400);send(res,errorResponseSchema,{error:'The request could not be completed.',code:'INTERNAL_ERROR'},500)}
  app.use(errors);return app
}
export const app=createApp()

// Sessions are self-contained signed tokens (user id and the roles loaded at sign-in), so every
// Lambda instance can verify them without shared session storage.
function encodeSession(user: User) {
  return Buffer.from(JSON.stringify({ id: user.id, roles: user.roles })).toString('base64url')
}

function decodeSession(token: string): Pick<User, 'id' | 'roles'> | undefined {
  try {
    const claims = JSON.parse(Buffer.from(token, 'base64url').toString('utf8'))
    return typeof claims?.id === 'string' && Array.isArray(claims.roles) ? claims : undefined
  } catch {
    return undefined
  }
}
