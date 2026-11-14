# Plan: self-hosted decision model as a shadow second opinion

- Status: Planned, not started
- Date: 2026-11-11
- Related: ADR 0006 (rule-based escalation, no LLM), [escalation PoC](../escalation-poc/README.md)

## Why

The rule engine reached conflict recall 0.85 on the 44-case set; the delta targets 0.95. The misses are a pronoun reference, a nickname, a name six words from the complaint, and a classmate with a faculty surname.
"System One" decision models take text plus a fixed set of answers and return one answer with a confidence score. They generate no text, so they cannot invent a person. Open-weight ones can run inside our own AWS account, so report text never leaves it.

This plan checks whether such a model adds recall without weakening privacy or explainability. The rules stay the decision-maker throughout.

## Constraints that do not change

- The rule engine decides the route and writes the trace (matched alias, term, score, rule) that handlers see. The model never replaces that trace.
- Report text stays in our AWS account (Singapore region, private subnet, no internet egress). No hosted model API, including TypeSafe Jev.
- The model may only escalate: it can raise a report to the Program Chair. It can never send one back to the adviser or unlock a person the rules kept out.
- The proposal keeps NLP models as future work (line 145) and rules out autonomous decisions (line 109). Phases 3 and later need adviser and panel approval and a new ADR (0007) that amends ADR 0006. Phases 0 to 2 are offline or log-only and change no routing.

## Candidates

| Model | Size | License | Hardware | Notes |
|---|---|---|---|---|
| Laya multilingual | 322M | Apache-2.0 | CPU | First choice. Ships `laya-serve` (`POST /v1/systemone`). Base checkpoint near random; must be fine-tuned |
| Kev 0.8B | 0.8B | Apache-2.0 | CPU (slow) or GPU | Same API; larger sizes need a GPU |
| Mapika decider-2b | 1.9B | Apache-2.0 (confirm on model card) | GPU | Strong self-reported JevBench score |
| AWS Strands Decider 2B | 1.9B | Apache-2.0 (weight availability disputed) | GPU | Confirm the Hugging Face card first |

Every option uses the same `/v1/systemone` protocol, so swapping one for another changes only a URL. Benchmarks are mostly self-reported, and none cover Taglish.

## Phases

### Phase 0: data (prerequisite)

- Grow `tests/fixtures/escalation/reports.json` from 44 to at least 300 synthetic, labeled Taglish and English reports. Team members label them independently and resolve disagreements.
- Split the set 70/15/15 into train, validation and a held-out test set. Freeze the held-out set before any tuning.
- Add the four rule fixes first: a pronoun carry-forward after a match, a faculty `aliases` field for nicknames, a classmate guard, and a proximity window test at 7 words. Measure the rules on the held-out set. This is the baseline the model has to beat.

### Phase 1: offline spike (local only)

- Run `laya-serve` in Docker on a laptop. Define one question per roster person: "Is <role> the subject of a complaint in this report?" with answers `yes` and `no`.
- Fine-tune on the train split. Report precision, recall and calibration on the held-out set, next to the rule baseline.
- Exit if the model does not beat the rules on recall at equal or better precision. Write the result up either way.

### Phase 2: shadow mode (dev and staging)

- Backend: if `ESCALATION_SHADOW_MODEL_URL` is set, `createReport` calls the model after `route()` with a 300 ms timeout and stores `{model, version, answers, confidence}` in `report.routing.shadow`. A failure or timeout is logged and ignored, and routing never waits on it.
- The shadow result appears only in the escalation lab and in an export for evaluation. Handlers and students do not see it.
- AWS: one ECS Fargate task (2 vCPU, 4 GB) in `ap-southeast-1`, private subnet, reached from the API Lambda through the VPC. No public endpoint and no NAT egress. Estimated $50 to $70 a month running all day; a Lambda container image is the scale-to-zero option.
- Track agreement and disagreement between model and rules. Review every disagreement by hand.

### Phase 3: escalate-only (needs approval and ADR 0007)

- If shadow data shows the model catches real conflicts the rules miss, a model `yes` above a confidence threshold may raise an adviser-stage report to the Program Chair as a possible conflict. The rules' trace stays; the handler also sees "A second check flagged a possible conflict".
- The model never lowers a route, never removes a person from `involvedUserIds`, and never decides Dean or Guidance routing.

## Privacy and records

- Update the Privacy Impact Assessment: the new processing component, where it runs, and that no text leaves the account.
- Store the model name, version and threshold with every shadow result, as the rules already store the engine and lexicon versions.
- Students can be told that an automated check helps choose the first office, and they keep the "about my adviser" answer as an override.

## Risks

- Labeled data is the bottleneck. With 300 synthetic reports, fine-tuning may still not generalize to real reports.
- Taglish and code-mixed text is untested on every candidate.
- Decision models give a confidence score but no reasons, so they cannot replace the rule trace.
- Prompt injection: report text is free input. The escalate-only rule limits the damage to a false escalation.
- Operating cost and on-call for one more service; it must fail open without blocking report submission.

## Not in scope

- Any hosted model API.
- Using the model for grouping similar reports. TF-IDF stays.
- Generating summaries or replies.
