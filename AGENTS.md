# AGENTS.md — Modelry

## Read first

1. CONTEXT.md
2. docs/00-product-vision.md
3. docs/01-product-roadmap.md
4. docs/02-technical-roadmap.md
5. docs/03-editions-and-cloud.md
6. docs/04-v0.1-community-scope.md
7. docs/05-product-experience-and-acceptance.md
8. docs/06-product-architecture.md
9. the accepted ADR / Spec / Contract for the task

## Product rule

Do not optimize Modelry as an internal engineering system.

Every feature must be judged as a product surface:

- Can a new user understand it quickly?
- Is there one obvious next action?
- Are defaults safe and useful?
- Is the durable result visible?
- Are errors actionable?
- Can a real workflow finish end to end?
- Does the UI feel like one coherent product?

## V0.1 Community baseline

- Go
- SQLite
- React + TypeScript + Vite
- modular monolith
- Contract First
- zero-config-first
- simple self-hosted distribution

Single Binary and One Instance / One Project are V0.1 Community delivery choices. Do not turn them into permanent global assumptions.

## Architecture rules

- Product semantics must not equal SQLite-specific semantics.
- Do not build PostgreSQL in V0.1, but do not make adding it later require rewriting Modelry's domain model.
- Do not expose raw database concepts when a Modelry product concept exists.
- Data Plane and Control Plane stay separate.
- Admin identity and Application Auth stay separate.
- Schema evolution goes through ChangeSet / Diff / Risk / Apply / History.
- Hooks and extensions remain behind an explicit JavaScript / TypeScript-facing runtime boundary.
- MCP is another interface to the same product semantics, not a privileged bypass.
- Contract is defined before transport implementation.

## Quality rule

The definition of done is not code compiled or API passed.

Core work requires:

Functional Closure + UX Closure + Visual Closure + Error Closure + Business Flow Closure.

Use real runtime, real SQLite, real HTTP, real Admin browser and durable-state verification for mandatory acceptance.
