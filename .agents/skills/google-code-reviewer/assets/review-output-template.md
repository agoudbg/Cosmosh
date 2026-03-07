# Review Output Template

Use this template for consistent review comments.

## Verdict
- `Approve` | `LGTM with comments` | `Request changes`
- One-line rationale:

## Blocking Findings
1. `[Required] <short title>`
- File: `<path>:<line>`
- Risk: `<correctness/design/security/performance/etc.>`
- Why it matters: `<impact on users/developers/system>`
- Suggested direction: `<what should change>`

2. `[Required] <short title>`
- File: `<path>:<line>`
- Risk: `<...>`
- Why it matters: `<...>`
- Suggested direction: `<...>`

## Non-Blocking Suggestions
1. `[Nit|Optional|FYI] <short title>`
- File: `<path>:<line>`
- Suggestion: `<small improvement>`
- Reason: `<why this helps>`

2. `[Nit|Optional|FYI] <short title>`
- File: `<path>:<line>`
- Suggestion: `<...>`
- Reason: `<...>`

## Positives
- `<good design/testing/readability practice 1>`
- `<good practice 2>`

## Scope Note
- Reviewed: `<files/areas>`
- Not reviewed: `<files/areas>`
- Assumptions: `<any assumptions or missing context>`

## Final Check
- Blocking comments clearly labeled.
- Non-blocking comments clearly labeled.
- Language is respectful and focused on code, not person.
- Design + tests + maintainability were explicitly evaluated.
