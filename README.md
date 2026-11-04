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

## Storage boundary

Routes and domain rules reach data only through `Repository` (`src/store.ts`). `view` runs read-only work: its changes are discarded and its result is detached. `transact` is all or nothing: if the work throws, nothing it changed is kept. The work itself stays synchronous, so a backend does its I/O before and after it, and one unit of work is never interleaved with another. `GET /api/pages/P34` uses `transact` because opening a student record writes an audit entry. Both take an optional list of stored collections the work touches; the lookups that run on every request (session, sign-in, account sync) name none, so a backend that loads on demand skips them.

Two implementations:

- `createMemoryRepository` (`src/store.ts`): all state in one process. Used in tests and local runs, so data is per instance and lost on restart.
- `createRecordRepository` (`src/persist.ts`): used on a deployed stack, when `TABLE_PREFIX` is set and `NODE_ENV` is not `test` (`createRepository` makes the choice; handing it a DynamoDB client, real or fake, overrides the test rule). It needs no new infrastructure: only `TABLE_PREFIX` and the item-level access the Lambda role already has (`Query`, `TransactWriteItems` as `PutItem`; no `Scan`).

### Shared state (record repository)

The seed is the base. Six collections are shared by every instance and survive a cold start; each lives in its domain table (accs-architecture ADR 0004):

| Collection | Table |
|---|---|
| `reports` | `ccs_grievance` |
| `consultations`, `slots` | `ccs_scheduling` |
| `threads` | `ccs_messaging` |
| `notifications` | `ccs_notification` |
| `audit` | `ccs_audit` (add-only: entries are only ever put, never changed or deleted) |

One item per record: `PK = STATE#<collection>`, `SK` the record ID, `data` the record as JSON text, a numeric `version`, and `entity_type = STATE`. A stored record replaces the seeded record with the same ID; a record deleted from the seed (an availability slot) is kept as an item with `deleted` set, so it stays hidden. A seeded record that has been changed is stored whole, so later edits to its seed text do not reach it.

- `view` queries each collection it needs (strongly consistent, every page of the result, in parallel), lays the records over the seed, and runs the work on that private copy.
- `transact` does the same, then writes only the records that changed, each conditioned on the version it read (`attribute_not_exists(PK)` for a new record), in one `TransactWriteItems` per 100 writes. If another instance changed a record first, the work runs again on fresh data, up to 3 times in all, and then the call fails with `409 CONFLICT`. A change of more than 100 records is split into several transactions; if a later one loses a race the work is not run again, since the earlier ones are already stored, and the call fails with `409`. Transactions on one instance take turns.
- The write check is per record: two instances changing the same record cannot both win (one slot, one consultation), but a unit of work that only reads a record and acts on it is not re-checked.
- Every `view` loads whole collections. Notifications and the audit trail grow without bound; they need a per-user key or a time window before the pilot gets large.

Everything else stays on the seed, per instance, exactly as in memory: `users` (accounts come from the auth store below), `spaces`, `organizations`, `posts`, `drafts`, `todos`, `events`, `cycles`, `assignments`, `restrictions`, `referrals`, `offenses`, `goodMoral`, `clusters`, `moderation`, `settings`, `permissionOverrides`, `telemetry`, and `followUps`. A change to one of these is lost on a cold start and is not seen by other instances. `src/records.ts` holds the small `RecordStore` interface (`list`, `write`), its DynamoDB implementation, and an in-memory one the tests use to run two app instances over one store.

## Accounts and sign-in

| Endpoint | Body | Result |
|---|---|---|
| `POST /api/auth/sign-in` | `{ emailOrId, password, remember? }` | 200 + session cookie + session; 401 `INVALID_CREDENTIALS`; 429 `TOO_MANY_ATTEMPTS` after 5 failures in 15 minutes. `emailOrId` is the email, account ID, student ID, or username, in any case. A deactivated account gets the same 401 |
| `POST /api/auth/complete-first-login` | `{ currentPassword, username, password }` (signed in) | 200 + session; 400 `INVALID_CREDENTIALS` (wrong temporary password), 400 `VALIDATION_ERROR` (weak password, bad username, or either one unchanged), 409 `CONFLICT` (username taken, or already done); sets both, clears `mustChangeCredentials`, keeps this session, signs out the others |
| `POST /api/auth/forgot-password` | `{ emailOrId }` | Always 200, same answer for unknown accounts. Outside production issues a 6-digit code and logs it; in production issues nothing until email delivery exists |
| `POST /api/auth/reset-password` | `{ emailOrId, code, password }` | 200 and signs out every session; 400 `INVALID_CODE` |
| `POST /api/admin/accounts/:id/reset-code` | `{}` (administrator) | 200 with `record.code`, shown once; audited as `Password reset code issued`; 403 for other roles |
| `POST /api/auth/change-password` | `{ currentPassword, password }` (signed in) | 200; 400 `INVALID_CREDENTIALS` |
| `POST /api/auth/sign-out` | `{}` | Clears the cookie |
| `GET /api/session` | | `{ user, permissions, allowedPages, roleLabels }`; `user` includes `username` and `mustChangeCredentials` |

Passwords are hashed with `crypto.scryptSync` and need 10+ characters with upper and lower case, a number, and a symbol. Usernames are 3 to 32 characters (`a-z`, `0-9`, `.`, `_`, `-`), stored in lower case, and unique across every sign-in identifier (IDs, emails, student IDs, usernames), so an identifier never reaches the wrong account. Accounts are not self-registered; they come from the secretary (see below).

**Forced change.** An account created by the secretary, and the secretary once the Dean activates it, has a temporary username and password and `mustChangeCredentials: true`. Until `complete-first-login` succeeds, every authenticated `/api` route except `GET /api/session` and `POST /api/auth/sign-out` answers `403` with code `CREDENTIALS_CHANGE_REQUIRED`.

**Where accounts live.** All account state is in the auth store (`src/auth.ts`): an S3 object when `AUTH_STORE_BUCKET` is set (Lambda; `AUTH_STORE_KEY`, default `auth-store.json`), otherwise a JSON file at `AUTH_STORE_FILE` (default `/tmp/accs-auth-store.json`). Tests use an in-memory store. It holds the accounts created after the seed, any change to a seeded account, the password hashes, and `advisorAssignments`. A stored account record replaces the seeded user with the same ID on every instance (role, program, `active`, username, adviser), so changes persist across instances and cold starts; the profile text a person edits themselves (title, bio, education, office hours) stays per instance. Role and active changes made on the administrator's pages (`updateRoles`) are saved there too. Writes carry the object's ETag; a write that loses the race reloads and runs its change again, up to 5 attempts. Each request reads the store once (cached for 2 seconds, then a conditional GET) and touches the repository only when the stored data changed.

Seeded demo accounts (`QCU-STU-IT-A`, `QCU-ADMIN`, ...) sign in with their ID or email and `Accs@Qcu2026!` until they set a password; rotate or disable this shared password before real users join. The seeded secretary, `QCU-SECRETARY`, is inactive and never accepts the shared password: it signs in only with credentials the Dean issued.

## Account provisioning

The Dean activates the secretary, and the secretary creates and manages every other account. Routes are under `/api/accounts`, need a session, check permission (`account.activateSecretary` for the Dean, `account.provision` for the secretary) and validate with zod. Failures use the usual `{ error, code, fields? }` body: `401 UNAUTHENTICATED`, `403 FORBIDDEN` (wrong role), `403 CREDENTIALS_CHANGE_REQUIRED`, `400 VALIDATION_ERROR`, `404 UNAVAILABLE`, `409 CONFLICT`. Successful changes answer `{ ok: true, message, record }`.

An `AccountSummary` is `{ id, name, email, roles, program?, section?, year?, studentId?, adviserId?, active, mustChangeCredentials? }`. Credentials are `{ username, temporaryPassword }`, returned in the response that creates them and never again: only the hash is stored, and neither the audit trail nor the logs hold them.

| Route | Who | Body / query | Result |
|---|---|---|---|
| `GET /api/accounts/types` | Dean, secretary | | `{ types: [{ type, label, active, inactive, canManage }], secretary? }` for `secretary`, `faculty`, `advisor` (faculty with a year assignment), `chair`, `student`. `canManage` is true for `secretary` when the caller is the Dean and for the rest when the caller is the secretary. `secretary` is the secretary's `AccountSummary` |
| `POST /api/accounts/secretary/activate` | Dean | `{ name?, email? }` (the real name and email replace the placeholder) | `record: { account, credentials, invite: { sent, signInUrl } }`. Calling it again issues new credentials, sets `mustChangeCredentials` again, and signs the secretary out |
| `POST /api/accounts/:id/active` | Secretary (Dean for the secretary account) | `{ active }` | `record: { id, active }`. The secretary may switch students, faculty, and chairs only; 403 for anything else, and for anyone deactivating themselves. Deactivating ends the account's sessions at once. 404 for an unknown ID |
| `GET /api/accounts` | Secretary | `?role=&q=` (`q` matches name, email, ID, student ID) | `{ accounts: AccountSummary[], total }`, by name, at most 200 |
| `GET /api/accounts/faculty` | Secretary | `?q=&program=` (`BSIT`, `BSCS`, `BSIS`) | `{ faculty: [AccountSummary + { advisorYears: number[], chairProgram: string \| null }] }` for accounts with the `professor` role |
| `POST /api/accounts/faculty` | Secretary | `{ name, email, program }`, or `{ faculty: [that, ...] }` (1 to 25) | `record: { created, failed, results }` |
| `POST /api/accounts/students` | Secretary | `{ students: [{ name, email, studentId, program, year, section }] }` (1 to 25) | `record: { created, failed, results }`; also serves adding one student |
| `GET /api/accounts/advisors` | Secretary | | `{ advisors: [{ yearLevel: 1..4, faculty: AccountSummary[] }] }`, always four years |
| `PUT /api/accounts/advisors/:yearLevel` | Secretary | `{ facultyIds }` (replaces the list; `[]` clears the year) | `record: { yearLevel, facultyIds, studentsUpdated }`; 400 for a year outside 1 to 4 or an ID that is not faculty |
| `PUT /api/accounts/chairs/:program` | Secretary | `{ facultyId }` | `record: { program, chairId, previousChairIds }`; the choice must be faculty of that program, gets the `chair` role, and the previous chair of the program loses it (and stays faculty) |

Created accounts are active, with `mustChangeCredentials: true`. A batch is checked row by row and answered row by row, in the order sent, so one bad row does not fail the others (HTTP 200 even if every row failed). A `results` entry is either `{ index, status: 'created', account, credentials, invite: { sent, signInUrl } }` or `{ index, status: 'error', code, error, fields? }` with `code` one of `DUPLICATE_EMAIL`, `DUPLICATE_ID` (a student ID already in use), or `INVALID_ROW` (with `fields: [{ path, message }]`). Emails are compared in lower case. More than 25 rows is a 400, because each account costs a password hash and a Lambda call lasts 10 seconds; a client sends batches. A student gets the class spaces for their program and section.

**Advisers.** A student's `adviserId` follows from the assignments for their year: a faculty member in the student's program if one is assigned, otherwise the first assigned, otherwise none. It is recomputed when an assignment changes and when students are imported. One person can advise several years and a year can have several advisers. The seeded demo students keep their seeded advisers.

**Invites.** `sendInvite` (`src/accounts.ts`) hands each new account's invite to an `InviteMailer`. The default sends nothing: it logs that an invite was not sent (the account ID only, never the credentials) and returns `{ sent: false }`, so the UI shows a copyable invite with `invite.signInUrl`, the sign-in page of the site that made the request (or the first allowed origin). Email through SES will implement the same interface.

**Audit.** Each change adds an `identity` entry (`Secretary account activated`, `Faculty account created`, `Student account created`, `Account activated`, `Account deactivated`, `Year n advisers changed`, `Program chair changed`, `Sign-in details set`) with the actor and the account or program as reference. The entry is written after the change is stored; if that write fails it is logged and the response still carries the credentials, which are shown only once.

## Password reset codes

Codes live in `ccs_identity` as the `RESET` item `USER#<id>` / `RESET` (hash only, TTL on `expires_epoch`), so limits hold on every Lambda instance: 5 guesses per code (counted before the check, so parallel guesses cannot exceed it), 15-minute expiry, single use, 60-second cooldown, and 5 self-service codes per account per hour (a new code keeps the count). An administrator-issued code skips the cooldown and the cap. There is no email channel yet (SES is planned): in production the CCS office gets a code from an administrator and hands it to the account holder. Limits are provisional until D-08.

## Sessions

Sign-in creates a server-side session. The `accs_session` cookie holds an opaque random token; the `ccs_identity` table (`<TABLE_PREFIX>ccs_identity`, a DOC006 `SESSION` item keyed `SESSION#<sha256 of token>`) stores only its hash, so a leaked table cannot be replayed. Every request reads the session and the account, so sign-out, a role change, and deactivation apply at once. Sessions end after 30 minutes idle or 12 hours (remember me: 7 days idle, 30 days); these are provisional until DOC003 decision D-08. Changing a password signs out other devices; a password reset signs out all of them. Without `TABLE_PREFIX`, sessions stay in memory locally, and on Lambda sign-in fails rather than issuing sessions valid on one instance only.

## Errors and logging

Every unexpected error returns `500 INTERNAL_ERROR` and writes one JSON line to stderr (CloudWatch on Lambda, where the runtime adds the timestamp and request ID): `level`, `msg`, `method`, `path`, `status`, and the error's name, message, and stack. The body, query string, headers, and cookies are never logged, since they can hold passwords, reset codes, and session tokens. Validation, auth, and other expected 4xx responses are not logged; a body over the 128 KB limit returns `413`.
