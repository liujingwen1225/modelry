# Modelry

Modelry is a productized Backend Platform for building and operating application backends through a visual Admin, stable APIs, and agent-friendly interfaces.

The product goal is not to expose database internals. Modelry should be easy to start, easy to understand, pleasant to use, visually coherent, and complete enough to finish real backend work without assembling many unrelated tools.

## Product direction

Modelry is developed as one product family:

- Modelry Community: open-source, self-hosted, SQLite-based, zero-config-first.
- Modelry Enterprise: self-hosted commercial edition for production teams and organizations, with PostgreSQL and enterprise governance capabilities.
- Modelry Cloud: official managed SaaS built around PostgreSQL and a dedicated cloud control plane.

Community must remain a complete backend product rather than a demo edition. Enterprise and Cloud sell production scale, governance, operations, and managed service value.

## V0.1 Community technical baseline

- Backend runtime: Go
- Database: SQLite
- Admin: React + TypeScript + Vite
- Architecture: modular monolith
- Product discipline: Contract First
- Default delivery: simple self-hosted runtime with an embedded Admin
- User extension direction: JavaScript / TypeScript runtime boundary, not Go plugins

Single Binary and One Instance / One Project are V0.1 Community delivery choices. They are not permanent product-wide constraints and must not block future Enterprise or Cloud evolution.

## Documentation

The authoritative documentation starts at docs/README.md.

Historical pre-Reboot documents are intentionally not kept in this repository's active documentation tree. The previous implementation and historical material remain available through repository history and the separate modelry-bf repository.

## Current phase

The current phase is product and architecture definition before production implementation. Product roadmap, technical roadmap, edition strategy, V0.1 scope, product experience rules, and product architecture are authoritative inputs for the next ADR / Spec / Contract pass.
