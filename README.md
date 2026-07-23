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
- FTP/SFTP Component
- Database Component
- Scheduler Component
- Webhook Component
- Custom Components

Components are designed to be extensible, allowing new integrations to be added without modifying the core runtime.

### Declarative Configuration

Instead of writing integration-specific code, developers **register** a component by sending its definition to the runtime — component type, connection details, authentication, request/response mapping, execution rules, and metadata.

> 🚧 **Planned / target design — not yet implemented.** Shown here to illustrate the intended registration model; the actual request/response shape is still being finalized.

> **Note on `context`:** `context` is an arbitrary JSON payload — its shape is entirely up to the caller and the component definition's mapping rules. It is not a fixed schema. The `customer`/`id` fields used throughout these examples are illustrative only, to keep the examples concrete and easy to follow.

**Register a component:**

```
POST /components/register
Content-Type: application/json

{
  "serviceName": "customer-service",
  "serviceType": "create_customer",
  "component": "rest",
  "serviceDetails": {
    "url": "https://example.com/customer",
    "method": "POST",
    "request": {
      "mapping": {
        "customerId": "$.context.id"
      }
    },
    "response": {
      "mapping": {
        "customerId": "$.response.id"
      }
    }
  }
}
```

**Invoke the registered component:**

```
POST /components/invoke/customer-service/rest/create_customer
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
  "customerId": "12345"
}
```

The runtime looks up the stored definition, executes it against the external system, applies the response mapping, and returns the transformed result — no custom client code required. This mirrors a register-once, invoke-anywhere model rather than a static config file checked into the repo, since definitions are expected to be created, updated, and queried at runtime (e.g. from an admin UI or another service).

### Component Composition (Sequential & Parallel)

> **Scope note:** Apiconfy is **not** a general-purpose workflow engine (like Temporal or Netflix Conductor). It does not aim to provide durable execution history, human-in-the-loop tasks, a visual workflow designer, or a full state-machine DSL. Its scope is intentionally narrower: **combine registered components and execute them sequentially or in parallel**, driven entirely by the component's configuration. Anything resembling "orchestration" here means config-driven execution ordering, not a standalone workflow engine.

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

> 🚧 **Planned / target design — not yet implemented.**

```
POST /workflows/invoke/customer-onboarding
Content-Type: application/json

{
  "context": {
    "id": "12345"
  }
}
```

Internally, this might execute as:

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
  "customerId": "12345",
  "messageId": "msg-98231",
  "status": "sent"
}
```

If any step fails, the workflow can be configured to roll back prior steps (compensating actions) rather than leaving the system in a partial state — see [Event-Driven Execution](#event-driven-execution) below.

This enables building reusable integration flows for:

- Business processes
- Data synchronization
- System integration
- Event-driven automation
- Third-party service coordination

### Event-Driven Execution

Apiconfy is designed around event-driven execution. An event can trigger one or more component actions.

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

Planned capabilities include event listeners, message consumers, scheduled triggers, and background workers.

---

## Supported Integration Patterns

**API Integrations**
Examples: REST APIs, HTTP services, webhooks
Capabilities: request transformation, response transformation, authentication handling, dynamic execution

**Messaging Integrations**
Examples: message queues, event streams
Capabilities: publish messages, consume events, trigger workflows

**File Integrations**
Examples: FTP, SFTP, file processing
Capabilities: file generation, file transfer, data transformation

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

         REST | Queue | FTP | Database | Events | APIs
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

**Prerequisites:** Bun (≥1.x) and pnpm (≥9.x).

```bash
# Clone and install
git clone https://github.com/apiconfy/apiconfy.git
cd apiconfy
pnpm install

# Start the dev server (SQLite by default, zero config)
pnpm dev

# Run tests
pnpm test

# Build for production
pnpm build
```

The server starts on `http://localhost:3000` with a health check at `GET /health` and API docs at `/docs`.

For PostgreSQL, set `DATABASE_URL=postgres://user:pass@host:5432/db` in your environment before starting.

---

## Project Status

🚧 **Early Development — Phase 0 Complete**

Phase 0 (Foundation) is done: monorepo scaffolded, Hono API server running, SQLite/Postgres DB layer operational, CI pipeline active.

See the [Implementation Roadmap](plans/roadmap.md) for phase-by-phase details.

**Next milestone:** Phase 1 — Component Registry (register, lookup, and manage component definitions).

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
│       │   ├── core/     # DB adapters, repositories, schemas
│       │   ├── lib/      # Logger, shared utilities
│       │   ├── middleware/
│       │   ├── routes/
│       │   ├── app.ts
│       │   ├── config.ts
│       │   └── index.ts
│       └── __tests__/
│
├── packages/              # Shared packages (db, shared, auth, components, runtime, etc.)
│
├── plans/                 # PRD and phased implementation roadmap
│
├── .commandcode/plans/    # Technical design plans per phase
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