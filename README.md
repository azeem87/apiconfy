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
  "context": {
    "id": "12345"
  }
}
```

**Response:**

```json
{
  "success": true,
  "data": { "createCustomerResponse": { "customerId": "12345" } },
  "meta": { "executionId": "uuid", "durationMs": 25 }
}
```

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
    "customerId": "{$context.output.createCustomerResponse.customerId}",
    "messageId": "{$context.output.publishEventResponse.messageId}",
    "status": "{$context.output.sendEmailResponse.status}"
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
| **Databases** | SQLite (default), PostgreSQL |
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

**Current adapter status:** all six engines are implemented — SQLite (default), **PostgreSQL**, **MariaDB**, **Oracle**, **MongoDB** and **Couchbase**. The schema scripts ship in `apps/server/src/core/db/schema/` and are run **once by the operator** with an admin account: `psql -f apps/server/src/core/db/schema/sql/postgres.sql`, `mysql --user=<admin> --password --database=apiconfy < apps/server/src/core/db/schema/sql/mariadb.sql`, `sqlplus <admin>@//host:1521/service @apps/server/src/core/db/schema/oracle/oracle.sql`, `mongosh "<DATABASE_URL>" apps/server/src/core/db/schema/mongodb/mongodb.js`, or `CB_BUCKET=apiconfy bun run apps/server/src/core/db/schema/couchbase/couchbase.js`. The app never creates schema: on startup it probes for the required tables/collections/indexes and exits with the script path if any are missing. Couchbase transactions are intentionally not implemented — the config/CRUD writes that would use them are rare, while the hot paths (invoke, workflow reads) are key-value reads (see the plan's Step 7 notes). A per-engine prerequisite table lands with the Phase 3 README work.

**Production / Cloud:** set `DATABASE_URL` to the engine you run — today `postgres://user:pass@host:5432/db`, with `mysql://`/`mariadb://`, `oracle://`, `mongodb://` and `couchbase://` (+ `CB_BUCKET`) arriving in Phase 3. A named engine is never bypassed in favour of SQLite; an unknown scheme refuses to start.

---

## Environment Variables

> See [`.env.example`](.env.example) for a copy-ready template: every engine's connection string commented, SQLite as the local-development default, and the optional overrides.

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `3000` | HTTP server port |
| `LOG_LEVEL` | `info` | Log level for pino (`trace`, `debug`, `info`, `warn`, `error`, `fatal`) |
| `API_KEY` | *(unset)* | Bearer token for `/api/*` routes. If unset, all routes are open (warning logged at startup) |
| `REQUIRE_API_KEY` | `false` | When `true`, server refuses to start if `API_KEY` is missing. Set this in production |
| `DATABASE_URL` | *(unset → SQLite)* | Selects the database engine by URL scheme. Implemented today: `postgres://` (stub until Phase 3). Phase 3 adds `mysql://`/`mariadb://`, `oracle://`, `mongodb://`, `couchbase://` (+ `CB_BUCKET`), and the explicit `sqlite:` scheme. Unset or empty → SQLite, with a local-development warning logged at startup |
| `SQLITE_PATH` | `../../data/apiconfy.db` | SQLite database file path when no engine is selected — and, from Phase 3, when the `sqlite:` URL omits a path |
| `CB_BUCKET` | *(unset)* | Couchbase bucket name — required whenever `DATABASE_URL` uses `couchbase://` |
| `CB_USER` | `Administrator` | Couchbase username, used when the `couchbase://` URL carries none |
| `CB_PASS` | *(unset)* | Couchbase password, used when the `couchbase://` URL carries none — required in that case, or the adapter refuses to start |

**Security note:** If `API_KEY` is not set, a warning is logged at startup and all `/api/*` routes are accessible without authentication. For production deployments, always set `API_KEY` and `REQUIRE_API_KEY=true`.

---

## Testing the API

A [Postman collection](postman/apiconfy.postman_collection.json) is included for manual and exploratory testing. It covers every implemented endpoint with simple and complex examples.

**Import:**
1. Open Postman → **Import** → select `postman/apiconfy.postman_collection.json`
2. Set the `base_url` collection variable (default: `http://localhost:3000`)
3. If `API_KEY` is configured, set the `api_key` collection variable for Bearer auth
4. Start the server (`pnpm dev`) and run the requests

The collection is organized **by component type**. REST → Invoke contains ordered
Simple Examples, Complex Examples and Error Cases: register each example before invoking
it. Invoke scripts save `meta.executionId` as `execution_id` for execution lookup.
The simple scenario calls the local health endpoint. Complex scenarios use `upstream_url`
(default `https://httpbin.org`); send only dummy data or point it at your own compatible server.

Existing auth/TLS/circuit-breaker complex examples are **registration-only** until their
execution capabilities arrive. Runnable Phase 2 complex examples include every supported
section (request, timeout, retry, condition, validation, transformation and metadata)
and intentionally omit unsupported auth/TLS/circuit-breaker fields.

### Phase 2 invocation behavior

- `POST /api/v1/services/:service/:action/invoke` requires `{ "context": { ... } }`.
  `context.output` is reserved. False conditions return a successful skip without resolving
  environment references or calling upstream.
- Request fields live under `config.request`. JSON and form-urlencoded bodies are supported.
  Validation reads `{$output.*}`; default applies only to an empty/null body after rules pass.
  Transformation still runs on failure. Single-service output is returned directly;
  accumulation into `{$context.output.<uniqueKey>}` is Phase 5.
- `GET /api/v1/executions/:executionId` retrieves sanitized service execution state,
  including failed transformed output and actual dispatch attempts (zero before dispatch).
  Recording is awaited but best-effort, not durable workflow recovery.
- `timeout.response` defaults to 30 seconds **per attempt**, including response-body reads.
  Retries use fixed/exponential backoff; never retry 4xx. Retrying writes may duplicate
  upstream side effects unless that upstream provides idempotency.
- Auth, custom SSL, `disableSSL: true`, circuit breakers, connect/socket/idle timeouts and
  unsupported request content types return `501 NOT_IMPLEMENTED` at invocation.
- Resolved `{$env.NAME}` values are scrubbed from successful/error responses, details,
  audit rows and logs, including upstream echoes. Stored references and existing
  retrieval masking behavior are preserved.

**Deployment caution:** outbound SSRF protection, body-size limits and audit retention
are not part of Phase 2. Restrict registration access and outbound network connectivity.

---

## Project Status

🚧 **Early Development — Phase 2 Complete**

- ✅ Phase 0 (Foundation): monorepo scaffolded, Hono API server running, SQLite DB adapter operational, PostgreSQL adapter seam, CI pipeline active.
- ✅ Phase 1 (Component Registry): register, list, get, and delete component definitions via REST API.
- ✅ Phase 2: REST invocation, shared expressions/response pipeline, retry/timeout,
  and execution lookup. Verified with real HTTP integration and
  executable Postman scenarios, alongside the Phase 1 regression suite.

See the [Implementation Roadmap](plans/roadmap.md) for phase-by-phase details.

**Next milestone:** Phase 3 — outbound request safety and
the separately gated database-adapter work.

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