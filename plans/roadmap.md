# Implementation Roadmap — Apiconfy

> **Status:** 📝 Draft  
> **Version:** v0.3  
> **Last Updated:** 2026-07-19

---

## How to Use This Roadmap

- Phases are **sequential**: complete the exit criteria before moving to the next.
- Each phase references plan files under `.commandcode/plans/` that detail the technical design.
- **Before starting a phase:** open the linked plan files, review them together, refine any gaps, and agree on the approach before writing code.
- The "walking skeleton" strategy means Phase 2 (single REST invocation) is the first milestone that proves the architecture end-to-end. Everything before it sets up the skeleton; everything after it adds muscle.

---

## Phase Summary Table

| # | Phase | Status | Depends On |
|---|---|---|---|
| 0 | Foundation | 🟢 Complete | — |
| 1 | Component Registry | 🔴 Not Started | 0 |
| 2 | Single Component Execution (REST) | 🔴 Not Started | 1 |
| 3 | Transformation Engine | 🔴 Not Started | 2 |
| 4 | Auth & Connection Handling | 🔴 Not Started | 3 |
| 5 | Multi-Component Composition (Sequential) | 🔴 Not Started | 2, 4 |
| 6 | Parallel Execution | 🔴 Not Started | 5 |
| 7 | Conditional Execution & Response Validation | 🔴 Not Started | 3, 5 |
| 8 | Event → Action Mapping | 🔴 Not Started | 5 |
| 9 | Rollback / Compensating Actions | 🔴 Not Started | 5, 8 |
| 10 | Scheduler + Webhook Callbacks | 🔴 Not Started | 4, 5 |
| 11 | Additional Components | 🔴 Not Started | 0-10 |
| 12 | OSS Readiness | 🔴 Not Started | 0-11 |

**Status Legend:** 🔴 Not Started | 🟡 In Progress | 🟢 Complete

---

## Phase 0 — Foundation

**Goal:** Establish the repo, toolchain, and persistence layer so all future phases have a solid base.

### Deliverables
- Monorepo scaffolded with Turborepo and `packages/` + `apps/` layout
- TypeScript strict mode, `tsconfig.base.json` shared across packages
- Bun as sole runtime (no Node.js compatibility layer)
- **Non-blocking execution baseline:** All DB operations use async wrappers; bun:sqlite queries wrapped for non-blocking; no sync I/O anywhere in the codebase
- `packages/shared`: error classes, logger factory (pino with OTel trace correlation), UUID, JSON/HTTP utilities
- `packages/db`: DBAdapter interface, SQLite adapter (bun:sqlite + Drizzle), Postgres adapter (postgres.js + Drizzle), connection resolver (env-based)
- Drizzle schemas for: component_definitions, workflow_definitions, workflow_steps, execution_logs, master_configuration
- Repository classes: component-repo, workflow-repo, execution-repo, config-repo
- `apps/server`: Hono skeleton, global middleware (error, logger, auth stub), env config
- Secret redaction utility (`packages/shared`): masks credential-shaped fields (secrets, passwords, tokens, keys) before any log write, used consistently across all packages
- OpenAPI docs: `@hono/zod-openapi` generating spec from Zod schemas, Scalar UI mounted at `/docs`
- OTel tracing: `@hono/otel` middleware active, pino logs include trace/span IDs when OTel is active
- CI pipeline: GitHub Actions with `bun install && bun test --coverage`
- Test setup: bun:test runner, in-memory SQLite for DB tests, factory functions for fixtures

### Exit Criteria
- [x] `pnpm install && pnpm run build` completes in under 30 seconds
- [x] `bun test` passes all tests with ≥80% coverage on shared + db packages
- [x] SQLite adapter saves and retrieves component records (DBAdapter interface validated)
- [x] Hono server starts on configured port, responds to `GET /health`
- [x] CI pipeline configured (GitHub Actions), runs on every push
- [x] Log a mock object containing a `password` and `clientSecret` field → verify both are redacted in output

### Plan Files to Review
- [tech-stack.md](../.commandcode/plans/tech-stack.md) ✅
- [monorepo-strategy.md](../.commandcode/plans/monorepo-strategy.md) ✅
- [folder-structure.md](../.commandcode/plans/folder-structure.md) ✅
- [multi-db-strategy.md](../.commandcode/plans/multi-db-strategy.md) ✅
- [logging.md](../.commandcode/plans/logging.md) ✅
- [shared-utilities.md](../.commandcode/plans/shared-utilities.md) 📝
- [testing-strategy.md](../.commandcode/plans/testing-strategy.md) ✅

### Open Decisions
- (Decided) Hono over Express/Fastify
- (Decided) Drizzle ORM over Prisma — private impl detail of `packages/db`, hidden behind `DBAdapter` interface
- (Decided) Turborepo over Nx
- (Decided) bun:test as sole test runner
- (Decided) v1 commits to SQL databases only: SQLite (zero-config, `bun:sqlite`) + PostgreSQL (`postgres.js`). MongoDB, Couchbase, Oracle deferred to post-launch as community-contributed adapters.
- (Decided) `bun` as sole package manager (`bun.lock`)
- (Decided) `@apiconfy/*` npm scope
- (Decided) `@hono/zod-openapi` + Scalar UI for API docs from day one

---

## Phase 1 — Component Registry

**Goal:** Users can register, look up, list, and delete component definitions that persist across restarts.

### Deliverables
- **Design the registration API contract:** POST/GET/PATCH/DELETE endpoints, request body shape, validation rules (components route in Hono)
- Zod schemas per component type (REST first — others stubbed)
- `packages/runtime`: ComponentRegistry — register, find, list (paginated), update, delete components via DB repo
- SchemaRegistry: validate component-type-specific serviceDetails
- Field-level encryption for credential fields (secrets, passwords, tokens, keys) before persisting; decrypted only when the runtime needs them for an outbound call, never on a read API response
- API routes: `POST /api/components/register`, `GET /api/components` (paginated), `GET /api/components/:id`, `PATCH /api/components/:id`, `DELETE /api/components/:id`, `GET /api/components/lookup/:serviceName/:component/:serviceType`
- Consistent JSON response envelope on all endpoints

### Exit Criteria
- [ ] Register a REST component → returns 201 with component ID
- [ ] Look up by natural key → returns the saved definition
- [ ] Update a component's URL via `PATCH` → subsequent lookup reflects the change, ID and natural key unchanged
- [ ] Delete → subsequent lookup returns 404
- [ ] Restart server → previously registered components still queryable
- [ ] Invalid registration payload (e.g., missing url for REST) → returns 400 with structured error
- [ ] Register the same natural key twice → returns the decided behavior (409 Conflict or upsert — see Open Decisions), not undefined behavior
- [ ] A component with a `clientSecret` → `GET` response has it redacted; DB row has it encrypted, not plaintext
- [ ] List endpoint with 50+ components → `limit`/`offset` params return the correct page
- [ ] Integration test: register → lookup → update → delete → verify gone

### Dependencies
- Phase 0 (DB layer, Hono server, error classes)

### Plan Files to Review
- [api-routes.md](../.commandcode/plans/api-routes.md) 📝 — components section
- [core-types.md](../.commandcode/plans/core-types.md) 📝 — RegisterComponentRequest, ComponentRecord
- [multi-db-strategy.md](../.commandcode/plans/multi-db-strategy.md) ✅ — component_definitions schema
- [validation.md](../.commandcode/plans/validation.md) ✅ — Zod schemas

### Open Decisions
- Registration mechanism: REST API only (no SDK or CLI — API is the sole integration surface)
- Exact endpoint paths (currently `/api/components/*`) — finalize during plan review
- Duplicate registration: upsert vs `409 Conflict` — finalize during plan review
- Encryption approach for credential fields: app-level (e.g. AES-GCM with a configured key) vs relying on DB-level encryption-at-rest (less portable across the SQLite/Postgres/Mongo/Couchbase adapter matrix — leaning app-level for portability)

---

## Phase 2 — Single Component Execution (REST, no transformation)

**Goal:** Prove the end-to-end path: register a REST component, invoke it, get a response — the walking skeleton.

### Deliverables
- **Design the invocation API contract:** endpoint path, request body (arbitrary JSON payload), response envelope
- `packages/runtime`: RuntimeExecutor — lookup definition, evaluate condition, dispatch to component handler, return result
- `packages/components`: ComponentHandler interface, RestComponent implementation
- ComponentHandlerRegistry: built-in handlers register on startup
- API route: `POST /api/invoke/:serviceName/:component/:serviceType`
- Execution log: persist invocation to execution_logs table (executionId, serviceName, component, status, duration)
- Global error handler catches all errors → structured JSON envelope

### Exit Criteria
- [ ] Register REST component → invoke with payload → HTTP call made → raw response returned
- [ ] Invoke non-existent component → returns 404 with "Component not found"
- [ ] External API returns 4xx/5xx → error returned in envelope with upstream status code
- [ ] Execution log recorded in DB for every invocation (success and failure)
- [ ] Integration test: register → invoke → verify response → verify log

### Dependencies
- Phase 1 (Component Registry — need registered components to invoke)

### Plan Files to Review
- [runtime-executor.md](../.commandcode/plans/runtime-executor.md) 📝
- [component-plugin.md](../.commandcode/plans/component-plugin.md) 📝 — ComponentHandler, RestComponent
- [api-routes.md](../.commandcode/plans/api-routes.md) 📝 — invoke section
- [core-types.md](../.commandcode/plans/core-types.md) 📝 — InvocationResult, ExecutionContext

### Open Decisions
- Fetch library: Bun-native `fetch` vs undici (leaning built-in `fetch`)
- AbortSignal.timeout for request timeouts
- Exact invoke endpoint shape — finalize during plan review

---

## Phase 3 — Transformation Engine

**Goal:** Request and response mappings transform data between the execution context and external systems using path expressions.

### Deliverables
- **Pre-phase spike:** Evaluate JSONata vs JMESPath vs JSONPath+expression-lib with real component mapping scenarios. Document findings, pick one.
- `packages/transform`: resolveTemplate() — pure path, embedded path, objects, arrays, primitives
- Request mapping: resolve template against context → outgoing payload
- Response mapping: extract mapped fields from external response → result data
- Context merge: external response merged into execution context after each call
- Works in both single invocation (phase 2) and workflow contexts (phase 5)
- SSRF guard: block outbound calls to private/link-local IP ranges by default when the target URL is resolved from a dynamic template, with a configurable allow-list for legitimate internal use

### Exit Criteria
- [ ] Pre-phase spike document: library comparison with concrete mapping scenarios, recommendation
- [ ] `"$.id"` resolves to value (preserving type — number stays number)
- [ ] `"prefix-$.id-suffix"` substitutes embedded paths
- [ ] Nested objects and arrays resolve recursively
- [ ] `"$.missing"` kept as literal string (no throw)
- [ ] REST component: request mapping transforms context → HTTP body; response mapping extracts result
- [ ] Existing phase 1-2 tests still pass (no transformation = passthrough behavior)
- [ ] A component whose resolved URL points to `127.0.0.1` or `169.254.169.254` → request blocked with a clear error, unless explicitly allow-listed

### Dependencies
- Phase 2 (REST component execution — the transformation engine plugs into the existing executor)

### Plan Files to Review
- [transformation-engine.md](../.commandcode/plans/transformation-engine.md) ✅

### Open Decisions
- **Expression library:** JSONata vs JMESPath vs JSONPath(jsonpath-plus) — settled by spike before implementation
- Conditional expression evaluator (SpEL-style): separate library or reuse path language with operators? (Defer to Phase 7 spike)

---

## Phase 4 — Auth & Connection Handling

**Goal:** Components delegate auth to a proxy that handles OAuth2, JWT, basic auth, and SSL/mTLS transparently.

### Deliverables
- `packages/auth`: AuthProxy interface, OAuth2 implementation (client_credentials + password grants), JWT implementation
- Token cache: in-memory, TTL from `expires_in`, auto-invalidate on 401, retry once
- Basic auth: Authorization header from credentials
- Two-way SSL/mTLS: client cert + key + CA config per component
- SSL disable toggle for non-production environments
- Components call `authProxy.acquireToken()` or `authProxy.proxyCall()` instead of handling auth themselves

### Exit Criteria
- [ ] OAuth2 client_credentials: acquire token, cache, use in external call, expires and re-acquires
- [ ] OAuth2 password grant: acquire token with username/password
- [ ] JWT: acquire token, check `exp` claim, auto-refresh
- [ ] Basic auth: Authorization header populated from config
- [ ] 401 response → token invalidated → retry once → succeeds (or fails with clear error)
- [ ] mTLS: component config specifies cert/key/ca paths → external call uses mutual TLS
- [ ] Non-prod SSL disable: self-signed certs accepted when configured

### Dependencies
- Phase 3 (Transformation engine — auth is a dependency injected into the executor, not a transformation concern)

### Plan Files to Review
- [auth-proxy.md](../.commandcode/plans/auth-proxy.md) 📝 — needs enrichment: SSL/mTLS config, basic auth as first-class type, non-prod SSL toggle

### Open Decisions
- Certificate format: PEM, PFX/PKCS12, or both?
- SSL config storage: inline in serviceDetails, file paths, or env-var references?
- Token cache persistence: in-memory only for v1; Redis-backed deferred to post-v1

---

## Phase 5 — Multi-Component Composition (Sequential)

**Goal:** Register and invoke workflows — multiple components execute sequentially across groups with shared context threading.

### Deliverables
- Workflow registration API: POST/GET/PATCH/DELETE — define ordered groups of component references, plus list (paginated) for parity with components
- `packages/runtime`: WorkflowOrchestrator — group steps, execute sequentially, merge context, apply final mapping
- Workflow invoke API: POST /api/workflows/invoke/:workflowName
- Context threading: each step's response merged into shared ExecutionContext before next group
- Workflow-level response mapping: shape final result from accumulated context
- Execution logs: workflow-level + per-step logs with shared executionId

### Exit Criteria
- [ ] Register workflow with 3 steps in 3 groups → invoke → all 3 execute in order
- [ ] Step 1 response (e.g., `{ customerId: 42 }`) is readable by step 3's request mapping
- [ ] Workflow response mapping returns only specified fields
- [ ] Workflow invoke returns all step results merged into final response
- [ ] List, update, and delete workflows via API — same CRUD parity as components
- [ ] Integration test: register 2 components + workflow → invoke → verify order and context sharing

### Dependencies
- Phase 2 (REST component execution — orchestrator reuses RuntimeExecutor)
- Phase 4 (Auth — components in a workflow may need auth)

### Plan Files to Review
- [workflow-orchestrator.md](../.commandcode/plans/workflow-orchestrator.md) 📝 — sequential groups, context threading
- [runtime-executor.md](../.commandcode/plans/runtime-executor.md) 📝 — reused by orchestrator
- [api-routes.md](../.commandcode/plans/api-routes.md) 📝 — workflows section
- [core-types.md](../.commandcode/plans/core-types.md) 📝 — WorkflowDefinition, WorkflowStep

### Open Decisions
- (Decided) Sequential groups are the default; parallel within groups is phase 6
- (Decided) Orchestrator is stateless — context lives in memory during invocation

---

## Phase 6 — Parallel Execution

**Goal:** Components within the same group execute concurrently, with partial-failure handling and dependency ordering.

### Deliverables
- Parallel execution: steps in same group run via Promise.all
- Within-group dependency: `dependsOnStepId` enforces ordering within a parallel group
- Partial failure: if one parallel step fails, all sibling promises settle (not abort), error collected
- Context merge after parallel group: all successful responses merged before next group
- Cycle detection: workflow registration validates `dependsOnStepId` references form an acyclic graph within each group; rejected at registration time, not discovered at execution time

### Exit Criteria
- [ ] Workflow with 2 steps in same group → both HTTP calls made concurrently (measured by total duration ≈ max duration, not sum)
- [ ] Step with `dependsOnStepId` waits for its dependency before executing
- [ ] One parallel step fails → error returned to caller, other successful steps' data available for rollback
- [ ] Context after parallel group contains merged data from all successful steps
- [ ] Workflow with a circular `dependsOnStepId` reference (A depends on B, B depends on A) → registration rejected with a structured error

### Dependencies
- Phase 5 (Sequential composition — parallel is an extension of the same orchestrator)

### Plan Files to Review
- [workflow-orchestrator.md](../.commandcode/plans/workflow-orchestrator.md) 📝 — parallel section needs enrichment: partial-failure semantics

### Open Decisions
- Promise.all vs Promise.allSettled — allSettled preferred (collect results even with failures)
- Abort in-progress parallel calls on failure? (Leaning no — let them complete, collect results)

---

## Phase 7 — Conditional Execution & Response Validation

**Goal:** Components can be conditionally skipped, and external responses are validated before proceeding.

### Deliverables
- **Pre-phase spike:** Evaluate expression evaluator libraries. Can we use the path expression language with inline operators (e.g., `$.id != null`), or do we need a dedicated expression language? Document findings.
- Component-level condition: evaluate expression against context → skip if false → return `skippedExecution: true`
- Response validation — nonNullPaths: after external call, check specified paths are non-null
- Response validation — conditions: eq, neq, gt, lt, exists, regex operators
- Validation failure returns `ValidationError` with path, operator, expected value, actual value
- In a workflow: validation failure triggers rollback (phase 9)

### Exit Criteria
- [ ] Component with condition `"$.id != null"` invoked with `{ id: null }` → skipped, `skippedExecution: true`
- [ ] Component with nonNullPaths `["$.customer.id"]` → external response missing `customer.id` → ValidationError
- [ ] Condition `{ path: "$.status", operator: "eq", value: "success" }` → response has `status: "error"` → ValidationError
- [ ] Condition `{ path: "$.email", operator: "regex", value: "^.*@.*$" }` → response email invalid → ValidationError
- [ ] All 6 operators tested with valid and invalid responses

### Dependencies
- Phase 3 (Transformation — validation uses the same path resolution)
- Phase 5 (Workflows — validation failures must trigger rollback, but rollback is phase 9; stub the rollback trigger)

### Plan Files to Review
- [validation.md](../.commandcode/plans/validation.md) ✅ — response validation
- [transformation-engine.md](../.commandcode/plans/transformation-engine.md) ✅ — path resolution used in validation
- [conditional-execution.md](../.commandcode/plans/conditional-execution.md) 📝 — expression evaluator design
- [runtime-executor.md](../.commandcode/plans/runtime-executor.md) 📝 — condition evaluation step
- [core-types.md](../.commandcode/plans/core-types.md) 📝 — ValidationCondition

### Open Decisions
- **Expression evaluator:** Dedicated library (e.g., expression-eval, jexl) vs extending transformation engine with operators — settled by spike
- Condition syntax: path-based (`$.id != null`) vs expression-based (`context.id != null`)

---

## Phase 8 — Event → Action Mapping

**Goal:** Named events trigger pre-configured component chains without knowing the implementation details.

### Deliverables
- **Create `event-action-mapping.md` plan file** in `.commandcode/plans/`
- Event registry: API to register an event name mapped to a list of component actions
- Event trigger API: POST with event name + payload → executes mapped chain
- Event payload passed as initial execution context
- Stretch: webhook-style event trigger (external system POSTs to an event endpoint)

### Exit Criteria
- [ ] Register event "customer.created" mapped to 2 components → trigger event → both execute in order
- [ ] Event payload `{ customerId: 42 }` available as context for all mapped components
- [ ] Trigger non-existent event → 404 with "Event not found"
- [ ] Event mappings persist across restarts

### Dependencies
- Phase 5 (Workflows — event trigger executes a workflow under the hood)

### Plan Files
- ⚠️ **New:** `event-action-mapping.md` — create before starting this phase

### Open Decisions
- Event to workflow vs event to loose component chain? (Leaning: events map to workflows for consistency)
- Event namespace: flat names or hierarchical (`customer.created`)?
- Webhook-style event endpoint vs separate webhook component (phase 10)?

---

## Phase 9 — Rollback / Compensating Actions

**Goal:** On workflow step failure, prior successfully completed steps execute compensating rollback actions.

### Deliverables
- Step-level rollback config: `rollbackServiceName` + `rollbackServiceType` per workflow step
- Workflow-level rollback: `rollbackAllPrevious: true` flag
- Rollback execution: reverse order, best-effort (failures logged, don't block other rollbacks)
- Original error returned to caller after all rollback attempts complete

### Exit Criteria
- [ ] Workflow with 3 steps → step 3 fails → steps 2 and 1 execute their rollback actions (in 2→1 order)
- [ ] rollbackAllPrevious on step 3 → steps 1 and 2 roll back even if they didn't define individual rollback
- [ ] Rollback step itself fails → error logged, other rollbacks continue
- [ ] No rollback configured → error returned without rollback attempt

### Dependencies
- Phase 5 (Workflows — rollback is part of the orchestrator)
- Phase 8 (Event → action mapping — rollback may need to trigger compensating events)

### Plan Files to Review
- [workflow-orchestrator.md](../.commandcode/plans/workflow-orchestrator.md) 📝 — rollback section

### Open Decisions
- Rollback granularity: per-step config vs workflow-level rollback policy
- Compensating action semantics: rollback component may need context from original execution (what data to pass?)

---

## Phase 10 — Scheduler + Webhook Callbacks

**Goal:** Workflows can be triggered by cron schedules or incoming webhook calls.

### Deliverables
- **Create `scheduler-and-webhooks.md` plan file** in `.commandcode/plans/`
- Scheduler: register cron expression → triggers a workflow on schedule
- Scheduler runs in-process (node-cron or croner) with configurable timezone
- Webhook component: register an endpoint → incoming POST triggers a configured workflow
- Webhook payload passed as execution context

### Exit Criteria
- [ ] Register cron `"0 */1 * * *"` → workflow invoked every hour
- [ ] Registered cron expression visible in scheduler status endpoint
- [ ] Webhook endpoint receives POST → workflow invoked with webhook body as context
- [ ] Scheduler persists across restarts (registered crons re-loaded on startup)

### Dependencies
- Phase 4 (Auth — webhooks may need auth)
- Phase 5 (Workflows — scheduler + webhook both trigger workflows)

### Plan Files
- ⚠️ **New:** `scheduler-and-webhooks.md` — create before starting this phase

### Open Decisions
- Cron library: node-cron vs croner vs cron (leaning croner — zero-dependency, timezone support)
- Webhook auth: API key validation, HMAC signature verification, or both?
- Webhook naming: separate component type ("webhook") vs event-trigger variant?

---

## Phase 11 — Additional Components

**Goal:** Built-in FTP/SFTP, SQS, Kafka, and RabbitMQ components.

> ⚠️ **Scope flag:** publish-style operations (SQS/Kafka/RabbitMQ publish, FTP upload) fit the existing request/response executor. Consume-style operations need a long-running background listener — architecturally new territory for a runtime that's otherwise entirely HTTP-request-driven, and in tension with the "stateless orchestrator" decision from Phase 5. Recommend scoping v1 of this phase to publish/upload/download only, and treating consumers as a separate sub-phase with its own plan file once the listener lifecycle (start/stop, backpressure, DLQ handling, how a consumed message triggers a workflow) is designed.

### Deliverables
- FTP/SFTP component: connect, upload, download, list, delete (basic-ftp or ssh2-sftp-client)
- SQS component: publish (aws-sdk v3). Consume deferred — see scope flag above.
- Kafka component: produce (kafkajs). Consume deferred — see scope flag above.
- RabbitMQ component: publish (amqplib). Consume deferred — see scope flag above.
- Database component: execute parameterized queries against existing DB connections
- Each component: Zod schema, handler implementation, unit tests with mocked external calls
- Integration test infrastructure: Docker Compose (or Testcontainers) spinning up a real FTP server, SQS (LocalStack), Kafka, and RabbitMQ for CI — not mocked-only tests

### Exit Criteria (per component)
- [ ] FTP: upload file to test FTP server → success; download → file content matches
- [ ] SQS: publish message → message visible in queue (verified against a real or LocalStack queue, not just a mock)
- [ ] Kafka: produce → message in topic (verified against a real broker in CI)
- [ ] RabbitMQ: publish → message in queue (verified against a real broker in CI)
- [ ] DB: SELECT query → rows returned as JSON array
- [ ] CI pipeline runs the Docker Compose/Testcontainers integration suite on every PR touching `packages/components`

### Dependencies
- Phase 0-10 (All components plug into the same executor/orchestrator)

### Plan Files
- Existing: [component-plugin.md](../.commandcode/plans/component-plugin.md) 📝 — component interface, placeholders
- ⚠️ **New:** Per-component plan files to be created during this phase (not before)
- ⚠️ **New:** `queue-consumer-architecture.md` — required before any consume-style feature (SQS/Kafka/RabbitMQ consume) is implemented, even if that lands post-v1

### Open Decisions
- FTP library: basic-ftp (SFTP via ssh2-sftp-client) vs ssh2 directly
- Kafka: kafkajs vs node-rdkafka (leaning kafkajs for pure JS, no native deps)
- DB component: Drizzle query builder vs raw SQL with parameterized queries?
- Should messaging components support both produce and consume in the same component, or separate them?
- Do consumers ship in v1 at all, or move to Post-Launch? (Recommendation: Post-Launch, given the architectural lift — see scope flag above)

---

## Phase 12 — OSS Readiness

**Goal:** Apiconfy is ready for public consumption — documented, licensed, contributable, and discoverable.

### Deliverables
- **Create `oss-readiness.md` plan file** in `.commandcode/plans/`
- Documentation site (VitePress or Docusaurus) with: Getting Started, Concepts, API Reference, Component Guide, Workflow Guide
- CONTRIBUTING.md: development setup, code style, PR process, testing requirements
- LICENSE file (MIT or Apache 2.0)
- At least 3 end-to-end examples: simple REST invocation, multi-step workflow, scheduled workflow
- README polish: badges, quickstart, feature list, architecture diagram
- Release process: versioning (semver), changelog (auto-generated from conventional commits), GitHub Releases + tagged Docker image
- GitHub: repo description, topics, website link

### Exit Criteria
- [ ] `bun install && bun run dev` → server running with zero config in under 60 seconds (following README)
- [ ] Documentation site deployed and accessible
- [ ] All 3 examples runnable end-to-end by following docs
- [ ] CONTRIBUTING.md covers: environment setup, running tests, making a PR, adding a component
- [ ] LICENSE file present and correct
- [ ] Release `v0.1.0` published as GitHub Release with changelog + tagged Docker image

### Dependencies
- Phases 0-11 (Everything must be implemented and tested before OSS release)

### Plan Files
- ⚠️ **New:** `oss-readiness.md` — create before starting this phase

### Open Decisions
- License: MIT vs Apache 2.0
- Docs framework: VitePress vs Docusaurus vs Starlight
- Release cadence: time-based (e.g., monthly) or milestone-based?

---

## Post-Launch (Not in v1 Scope)

| Topic | Discussion Needed |
|---|---|
| Redis-backed token cache for multi-instance | Auth scalability |
| Admin UI (React + shadcn/ui — folder skeleton exists) | UI scope and priority |
| Retry/timeout/circuit breaker policy | Resilience layer |
| Workflow intermediate state persistence | Crash recovery |
| API versioning strategy | Stable API contract |
| Built-in rate limiting | Infrastructure |
| Plugin system for loading third-party components at runtime | Extensibility |
| Observability: metrics, tracing (OpenTelemetry) | Production readiness |
| gRPC component | Additional protocols |
| Queue consumer support (SQS/Kafka/RabbitMQ consume) | Background listener architecture — see Phase 11 scope flag |
| Async invoke + execution polling for long workflows | Avoids reverse-proxy/gateway timeouts on long sequential+parallel chains |
