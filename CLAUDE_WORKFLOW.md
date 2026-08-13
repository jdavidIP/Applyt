# Working agreements

Standing rules for how we collaborate in this repo. These govern *process*, not code — they apply
regardless of what the project is.

## Commits

- **Confirm every commit before making it.** Explain what the commit does, then stop and wait for a
  reply — do not commit in the same turn as the explanation, and don't treat "describing the change"
  as consent.
- **Work one commit at a time.** Plan the split into logical commits up front (group by concern:
  domain logic, one area per commit, tests/docs last), but only build the first commit's scope, hand
  it over for review, get the go-ahead, commit, *then* start the next one. Never build the whole
  feature and retroactively slice the finished tree into commits — the review checkpoint has to land
  while the next commit's code doesn't exist yet.
- Never add a `Co-Authored-By: Claude...` trailer (or otherwise credit the assistant) unless
  explicitly asked to in that turn.
- Avoid `--no-verify`, force-push, and other destructive git operations.

## Branches

- **Never work directly on `main`/`master`.** Branch *before* the first edit, not just before the
  commit. If a sync (`git switch main && git pull`) just happened, branch off immediately afterward,
  before opening any file — don't rely on remembering to check later.
- Branch naming: `<type>/<issue#>-<kebab-summary>` (e.g. `fix/12-ci-trigger-branch`). Types mirror
  issue labels: `feat` `fix` `docs` `chore` `test` `refactor` `perf`. Lowercase, kebab-case, ~50
  chars or less. Omit the issue number only when genuinely no issue exists.
- Delete branches (local + remote) once merged.

## Pull requests

- Pushing and opening a PR each require an **explicit, in-turn request** — never implied by
  "start on this" or similar.
- Before opening a PR, run the `code-reviewer` agent (`.claude/agents/code-reviewer.md`)
  against the branch diff. Only a clean "ready" verdict clears
  the gate to `gh pr create`. Any other verdict: stop, show the findings, let the user decide whether
  to fix, override, or address together — don't silently fix-and-proceed, and don't open the PR
  anyway because the issues look minor.

## Issues (GitHub)

- File an issue for anything **actionable, needing the user's decision, and still relevant in a
  month** — bugs, gaps, enhancements, doc needs — including things noticed incidentally. Without that
  bar the tracker fills with noise and stops being signal.
- **Creating an issue, project, or milestone needs the same explain-then-ask gate as a commit** —
  say what it would cover, its type/label, and why it deserves tracking, then wait. Propose batches
  at natural checkpoints (end of a work chunk), not the instant something is noticed. Labels
  themselves are exempt — apply those at your own discretion.
- Always assign the user on every issue; state lives in labels (and a project board, if one exists),
  not the assignee field.
- Shape the description to the type: bugs get repro + evidence + blast radius; enhancements get
  problem/approach/alternatives/done-criteria; docs get which-doc + what's-wrong + who's-misled;
  chores get friction + frequency + workaround.
- Keep issues alive: comment when something material is learned, close with a comment naming the PR
  and how it was verified (use `Closes #N` in the PR body for auto-close, but still write the
  comment — auto-close explains nothing on its own). Reference PRs by number, not commit SHA — a
  squash merge doesn't preserve the branch SHA.

## Subagents / concurrency

- Running a second issue concurrently via a background subagent while working a first is allowed
  only case-by-case, never by default. Ask first with situation-specific reasoning (disjoint files,
  no dependency chain, no port/build collision) and wait for a yes before spawning.
- When it does happen: always use worktree isolation (never let a subagent run `git switch`/
  `git checkout` in the same working directory), watch for port/infra contention between two running
  stacks (backend on `4317`, dashboard on `5173`), and keep the review/decision loop serial
  regardless — concurrency only speeds up the write-code-and-test phase.

## Working style

- **Push back plainly** when a decision, idea, or premise looks wrong — including the user's own.
  Lead with the objection and concrete reasoning, give a recommendation rather than a menu, say
  plainly when uncertain. Once the user reaffirms a call, execute it fully without relitigating.
- **Measure refactors against the actual codebase before recommending them** — line counts
  before/after, what guards or wrapping it forces, whether it adds an experimental/unstable
  dependency. Don't recommend on the strength of how a pattern reads in the abstract. If a downside
  surfaces mid-implementation, revisit the recommendation instead of quietly absorbing it.
