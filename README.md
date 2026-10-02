# Apiconfy

<p align="center">
  <b>A declarative integration runtime built on composable components.</b>
</p>

---

## Overview

Apiconfy is an open-source, lightweight integration runtime designed to simplify how applications connect with external systems.

Modern applications often need to integrate with multiple systems such as APIs, queues, databases, file systems, and third-party platforms. Building these integrations usually requires custom code for every connection, including authentication, request mapping, response transformation, error handling, and workflow coordination.

Apiconfy introduces a component-based approach where integrations can be defined, reused, and orchestrated through declarative configurations instead of writing custom integration code repeatedly.

The goal is to provide a flexible runtime where any external capability can be exposed as a reusable component and composed into integration workflows.

---

## Why Apiconfy?

**Traditional integration approach:**

```
Application
    |
    v
Custom Integration Code
    |
    v
External System
```

Every new integration requires:

- Custom client implementation
- Authentication handling
- Request/response mapping
- Data transformation
- Error handling
- Workflow logic

This gets repeated, with small variations, for every API, queue, or file system an application talks to.

**The Apiconfy approach:**

```
Component Definition
    |
    v
Apiconfy Runtime
    |
    v
External Systems
```

Developers define reusable components once, and let the runtime handle execution, transformation, and orchestration.

---

## Core Concepts

### Components

Components are the foundation of Apiconfy.

A component represents a reusable capability that can interact with an external system or perform an operation.

Examples:

- REST API Component
- Queue Producer Component
- Queue Consumer Component
- Database Component
- Scheduler Component
- Webhook Component
- Custom Components

Components are designed to be extensible, allowing new integrations to be added without modifying the core runtime.

### Declarative Configuration

Instead of writing integration-specific code, developers **register** a component by sending its definition to the runtime — component type, connection details, authentication, request/response mapping, execution rules, and metadata.

> **Phase 2 service contract** — implemented and verified. Workflow
> examples later in this README remain planned (Phase 5).

> **Note on `context`:** `context` is an arbitrary JSON payload — its shape is entirely up to the caller and the component definition's mapping rules. It is not a fixed schema. The `customer`/`id` fields used throughout these examples are illustrative only, to keep the examples concrete and easy to follow.
>
> **`$context` is internal.** The runtime wraps the caller's payload into its own execution bag and
> references it as `{$context.*}` in templates, conditions and validation rules; the same wrapping
> serves workflow execution (Phase 5). Callers send plain JSON — never `$context`, `$output` or
> `$env` fields — and `output` inside the payload is reserved (`400`). Payload validation paths name
> the payload's own fields (`userId`), never `context.userId`. A template reference to a missing
> field resolves to `null` (identical to a present null), so placeholder text can never leak into a
> payload or a transformed response.

**Register a service:**

```
POST /api/v1/services
Content-Type: application/json

{
  "service": "customer-service",
  "action": "create_customer",
  "componentType": "rest",
  "config": {
    "request": {
      "uri": "https://example.com/customer",
      "method": "POST",
      "payloadTemplate": {
        "customerId": "{$context.id}"
      },
      "validation": {
        "fields": [{ "path": "id", "required": true, "type": "string" }]
      }
    },
    "output": {
      "transformation": {
        "createCustomerResponse": { "customerId": "{$output.id}" }
      }
    }
  }
}
```

**Invoke the registered service:**

```
POST /api/v1/services/customer-service/create_customer/invoke
Content-Type: application/json

{
  "id": "12345"
}
```

The body is the context itself — send the API payload as-is. Wrapping it as
`{ "context": { "id": "12345" } }` is also accepted.

**Response:**

```json
{
  "data": { "createCustomerResponse": { "customerId": "12345" } }
}
```

On failure the HTTP status carries the outcome and the body is
`{ "error": { "code", "message", "details" } }`. The execution id is returned in the
`Execution-Id` response header (use it with `GET /api/v1/executions/:id`).
For upstream failures `error.details.body` is the upstream's own response body.

The runtime looks up the stored definition, executes it against the external system, applies the response mapping, and returns the transformed result — no custom client code required. This mirrors a register-once, invoke-anywhere model rather than a static config file checked into the repo, since definitions are expected to be created, updated, and queried at runtime (e.g. from an admin UI or another service).

### Component Composition (Sequential & Parallel)

> **Scope note:** Apiconfy is **not** a general-purpose workflow engine (like Temporal or Netflix Conductor). It does not provide durable execution history with replay, a visual drag-and-drop workflow designer, or a full state-machine DSL. Its scope is intentionally narrower but powerful: **compose registered components into sequential and parallel workflows with config-driven execution ordering, shared context threading, conditional execution, response validation, and compensation (saga-style rollback)**. Workflows are defined declaratively and executed in-process — no external orchestration service required.

Multiple components can be composed together and executed — any component can be chained after any other, regardless of type (a REST call feeding a queue, a file drop triggering a database write, and so on). Components in the same group can run in parallel; components with a declared dependency run sequentially.

```
Event
  |
  v
REST API Component
  |
  v
Data Transformation
  |
  v
Queue Component
  |
  v
Notification Component
```

**How data flows through a workflow:**

Each component's response is merged back into a shared execution context before the next component runs. That means every step in the chain can read the output of any step before it — not just the one immediately prior. Once the last component finishes, the runtime returns a single final response to the caller (optionally shaped by a workflow-level response mapping), rather than requiring the caller to poll or stitch results together manually.

> 🚧 **Planned — workflow registration and execution are Phase 5.** The service CRUD routes above are Phase 1 (complete).

**Register a workflow:**

```
POST /api/v1/workflows
Content-Type: application/json

{
  "name": "customer-onboarding",
  "groupId": "customer-group-1",
  "steps": [
    {
      "name": "Create Customer",
      "service": "customer-service",
      "action": "create_customer",
      "compensationAction": "delete_customer",
      "onFailure": "halt"
    },
    {
      "name": "Publish Event",
      "service": "queue-service",
      "action": "publish_customer_created",
      "onFailure": "continue"
    },
    {
      "name": "Send Welcome Email",
      "service": "notification-service",
      "action": "send_welcome_email",
      "compensationAction": "send_apology_email",
      "onFailure": "compensate"
    }
  ],
  "responseTransformation": {
    "customerId": "{$context.createCustomerResponse.customerId}",
    "messageId": "{$context.publishEventResponse.messageId}",
    "status": "{$context.sendEmailResponse.status}"
  }
}
```

**Execute the workflow:**

```
POST /api/v1/workflows/customer-onboarding/execute
Content-Type: application/json

{
  "context": {
    "id": "12345",
    "name": "John"
  }
}
```

Internally, this executes as:

```
Step 1 — REST API Component (create_customer)
  context.id → request
  response { customerId } → merged into context

Step 2 — Queue Component (publish_customer_created)
  context.customerId → request
  response { messageId } → merged into context

Step 3 — Notification Component (send_welcome_email)
  context.customerId, context.messageId → request
  response { status } → merged into context
```

**Final response returned to the caller:**

```json
{
  "success": true,
  "data": {
    "customerId": "12345",
    "messageId": "msg-98231",
    "status": "sent"
  },
  "meta": {
    "executionId": "uuid",
    "workflowName": "customer-onboarding",
    "workflowStatus": "COMPLETED"
  }
}
```

**Compensation on failure:** If a step with `onFailure: "compensate"` fails, all previously completed steps execute their `compensationAction` in reverse order (saga pattern). Steps with `onFailure: "halt"` (default) stop execution immediately without compensation. Steps with `onFailure: "continue"` are logged and skipped, allowing the workflow to proceed.

This enables building reusable integration flows for:

- Business processes (with saga-style rollback on failure)
- Data synchronization
- System integration
- Event-driven automation
- Third-party service coordination

### Event-Driven Execution

Apiconfy is designed around event-driven execution. An event can trigger pre-configured component chains without knowing the implementation details.

Example:

```
CustomerCreated Event
      |
      v
Create Customer Account
      |
      v
Publish Message
      |
      v
Send Notification
```

Planned capabilities include event listeners, message consumers, scheduled triggers (cron-based via the scheduler component), and background workers.

---

## Supported Integration Patterns

**API Integrations**
Examples: REST APIs, HTTP services, webhooks
Capabilities: request transformation, response transformation, authentication handling, dynamic execution

**Messaging Integrations**
Examples: message queues, event streams
Capabilities: publish messages, consume events, trigger workflows

**File / Object Storage Integrations**
Examples: S3 object storage, file generation and processing
Capabilities: file generation, object upload/download, data transformation

**Automation**
Examples: scheduled jobs, timed execution, background processing

---

## Architecture Vision

```
                    Apiconfy Runtime
                            |
        ------------------------------------------
        |                   |                    |
   Components           Workflows            Scheduler
        |                   |                    |
        ------------------------------------------
                            |
                    External Systems

         REST | Queue | Storage | Database | Events | APIs
```

### Extensible Plugin Architecture

Apiconfy is designed to support custom components. Developers will be able to create new components for internal services, enterprise systems, cloud services, and custom business operations.

The runtime focuses on execution — components provide the capabilities.

---

## Technology

| | |
|---|---|
| **Runtime** | Bun |
| **Language** | TypeScript |
| **Package Manager** | pnpm |
| **Framework** | Hono |
| **ORM** | Drizzle |
| **Databases** | SQLite (default), PostgreSQL, Oracle, MongoDB, Couchbase |
| **Monorepo** | Turborepo |
| **Design Goals** | Lightweight, extensible, plugin-based, developer friendly, cloud native, easy to deploy |

---

## Getting Started

**Prerequisites:** Bun (1.4.x) and pnpm (≥9.x).

> **Use `pnpm` for installs — not `bun install`.** The workspace is declared in `pnpm-workspace.yaml`, which bun does not read, so `bun install` would install only the root devDependencies and leave `apps/server` without its runtime dependencies. `pnpm-lock.yaml` is the single lockfile; `bun.lock` is gitignored. Bun is the runtime and test runner only.

```bash
# Clone and install
git clone https://github.com/apiconfy/apiconfy.git
cd apiconfy
pnpm install

# Start the dev server
pnpm dev

# Run tests
pnpm test
pnpm run test:coverage

# Build for production
pnpm build
```

The server starts on `http://localhost:3000` with a health check at `GET /health`.

**Database:** SQLite is the default for local development — no configuration needed. The database file is created automatically at `data/apiconfy.db` on first run. The `data/` directory is gitignored and only used locally. With `DATABASE_URL` unset or empty the server selects SQLite and logs a warning at startup: a single local file has no durability guarantees of its own, so for production prefer a **replicated SQLite** (Turso, LiteFS) or a server engine. The warning is informational — the process never refuses to start over it.

**Supported databases (Phase 3 complete):** the engine is selected by the `DATABASE_URL` scheme — a named engine is never bypassed in favour of SQLite, and an unknown scheme refuses to start.

| Engine | `DATABASE_URL` | Notes |
|---|---|---|
| **SQLite** (default) | unset/empty, or `sqlite:./data/apiconfy.db` (or `SQLITE_PATH`) | Local-development engine and the only one that **self-creates** its schema; a single local file — for production prefer a replicated SQLite (Turso, LiteFS) or a server engine |
| **PostgreSQL** | `postgres://user:pass@host:5432/apiconfy` | Drizzle + postgres.js; run the DDL once: `psql -f apps/server/src/core/db/schema/sql/postgres.sql` |
| **Oracle** | `oracle://user:pass@host:1521/ORCL` | `oracledb` driver with raw SQL; run `sqlplus <admin>@//host:1521/service @apps/server/src/core/db/schema/oracle/oracle.sql` |
| **MongoDB** | `mongodb://user:pass@host:27017/apiconfy` | Native driver; transactions require a replica set (CI runs a single-node `rs.initiate`); run `mongosh "<DATABASE_URL>" apps/server/src/core/db/schema/mongodb/mongodb.js` |
| **Couchbase** | `couchbase://localhost` + `CB_BUCKET` (+ `CB_USER`/`CB_PASS`) | SDK with KV inserts and N1QL by-id reads; run `CB_BUCKET=apiconfy bun run apps/server/src/core/db/schema/couchbase/couchbase.js`. Transactions are intentionally not implemented |

The app never creates schema on a named engine: on startup it **probes** for the required tables/collections/indexes and exits with the missing-object list, the script path and the GitHub URL when any are absent.

**Execution log saving is optional.** Per-invocation audit rows in `execution_logs` are written only when `ENABLE_DB_TRANSACTION_LOGS=true` (off by default — the startup probe then treats the table as optional). When you enable it on a named engine, uncomment the `execution_logs` block in that engine's schema script before running it. **Retention:** the purge is designed and scheduled for **Phase 5** (`plans/multi-db-strategy.md` → "Execution Retention & Purge"): a background task (once at startup, then every 24h) deletes `execution_logs` then `executions` older than **15 days** from `created_at` — configurable via `EXECUTION_LOG_RETENTION_DAYS` (default `15`) — best-effort, never blocking execution. Until it ships, the tables grow with traffic and operators own cleanup.

**Production / Cloud:** set `DATABASE_URL` to the engine you run — `postgres://`, `oracle://`, `mongodb://` or `couchbase://` (+ `CB_BUCKET`). A named engine is never bypassed in favour of SQLite; an unknown scheme refuses to start. **Graceful shutdown:** on `SIGTERM` the server stops accepting connections, lets in-flight requests finish, flushes queued execution records (bounded 10s drain), then closes the database — keep `terminationGracePeriodSeconds` above ~15s (the default 30s fits) and prefer a `preStop` sleep so endpoint removal doesn't cut off traffic.

---

## Environment Variables

> See [`.env.example`](.env.example) for a copy-ready template: every engine's connection string commented, SQLite as the local-development default, and the optional overrides.

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `3000` | HTTP server port |
| `LOG_LEVEL` | `info` | Log level for pino (`trace`, `debug`, `info`, `warn`, `error`, `fatal`) |
| `API_KEY` | *(unset)* | Bearer token for `/api/*` routes. If unset, all routes are open (warning logged at startup) |
| `REQUIRE_API_KEY` | `false` | When `true`, server refuses to start if `API_KEY` is missing. Set this in production |
| `DATABASE_URL` | *(unset → SQLite)* | Selects the database engine by URL scheme: `postgres://`, `oracle://`, `mongodb://`, `couchbase://` (+ `CB_BUCKET`) or the explicit `sqlite:` scheme. Unset or empty → SQLite, with a local-development warning logged at startup; an unknown scheme refuses to start |
| `SQLITE_PATH` | `../../data/apiconfy.db` | SQLite database file path when no engine is selected — or when the `sqlite:` URL omits a path |
| `CB_BUCKET` | *(unset)* | Couchbase bucket name — required whenever `DATABASE_URL` uses `couchbase://` |
| `CB_USER` | `Administrator` | Couchbase username, used when the `couchbase://` URL carries none |
| `CB_PASS` | *(unset)* | Couchbase password, used when the `couchbase://` URL carries none — required in that case, or the adapter refuses to start |
| `ENABLE_DB_TRANSACTION_LOGS` | `false` | When `true`, writes the optional `execution_logs` audit rows (the table must exist — uncomment its block in the engine's schema script before running it). Off by default; no automatic retention/purge yet (Phase 5) |
| `NODE_TLS_REJECT_UNAUTHORIZED` | *(unset)* | Leave unset. `0` disables TLS verification for the entire process; the server ignores it at startup (warning logged) and `bun test` unsets it, so outbound calls always verify certificates. Skip verification per component with `request.disableSSL` |

**Security note:** If `API_KEY` is not set, a warning is logged at startup and all `/api/*` routes are accessible without authentication. For production deployments, always set `API_KEY` and `REQUIRE_API_KEY=true`.

---

## Testing the API

A [Postman collection](postman/apiconfy.postman_collection.json) is included for manual and exploratory testing. It covers every implemented endpoint with simple and complex examples.

**Import:**
1. Open Postman → **Import** → select `postman/apiconfy.postman_collection.json`
2. Set the `base_url` collection variable (default: `http://localhost:3000`)
3. If `API_KEY` is configured, set the `api_key` collection variable for Bearer auth
4. Start the server (`pnpm dev`) and run the requests

The collection is organized **by component type**. REST → Invoke and **Script** contain ordered
Simple Examples, Complex Examples and Error Cases: register each example before invoking it.
Invoke scripts save the `Execution-Id` response header as `execution_id` for execution lookup. The simple
scenario calls the local health endpoint; the Script complex example calls a registered REST
echo through the script bridge. Complex scenarios use `upstream_url` (default
`https://httpbin.org`); send only dummy data or point it at your own compatible server.

Complex examples with `auth.jwt` or circuit-breaker are **registration-only** until their
execution capabilities arrive (`auth.basic` and `auth.oauth2` execute). Runnable complex examples include every supported
section (request, timeout, retry, condition, request-payload validation, response
validation, transformation and metadata) and intentionally omit unsupported
auth/circuit-breaker fields. The REST → TLS Certificates group is registration-only
(its upstream is not HTTPS); real handshakes are covered by the integration tests. Future
component folders (Mapper, Database, SQS) show the same `validation` block in their own config sections.

### Phase 2 invocation behavior

- `POST /api/v1/services/:service/:action/invoke` takes the context as the JSON body, raw or wrapped in a lone `{ "context": { ... } }`.
  False conditions return a successful skip without resolving environment references or
  calling upstream.
- Request fields live under `config.request`. JSON and form-urlencoded bodies are supported.
  Validation reads `{$output.*}`; default applies only to an empty/null body after rules pass.
  Transformation still runs on failure. Single-service output is returned directly;
  in workflows the response object merges flat into `{$context.<key>}` (Phase 5).
- `config.request.validation.fields` validates the invoke payload after `condition` and
  before any upstream call. Each entry is a payload-relative `path` (dotted keys,
  `[n]` indices, `[*]` for every array element, `["quoted key"]` segments for names like
  `user-id`) plus at least one of `required`, `type` (`string`, `number`, `integer`,
  `boolean`, `array`, `object`), `minItems` (arrays) or `minLength` (strings). `required`
  accepts `[]` and `""` — use `minItems`/`minLength` to reject empties — while `0`, `false`
  and `{}` count as present. Failures return `400 VALIDATION_FAILED` with a Zod-style
  `details` array of `{ path, message }`, zero upstream requests and `attempts: 0`; a
  custom `message` per field overrides the generated one.
- Validation paths are payload-relative and the internal `{$context.*}` wrapping is shared with
  workflow execution. Missing template references resolve to `null` instead of placeholder text.
- `GET /api/v1/executions/:executionId` retrieves sanitized service execution state,
  including failed transformed output and actual dispatch attempts (zero before dispatch).
  Recording is queued off the response path (best-effort, not durable workflow recovery),
  so a lookup immediately after an invoke response can briefly 404 until the write lands.
- `timeout.response` defaults to 30 seconds **per attempt**, including response-body reads.
  Retries use fixed/exponential backoff; never retry 4xx. Retrying writes may duplicate
  upstream side effects unless that upstream provides idempotency.
- `auth.jwt`, circuit breakers, connect/socket/idle timeouts and unsupported request content types
  return `501 NOT_IMPLEMENTED` at invocation.
- **Auth (REST):** `auth.basic` sends `Authorization: Basic base64(username:password)`. `auth.oauth2`
  fetches a `client_credentials` token (`clientAuth: basic|body`, `scope`, `audience`, `auth.ssl` for the
  token endpoint), caches it in memory, and replays the call once after a 401 with a fresh token. No
  `accessToken` is passed by the caller; credentials come from config (use `{$env.*}` references).
- **TLS certificates (REST):** trust an HTTPS API's private CA with `request.ssl.ca`. Give one list
  entry per certificate file: `"ssl": { "ca": ["<root>", "<issuing CA>"] }` (a single string also
  works). Each entry is either the **text of a PEM file** (starts with `-----BEGIN CERTIFICATE-----`;
  `.crt`/`.cer`/`.txt`, newlines written `\n`; `TRUSTED CERTIFICATE` blocks are accepted too) or, for
  a **binary DER file** (`head -1` shows garbage), its base64: `base64 -w0 file.cer`. A multi-cert PEM
  bundle is one entry. Every certificate is parsed at registration, so a private key or a truncated
  blob is rejected with `400` rather than ignored. `ca` **replaces** the default CA list for that
  request and must include the self-signed **root**; the root alone is enough when the server sends
  its intermediates, otherwise add the issuing CA(s). A lone leaf/intermediate is not a trust anchor
  (unlike Java's `keytool`) — registration fails with `400`. For mTLS add `cert` + `key` (PEM only)
  and optional `passphrase`. **Inline or from the environment, your choice:** any of `ca` (or a
  `ca` list entry), `cert`, `key` and `passphrase` can be `"{$env.NAME}"`; the variable is read at
  each invocation and may hold real newlines or a single line with literal `\n`. Env-supplied
  material can't be checked at registration, so a missing variable returns `500 ENV_REF_UNRESOLVED`
  and invalid or root-less material returns `502 CONNECTION_ERROR` when invoked. To skip server
  verification set `ssl.disableSSL: true` (optional; only on its own — never together with `ca`,
  `cert` or `key`) or the older top-level `request.disableSSL: true` (mutually exclusive with `ssl`);
  both apply in every environment (no production guard). TLS failures return `502 CONNECTION_ERROR`
  and never echo the material. Read APIs return inline `ca`/`cert` verbatim (public certificates)
  and mask `key`, `passphrase` and env references. File paths and PFX are unsupported. `ssl` is read
  from the stored component on every invocation (nothing is cached or loaded at startup), so an
  update via `PUT` applies to the next call. Operators can trust extra CAs process-wide for
  components **without** `ssl.ca` by starting the server with the standard `NODE_EXTRA_CA_CERTS=/path/to/extra-ca.pem`
  (optional, not read by Apiconfy itself); a component with `ssl.ca` ignores it.
- Resolved `{$env.NAME}` values are scrubbed from successful/error responses, details,
  audit rows and logs, including upstream echoes. Stored references and existing
  retrieval masking behavior are preserved.

**Deployment caution:** outbound SSRF protection, body-size limits and audit
retention/purge remain future work (retention is planned with Phase 5). Restrict
registration access and outbound network connectivity.

### Script component (Phase 3.5)

`componentType: "script"` runs an operator-authored JS function locally — one Bun Worker per
invocation, terminated on every exit path, with `timeout.response` as the hard deadline. The
script receives the execution context and **contributes by writing to `$context`**: the
changed/added top-level variables become the response `data` (later workflow steps read them
as `{$context.<variable>}`). A `return` value is ignored.

```json
POST /api/v1/services
{
  "service": "calc-service",
  "action": "add_numbers",
  "componentType": "script",
  "config": {
    "expression": "async function ($context) { $context.sum = $context.a + $context.b; }",
    "timeout": 15000
  }
}
```

- Full modern JS inside the function — async/await, optional chaining, template literals.
- **Tools:** the frozen `apiconfy` factory parameter exposes `invoke(service, action, context?)`,
  `executeWorkflow(name, context?)` (returns `NOT_IMPLEMENTED` until Phase 5), `generate(name)`
  (returns `NOT_IMPLEMENTED` until the `$gen.*` registry ships) and `executionId` — all awaited.
  `context` defaults to the live `$context` snapshot at call time. Each nested invoke is a
  first-class execution with its own audit row, and never throws — branch on `r.success`.
- Config is `expression` plus optional `timeout` — a number of ms (default 60 s, max 120 s) — only; every
  REST-only field — including the whole `output` block — and `$env.` inside the expression are
  rejected with `400`.
- Failures: `SCRIPT_ERROR` `500` (`not-a-function`, `threw`, `not-serializable`,
  `evaluation-failed`) and `TIMEOUT` `504`. The Worker's shadowed scope is accident-prevention,
  **not a sandbox** — registration access (`API_KEY`) is the boundary.

**Deployment caution (script):** a script can invoke other registered services in-process
(recursion/fan-out are uncapped by decision) and is operator code — never expose the registry
without `API_KEY`.

---

## Project Status

🚧 **Early Development — Phases 0–3.6 complete; Phase 4 (auth) in progress**

- ✅ Phase 0 (Foundation): monorepo scaffolded, Hono API server running, SQLite DB adapter operational, PostgreSQL adapter seam, CI pipeline active.
- ✅ Phase 1 (Component Registry): register, list, get, and delete component definitions via REST API.
- ✅ Phase 2: REST invocation, shared expressions/response pipeline, retry/timeout,
  and execution lookup. Verified with real HTTP integration and
  executable Postman scenarios, alongside the Phase 1 regression suite.
- ✅ Phase 3 (Multi-DB): PostgreSQL, Oracle, MongoDB and Couchbase adapters pass the
  shared parity suite alongside SQLite.
- ✅ Phase 3.5 (Local Script Component): `componentType: "script"` — mutation-only contract,
  `apiconfy` bridge tools with fully audited nested invokes, Worker-per-invocation with a hard
  deadline.
- ✅ Phase 3.6 (REST TLS certificates): `request.ssl` (PEM/DER `ca`, mTLS) and `disableSSL`.
- 🟡 Phase 4 (Auth): the auth config surface is merged; `auth.basic` and `auth.oauth2`
  (`client_credentials`) execute with token caching and a single replay on 401. The invoke body is
  the context itself, and responses are slimmed to `{ data }` / `{ error }` with the execution id in
  the `Execution-Id` header. `auth.jwt` (local/external) execution is still pending.

See the [Implementation Roadmap](plans/roadmap.md) for phase-by-phase details.

**Next milestone:** `auth.jwt` execution (`plans/auth-proxy.md`), then Phase 5 workflows.

---

## Future Vision

The vision of Apiconfy is to create an open integration runtime where complex integrations can be built by composing reusable components.

Instead of building integrations from scratch:

> **Build once. Register as a component. Compose anywhere.**

---

## Repository Structure

```
apiconfy/
│
├── apps/
│   └── server/           # Hono API server — component runtime
│       ├── src/
│       │   ├── core/     # DB/repositories, schemas, transform, runtime, REST components
│       │   ├── lib/      # Logger, shared utilities
│       │   ├── middleware/
│       │   ├── routes/   # health, service CRUD/invoke, execution lookup
│       │   ├── app.ts
│       │   ├── config.ts
│       │   └── index.ts
│       └── __tests__/
│
│                          # (no packages/ dir — all code lives in apps/server/src until a
│                          #  second consumer needs it. See plans/folder-structure.md)
│
├── postman/               # Postman collection for API testing
│
├── plans/                 # PRD and phased implementation roadmap
│
├── .github/workflows/     # CI pipeline (GitHub Actions)
│
├── tsconfig.base.json     # Shared TypeScript config
├── turbo.json             # Turborepo task pipeline
├── pnpm-workspace.yaml
└── README.md
```

---

## Contributing

Apiconfy is an open-source project. Contributions, ideas, and discussions are welcome.

Future contribution areas:

- New components
- Runtime improvements
- Sequential & parallel execution engine
- Documentation

---

## License

License: TBD