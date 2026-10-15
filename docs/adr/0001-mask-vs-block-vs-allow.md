# ADR 0001: Three policy actions, mask, block and allow

- Status: Accepted
- Date: 2026-10-13

## Context

pii-gate stands between application code and a third-party LLM. For each category of personal data, a team needs to decide what crosses that boundary. In insurance the categories have very different risk and usefulness:

- A claimant's **name** shows up in most notes. The model needs to know a person is involved, but not who.
- An **SSN** or **card number** almost never helps the model, and sending one even in tokenised form usually means an upstream step (a prompt template, a RAG retrieval, a CRM tool) pulled a field it shouldn't have. Masking hides that bug.
- A **date of birth** is PII, but some tasks, such as age banding or eligibility checks, need it.

One global switch can't express all three. A per-category boolean (mask or don't) can't express "this should never happen", and that's the case that matters most for compliance.

## Decision

Each category maps to one of three actions, with `mask` as the default:

1. **`mask`**: replace the value with a typed, per-request placeholder (`{{SSN_1}}`) and restore it in the response.
2. **`block`**: if any value in the category is detected anywhere in the request, throw `PiiBlockedError` before calling the model and before issuing any tokens. The error and the audit record carry category counts, never values.
3. **`allow`**: forward the value unchanged, but still detect it and count it in the audit record.

Detection runs over the whole request (system prompt, all messages and tool results) before anything is replaced, so a block in one tool result aborts the entire call.

## Consequences

- **Block fails loud.** A blocked request is a visible error and an audit row with `blocked: true`. This is intentional: it gives a security review something concrete to alert on, and it turns "we accidentally put SSNs in the prompt" into a bug ticket instead of a silent data flow.
- **Block is subject to false positives.** A 9-digit number misread as an SSN stops a legitimate request. The SSN detector rejects never-issued ranges and identifier-labelled numbers to keep this rare. Teams can lower the risk further with `minConfidence` or schema hints for known identifiers.
- **Allow is explicit and audited.** Sending a value in clear text is a decision someone wrote down in code, and the audit log shows how often it happens.
- **Mask is the default** so that a newly added detector or custom category is protected without a policy change. The cost is that a new category can change prompts and so change model behaviour.
- **Not chosen: "redact"** (replace with `[REDACTED]` and never restore). It would lose the referential structure the model uses ("PERSON_1 called PERSON_2"). `mask` combined with ignoring the vault gives the same result where it's needed.
- **Not chosen: per-detector or per-confidence actions.** Policy is about the type of data, not how it was found. Confidence is handled separately with `minConfidence`.
