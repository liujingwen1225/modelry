# ADR-0006: Administrators, Mail Delivery, and Account Recovery

- **Status:** Accepted — Community V0.1.x
- **Date:** 2026-09-25
- **Scope:** Additional Control Plane Administrators, their Permissions and sessions, SMTP mail delivery, App User email verification, and App User password reset
- **Depends on:** [ADR-0001](./0001-runtime-storage-architecture.md), [ADR-0003](./0003-extension-runtime-lifecycle-secrets.md), [ADR-0004](./0004-local-webhook-delivery-and-cron.md), [Administrators, Mail Delivery, and Account Recovery](../product-model/0003-identity-and-recovery.md)
- **Issue:** [#26](https://github.com/liujingwen1225/modelry/issues/26)

## Context

V0.1 has one human Control Plane identity (the Owner) plus Service Account API Keys, and one human Application identity (an Auth Collection Record plus a write-only password Credential). Both work, but neither can be delegated or recovered.

Delegation and recovery introduce three risks that must be decided here rather than during implementation: how a second Control Plane identity is authorized without weakening the Owner bootstrap, how an outbound mail side effect stays outside SQLite transactions while remaining observable, and how recovery tokens avoid becoming long-lived credentials in a database file.

## Decisions

### Administrator identity

- A new Control Plane identity, the Administrator, is stored in the Project database with an email, a password hash, a Permission, a status, and timestamps. It is not a Record, not an Auth Collection user, and not a Service Account.
- The Owner remains the bootstrap identity: created by the local-only bootstrap path, always Full access, never deletable or disable-able, and never creatable through the Administrator API.
- Administrators reuse the Control Plane Permission vocabulary already defined for Service Accounts (operation names such as `records.read`, `files.write`, `schema.apply`, `audit.read`) with the same presets: Full access, Read only, and Custom. A shared vocabulary is extracted into one package so every Control Plane principal is evaluated by the same table.
- One login surface. `POST /admin/api/v1/auth/login` accepts Owner and Administrator credentials and returns the session role plus the effective Permission. The session cookie keeps its existing name so existing projects and browser flows continue to work.
- The session record distinguishes its principal kind. `OwnerFromContext` keeps returning the Owner only, so existing Owner-only decisions stay owner-only; new code asks for the Administrator context or the operation-level Permission check.
- Permission evaluation is fail closed: an Administrator is denied when the request maps to an operation it does not hold, and any Control Plane route without a known operation requires the Owner. Denials are audited as denied Control Plane facts.
- Administrator sessions are durable rows with expiry and revocation, mirroring Application sessions. Disabling or deleting an Administrator revokes its sessions in the same transaction; every later request with that session is rejected.

### Mail delivery

- The Project owns one Mail Provider configuration: enabled flag, SMTP host, port, transport security, sender address and name, and Project Secret references for the username and password. It is Owner-only, revision-guarded, and disabled by default.
- A verification or password reset request writes a durable mail intent in SQLite and returns. The outbound SMTP conversation happens only after commit, on a bounded worker, exactly like the Webhook dispatcher from ADR-0004. A delivery failure never rolls back the request.
- The outbox stores the recipient, the intent kind, an opaque payload reference, and safe attempt metadata. It never stores the message body, the token, a Secret value, or a credential. History keeps the attempt outcome and an optional SMTP status class.
- Retries are bounded with backoff, the worker is cancellable, and a Runtime restart turns in-flight attempts into interrupted history and returns the intent to pending only while its budget remains. A disabled Provider pauses new attempts instead of failing the intent permanently.
- SMTP credentials resolve per attempt from Project Secrets through the existing internal callback, are used for one connection, and are never cached in plaintext, logged, or returned. Missing or unreadable credentials fail closed before any network call.
- Delivery is bounded: request timeout, per-attempt timeout, maximum attempts, maximum pending intents, maximum retained history, and a maximum message size. Recipients must be syntactically valid single addresses; no header injection is possible.

### Account recovery and verification

- Recovery tokens are opaque, single-use, and expiring. Modelry stores a SHA-256 hash for confirmation and an AES-256-GCM copy encrypted with the Project key for the delivery worker; the plaintext token exists only in memory. The delivered message contains the code itself and no absolute URL, so a spoofed Host header cannot redirect an App User to an attacker.
- `POST /api/v1/auth/{collectionName}/password-reset/request` always answers with the same accepted response, whether or not the email exists, so the flow cannot enumerate App Users. It creates an intent only when the App User exists, the Auth Collection allows the flow, and mail is configured.
- `POST /api/v1/auth/{collectionName}/password-reset/confirm` sets the new password, consumes the token, and revokes every Application session of that App User in the same transaction.
- `POST .../email-verification/request` follows the same discipline, and `POST .../email-verification/confirm` marks the App User verified. Email verification is per Auth Collection: off, optional, or required. With `required`, an unverified App User cannot sign in until verification succeeds, and the login response explains the recovery path.
- Verification and reset while the Mail Provider is unconfigured fails closed with a configuration error. Modelry never writes a link into a log, a RequestRecord, an Audit record, or the Admin UI as a workaround.
- Password changes through the existing Application password route mark the App User verified only if the caller proved control of the existing password; recovery link confirmations mark verification separately.

### Provider seam

- Control Plane login and App User credentials stay behind interfaces: a Control Plane credential verifier and an Application credential verifier. Adding an OAuth provider later means adding an implementation of the same boundary, not redefining Record, Credential, or Session semantics.
- Community V0.1.x ships exactly one implementation of each: Control Plane email plus password, and Application email plus password. No OAuth provider is configured, registered, or reachable.

## Bounds

- 32 Administrators, 1,024 retained Administrator sessions, 30-day Administrator session duration, 90-day Application session duration (existing configuration), 3 Administrator password resets per hour per Project, 5,000 retained mail intents, 1,000 pending mail intents, 8 delivery attempts per intent, 2 attempts per minute per Project, 10-second SMTP connect and 20-second overall attempt timeout, 512 KiB maximum message size, 16 verification or reset requests per App User per hour, 30-minute recovery token lifetime, and 1,024 retained recovery tokens per Project.

## Rejected alternatives

- **Treating Administrators as Auth Collection users.** It merges the Control Plane and Data Plane identities and would let an Application sign-in reach the Control Plane. Rejected.
- **Reusing the Service Account API Key model for humans.** Humans need a password, a session, revocation on disable, and per-action auditing; API keys are machine credentials with different rotation semantics. Rejected.
- **Sending mail inside the request transaction.** SMTP cannot be rolled back, and a slow provider would hold the SQLite write lock. Rejected.
- **Storing recovery tokens in plaintext.** A database copy would become an account takeover vector. Rejected.
- **Logging recovery links when SMTP is unavailable.** It leaks credentials into logs and telemetry. Rejected.
- **Implementing OAuth/OIDC now.** Explicitly out of scope for Community V0.1.x; the provider seam keeps the door open. Rejected for this package.
- **A second mail-specific settings store.** Mail configuration joins the existing Project Secret model instead of introducing another credential store. Rejected.
