# Realtime & Record Event Domain Spec

- **Status:** Accepted — Community V0.1.x Work Package #21
- **Scope:** Project Record Event semantics and Application Realtime Subscription
- **Depends on:** [ADR-0001](../adr/0001-runtime-storage-architecture.md), [ADR-0002](../adr/0002-durable-record-events.md), [V0.1 Foundation Spec](./0002-v0.1-foundation-spec.md), [Core HTTP Contract](../contracts/core-http-contract.md)

## 1. Product Model

A **Record Event** is the durable fact that one Collection Record was created, updated, or deleted. Its Event ID identifies its position in the Project event sequence. A Realtime Subscription delivers the Record Events that the subscribing Application Principal may list under the Collection's currently Applied Access Rules.

Record Event, RequestRecord, AuditRecord, and Activity are separate product concepts:

- Record Event describes a committed data change and supports application consumers.
- RequestRecord describes one HTTP request and its safe operational outcome.
- AuditRecord describes a Control Plane security or governance action.
- Activity is not introduced by this package.

The HTTP representation and reconnect cursor are defined in [Realtime HTTP Contract](../contracts/realtime-http-contract.md). SQLite tables, Go types, and React component structure are implementation details and do not define these product terms.

## 2. Event Identity and Ordering

- Each Project has one ordered Event sequence. An Event ID is stable across reload and same-Project Runtime restart, and identifies exactly one committed Record Event.
- An Event Cursor identifies a sequence position from which delivery resumes. It is usually the most recently delivered Event ID; the reserved zero cursor represents the position before the first committed Event and is not itself an Event.
- Event IDs increase in Record mutation commit order. The sequence is not a count: gaps are permitted, and clients must not infer that a missing integer means data loss.
- `occurredAt` records the mutation's committed UTC time. The Event's Collection ID, Record ID, operation, and Applied schema version describe the committed change.
- Events are emitted for successful Create / Update / Delete operations through Application API, Admin Record management, and Auth Collection Profile Record services. This keeps all interfaces on the same Record semantics.
- Schema Apply, Access Rule edits, Authentication Configuration, file-only side effects, RequestRecord, and AuditRecord do not create Record Events in this package.

## 3. Mutation and Durable Result

1. Validate the operation, current Applied Model, and caller's existing operation Access Rule.
2. Prepare the resulting Record and the event's before/after authorization snapshots.
3. Persist the Record change and its Record Event in the same transaction that owns the complete product mutation. Auth Profile Record creation follows the surrounding App User transaction.
4. Make the Event available to subscribers only after that transaction commits.

If validation, authorization, event persistence, transaction commit, or any required operation step fails, neither the Record mutation nor its Event is durable. A rolled-back or rejected operation emits no Event. A successful transaction remains durable even when no client is connected or a client disconnects while the Event is being written to the network.

Create stores the committed Record snapshot. Update stores its before and after snapshots. Delete stores the before snapshot. Snapshots are internal authorization context; they are retained only inside the bounded event recovery window and are never returned as event history or as a general Activity feed.

## 4. Application Authorization and Safe Event Semantics

- The endpoint uses the Application Data Plane. A supplied Application Session must authenticate successfully; invalid credentials never downgrade to anonymous. Anonymous access is evaluated only when no credential is supplied.
- Revalidate a supplied Session before each Event and at least once per heartbeat interval. A revoked, expired, or unverifiable Session closes the stream before any further protected Event is sent.
- Opening a Collection stream first evaluates its currently Applied `list` Access Rule with no Record. Before each Event and heartbeat, re-evaluate this Collection-level admission; a deny or evaluator failure closes the stream.
- Before an Event is delivered or replayed, evaluate the current Applied `list` Access Rule against the Event's corresponding Record snapshot. Rules are evaluated again at delivery time; a stored Event does not preserve an old authorization grant. An evaluator failure closes the stream.
- `record.created` uses the after snapshot and may include the resulting Record. `record.updated` uses the after snapshot and may include the resulting Record. `record.deleted` uses the before snapshot and includes only the Record ID. A client can use the normal Record API to read current state, which performs its own authorization.
- If an Update changes a Record from listable to not listable for the current Principal, deliver `record.removed` with only its Collection ID and Record ID so a client can remove a previously visible row. If neither before nor after snapshot is listable, send nothing.
- A denied row Event is omitted without disclosing its Record ID, values, or denial reason. If Access Rule evaluation fails, close the stream without sending the affected Event. No credential, session token, API key, authorization header, internal file path, or request body is event data.
- Record Events do not grant access to API routes. Direct Record reads and mutations still use their normal Access Rules.

## 5. Subscription, Replay, and Recovery

- One subscription observes one Collection. It has no arbitrary search/filter language in V0.1.x; consumers use the existing Records API for query results.
- A new subscription with no cursor starts at the current sequence head and receives a `stream.ready` frame containing that baseline Event Cursor. Consumers should establish the stream, load current Records, and then apply subsequent Events so that changes concurrent with the initial load are not missed.
- A subscription with a valid Last-Event-ID resumes strictly after that Event ID. The order of delivered Events follows the Project sequence; hidden Events are skipped, and only visible Events advance the client-visible cursor.
- The event log retains at most the most recent 10,000 events and 64 MiB of event plus authorization snapshot data, whichever limit is reached first. The Project retains the highest pruned Event ID as a recovery watermark. A cursor at or before that watermark is an explicit recovery condition: the client reloads current Collection Records and opens a fresh stream.
- A cursor later than the current sequence head or a malformed cursor is a client error. Numeric gaps alone do not imply lost Events; the retained watermark is the authoritative signal that a cursor needs recovery.
- Realtime is an observation channel. The durable Record API remains the source of current state; clients must handle duplicate delivery idempotently by Event ID and may re-read a Record after receiving its ID.

## 6. Bounded Lifecycle and Request Observability

- Runtime subscription count, per-connection buffered notifications, and write time are bounded. One slow client may lose its stream but cannot wait inside or block a Record transaction. Its next connection resumes from the last Event ID while the cursor remains in the retention window.
- A disconnected client cancels its subscription promptly. Runtime shutdown closes all live streams within the Runtime shutdown deadline. A client may reconnect after same-Project restart using its last Event ID.
- SSE heartbeat frames are comments and do not advance the Event cursor or create Record Events.
- One long-lived SSE HTTP connection creates one redacted RequestRecord. It is persisted before response headers when possible; `X-Request-Record-Persisted` states whether that initial write succeeded. Duration and response-byte count are finalized when the connection ends. No Event frame body or Last-Event-ID is copied into RequestRecord.
- `X-Request-Id` identifies the HTTP subscription request. It is not an Event ID or reconnect cursor.

## 7. Admin API Workspace Discovery

The Collection API Workspace presents the Realtime subscription alongside that Collection's other Application API endpoints. It explains that subscriptions use the Application Access Rule, shows the `Last-Event-ID` resume header, and provides a JavaScript `fetch` streaming example that supports an in-memory Bearer Session, parses named SSE frames, reconnects with a bounded delay, and handles an expired cursor by reloading Records. It must not put credentials in a URL or persist an Application Session as part of the example.

All visible copy and errors use the shared English / Simplified Chinese i18n resources. Existing deep links, Collection context, theme, and the shared Command Registry continue to work.

## 8. Non-Goals

- WebSockets, Kafka, NATS, Redis, distributed queues, or multi-Runtime delivery.
- Lifecycle Hooks, Webhooks, Jobs, or Cron. Later consumers use the same Record Event semantics and cannot create a separate mutation path.
- A generic Activity Timeline, public event-history browsing API, or event filter/search language.
- PostgreSQL, Cloud, Enterprise, HA, multi-Project Runtime, or OAuth/OIDC providers.

## 9. Acceptance

- A committed Create / Update / Delete is present in the durable Event sequence; a failed or rolled-back mutation is absent after read and restart.
- No Event is sent before the corresponding Record transaction commits.
- Collection-level and per-Record List Access Rules are enforced on both live and replay delivery. Denied Record IDs and values never appear on the stream.
- Update visibility transitions produce a safe `record.removed` signal; a denied Delete does not disclose its Record ID.
- Disconnect, reconnect, expired cursor, Runtime restart, and Runtime shutdown follow the rules above.
- A slow or non-reading HTTP client is bounded and does not block an independent Record mutation.
- RequestRecord identifies the long-lived HTTP connection, preserves canonical request headers, records safe outcomes, and never stores SSE bodies or credentials.
- The Collection API Workspace documents the endpoint and its Bearer-compatible JavaScript example.
- The existing FLOW-001–010 and the WP21 real Runtime / SQLite / HTTP / Admin Chromium acceptance both pass.
