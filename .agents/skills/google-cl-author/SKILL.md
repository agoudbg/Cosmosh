---
name: google-cl-author
description: 'Prepare and iterate changelists/pull requests using Google-style author practices. Use when writing clear CL descriptions, splitting large changes, bundling tests, handling reviewer comments, and keeping dependent CLs build-safe.'
argument-hint: 'Provide change summary, current diff size, and reviewer feedback if available.'
---

# Google CL Author Skill

Use this skill to prepare review-friendly changelists and respond to review feedback efficiently.

## Default Mode
- Authoring profile: `Balanced` (quality-first without perfection blocking).
- Output language: English.

## Inputs To Request
- Proposed change summary and intended user/developer impact.
- Current CL size (rough LOC/files) and dependency chain.
- Test status and documentation impact.
- Open reviewer comments and disputed points.

## Workflow
1. Define one self-contained change.
- Keep CL focused on one conceptual change.
- Separate pure refactors from behavior changes when review clarity benefits.

2. Right-size the CL.
- If CL is large, split by dependency stack, file groups, horizontal layers, vertical features, or combined matrix.
- Keep each split independently understandable and reviewable.
- Ensure each submitted step keeps build and tests healthy.

3. Include tests with behavior changes.
- Add or update tests in same CL for changed logic when feasible.
- Verify tests fail on broken behavior and avoid brittle assertions.

4. Write a high-quality CL description.
- First line: short imperative summary of what changed.
- Body: why, context, key trade-offs, limitations, links (bugs/design docs).
- Avoid vague descriptions like "fix bug".

5. Prepare reviewer ergonomics.
- Highlight where to start reviewing and key design choices.
- Call out risky areas and validation performed.
- Keep unrelated formatting noise out of functional CLs.

6. Handle review comments constructively.
- Classify feedback into required changes, nits, and optional suggestions.
- Resolve clear items quickly.
- For disagreement, discuss with evidence and design principles, then escalate if needed.
- Update CL description when scope changed during review.

7. Final submission checks.
- Re-run relevant tests.
- Confirm docs and release notes updates if behavior or operations changed.
- Ensure no hidden coupling to unsubmitted dependent CLs.

## Branching Logic
- Reviewer says CL is too large: split before deep iteration unless explicitly pre-approved.
- Change is emergency: allow temporary quality trade-offs, document follow-up fixes.
- Refactor plus feature mixed: split unless tiny and clearly reviewable.
- Disagreement stalls progress: move from comment thread to synchronous discussion, then document decision.

## Completion Checklist
- CL is conceptually focused and reviewable.
- Description explains both what and why.
- Tests and docs are updated appropriately.
- Reviewer comments are resolved or clearly dispositioned.
- Build remains healthy for each landed step.

## Output Format
- `CL Plan:` size/split strategy and dependency order.
- `Description Draft:` first line + body.
- `Test Plan:` what to run and why.
- `Review Response Plan:` how to address each comment category.

## Assets
- Use [CL description template](./assets/cl-description-template.md) for first-line and body structure.

## Extra References
- Use [eng-practices map](./references/eng-practices-map.md) to select source docs by authoring situation.

## References
- `./references/eng-practices-full/review/developer/index.md`
- `./references/eng-practices-full/review/developer/cl-descriptions.md`
- `./references/eng-practices-full/review/developer/small-cls.md`
- `./references/eng-practices-full/review/reviewer/standard.md`
