# CL Description Template

Use this template to write clear changelist or pull request descriptions.

## First Line (Imperative)
`<Verb> <specific component/behavior> <primary change>`

Examples:
- `Refactor payment retry logic to remove duplicate backoff handling`
- `Add optimistic locking to order update workflow`

## Body
### What changed
- `<main code/data/API changes>`
- `<secondary changes>`

### Why this change
- `<problem statement>`
- `<why this approach is preferred>`

### Scope and trade-offs
- `<what is intentionally out of scope>`
- `<limitations or known follow-ups>`

### Validation
- Tests run:
- Manual checks:
- Metrics/benchmarks (if any):

### Risks and rollback
- Risk level: `<low/medium/high>`
- Rollback plan: `<how to revert safely>`

### Links
- Issue:
- Design doc:
- Related CLs/PRs:

## Quality Checks
- First line stands alone and is specific.
- Body includes both what and why.
- Description still matches latest diff after review iterations.
