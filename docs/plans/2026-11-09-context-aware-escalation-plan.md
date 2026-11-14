# Implementation plan: rule-based context-aware escalation

**Spec:** [`accs-docs/deltas/2026-11-09-context-aware-escalation-engine.md`](../../../docs/deltas/2026-11-09-context-aware-escalation-engine.md)
**Decision:** [`accs-architecture/adr/0006-rule-based-context-aware-escalation.md`](../../../architecture/adr/0006-rule-based-context-aware-escalation.md)
**Status:** proposed, 2026-11-09. Start after the team approves the delta. Rows that need D-04 ship switched off.

## Goal

Replace the exact full-name check at `src/services.ts:702` with a deterministic engine that detects conflicts from the reporter's roster context, computes report similarity, and scores agreement on posts. No LLM, no external API, no new paid service.

## Where it lives

```
src/escalation/
  normalize.ts     text cleanup, Taglish stopwords, honorific token, tokenizer
  lexicon.ts       complaint, critical, scope, agreement word lists (versioned)
  aliases.ts       alias set per faculty member from the roster
  match.ts         exact multi-pattern + Jaro-Winkler fuzzy matching
  conflict.ts      proximity scoring, conflict score per mentioned person
  scope.ts         scope and severity hint
  route.ts         decision table, returns office + reason + trace
  similarity.ts    TF-IDF, cosine, group assignment
  agreement.ts     support/dissent from comments and reactions
  index.ts         analyzeReport(), analyzePost(), assignToGroup()
tests/escalation/
  *.test.ts
tests/fixtures/escalation/
  reports.jsonl    labeled Taglish set (text, reporter roster, expected conflict, scope, route)
```

Pure functions with no I/O, so tests run without DynamoDB.

**Dependency choice:** write Jaro-Winkler, TF-IDF and cosine by hand (about 80 lines together) rather than adding `natural`, which pulls in a large bundle for the Lambda. Re-check if the hand-written code grows past that.

## Phases

### Phase 1: normalize, lexicons, aliases (no behavior change)

- `normalize.ts`: lowercase, strip punctuation and emoji, collapse letters repeated 3+ times (`grabeee` → `grabee`), map `sir|ma'am|maam|mam|miss|prof|professor|propesor` to `<HON>`, split tokens, drop stopwords (English and Filipino list in `lexicon.ts`).
- `lexicon.ts`: export `LEXICON_VERSION` and the lists. Seed lists, for the team to extend:
  - complaint: absent, late, hindi pumapasok, di nagtuturo, unfair, bias, favoritism, sinigawan, minura, bastos, pinahiya, threat, hindi nagre-reply, walang feedback, bagsak lahat
  - critical: harass, hinipuan, sexual, threat to kill, sinaktan, suicide, papatayin, stalking
  - scope: individual (ako, ko, akin), section (kami, namin, buong section, lahat kami, klase namin), program (buong IT, lahat ng BSIT, buong program), college (buong CCS, lahat ng CCS, buong college)
  - agreement: totoo, true, same, agree, relate, +1, legit, ganyan din; dissent: hindi totoo, mali, disagree, fake, hindi naman
- `aliases.ts`: `buildAliases(reporter, db)` returns `{ facultyId, role, aliases[] }[]` for the adviser (`reporter.adviserId`), subject professors (owners of the reporter's class spaces in `reporter.spaceIds`), the chair of `reporter.program`, and the Dean. Aliases: full name, surname, first name, initials, `<HON> + each`, joined surname, optional faculty-defined nicknames, role phrases for the adviser, and `prof sa <subject code|subject name>` for subject professors.
- Tests: normalization cases, alias generation for a seeded professor.

### Phase 2: matching and conflict score

- `match.ts`: token-trie exact matcher over alias token sequences; Jaro-Winkler for single tokens of length ≥ 4 with score ≥ 0.85. Return `{ facultyId, alias, score, tokenIndex }[]`.
- `conflict.ts`: for each mention, distance in tokens to the nearest complaint term. `conflict = match × proximity × role` (weights in the delta §4). Keep the best score per faculty member.
- Tests: exact, surname only, typo (`delacrus`), honorific (`sir jdc`), role phrase (`adviser namin`), helper mention that must not bypass.

### Phase 3: routing (behavior change)

- `scope.ts`: scope from the scope lexicon (largest match wins); severity hint `critical` if any critical term matches.
- `route.ts`: the decision table in delta §5. Input: student's `aboutAdvisor`, conflict scores, scope, severity hint, settings flags (`d04HigherBypass`, `criticalToGuidance`, both false by default). Output: `{ stage, bypassed, possibleConflict, reason, trace }`.
- Wire into `createReport` at `src/services.ts:695-736`:
  - replace line 702 with `const decision = analyzeReport(p, user, db, settings)`.
  - `stage`, `bypassed`, `aboutAdvisor`, `involvedUserIds` come from `decision`.
  - add `routing: decision.trace` to `Report` (type in `src/store.ts:19`, schema if validated). Fields: engine version, lexicon version, matched alias, matched term, scores, rule.
  - history entry reason stays handler-facing; student-facing text keeps "Your report was sent to the office handling it."
- Keep the student's `aboutAdvisor` answer as a forced bypass.
- Show `routing` on P22 next to the existing `ConflictNotice` (frontend change; small).
- Tests: extend `tests/concern.test.ts` with the delta success criteria 4 and 5; existing tests must still pass.

### Phase 4: similarity groups

- `similarity.ts`: build TF-IDF over normalized tokens of open reports in the same program; cosine against each group centroid; join when ≥ `settings.similarityThreshold` (default 0.80); else open a hidden candidate group. Top shared terms become `phrases`.
- Call `assignToGroup` after a report is created. Update `clusters` (`ccs_grievance` via `src/persist.ts:12`).
- Replace `data.threshold=80` at `src/services.ts:372` with the settings value; compute `similarity` per group instead of the seeded number.
- Keep the seeded cluster only in dev seed data.
- Tests: two near-duplicate reports form a group with the right percentage; an unrelated one does not.

### Phase 5: agreement and post prompt

- `agreement.ts`: per comment, support/dissent/neutral from the agreement lexicon; total = Agree reactions + supporting comments.
- `analyzePost`: on posts with label `rant` or `complaint`, complaint score from phases 1–2; show the P06 prompt when score passes and agreement ≥ `min(settings.agreeUsers, settings.agreePercent × sectionSize)`.
- Group P24 supporting/dissenting lists use the same function on the reports in the group.
- Tests: prompt appears at the threshold and not below; only the author sees it.

### Phase 6: evaluation set and report

- Write at least 150 labeled synthetic Taglish reports in `tests/fixtures/escalation/reports.jsonl` (team writes them; no real student data).
- `tests/escalation/evaluation.test.ts` computes conflict precision and recall, routing accuracy and group F1, and fails below the delta targets.
- Export the metrics table for the paper's evaluation chapter (ISO/IEC 25010 functional suitability).

## Settings added

| Key | Default | Decision |
|---|---|---|
| `similarityThreshold` | 0.80 | D-07 |
| `agreeUsers` | 10 | D-07 |
| `agreePercent` | 0.30 | D-07 |
| `conflictBypass` | 0.60 | new |
| `conflictTriage` | 0.30 | new |
| `d04HigherBypass` | false | D-04 |
| `criticalToGuidance` | false | D-04 |

## Verification per phase

```sh
cd /home/batdimoiprint/Development/CAPSTONE/accs-system/backend
pcore npm run typecheck
pcore npm test
```

Phase 3 onward also: file the success-criteria reports through the dev portal as a student and check the first office and the P22 trace.

## Docs to update after build

- Fold the delta into `accs-docs/sitemap.md` (§1.2 Conflict rule, §5 stages, §9 D-04/D-07) and `pages/06-reports.md`, `pages/07-cases.md`, `pages/03-community.md`.
- Set ADR 0006 to Accepted.
- Paper: `accs-docs/context-aware-escalation-paper.md` into the methodology chapter.

## Risks

- Lexicon coverage of Taglish slang decides accuracy. Plan a lexicon review with Program Chairs and Guidance.
- Common first names (for example two professors named "Mark") can cause false mentions; the alias set is limited to the reporter's own faculty to keep this small.
- TF-IDF misses paraphrases with no shared words. Accept for this study; note as a limitation.
