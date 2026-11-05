# Persist domain data across Lambda instances

Issue: [MeetingAt10/accs-backend#1](https://github.com/MeetingAt10/accs-backend/issues/1)
Date: 2026-11-05
Status: awaiting review
Branch: `feat/1-persist-domain-data`, from `main`; the PR targets `dev`

## Problem

`createRecordRepository` (`src/persist.ts`) keeps six collections in DynamoDB. Everything else lives in a seed object per Lambda instance, so a change is lost on a cold start and other instances never see it.

Where the issue's acceptance criteria stand today:

| Criterion | Status |
|---|---|
| Posts, reports, messages, schedules, and audit entries are stored in shared storage | Posts are missing; the other four are done |
| Data written on one instance is visible on another and survives a cold start | Done for the six stored collections only |
| Role grants (P46/P47) persist across restarts | `updateRoles` saves to the auth store (`src/services.ts:628`); this work adds a test that proves it across a restart |
| Required tables are in the CloudFormation template | No change needed: all twelve tables exist and the Lambda role reaches them |

## Scope

Decision: persist every collection that a route can change, not only the ones the issue lists. Restrictions, referrals, evaluation cycles, and the rest are lost the same way as posts.

This work adds 15 collections and moves profile text to the auth store.

These stay per instance, because no route writes them, or they are rebuilt from another store:

- `users`: comes from the auth store.
- `spaces`: only `applyAccounts` changes it, from the auth store.
- `organizations`, `offenses`: read-only in the code today.

Out of scope:

- Real DOC006 item types (see Approach).
- Moving accounts from the auth store to `ccs_identity` (ADR 0004 keeps the bucket until then).
- Bounding the growth of `audit`, `notifications`, and `telemetry`.
- The per-instance throttle counters (issue #4).

## Approach

Extend `createRecordRepository` with the new collections, stored as the existing generic items: `PK = STATE#<collection>`, `SK` the record key, `data` the record as JSON, a numeric `version`.

Tables follow DOC006 (`DOC006_DATA-DICTIONARY.new.docx`, with tracked changes accepted). **Item shapes do not.** Items do not use DOC006 item types or attribute names, and comments and reactions stay inside their post rather than being `COMMENT` and `REACTION` items. The six stored collections already work this way; this is a deliberate deviation.

Rejected:

- **A hand-kept list of collections for every page and action.** Fewer queries, but about 100 entries to maintain, and a missed entry is a 500. Not worth it until latency is measured (see Rollout).
- **Real DOC006 item types and indexes.** Matches the dictionary, but means rewriting most of `src/services.ts`, far beyond this issue.

## Table mapping

| Collection | Table | DOC006 item type |
|---|---|---|
| `posts` | `ccs_community` | `POST` (with `COMMENT` and `REACTION` inside it) |
| `moderation` | `ccs_moderation` | `FLAG`, `CREPORT`, `MODDECISION` |
| `events` | `ccs_scheduling` | `CALEVENT` |
| `todos` | `ccs_scheduling` | `TASK` |
| `cycles` | `ccs_evaluation` | `CYCLE` |
| `assignments` | `ccs_evaluation` | `EVALASSIGN` |
| `followUps` | `ccs_evaluation` | none; closest domain |
| `restrictions` | `ccs_discipline` | `RESTRICTION` |
| `referrals` | `ccs_discipline` | none; closest domain |
| `goodMoral` | `ccs_discipline` | `GMREQUEST` |
| `clusters` | `ccs_grievance` | `SIMGROUP` |
| `drafts` | `ccs_assistant` | `DRAFT` (report drafts; these hold concern narratives, so they must stay out of the forum table) |
| `telemetry` | `ccs_assistant` | none; `USAGE` in `ccs_audit` is a daily rollup, this is one row per assistant call |
| `settings` | `ccs_notification` | `PREFERENCE` for `priorities`; `theme` and `density` have no type. DOC006 `SETTING` is platform config, not per user |
| `permissionOverrides` | `ccs_identity` | `ROLEPERM` |

Only `audit` stays add-only. `ccs_audit` gets no new collection.

## Code changes

### 1. Record shapes (`src/persist.ts`, `src/store.ts`)

`persist.ts` assumes every record is a row with an `id`. Five collections are not:

| Collection | Shape | Change |
|---|---|---|
| `drafts`, `settings` | Object keyed by user ID | Stored per key; the key is the `SK` |
| `permissionOverrides` | Object of `role:permission` to boolean | Stored per key, with the value wrapped so it can hold a boolean |
| `goodMoral` | Rows with no `id`, one per student | The `SK` is `studentId` |
| `telemetry`, `followUps` | Rows with no `id` | Rows gain `id` from `nextId`. Their seeds are empty, so there is no old data to convert |

The working copy that domain rules see keeps today's shapes, so `db.drafts[user.id]` and `db.goodMoral.find(...)` do not change. Conversion happens only when loading and writing.

### 2. The per-request read of restrictions (`src/app.ts:38`, `src/app.ts:65`)

`refreshRestrictions` reads `db.restrictions` during the session check and session response, which today name no collections (`[]`). Once `restrictions` is stored, that read throws. Both calls name `['restrictions']`. This adds one query per authenticated request.

Every other `[]` call site reads only `users` and `spaces`, which stay per instance.

### 3. Profile text (`src/services.ts`, `src/accounts.ts`)

`saveProfile` changes `title`, `bio`, `education`, and `officeHours` on the per-instance user.

- `performAction` also saves the change to the auth store after the transaction, the same way `updateRoles` does.
- `applyAccounts` takes these four fields from the stored account, and falls back to the instance's copy when a stored account has none.

A failed auth-store write answers 500 with the instance's copy already changed. `updateRoles` behaves the same way today.

### 4. Documentation

`README.md` ("Shared state", "Where accounts live") and the comments in `src/store.ts` and `src/persist.ts` that say these collections are per instance.

## Data flow

Unchanged: `view` and `transact` load, run the work on a private copy, and `transact` writes the changed records, each conditioned on the version it read.

What grows: a page view or action with no collection list goes from 6 to 21 parallel queries, plus the one restrictions query in the session check.

Checked against the code, and safe:

- **Order.** Stored records load in ID order after seeded ones. Writes append, and IDs are time-sorted, so order matches today's. The only positional read is `db.telemetry.length`.
- **IDs.** All new IDs come from `nextId` (ULID), so instances cannot collide.
- **Module state.** `services.ts`, `accounts.ts`, and `access.ts` hold no module-level mutable state that would bypass the repository.

## Failure behaviour

These follow the existing rules, documented rather than changed:

- **Version race:** the work runs again on fresh data, up to 3 times in all, then `409 CONFLICT`.
- **Comments on one post:** a post is one record, so comments racing on it retry, and can reach that 409.
- **Over 100 changed records:** split into several transactions, so the change is not atomic. A large `createCycle` can reach this; it adds one `assignments` row per evaluator pair. If a later transaction loses a race, the call answers 409 with the earlier ones stored.
- **Unbounded growth:** every page view loads `telemetry`, `audit`, and `notifications` whole. The existing ponytail comment in `persist.ts` gains `telemetry`.

## Rollout

- **Infrastructure:** none. `TABLE_PREFIX` and the Lambda role already cover the eleven business tables. This is read from the template on `accs-architecture` `main`, not from the deployed stack.
- **Data:** no backfill. Per-instance changes were never durable, and the seed stays the base.
- **Rollback:** older code ignores the new `STATE#` items.
- **After deploying to dev:** confirm a write survives a cold start, and check page-view latency. If a page view takes over 1 second, per-page collection lists become worth doing, as a follow-up.

## Testing

Baseline on `main`: 966 tests passing.

In `tests/persistence.test.ts`, over the in-memory `RecordStore`:

1. For each new collection, driven through the HTTP routes where a route exists: write on one instance, read it on a second, and read it on a cold third.
2. Each collection lands in the table from the mapping above.
3. Shape round trips: the three keyed objects (including a `false` override), `goodMoral` replacing a student's row, and `id` on `telemetry` and `followUps`.
4. P46/P47 role grants and `saveProfile` text survive a new app instance over the same auth store.
5. A session check runs exactly one store query, on `restrictions`.
6. A restriction applied on one instance takes effect on an existing session on another.
7. Every page and every action runs against the record repository, so an unloaded read fails the test rather than production.

The existing test that uses `todos` as per-instance data moves to a collection that stays per instance.

Mutants, each of which must turn a named test red:

- Drop a collection from `persisted`.
- Map `drafts` to `ccs_community`.
- Name `[]` again in the session check.
- Stop `applyAccounts` taking stored profile text.
- Treat a `false` override as absent.

Then the full suite, reading the `Tests N passed` line and the exit code.

## Closing the issue

The PR body lists each acceptance criterion and states that no CloudFormation change was needed, so the fourth criterion is answered rather than silently skipped.
