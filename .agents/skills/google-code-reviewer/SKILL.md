---
name: google-code-reviewer
description: 'Run a Google-style code review workflow for pull requests and changelists. Use when reviewing design, correctness, tests, readability, comments, documentation, review speed, and comment severity (Required/Nit/Optional/FYI). Includes decision branches for large CLs, major design problems, and LGTM with comments.'
argument-hint: 'Provide PR/CL context, risk areas, and what kind of review output you want.'
---

# Google Code Reviewer Skill

Use this skill to perform a structured, high-signal code review inspired by Google Engineering Practices.

## Default Mode
- Strictness profile: `Balanced`.
- Output language: English.
- Comment labeling: `Required`, `Nit`, `Optional`, `FYI`.

## Inputs To Request
- Change context: PR/CL link, summary, related issue/design doc.
- Scope: files to review and any explicit ownership boundaries.
- Risk profile: user-facing impact, security, privacy, data integrity, performance, concurrency.
- Constraints: release deadlines, emergency status, reviewer turnaround expectations.

## Review Standard
- Approve when the change clearly improves overall code health, even if not perfect.
- Do not approve if code health clearly regresses, except true emergencies.
- Prefer evidence, style guide rules, and engineering principles over personal preference.

## Workflow
1. Triage the CL.
- Check if the change should happen at all.
- Read description for clear "what" and "why".
- If direction is wrong, stop early and suggest a better direction.

2. Review high-leverage parts first.
- Find core files and design decisions.
- Send major design concerns immediately without waiting for full pass.

3. Review all assigned code in sequence.
- Cover every human-written line in assigned scope.
- Pull broader file/system context when local diff is insufficient.

4. Evaluate quality dimensions.
- Design: architecture fit, boundaries, extensibility without over-engineering.
- Functionality: correctness, edge cases, failure modes, UX impact.
- Concurrency and safety: race/deadlock risk, state consistency.
- Complexity: readability, maintainability, avoid speculative abstractions.
- Tests: right level, useful assertions, failure sensitivity, maintainable tests.
- Naming/comments/docs: clear names, comments explain why, docs updated when behavior changes.
- Style/consistency: follow style guides first, then local consistency.

5. Write review comments with explicit severity.
- `Required:` must change before approval.
- `Nit:` polish, non-blocking.
- `Optional:` suggestion, author can choose.
- `FYI:` informational only.
- Be respectful, explain reasoning, and compliment strong work when present.

6. Decide review outcome.
- `Approve/LGTM`: no blocking concerns.
- `LGTM with comments`: only minor non-blocking points remain and author is likely to apply them.
- `Request changes`: blocking issues remain.
- For partial reviews, state exactly what was reviewed and what was not.

7. Keep review latency low.
- Target a quick first response and short response loops.
- Maximum normal response time target: within one business day.
- If busy, acknowledge and provide ETA or suggest alternate reviewer.
- For oversized CLs, ask to split into smaller self-contained changes.

## Branching Logic
- Large CL and no fast full review possible: request split first; if unavoidable, provide immediate high-level design feedback.
- Major design flaw found early: send that feedback immediately; avoid deep nits until direction is settled.
- Style-only disagreement not in style guide: treat as preference, usually non-blocking.
- Multiple reviewers: state your reviewed scope explicitly.
- Time-zone delay risk: prefer `LGTM with comments` when only minor issues remain.

## Completion Checklist
- Outcome stated clearly (approve, lgtm-with-comments, or changes requested).
- Blocking vs non-blocking comments are clearly labeled.
- Comments focus on code and rationale, not person.
- Review explicitly covers design, tests, and maintainability.
- Any missing docs/tests are called out.
- If scope was partial, reviewed scope is documented.

## Output Format
- `Verdict:` one-line decision.
- `Blocking Findings:` numbered, each with file/path reference and why it matters.
- `Non-Blocking Suggestions:` numbered and severity-labeled.
- `Positives:` concrete good practices observed.
- `Scope Note:` what you did and did not review.

## Assets
- Use [review output template](./assets/review-output-template.md) when generating structured review feedback.

## Extra References
- Use [eng-practices map](./references/eng-practices-map.md) to select source docs by review situation.

## References
- `./references/eng-practices-full/review/reviewer/index.md`
- `./references/eng-practices-full/review/reviewer/standard.md`
- `./references/eng-practices-full/review/reviewer/looking-for.md`
- `./references/eng-practices-full/review/reviewer/navigate.md`
- `./references/eng-practices-full/review/reviewer/speed.md`
- `./references/eng-practices-full/review/reviewer/comments.md`
