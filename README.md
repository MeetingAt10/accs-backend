# Backend

Node + Express 5 + TypeScript. Zod-validated env, helmet, cors. Tests with Vitest + Supertest.

```
cp .env.example .env
pnpm install   # or npm install
pnpm dev       # http://localhost:3000, GET /api/health
pnpm test
pnpm build && pnpm start
```

`CORS_ORIGIN` is a comma-separated list of allowed browser origins (default `http://localhost:5173`). Every ACCS module site calls this one API with credentials, so list all seven site origins in deployed environments; see `.env.example`.

`tests/doc003-modules.test.ts` checks the DOC003 module inventory (`tests/fixtures/doc003-modules.json`, 58 modules): for each module, every owning role can sign in as its seeded account and reach at least one of the module's pages.

System concept not defined yet.

## Accounts and sign-in

| Endpoint | Body | Result |
|---|---|---|
| `POST /api/auth/register` | `{ fullName, email, identifier, role: 'student' \| 'professor' \| 'staff', program?, yearLevel?, section?, password }` | 201 + session cookie; 409 `CONFLICT` on a taken email or ID |
| `POST /api/auth/sign-in` | `{ emailOrId, password, remember? }` | 200 + session cookie; 401 `INVALID_CREDENTIALS`; 429 `TOO_MANY_ATTEMPTS` after 5 failures in 15 minutes |
| `POST /api/auth/forgot-password` | `{ emailOrId }` | Always 200, same answer for unknown accounts. Outside production issues a 6-digit code and logs it; in production issues nothing until email delivery exists |
| `POST /api/auth/reset-password` | `{ emailOrId, code, password }` | 200 and signs out every session; 400 `INVALID_CODE` |
| `POST /api/admin/accounts/:id/reset-code` | `{}` (administrator) | 200 with `record.code`, shown once; audited as `Password reset code issued`; 403 for other roles |
| `POST /api/auth/change-password` | `{ currentPassword, password }` (signed in) | 200; 400 `INVALID_CREDENTIALS` |
| `POST /api/auth/sign-out` | `{}` | Clears the cookie |

Passwords are hashed with `crypto.scryptSync` and need 10+ characters with upper and lower case, a number, and a symbol. Students must give program, year level, and section. Privileged roles are granted by an administrator, never self-registered.

Registered accounts and password hashes live in the auth store (`src/auth.ts`): an S3 object when `AUTH_STORE_BUCKET` is set (Lambda; `AUTH_STORE_KEY`, default `auth-store.json`), otherwise a JSON file at `AUTH_STORE_FILE` (default `/tmp/accs-auth-store.json`). Tests use an in-memory store. Seeded pilot accounts (`QCU-STU-IT-A`, `QCU-ADMIN`, …) sign in with their ID or email and `Accs@Qcu2026!` until changed; rotate or disable this shared password before real users join.

## Password reset codes

Codes live in `ccs_identity` as the `RESET` item `USER#<id>` / `RESET` (hash only, TTL on `expires_epoch`), so limits hold on every Lambda instance: 5 guesses per code (counted before the check, so parallel guesses cannot exceed it), 15-minute expiry, single use, 60-second cooldown, and 5 self-service codes per account per hour (a new code keeps the count). An administrator-issued code skips the cooldown and the cap. There is no email channel yet (SES is planned): in production the CCS office gets a code from an administrator and hands it to the account holder. Limits are provisional until D-08.

## Sessions

Sign-in creates a server-side session. The `accs_session` cookie holds an opaque random token; the `ccs_identity` table (`<TABLE_PREFIX>ccs_identity`, a DOC006 `SESSION` item keyed `SESSION#<sha256 of token>`) stores only its hash, so a leaked table cannot be replayed. Every request reads the session and the account, so sign-out, a role change, and deactivation apply at once. Sessions end after 30 minutes idle or 12 hours (remember me: 7 days idle, 30 days); these are provisional until DOC003 decision D-08. Changing a password signs out other devices; a password reset signs out all of them. Without `TABLE_PREFIX`, sessions stay in memory locally, and on Lambda sign-in fails rather than issuing sessions valid on one instance only.

## Errors and logging

Every unexpected error returns `500 INTERNAL_ERROR` and writes one JSON line to stderr (CloudWatch on Lambda, where the runtime adds the timestamp and request ID): `level`, `msg`, `method`, `path`, `status`, and the error's name, message, and stack. The body, query string, headers, and cookies are never logged, since they can hold passwords, reset codes, and session tokens. Validation, auth, and other expected 4xx responses are not logged; a body over the 128 KB limit returns `413`.
