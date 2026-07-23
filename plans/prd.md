# Product Requirements Document — Apiconfy

> **Status:** 📝 Draft  
> **Version:** v0.4  
> **Last Updated:** 2026-07-19

---

## 1. Problem Statement

Modern applications integrate with dozens of external systems — REST APIs, message queues, databases, file servers, and cloud platforms. Every integration demands custom code: authentication handling, request mapping, response transformation, error handling, and workflow coordination. This code is repetitive, error-prone, and reinvented for each connection.

Apiconfy replaces this pattern with a **declarative integration runtime**: developers register a component once (REST API, FTP, SQS, database, scheduler, etc.) and invoke it — or chain multiple components — without writing integration-specific code. The runtime handles execution, transformation, validation, and orchestration.

The domain concepts are proven: Apiconfy is a Node.js/Bun + TypeScript rewrite of an internal Java Spring Boot integration service that has been running in production. This rewrite preserves the battle-tested domain model while rebuilding the implementation on a modern stack.

---

## 2. Target Users & Use Cases

**Primary: Backend/platform engineers** who build and maintain system integrations.

**Use cases:**
- **API orchestration:** Call multiple REST APIs in sequence, pass data between them, validate responses, return a unified result.
- **Event-driven automation:** When a customer is created, automatically update the CRM, publish a message to SQS, and send a notification — with rollback if any step fails.
- **Declarative data pipelines:** Fetch data from a REST API, transform and filter it, push it to a queue or database — defined as config, not code.
- **Scheduled integrations:** Run an FTP file transfer every hour, process the file, and push results to an API — triggered by cron, no custom scheduler.
- **Ad-hoc integration tooling:** Invoke a registered component via an HTTP call, or trigger a multi-component workflow from any application — without writing an HTTP client for every downstream service.
- **In-component data transformation:** Insert a pure data transformation step (inline component) between external calls — reshape, enrich, or filter the context without making an HTTP call.

---

## 3. Goals

1. **Replace custom integration code with declarative config.** A component definition (auth, URL, mappings, validation) is all that's needed to talk to an external system.
2. **Compose components into workflows.** Sequential and parallel execution across any registered components, with shared context threading between steps.
3. **Handle auth transparently.** OAuth2, JWT, basic auth, and SSL/mTLS handled by the runtime — components don't implement their own auth.
4. **Be extensible.** New component types can be added by implementing the `ComponentHandler` interface in-repo — no core runtime changes needed, just a new handler registered at startup.
5. **Zero-config to start.** SQLite is the default database — no external dependencies needed to run locally. First-party support scales to PostgreSQL via the same SQL-oriented adapter (Drizzle). MongoDB, Couchbase, and Oracle are supported through the `DBAdapter` interface but are not guaranteed drop-in via Drizzle, since it is a SQL-dialect ORM — these adapters may require bespoke implementations rather than a dialect swap. See Open Questions.
6. **Be lightweight and developer-friendly.** One binary or Bun script to run. Fast startup. Monorepo managed by Turborepo. TypeScript throughout.
7. **Non-blocking execution throughout.** Every component invocation, every workflow step, every database operation, every transformation — all execution must be non-blocking and non-blocking. The runtime never blocks the event loop. Asynchronous-only by design. This applies to the executor, orchestrator, DB layer, auth proxy, logging, and every package in between. No `readFileSync`, no blocking SQLite calls, no synchronous HTTP clients. When Bun's built-in APIs have sync variants (`bun:sqlite`), they are wrapped in worker threads or `Bun.spawn` to avoid blocking.

---

## 4. Explicit Non-Goals

**Apiconfy is NOT a general-purpose workflow engine.** It does not and will not provide:

- ❌ Durable execution history with replay capability (like Temporal)
- ❌ Human-in-the-loop tasks or approval gates
- ❌ A visual workflow designer / drag-and-drop UI
- ❌ A full state-machine DSL (like AWS Step Functions)
- ❌ Long-running sagas with sleep/wait states spanning hours or days
- ❌ A hosted cloud service (Apiconfy is self-hosted open-source)

**Scope boundary:** Combine registered components and execute them sequentially or in parallel, driven by component configuration. Anything beyond that is outside scope.

Additional non-goals:
- ❌ Building a replacement for API gateways (Kong, Tyk)
- ❌ General-purpose ETL or data pipeline engine
- ❌ Message broker or event bus
- ❌ Full admin UI in v1 (the admin UI is a future phase)
- ❌ SDK for third-party component publishing (extensibility is in-repo only via `ComponentHandler`)
- ❌ CLI tooling (`apiconfy` CLI commands)

---

## 5. Core Concepts

These are functional descriptions, not API contracts. The exact registration and invocation interfaces will be designed during the relevant phases.

### 5.1 Component

A reusable, pluggable capability that interacts with an external system — or transforms data without one. Each component type (REST, FTP, SQS, database, scheduler, webhook, inline) implements a common `ComponentHandler` interface. Built-in components ship with the runtime.

A component definition includes:
- **Identity:** Type (rest, ftp, etc.), display name
- **Connection:** Target URL, method, headers, timeout (for external components)
- **Auth:** Type and credentials (delegated to auth proxy)
- **Request mapping:** How to transform the invocation context into the outgoing payload
- **Response mapping:** How to extract fields from the external response
- **Validation:** Non-null paths and conditions that the response must satisfy
- **Condition:** Optional expression that determines whether the component executes or is skipped
- **Content type:** JSON (default), form-urlencoded, multipart — with automatic serialization

There are two categories of components:
1. **External components** (REST, FTP, SQS, Kafka, RabbitMQ, database): Make an outbound call to an external system.
2. **Inline components** (transform/expression, webhook): Operate purely on the execution context without calling an external system — for data transformation, filtering, enrichment, and receiving incoming triggers.

### 5.2 Registration

Components are registered dynamically at runtime — not via a static config file checked into source control — because definitions need to be created, updated, and queried by various callers (an admin UI, another service). Once registered, a component can be invoked by its natural key: `{serviceName}/{component}/{serviceType}`.

### 5.3 Invocation

A registered component is invoked on demand with an arbitrary JSON `context` payload (no fixed schema). The runtime looks up the definition, resolves request mappings against the context, acquires auth tokens if needed, executes the external call, validates the response, applies response mappings, and returns the transformed result.

### 5.4 Context Threading

In a multi-component chain (workflow), each component's response is merged back into a shared execution context data bag. Any later component can read the output of any earlier component — not just the immediately prior one. There are no `$.context` vs `$.response` path prefixes; the transformation engine is path-agnostic and resolves relative to the flat context data bag.

### 5.5 Composition

Components are organized into groups within a workflow. Groups run sequentially (group 0 → group 1 → group 2 → ...). Within a group, components run in parallel unless a `dependsOnStepId` declares an explicit dependency. Composition is driven entirely by configuration — no hand-authored graph, no visual designer.

### 5.6 Transformation

Request mapping transforms the execution context into the payload sent to the external system. Response mapping extracts fields from the external response into the result returned to the caller. The transformation engine uses a path expression language (JSONPath, JMESPath, or JSONata — to be decided in a pre-phase 3 spike) and is path-agnostic: no hardcoded `$.context` or `$.response` prefixes.

### 5.7 Event → Action Mapping

Named events map to one or more component actions. Triggering an event (via API call or webhook) executes the mapped chain. This decouples the event source from the integration logic — the event name is the contract, and the mapping is configuration.

### 5.8 Rollback

If a workflow step fails mid-chain, prior successfully completed steps can be rolled back via configured compensating actions. Each step can declare a rollback service/type, or a `rollbackAllPrevious` flag to undo every prior step. Rollback runs in reverse order (last completed first) and is best-effort — rollback failures are logged but don't block other rollbacks.

### 5.9 Non-Blocking Execution

All execution in Apiconfy is non-blocking. Every component invocation, workflow step, database operation, transformation, auth token acquisition, and log write must use async APIs. The event loop never blocks. This is a hard architectural requirement:

- **No sync I/O anywhere.** No `readFileSync`, no blocking SQLite queries, no synchronous HTTP clients.
- **Bun SQLite handling:** `bun:sqlite`'s native query interface is synchronous. The SQLite adapter wraps queries in `Bun.spawn` worker threads or uses `Database.query()` carefully to avoid blocking the event loop on large datasets.
- **Hono + Bun:** Hono on Bun supports native async handlers — all routes and middleware return `Promise<Response>`.
- **All packages:** `packages/shared`, `packages/db`, `packages/runtime`, `packages/transform`, `packages/components`, `packages/auth` — every function that does I/O or CPU-bound work must be `async` or offloaded.
- **Non-blocking transforms:** Template resolution and expression evaluation are synchronous (pure computation) but must return in sub-millisecond time. Heavy transforms or large object traversals use `setImmediate` or are split into microtasks to yield the event loop.

This is not a performance optimization — it's the architectural baseline. Nothing in Apiconfy blocks the event loop.

### 5.9 Auth Handling

Components delegate auth to a built-in auth proxy that handles:
- OAuth2 client_credentials and password grants
- JWT token acquisition with expiry tracking
- Basic auth
- Two-way SSL / mTLS
- SSL disable for non-production environments
- Token caching with TTL and automatic retry on 401

**Credential storage and redaction:** Component definitions may contain secrets (OAuth2 client secrets, basic-auth passwords, JWT credentials, mTLS keys). These must be encrypted at rest in the persistence layer, and redacted (masked) whenever a component definition is returned via a read API (`GET`/list) or written to execution logs. This is treated as a security requirement, not an optional hardening pass — see FR-0.8 and FR-1.6.

---

## 6. Functional Requirements (by Phase)

### Phase 0 — Foundation
- **FR-0.1:** Monorepo scaffold with Turborepo, TypeScript strict mode, and Bun as primary runtime.
- **FR-0.2:** Database persistence layer with SQLite zero-config fallback and adapter pattern for PostgreSQL, MongoDB, Couchbase, Oracle.
- **FR-0.3:** Structured logging (pino) with app logs to stdout and execution logs persisted to DB.
- **FR-0.4:** Test suite running in CI with in-memory SQLite.
- **FR-0.5:** Server health check endpoint (`GET /health`) returning status and DB connectivity.
- **FR-0.6:** API key authentication middleware for all routes (configurable, skippable for dev).
- **FR-0.7:** Standardized error code taxonomy: NOT_FOUND, VALIDATION_FAILED, AUTH_FAILED, EXTERNAL_SERVICE_ERROR, TRANSFORMATION_ERROR, WORKFLOW_ERROR.
- **FR-0.8:** Secret redaction utility: any credential-shaped field (secrets, passwords, tokens, keys) is masked before being written to logs, regardless of which package emits the log line.

### Phase 1 — Component Registry
- **FR-1.1:** API to register a component definition (type, identity, connection details, auth, mappings, validation).
- **FR-1.2:** API to look up a component by its natural key: `serviceName/component/serviceType`.
- **FR-1.3:** API to list components with optional filters, pagination (limit/offset or cursor), get by ID, and delete.
- **FR-1.4:** Component definitions persist across server restarts.
- **FR-1.5:** Registration payloads are validated (Zod) per component type.
- **FR-1.6:** API to update an existing component definition (partial update). Updating does not change the natural key or component ID.
- **FR-1.7:** Duplicate registration behavior is explicit: registering an already-existing natural key either upserts (updates in place) or returns `409 Conflict` — decision to be finalized during Phase 1 plan review, not left implicit.
- **FR-1.8:** Auth credential fields (secrets, passwords, tokens, private keys) are encrypted at rest in the database, and redacted (e.g. `***`) whenever a component definition is returned by `GET`/list, per FR-0.8.

### Phase 2 — Single Component Execution (REST, no transformation)
- **FR-2.1:** API to invoke a registered REST component by its natural key with an arbitrary JSON payload.
- **FR-2.2:** Runtime resolves component definition, makes the HTTP call, and returns the raw response.
- **FR-2.3:** Environment-based configuration: port, DB type, API key.
- **FR-2.4:** Consistent JSON response envelope (success/error/data/meta).
- **FR-2.5:** Execution audit trail: every invocation logged with execution ID, duration, status.
- **FR-2.6:** Configurable request timeout per component with sensible default (30s).
- **FR-2.7:** Content type handling: JSON (default), application/x-www-form-urlencoded, multipart/form-data.

### Phase 3 — Transformation Engine
- **FR-3.1:** Request mapping: transform context using path expressions before sending to external system.
- **FR-3.2:** Response mapping: extract fields from external response into result using path expressions.
- **FR-3.3:** Pure path resolution: `"$.id"` → value (as-is type).
- **FR-3.4:** Embedded path substitution: `"prefix-$.id-suffix"` → `"prefix-42-suffix"`.
- **FR-3.5:** Nested object/array template resolution.
- **FR-3.6:** Unresolved paths kept as literals (no throw).
- **FR-3.7:** Dynamic URL resolution: template expressions in the component's `url` field resolve against context before the call.
- **FR-3.8:** Dynamic header resolution: template expressions in header values resolve against context.
- **FR-3.9:** Outbound request safety: since resolved URLs can be influenced by caller-supplied context, requests targeting private/link-local IP ranges (e.g. `127.0.0.1`, `169.254.169.254`, `10.0.0.0/8`, `192.168.0.0/16`) are blocked by default (configurable allow-list for legitimate internal use), to prevent SSRF via dynamic URL templating.

### Phase 4 — Auth & Connection Handling
- **FR-4.1:** OAuth2 client_credentials grant: acquire token, cache, attach to requests.
- **FR-4.2:** OAuth2 password grant.
- **FR-4.3:** JWT token acquisition with exp-based expiry.
- **FR-4.4:** Basic auth via Authorization header.
- **FR-4.5:** Token cache: in-memory with TTL, auto-retry on 401.
- **FR-4.6:** Two-way SSL / mTLS configuration.
- **FR-4.7:** SSL disable toggle for non-production environments.

### Phase 5 — Multi-Component Composition (Sequential)
- **FR-5.1:** API to register a workflow definition: ordered groups of component references.
- **FR-5.2:** API to invoke a workflow by name with a payload.
- **FR-5.3:** Sequential group execution: group 0 completes → group 1 starts → ....
- **FR-5.4:** Shared context threading: each component's response merged into context before next group.
- **FR-5.5:** Workflow-level response mapping: shape the final result from accumulated context.
- **FR-5.6:** Inline/expression component: standalone data transformation step that reshapes context without calling an external system — useful for enrichment, filtering, and field renaming between external calls.
- **FR-5.7:** API to list, get, update, and delete workflow definitions — parity with component CRUD (FR-1.3, FR-1.6).

### Phase 6 — Parallel Execution
- **FR-6.1:** Components in the same group execute in parallel via Promise.all.
- **FR-6.2:** Within-group dependency ordering via `dependsOnStepId`.
- **FR-6.3:** Partial failure handling: if one parallel step fails, all sibling promises settle (log errors, trigger rollback).
- **FR-6.4:** Parallel component responses merged into shared context.
- **FR-6.5:** Workflow registration validates that `dependsOnStepId` references form an acyclic graph within each group; a circular dependency is rejected at registration time with a structured error, not discovered at execution time.

### Phase 7 — Conditional Execution & Response Validation
- **FR-7.1:** Component-level condition: expression evaluated against context; if false, skip execution and return `skippedExecution: true`.
- **FR-7.2:** Response validation: non-null JSONPath checks after external call.
- **FR-7.3:** Response validation: condition-based checks (eq, neq, gt, lt, exists, regex).
- **FR-7.4:** Validation failure returns structured error with path and reason.

### Phase 8 — Event → Action Mapping
- **FR-8.1:** API to register an event and map it to one or more component actions.
- **FR-8.2:** API to trigger an event by name with a payload.
- **FR-8.3:** Event trigger executes the mapped component chain.
- **FR-8.4:** Event payload is passed as the initial execution context.

### Phase 9 — Rollback / Compensating Actions
- **FR-9.1:** Step-level rollback config: `rollbackServiceName` + `rollbackServiceType`.
- **FR-9.2:** Workflow-level rollback: `rollbackAllPrevious` flag on any step.
- **FR-9.3:** Rollback runs in reverse order on any step failure.
- **FR-9.4:** Rollback is best-effort: failures are logged without blocking other rollbacks.
- **FR-9.5:** Original error returned to caller after rollback completes.

### Phase 10 — Scheduler + Webhook Callbacks
- **FR-10.1:** Register a scheduled task with a cron expression that triggers a workflow.
- **FR-10.2:** Scheduler runs in-process with configurable timezone.
- **FR-10.3:** Webhook component: register an endpoint that, when called, triggers a workflow.
- **FR-10.4:** Webhook payload is passed as execution context.

### Phase 11 — Additional Components
- **FR-11.1:** FTP/SFTP component: file upload, download, list, delete.
- **FR-11.2:** SQS component: publish messages (request/response). Consuming messages requires a background listener process, architecturally distinct from every other component in this runtime (which is request/response over HTTP) — see Open Questions for whether consumer support ships in v1 or is deferred.
- **FR-11.3:** Kafka component: produce (request/response). Consume has the same background-listener caveat as FR-11.2.
- **FR-11.4:** RabbitMQ component: publish (request/response). Consume has the same background-listener caveat as FR-11.2.
- **FR-11.5:** Database component: execute queries against connected databases.
- **FR-11.6:** Integration test infrastructure (e.g. Docker Compose or Testcontainers) for FTP/SQS/Kafka/RabbitMQ, runnable in CI — not just mocked unit tests.

### Phase 12 — OSS Readiness
- **FR-12.1:** Public documentation site with getting-started, concepts, API reference.
- **FR-12.2:** Contribution guide (CONTRIBUTING.md).
- **FR-12.3:** Open-source license (MIT or Apache 2.0).
- **FR-12.4:** Example integrations (at least 3 end-to-end examples).
- **FR-12.5:** Release process and changelog.

---

## 7. Success Metrics (v1)

| Metric | Target |
|---|---|
| Time to first invocation | Under 5 minutes from `bun install` to successful REST component invoke |
| Zero-config startup | `bun run dev` starts server with SQLite, no env vars needed |
| Component registration → invocation | Single HTTP call to register, single call to invoke |
| Multi-component workflow | Register components, define workflow, invoke workflow — all via API |
| Test coverage | ≥80% on runtime, transform, and components packages |
| CI pipeline | Full test suite runs on every PR, passes in under 2 minutes |

---

## 8. Open Questions & Risks

### Open Questions
1. **Transformation library:** JSONPath (jsonpath-plus) vs JMESPath vs JSONata. Needs a spike in Phase 3.
2. **Expression evaluator:** The original service uses SpEL-style conditional expressions. Do we need a separate expression language, or can we use the transformation engine's path language with inline operators?
3. **Workflow persistence:** Currently stateless — workflow execution state lives in memory during invocation. Should intermediate state be persisted for crash recovery? (Likely a post-v1 concern.)
4. **Multi-instance auth cache:** Token cache is in-memory per process. Redis-backed cache for multi-instance deployments?
5. **API versioning:** Not part of v1 scope. Decisions about versioning strategy can be deferred.
6. **Multi-DB feasibility:** Drizzle is a SQL-dialect ORM. MongoDB/Couchbase adapters likely require bespoke, non-Drizzle implementations rather than a dialect swap — is first-class Mongo/Couchbase support realistic for v1, or should v1 commit to SQL databases only (SQLite + Postgres) and treat others as community-contributed adapters?
7. **Queue consumer architecture:** Publish-style components fit the existing request/response executor. Consume-style components (SQS/Kafka/RabbitMQ) need a long-running background listener, which is new architectural territory — how does a listener start/stop, and how does a consumed message trigger a workflow in an otherwise stateless, HTTP-request-driven runtime? Does v1 ship consumers at all, or defer to post-launch?
8. **Async invocation for long chains:** All invoke APIs are currently synchronous — the caller blocks on one HTTP request for an entire (potentially multi-step, sequential+parallel) workflow. Long chains risk exceeding typical reverse-proxy/gateway timeouts (often 30–60s). Is an async invoke pattern (return an execution ID immediately, poll or webhook for completion) needed for v1, or explicitly deferred?
9. **SSRF mitigation defaults:** FR-3.9 blocks private/link-local IP ranges by default — confirm this default (vs. an opt-in allow-list-only model) is the right posture before Phase 3 implementation, since some legitimate self-hosted use cases do target internal networks.

### Risks
1. **Feature creep into workflow engine territory:** The "not a workflow engine" boundary must be enforced. Each phase's exit criteria act as a gate — if a feature pushes toward durable execution or state-machine DSL, it's out of scope.
2. **Underspecified auth:** The original service handled two-way SSL at a level (Java keystores) that may not map cleanly to Bun TLS. Needs investigation during Phase 4 planning.
3. **SQS/Kafka/RabbitMQ abstraction leak:** Each messaging system has different semantics. A generic "queue" component may need to be system-specific.
4. **Credential exposure:** Component definitions carry live credentials (OAuth2 secrets, passwords, private keys). Without encryption at rest and consistent redaction across every read path and log line (FR-0.8, FR-1.8), this becomes a trust-breaking security issue for an OSS project asking users to self-host with real credentials.
5. **SSRF via dynamic URL/header templating:** Caller-supplied context resolves directly into outbound URLs and headers (FR-3.7/3.8). Without a default safeguard (FR-3.9), this is a realistic attack surface for a self-hosted server that makes outbound calls on behalf of its configuration.
