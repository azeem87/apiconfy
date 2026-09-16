Memory
Project Overview
See @README.md for project overview.

Plan Files — ALWAYS resolve to `plans/` folder
Hard rule, zero exceptions. Any time the user mentions a plan, design doc, spec, or markdown file by name or reference — "plan ", "plans ", "the plan ", "plan md ", "plan doc ", "check the plan ", "design doc ", "spec ", "api-routes ", "core-types ", "validation ", "component-configs ", "multi-db-strategy ", "phase1-implementation ", "roadmap ", "prd ", or any similar reference — always look in `plans/<filename>.md` at the repo root.
Never look in `.commandcode/plans/` or any other folder.
Never assume the file is elsewhere.
If the file doesn't exist in `plans/`, say so — don't go hunting in other directories.
`plans/` is gitignored (local/personal), so it may not exist in every checkout. If it's missing, tell the user rather than guessing.
`plans/` is the single authoritative source for all technical design, product scope, and phase sequencing. Before implementing, answering design questions, or reviewing code against a spec — read the relevant `plans/` files first. No shortcuts.
Key files: `plans/plan.md` (index), `plans/roadmap.md` (phase sequence), `plans/prd.md` (product scope), `plans/api-routes.md`, `plans/core-types.md`, `plans/validation.md`, `plans/component-configs.md`, `plans/multi-db-strategy.md`, `plans/phase1-implementation.md`.

Package Manager — pnpm only
Installs go through pnpm. Never run `bun install`.
pnpm install              # the only supported install command
The workspace is declared in `pnpm-workspace.yaml`, which bun does not read, and root `package.json` has no `workspaces` field. `bun install` therefore installs only the root devDependencies and silently leaves `apps/server` without `hono` / `pino` / `drizzle`.
`bun.lock` is gitignored so a second lockfile cannot reappear; `pnpm-lock.yaml` is the single source of truth. A `preinstall` guard rejects other package managers.
Bun (pinned to 1.4.x) is the runtime and test runner only.

Commands
Run from the repo root — these fan out through turbo:
pnpm install              # install dependencies
pnpm run dev              # dev server, port 3000
pnpm run build
pnpm run test
pnpm run test:coverage
pnpm run lint
pnpm run typecheck
Inside `apps/server`, bun drives the actual work:
bun test                       # all tests
bun test path/to/file.test.ts  # single file
bun test -t "test name"        # filter by name
bun run typecheck              # tsc --noEmit
CI (`.github/workflows/ci.yml`) runs exactly:
`pnpm install --frozen-lockfile && pnpm run typecheck && pnpm run lint && pnpm run build && pnpm run test:coverage`

Code Style Guidelines
Use descriptive variable names
Follow existing patterns in the codebase
Extract complex conditions into meaningful boolean variables
Use optional chaining (`?.`) as much as possible and wherever applicable to avoid if/else and else-if logic. Use the guard pattern (early return) to handle null/undefined cases cleanly.

Git & Commits
- **NEVER commit directly to the `main` branch.** This is a hard rule.
- **Always create a feature branch** before starting work on a task. Use a descriptive name based on the feature or fix (e.g., `feature/add-oauth-login`, `fix/db-connection-timeout`, `refactor/auth-middleware`).
- **Verify branch before committing:** Before running any `git commit` or `git push` command, explicitly check the current branch (`git branch --show-current`). If it is `main`, abort the commit, create a new branch, and then proceed.
- Follow Conventional Commits format (`feat:`, `fix:`, `docs:`, `chore:`, etc.)
- Never add `Co-Authored-By` lines to commit messages

Architecture Notes
Add important architectural decisions and patterns here.

Common Workflows
Document frequently used workflows and commands here.

API Testing
Postman collection at `postman/apiconfy.postman_collection.json` — committed to the repo, updated as each phase is completed. Import into Postman to test all implemented endpoints. Collection variables: `base_url` (default `http://localhost:3000`), `api_key` (Bearer token if `API_KEY` env is set).

Postman Collection Structure
Organized by component type (not phase). Each component type folder contains:
Simple Examples — minimal working requests
Complex Examples — full-featured scenarios with auth, resilience, mapping, validation
Error Cases — validation, auth, not-found scenarios

Postman Example Rules
MANDATORY: Every component registration example in the Postman collection MUST include ALL applicable config sections for that component type. This is not optional — the Postman collection is the reference for users, and incomplete examples mislead them.
Simple examples — minimal required fields only (uri, method for REST; template for Mapper; etc.)
Complex examples — MUST include every applicable config section:
`uri`, `method`, `contentType`, `headers` (with `$.context.*` expressions)
`timeout`, `resilience` (retry, backoff, circuitBreaker)
`auth` (oauth2/basic/jwt with `$env.` references)
`payloadTemplate` (with `$.context.*` expressions)
`response.validation.rules` (with `$.response.*` expressions)
`response.transformation` (wraps output under unique key, reads `$.response.*`)
`condition` (with `$.context.*` expressions)
`metaData`
Response transformation — ALWAYS wraps output under a unique key (e.g., `createOrderResponse`, `getUserResponse`) to prevent collisions when multiple components return similar fields.
Data bag convention — All examples follow: `$.context.*` (input) → `$.response` (ephemeral) → transformation → `$.context.output.<uniqueKey>`.

Karpathy Coding Guidelines
name: karpathy-llm-coding-guidelines
description: "Karpathy LLM coding guidelines - always applied"
Karpathy Guidelines
Behavioral guidelines to reduce common LLM coding mistakes, derived from Andrej Karpathy's observations on LLM coding pitfalls.
Tradeoff: These guidelines bias toward caution over speed. For trivial tasks, use judgment.
1. Think Before Coding
Don't assume. Don't hide confusion. Surface tradeoffs.
Before implementing:
State your assumptions explicitly. If uncertain, ask.
If multiple interpretations exist, present them - don't pick silently.
If a simpler approach exists, say so. Push back when warranted.
If something is unclear, stop. Name what's confusing. Ask.
Confirm approach in chat before generating files. Prefer execution-ready output over outlines/scaffolds.
If a task needs more than ~3 file changes, outline the plan first.
2. Simplicity First
Minimum code that solves the problem. Nothing speculative.
No features beyond what was asked.
No abstractions for single-use code.
No "flexibility" or "configurability" that wasn't requested.
No error handling for impossible scenarios.
If you write 200 lines and it could be 50, rewrite it.
Ask yourself: "Would a senior engineer say this is overcomplicated?" If yes, simplify.
3. Surgical Changes
Never overwrite sensitive properties.
When editing or deploying config files (settings.json, .env, any credentials file): preserve existing values for tokens, passwords, API keys, URLs, and secrets. If the source file has empty placeholders and the destination has real values, merge — do not overwrite. Do not touch sensitive properties unless the user explicitly asks.
Touch only what you must. Clean up only your own mess.
When editing existing code:
Don't "improve" adjacent code, comments, or formatting.
Don't refactor things that aren't broken.
Match existing style, even if you'd do it differently.
If you notice unrelated dead code, mention it - don't delete it.
When your changes create orphans:
Remove imports/variables/functions that YOUR changes made unused.
Don't remove pre-existing dead code unless asked.
The test: Every changed line should trace directly to the user's request.
When iterating on feedback, make targeted corrections - don't rewrite the whole thing.
4. Goal-Driven Execution
Define success criteria. Loop until verified.
Transform tasks into verifiable goals:
"Add validation" → "Write tests for invalid inputs, then make them pass"
"Fix the bug" → "Write a test that reproduces it, then make it pass"
"Refactor X" → "Ensure tests pass before and after"
For multi-step tasks, state a brief plan:
1. [Step] → verify: [check]
2. [Step] → verify: [check]
3. [Step] → verify: [check]
Strong success criteria let you loop independently. Weak criteria ("make it work") require constant clarification.
5. Never
Never touch `.env`, secrets, or credentials files without asking.
Never `git push --force` without explicit confirmation.
Never delete files outside the current task's scope. Don't add files that already exist.

Context Exclusions — Do Not Read, Search, or Load
These paths are out of scope for all analysis and context building. Never `read_file`, `grep_search`, `glob`, or `list_directory` into them, never summarize them, and never pull their contents into context — not even to "take a quick look".

| Path | Why |
| --- | --- |
| `node_modules/`, `**/node_modules/` | Vendored dependency trees — huge, zero signal |
| `dist/`, `**/dist/` | Generated build output — always stale relative to `src/` |

Both are generated or vendored, never authored. For truth, read `src/` — never `dist/`.
Root-level ignore files (e.g., `.qwenignore`, `.claudeignore`, `.cursorignore`, `.aiderignore`, or standard `.gitignore`) enforce this mechanically for search and directory listings across all major AI agents. This rule still governs direct `read_file` calls, which ignore files do not block.
When asked for a "full codebase analysis", the scope is `apps/`, `plans/`, and the root config files — never anything in the table above.
(All code lives in `apps`.)