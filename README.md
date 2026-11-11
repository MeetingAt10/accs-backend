# Backend

Node + Express 5 + TypeScript. Zod-validated env, helmet, cors. Tests with Vitest + Supertest.

```
cp .env.example .env
npm install
npm run dev          # http://localhost:3000, GET /api/health
npm test
npm run typecheck
npm run build && npm start
npm run build:lambda # bundles src/lambda.ts to dist-lambda/index.cjs
```

Node 22 or later. Environment variables are parsed in `src/env.ts`:

- `PORT` (default 3000) and `NODE_ENV` (`development`, `test`, `production`; default `development`).
- `CORS_ORIGIN`: comma-separated allowed browser origins (default `http://localhost:5173`). All modules are served from the one portal host, and the portal calls this API with credentials, so list only the portal origin in deployed environments.
- `TABLE_PREFIX`: DynamoDB table prefix. Set on the Lambda; see Storage boundary and Sessions.
- `AUTH_STORE_BUCKET`, `AUTH_STORE_KEY`, `AUTH_STORE_FILE`: where accounts live; see Accounts and sign-in.
- `MAIL_FROM`: verified Amazon SES sender of password reset emails and new-concern emails; see Password reset codes and New-concern emails.
- `APP_URL`: address of the portal, for links in emails (default: the first `CORS_ORIGIN`).
- `SEED_PASSWORD` (at least 10 characters): the shared sign-in password of the seeded demo accounts. Deployed stacks set it. Without it, production disables seeded sign-in, and local runs and tests use a built-in default. On Lambda with any other `NODE_ENV` (including an unset one, which defaults to `development`), the API fails at startup rather than accept the built-in password. It is not in `.env.example`.

CI (`.github/workflows/ci.yml`) runs `typecheck`, `test`, and `build:lambda` on pull requests. A push to `main` or `dev` (`deploy.yml`) runs the same checks, then uploads `dist-lambda/index.cjs` as the code of the API Lambda in the `accs-prod` (`main`) or `accs-dev` (`dev`) stack.

`tests/doc003-modules.test.ts` checks the DOC003 module inventory (`tests/fixtures/doc003-modules.json`, 58 modules): for each module, every owning role can sign in as its seeded account and reach at least one of the module's pages.

System concept not defined yet.

## Storage boundary

Routes and domain rules reach data only through `Repository` (`src/store.ts`). `view` runs read-only work: its changes are discarded and its result is detached. `transact` is all or nothing: if the work throws, nothing it changed is kept. The work itself stays synchronous, so a backend does its I/O before and after it, and one unit of work is never interleaved with another. `GET /api/pages/P34` uses `transact` because opening a student record writes an audit entry. Both take an optional list of stored collections the work touches; the lookups that run on every request (session, sign-in, account sync) name none, so a backend that loads on demand skips them.

Two implementations:

- `createMemoryRepository` (`src/store.ts`): all state in one process. Used in tests and local runs, so data is per instance and lost on restart.
- `createRecordRepository` (`src/persist.ts`): used on a deployed stack, when `TABLE_PREFIX` is set and `NODE_ENV` is not `test` (`createRepository` makes the choice; handing it a DynamoDB client, real or fake, overrides the test rule). It needs no new infrastructure: only `TABLE_PREFIX` and the item-level access the Lambda role already has (`Query`, `TransactWriteItems` as `PutItem`; no `Scan`).

### Shared state (record repository)

The seed is the base. Twenty-three collections are shared by every instance and survive a cold start; each lives in its domain table (accs-architecture ADR 0004):

| Collection | Table |
|---|---|
| `reports`, `clusters` | `ccs_grievance` |
| `consultations`, `slots`, `events`, `todos` | `ccs_scheduling` |
| `threads` | `ccs_messaging` |
| `notifications`, `settings` | `ccs_notification` |
| `posts` (with their comments and reactions) | `ccs_community` |
| `moderation` | `ccs_moderation` |
| `cycles`, `assignments`, `followUps` | `ccs_evaluation` |
| `restrictions`, `referrals`, `strikes`, `strikeSettlements`, `goodMoral` | `ccs_discipline` |
| `drafts`, `telemetry` | `ccs_assistant` |
| `permissionOverrides` | `ccs_identity` |
| `audit` | `ccs_audit` (add-only: entries are only ever put, never changed or deleted) |

One item per record: `PK = STATE#<collection>`, `SK` the record ID, `data` the record as JSON text, a numeric `version`, and `entity_type = STATE`. A stored record replaces the seeded record with the same ID; a record deleted from the seed (an availability slot) is kept as an item with `deleted` set, so it stays hidden. A seeded record that has been changed is stored whole, so later edits to its seed text do not reach it.

`drafts`, `settings`, and `permissionOverrides` are objects in the code; each key is stored as its own record. `goodMoral` has one record per student, with the student ID as `SK`. These are generic `STATE` items: the tables follow DOC006, but the items do not use its item types or attribute names.

- `view` queries each collection it needs (strongly consistent, every page of the result, in parallel), lays the records over the seed, and runs the work on that private copy.
- `transact` does the same, then writes only the records that changed, each conditioned on the version it read (`attribute_not_exists(PK)` for a new record), in one `TransactWriteItems` per 100 writes. If another instance changed a record first, the work runs again on fresh data, up to 3 times in all, and then the call fails with `409 CONFLICT`. A change of more than 100 records is split into several transactions; if a later one loses a race the work is not run again, since the earlier ones are already stored, and the call fails with `409`. Transactions on one instance take turns.
- The write check is per record: two instances changing the same record cannot both win (one slot, one consultation), but a unit of work that only reads a record and acts on it is not re-checked.
- Every `view` and action loads all 23 collections (one parallel query each) unless it names fewer. The session check on every authenticated request names only `restrictions`. Notifications, telemetry, and the audit trail grow without bound; they need a per-user key or a time window before the pilot gets large.
- A post is one record, so comments racing on the same post retry, and can reach the `409`. A cycle that generates more than 100 assignments is written in several transactions, so that change is not atomic.

Four collections stay on the seed, per instance: `users` (accounts come from the auth store below), `spaces` (only changed from the auth store), and `organizations` and `offenses` (no route writes them). `src/records.ts` holds the small `RecordStore` interface (`list`, `write`), its DynamoDB implementation, and an in-memory one the tests use to run two app instances over one store.

## Accounts and sign-in

| Endpoint | Body | Result |
|---|---|---|
| `POST /api/auth/sign-in` | `{ emailOrId, password, remember? }` | 200 + session cookie + session; 401 `INVALID_CREDENTIALS`; 429 `TOO_MANY_ATTEMPTS` after 5 failures in 15 minutes from one client (source IP) for one identifier, so failures elsewhere do not block the owner. The count is shared by every Lambda instance (see Attempt limits). `emailOrId` is the email, account ID, student ID, or username, in any case. A deactivated account gets the same 401 |
| `POST /api/auth/complete-first-login` | `{ currentPassword, username, password }` (signed in) | 200 + session; 400 `INVALID_CREDENTIALS` (wrong temporary password), 400 `VALIDATION_ERROR` (weak password, bad username, or either one unchanged), 409 `CONFLICT` (username taken, or already done); sets both, clears `mustChangeCredentials`, keeps this session, signs out the others |
| `POST /api/auth/forgot-password` | `{ emailOrId }` | Always 200, same answer for unknown accounts. Issues a 6-digit code and delivers it on the configured channel (see Password reset codes): emailed when `MAIL_FROM` is set, logged on local runs without it, and not issued in production without it. A failed email is logged and still answers the same 200. Within the 60-second cooldown or past 5 codes per hour it issues nothing and still answers the same 200 |
| `POST /api/auth/reset-password` | `{ emailOrId, code, password }` | 200 and signs out every session; 400 `INVALID_CODE` |
| `POST /api/admin/accounts/:id/reset-code` | `{}` (administrator) | 200 with `record.code`, shown once; audited as `Password reset code issued`; 403 for other roles |
| `POST /api/auth/change-password` | `{ currentPassword, password }` (signed in) | 200; 400 `INVALID_CREDENTIALS` |
| `POST /api/auth/sign-out` | `{}` | Clears the cookie |
| `GET /api/session` | | `{ user, permissions, allowedPages, roleLabels }`; `user` includes `username` and `mustChangeCredentials` |

Passwords are hashed with `crypto.scryptSync` and need 10+ characters with upper and lower case, a number, and a symbol. Usernames are 3 to 32 characters (`a-z`, `0-9`, `.`, `_`, `-`), stored in lower case, and unique across every sign-in identifier (IDs, emails, student IDs, usernames), so an identifier never reaches the wrong account. Accounts are not self-registered; they come from the secretary (see below).

**Forced change.** An account created by the secretary, and the secretary once the Dean activates it, has a temporary username and password and `mustChangeCredentials: true`. Until `complete-first-login` succeeds, every authenticated `/api` route except `GET /api/session` and `POST /api/auth/sign-out` answers `403` with code `CREDENTIALS_CHANGE_REQUIRED`.

**Where accounts live.** All account state is in the auth store (`src/auth.ts`): an S3 object when `AUTH_STORE_BUCKET` is set (Lambda; `AUTH_STORE_KEY`, default `auth-store.json`), otherwise a JSON file at `AUTH_STORE_FILE` (default `/tmp/accs-auth-store.json`). Tests use an in-memory store. It holds the accounts created after the seed, any change to a seeded account, the password hashes, and `advisorAssignments`. A stored account record replaces the seeded user with the same ID on every instance (role, program, `active`, username, adviser), so changes persist across instances and cold starts, including the profile text a person edits themselves (title, bio, education, office hours). Role and active changes made on the administrator's pages (`updateRoles`) are saved there too. Writes carry the object's ETag; a write that loses the race reloads and runs its change again, up to 5 attempts, and then the call fails with `409 CONFLICT` ("Someone else changed this at the same time. Try again."), saving nothing. Each request reads the store once (cached for 2 seconds, then a conditional GET); requests that arrive while that GET is under way share it, and a GET that started before this instance's own write is dropped so it cannot replace the newer copy. The repository is touched only when the stored data changed.

Seeded demo accounts (`QCU-STU-IT-A`, `QCU-ADMIN`, ...) sign in with their ID or email and the shared `SEED_PASSWORD` until they set a password; rotate or disable this shared password before real users join. The seeded secretary, `QCU-SECRETARY`, is inactive and never accepts the shared password: it signs in only with credentials the Dean issued.

## Account provisioning

The Dean activates the secretary, and the secretary creates and manages every other account. Routes are under `/api/accounts`, need a session, check permission (`account.activateSecretary` for the Dean, `account.provision` for the secretary) and validate with zod. Failures use the usual `{ error, code, fields? }` body: `401 UNAUTHENTICATED`, `403 FORBIDDEN` (wrong role), `403 CREDENTIALS_CHANGE_REQUIRED`, `400 VALIDATION_ERROR`, `404 UNAVAILABLE`, `409 CONFLICT`. Successful changes answer `{ ok: true, message, record }`.

An `AccountSummary` is `{ id, name, email, roles, program?, section?, year?, studentId?, adviserId?, active, mustChangeCredentials? }`. Credentials are `{ username, temporaryPassword }`, returned in the response that creates them and never again: only the hash is stored, and neither the audit trail nor the logs hold them. A temporary password is 14 characters and starts with a letter or digit, never `=`, `+`, `-`, or `@`, because the secretary downloads credentials as CSV and a spreadsheet reads a cell that starts with one of those as a formula.

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

## Concern flow

A student files a concern (a *report* until it reaches Guidance) and chooses how to talk about it. It is the report and page-action system (`POST /api/pages/:pageId/actions`), not a second API, and it lives in the persisted `reports`, `consultations`, `slots`, `notifications`, and `audit` collections. Notices are in-app only; there is no email channel yet.

| Action (page) | Payload | Who |
|---|---|---|
| `createReport` (P19) | the statement fields, plus `consent: { readStatement: true }` and `aboutAdvisor` (both required). `allowChair` and `allowDean` are still accepted from older clients and ignored | Student |
| `chooseTalkMode` (P19, P20) | `{ reportId, mode: 'chat' \| 'video' \| 'voice' \| 'face_to_face', consent: { participate: true, recordCall? }, slotId?, preferredAt? }` | The student who filed it |
| `setTalkDetails` (P22) | `{ reportId, scheduledAt?, meetingLink?, place? }`, at least one | The office handling the concern now |
| `sendReportMessage` (P20, P22) | `{ body }`, with the report as `recordId` | The student and the office handling it, only while the chosen way is `chat` |

`scheduledAt` and `preferredAt` are ISO 8601 dates with a time, with or without a time zone (`2026-11-06T10:00`, `2026-11-06T02:00:00Z`).

**Categories.** A concern has a `category` and a `subcategory` from the fixed list in `src/categories.ts` (Bullying, Cyberbullying, Harassment, Discrimination, Threat or violence, Faculty or staff conduct, Academic concern, Personal or emotional concern, Facilities, and "Other (please specify)", which takes a short `categoryDetail` instead of a sub-category). A missing or unknown choice is a 400 `VALIDATION_ERROR` naming the field. P19 returns the tree as `categoryOptions` for the dropdowns, each with `studentOnStudent`. Until the filing screen switches, P19 also keeps `categories` (the old four), which are still accepted without a sub-category.

**Agreement.** A missing or false `consent.readStatement`, or a missing `aboutAdvisor`, is a 400 `VALIDATION_ERROR`; nothing is stored, sent, or recorded. The server stamps the report with `consent: { readStatement: true, at, userId, version, wording }`. `wording` is the exact text from the one exported constant `consentWording` (`src/consent.ts`), which also holds the wording of each way to talk; changing any sentence changes its `version`. P19 and P20 return the constant as `data.consentWording`, so the app shows the text the server stores. Filing writes two `reports` audit entries (`Report submitted`, `Report consent recorded`) with the report as reference; no audit entry holds the statement or the wording.

**Who can read it.** The student owns it. The adviser (the `professor` account set as the student's `adviserId`) handles it at the first stage unless `aboutAdvisor` is true. The Program Chair of the student's program and the Dean **oversee** every concern in scope without the student's permission (baseline of 10 November 2026): they read it at every stage (`readOnly: true`, no actions) and act on it at their own stage. If the adviser marks it **confidential** (`setConfidential` on P22, adviser only, while it is at the adviser stage, with a reason; audited and recorded in the history), the chair and the Dean see its status only (`statusOnly: true`: status, office, dates and a timeline, never the statement, reporter, messages or notes), and it cannot be escalated until the mark is removed. A concern about the adviser cannot be marked confidential. A reader who is not the current handler sees an anonymous reporter's name only if the student shared it with that reader's office. Guidance and OSAS read it once a case reaches them. An office the case has moved past (the adviser after escalating, Guidance after forwarding to OSAS) keeps a status view (`statusOnly: true`: status, office, dates and the timeline of public actions, never the statement, reporter, messages or notes), sees the case in its queue, and is notified of every later case action except its own; a person named in the concern never is. Analytics count every concern the chair or Dean oversees, confidential or not. The `allowChair` / `allowDean` answers of older reports are ignored.

**About the adviser.** With `aboutAdvisor: true` the concern starts at the chair stage with the Program Chair of the student's program. The adviser is not told, cannot read it, and is not counted; the same holds when the existing conflict check sends a concern around the adviser (the adviser is named in the statement or in `involvedUserIds`, or `conflictedAdviser` is true), and then `aboutAdvisor` is stored as true. A student without an active adviser gets a 409 when filing unless `aboutAdvisor` is true. If no Program Chair other than the adviser can receive it, filing is a 409 and nothing is stored.

**How to talk.** `chooseTalkMode` stores `talk: { mode, consents, slotId?, consultationId?, preferredAt?, scheduledAt?, meetingLink?, place?, updatedAt }` on the report and notifies the office. Every call appends a consent record `{ mode, participate, recordCall?, wording, at }` and keeps the earlier ones, so a student can change the way and each change is recorded. `recordCall` applies to `video` and `voice` only (default false; `true` for another way is a 400). With `slotId`, one of the open times of an office handling the concern is reserved through the same rule as a consultation request (409 `That time was just taken. Pick another time.`), as a consultation with `reportId` and the purpose `Talk about a concern`; a student can hold one live request per concern, and an anonymous student shares their name with the office first (409), because the booking shows the office who asked. Choosing another way clears the time, link, and place the office had set. `setTalkDetails` adds them for the chosen way: `meetingLink` only for `video` and `voice` and only `https` (400 otherwise), `place` only for `face_to_face`; both are 409 for another way, and the student is notified.

**Messages.** `sendReportMessage` is a 409 unless `talk.mode` is `chat`, for the student and for the office alike. The conversation is read by polling P20 and P22. Each message is audited as `Reporter message sent` or `Handler message sent` without its text. A message and a change of details notify the other side. The student's views show who answered (`office`, and each message's `author.roles`) and never the internal notes.

**What the views return.** The student's views (P18, P20) and the office's (P21 rows, P22) carry `consent` (`{ readStatement, at, version, wording }`; the account behind it is never returned), `allowChair` and `allowDean` (always `true`: the chair and the Dean can read it), `confidential`, `aboutAdvisor`, and `talk`; the office's view also has `readOnly`. A P21 row also has `reporter` (the name, or the alias), `category`, `createdAt`, and `updatedAt`. There is no unread mark per report; an unread notice for the report on P40 (`recordId`, `read`) is the signal.

**Stages.** A case moves in a fixed order: Adviser, Program Chair, Dean, Guidance, OSAS. The adviser and the chair escalate; the Dean forwards to Guidance; Guidance opens a Case File and then forwards to OSAS. OSAS is the last stage: it can respond, record actions, add milestones, resolve and close, but not forward. Any stage can resolve a case, and a resolved case can be closed. The President's Office stage and role were removed on 2026-11-10; a report stored with stage `executive` is read as being with OSAS, and a stored account's `president` role is dropped (an account left with no role cannot sign in).

### New-concern emails
When a student files a concern, each office receiving it (the adviser, or the Program Chair for a concern that goes around the adviser) also gets an email, besides the in-app notification (#37). The email says only that a new concern was sent to them and links to the case (`<APP_URL>/cases/<report id>`). It never carries the statement, category, severity, the reporter's name or alias, or anything else from the concern. An adviser the concern names or goes around is never emailed, since they are never a receiving office. The email goes out only after the concern is saved, and only on filing, not on later case steps.

- **`MAIL_FROM` set:** Amazon SES sends a plain-text email (subject "New concern in ACCS"). Seeded demo accounts are never emailed, for the same reason as reset codes. If SES fails, the concern stays filed and one JSON line goes to stderr (`level`, `message`, `userId`, `reportId`, and the error name, never the address).
- **No `MAIL_FROM`, not production:** a line is logged instead (`[accs] new concern email for <id> not sent ...`).
- **No `MAIL_FROM`, production:** nothing is sent; the in-app notification still is.

The deployed stacks do not set `MAIL_FROM` yet. Sending needs a verified SES identity, the `MAIL_FROM` variable on the Lambda, and `ses:SendEmail` on that identity in `accs-architecture`.

## Appointments

"Consultations" are called **appointments** in everything users see (decided 11 November 2026); the API keeps its names (`createConsultation`, `decideConsultation`, the `consultations` collection, the `consultation` notification kind) so clients keep working. A booking says what it is for with a `category` and `subcategory` from `src/appointments.ts` (Academic advising, Class or subject, Thesis or capstone, Career or internship, Documents and signatures, Personal concern, and "Other (please specify)", which needs `details`); `details` is an optional note otherwise. A missing or unknown choice is a 400 `VALIDATION_ERROR` naming the field. P14 and P15 return the list as `appointmentCategories`. A time booked from a concern is filed under "Concern follow-up / Talk about a concern", which cannot be picked by hand. The current screen's free `purpose` is still accepted until it switches to the dropdowns; `purpose` is always set (the sub-category, or the description for Other) so lists keep showing it.

## Evaluation forms
Evaluation cycles use the **student form only** (#47): each student evaluates every professor of their class spaces (relation `Student to faculty`). `createCycle` and `saveCycle` set `forms: ['student']`; `saveCycle` may leave `forms` out, and any other form (`peer`, `upward-chair`, `upward-dean`) is a 400. Cycles stored with old forms still load, and their submitted answers stay in the results. An old form that was never submitted is no longer listed on P26, and submitting it is a 409.

## Evaluation completion
Evaluation is required for clearance (#33). For each published or closed cycle, each student has a completion status from their student-form evaluations: `submitted` (Finished, all submitted), `pending` (Not finished, the cycle is still open), `missing` (the cycle closed first) or `none` (Nothing to evaluate). The current cycle is the latest published or closed one.

- **P26** gives a student `completion`: one entry per cycle, newest first (`{ cycleId, cycleTitle, cycleStatus, closes, status, label, submitted, total }`).
- **P53 Clearance** (`clearance.view`: Secretary, Program Chair, Dean, OSAS) lists active students with their status in one cycle. Query: `cycle` (default the current one; a draft or a cycle in review is a 404), `program`, `year`, `section`, `q` (name or student ID) and `status` (comma-separated, for example `pending,missing`). It returns `students`, `cycles`, `cycle`, a `summary` count per status (before the status filter) and `filters`. The Secretary, the Dean and OSAS see the whole college; the Program Chair sees their own program only.

## Strikes and the clearance hold

A strike needs both the **Dean** and **OSAS** (decided 11 November 2026). While a case is with the Dean, the Dean recommends a strike against a student the concern names (`recommendStrike` on P22 or P34: `{ studentId, reportId, note }`). The student who filed the concern can never receive a strike, and a case holds one strike per student (409; a rejected one does not count). When the case reaches OSAS, OSAS confirms or rejects it (`decideStrike` on P22 or P34: `{ strikeId, decision: 'confirm' | 'reject', note }`; rejecting needs a reason). Only a confirmed strike counts; strikes stored before this rule have no `status` and count as confirmed. No-show strikes and the old `recordStrike` action are gone. P22 shows the case's `strikes` with `canRecommendStrike` (Dean) and `canDecideStrike` (OSAS). At **three** unsettled confirmed strikes the student's clearance is on hold. OSAS records the settlement (`settleStrikes`: `{ studentId, kind: 'letter' | 'reprimand', reference, note }`), which lifts the hold; the strikes stay on the record, and later strikes start a new count. Settling without a hold is a 409. P34 shows `strikes` (each with `status`, `recommendedBy`, `recordedBy`), `strikeSettlements` and `clearance` (`{ onHold, unsettledStrikes, totalStrikes, limit }`) to the offices that may open the record; Guidance and OSAS may also open the records of students named in their cases. Every recommendation, decision, hold and settlement is audited.

**Renamed accounts.** The Dean's account is `CCS-DEAN` (it was `QCU-DEAN` until 11 November 2026; email `dean@qcu.edu.ph`). `src/renames.ts` maps old IDs to new ones: stored records, account records, passwords and sessions saved under the old ID are read under the new one (a record stored under both keeps the new one), the old ID still signs in, and nobody can take it as a username.

## Password reset codes

Codes live in `ccs_identity` as the `RESET` item `USER#<id>` / `RESET` (hash only, TTL on `expires_epoch`), so limits hold on every Lambda instance: 5 guesses per code (counted before the check, so parallel guesses cannot exceed it), 15-minute expiry, single use, 60-second cooldown, and 5 self-service codes per account per hour (a new code keeps the count). An administrator-issued code skips the cooldown and the cap. Delivery goes through a `ResetCodeMailer` (`src/mail.ts`), chosen at startup:

- **`MAIL_FROM` set:** Amazon SES sends a plain-text email from that address to the account's email. The code is never logged. If SES refuses or fails, one JSON line goes to stderr (`level`, `message`, `userId`, and the error name, never the code or the address) and the caller gets the usual answer. Seeded demo accounts are never emailed, because their made-up addresses are on the real `qcu.edu.ph` domain and a code could reach whoever owns that mailbox; forgot-password for one issues nothing and answers the same, and an administrator issues their codes. The Lambda needs `ses:SendEmail` on the `MAIL_FROM` identity, and while the SES account is in the sandbox it can only send to verified addresses.
- **No `MAIL_FROM`, not production:** the code is logged (`[accs] password reset code for <id>: <code>`), for local runs and tests.
- **No `MAIL_FROM`, production:** no code is issued; the CCS office gets one from an administrator and hands it to the account holder. The limits were approved under DOC003 D-08 on 2026-11-10.

## Attempt limits

Sign-in (per source IP and identifier), password reset (per identifier), first sign-in, and password change (per account) allow 5 failures in 15 minutes, then answer 429 `TOO_MANY_ATTEMPTS`. Counters live in `ccs_identity` as the `THROTTLE` item `THROTTLE#<sha256 of the key>` / `THROTTLE` (`src/throttle.ts`), so the limit holds across Lambda instances and the table stores no typed identifiers or IP addresses. An attempt is counted before the password or code is checked, so parallel requests cannot exceed the limit, and a success clears the count. TTL on `expires_epoch` removes a counter after its window; because TTL deletes late, the code checks the window itself. Without `TABLE_PREFIX`, counters stay in memory locally, and on Lambda these routes fail rather than enforce a limit per instance. `THROTTLE` is not yet in DOC006 or ADR 0004.

## Sessions

Sign-in creates a server-side session. The `accs_session` cookie holds an opaque random token; the `ccs_identity` table (`<TABLE_PREFIX>ccs_identity`, a DOC006 `SESSION` item keyed `SESSION#<sha256 of token>`) stores only its hash, so a leaked table cannot be replayed. Every request reads the session and the account, so sign-out, a role change, and deactivation apply at once. Sessions end after 30 minutes idle or 12 hours (remember me: 7 days idle, 30 days); these were approved under DOC003 D-08 on 2026-11-10. Changing a password signs out other devices; a password reset signs out all of them. Without `TABLE_PREFIX`, sessions stay in memory locally, and on Lambda sign-in fails rather than issuing sessions valid on one instance only.

## Dev toolbox

Testers on the development stack change to another account without signing out. The session cookie is `httpOnly`, so the API does the swap. The code is `src/dev.ts`.

| Route | Result |
|---|---|
| `GET /api/dev/users` | `{ users: [{ id, name, roles, active, username? }] }`, by name: every account, the inactive ones and the ones from the auth store included. No email, student ID, or hash |
| `POST /api/dev/switch-user` `{ userId }` | Ends the caller's session, starts one for the target, and answers with the body sign-in answers with (`user`, `permissions`, `allowedPages`, `roleLabels`) and the new cookie. 409 `CONFLICT` for an account that is not active, 404 for one that does not exist, 400 for a bad body |

The routes are mounted only when `TABLE_PREFIX` starts with `accs-dev-`, or, with no prefix, when `NODE_ENV` is not `production`. On any other deployed stack, and in production without a prefix, they do not exist: a signed-in caller gets 404 `NOT_FOUND`, and a caller who is not signed in gets 401, as for any unknown API path. A prefix that is not `accs-dev-` never mounts them, whatever `NODE_ENV` is. The caller must be signed in, and the hold on an account that still has temporary sign-in details does not apply to these two calls, so a tester can leave such an account. Each switch adds one `identity` audit entry (`Account switched`, with the actor and the target) before the session changes; a switch that cannot be recorded does not happen. Anyone signed in on the development stack can become any active account, the Dean included, so keep real student data off that stack.

## Errors and logging

Every unexpected error returns `500 INTERNAL_ERROR` and writes one JSON line to stderr (CloudWatch on Lambda, where the runtime adds the timestamp and request ID): `level`, `msg`, `method`, `path`, `status`, and the error's name, message, and stack. The body, query string, headers, and cookies are never logged, since they can hold passwords, reset codes, and session tokens. Validation, auth, and other expected 4xx responses are not logged; a body over the 128 KB limit returns `413`.
