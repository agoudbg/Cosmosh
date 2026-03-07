---
name: google-review-conflict-resolution
description: 'Resolve reviewer-author disagreement using Google-style code review conflict workflow. Use when review comments stall, standards are disputed, or escalation is needed. Produces evidence-based consensus steps, escalation path, and documented final decision.'
argument-hint: 'Provide disputed comments, code context, and constraints such as timeline or ownership.'
---

# Google Review Conflict Resolution Skill

Use this skill when code review discussion is stuck or looping.

## Default Mode
- Conflict style: evidence-first and respectful.
- Output language: English.
- Goal: unblock progress without lowering code health standards.

## Inputs To Request
- Disputed review comments and current thread state.
- Relevant code excerpts and style/architecture constraints.
- Team ownership and escalation chain (tech lead, maintainer, manager).
- Time constraints (release window, emergency or normal flow).

## Workflow
1. Classify the disagreement.
- Objective standard conflict (style guide, tests, correctness, safety).
- Design trade-off conflict (multiple valid options).
- Preference-only conflict (no standard violation).

2. Attempt consensus first.
- Resolve using documented standards before escalation.
- Prefer technical facts and data over opinion.

3. Ground discussion in evidence.
- Quote applicable standards or style-guide rules.
- Bring data where possible: tests, perf numbers, incident history, readability impact.
- Rewrite claims as code-health outcomes instead of personal preference.

4. Decide local resolution path.
- If one option clearly better by principle/data, prefer it.
- If options are equivalent, prefer author choice.
- If change clearly improves code health and no blocking risk, move forward.

5. Unblock communication.
- Convert long async threads into quick synchronous discussion when needed.
- Keep tone respectful and focused on code, not person.
- Document the agreed result back in the review thread.

6. Escalate when needed.
- Trigger escalation when consensus cannot be reached in reasonable time.
- Escalate to designated decision owner (maintainer, tech lead, or manager).
- Record final decision, rationale, and follow-up actions.

7. Finalize and prevent recurrence.
- Land actionable decision for current CL.
- Capture reusable rule (team guideline, lint rule, or checklist item) if recurring.

## Branching Logic
- Personal preference only: convert to `Nit` or `Optional`, avoid blocking.
- Required standard violation: keep as blocking until fixed.
- Time-critical release and unresolved minor points: consider `LGTM with comments` if code health still improves.
- Repeated conflict pattern: propose team-level policy update.

## Completion Checklist
- Conflict type identified.
- Relevant standard/evidence cited.
- Clear next action and owner assigned.
- Escalation path used if needed.
- Final decision documented in the review thread.

## Output Format
- `Conflict Summary:` what is disputed and why.
- `Standards/Evidence:` applicable rules and factual support.
- `Resolution Options:` at least two with trade-offs.
- `Decision:` selected path and owner.
- `Record Note:` short text to post back in the review thread.

## Assets
- Use [conflict record template](./assets/conflict-record-template.md) to document decisions in the review thread.

## References
- [Local reviewer standard](./references/local-doc-links.md)
- `./references/eng-practices-full/review/reviewer/standard.md`
- `./references/eng-practices-full/review/reviewer/pushback.md`
- `./references/eng-practices-full/review/developer/handling-comments.md`
