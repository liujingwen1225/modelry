# Administrators, Mail Delivery, and Account Recovery

- **Status:** Accepted — Community V0.1.x
- **Date:** 2026-09-25
- **Issue:** [#26](https://github.com/liujingwen1225/modelry/issues/26)
- **Parent Goal:** [#22](https://github.com/liujingwen1225/modelry/issues/22)
- **Depends on:** [ADR-0001](../adr/0001-runtime-storage-architecture.md), [ADR-0003](../adr/0003-extension-runtime-lifecycle-secrets.md), [ADR-0006](../adr/0006-administrators-and-account-recovery.md), [Identity and Recovery Domain Spec](../specs/0008-identity-and-recovery-domain-spec.md)

## User problem

A project Owner needs help. Today Modelry has exactly one human Control Plane identity, so every colleague shares the Owner credential or works through a Service Account API Key. Nothing in the product lets the Owner delegate a bounded part of the Control Plane, and an App User who forgets a password or types the wrong email address has no recovery path at all.

## Product terms

- An **Owner** is the single human identity created by local bootstrap. Only the Owner can create, change, disable, or delete Administrators, and only the Owner can read or change the Project mail Provider.
- An **Administrator** is a Control Plane identity the Owner creates for another person. An Administrator signs in with email and password and holds an explicit **Permission**: Full access, Read only, or a Custom list of Control Plane operations. An Administrator is not an App User, and an App User is never an Administrator.
- A **Control Plane session** is a signed-in Owner or Administrator browser session. Sessions carry a role, expire, can be revoked, and never grant Application Data Plane access.
- A **Permission** is the Control Plane operation set an Administrator may perform. Permissions use the same operation vocabulary as Service Accounts, so the same action is either allowed or denied consistently for every Control Plane principal.
- The **Mail Provider** is the Project SMTP configuration used to deliver verification and password reset messages. It is disabled by default, its credentials are Project Secrets, and it never appears in a Record.
- A **Recovery message** is a durable outbound mail intent created for one App User action: email verification or password reset. The message body carries a single-use link; Modelry stores only a hash of that link token.
- An **App User credential** is the password of one Auth Collection Record. It stays a write-only credential: no response, RequestRecord, Audit record, Extension, or log ever returns it.

## Owner workflow

1. The Owner bootstraps the Project locally, exactly as today.
2. The Owner opens **Administrators**, enters a colleague email, an initial password, and a Permission, and creates the Administrator. The new Administrator can sign in immediately and sees only the surfaces its Permission allows.
3. When the colleague changes role, the Owner edits the Permission; every further request is evaluated against the new Permission, and every Control Plane mutation records which Administrator did it in Audit.
4. When the colleague leaves, the Owner disables or deletes the Administrator; all of that Administrator sessions stop working immediately.
5. The Owner opens **Settings → Mail** and enables the Mail Provider with an SMTP host, port, sender address, and two Project Secrets. A test message proves the configuration before App Users depend on it.
6. With mail enabled and the Auth Collection configured for it, an App User who forgot a password requests a reset from the Application login surface, receives one single-use link, and chooses a new password. Every existing Application session of that App User stops working.

## Product behavior

- Permissions fail closed. A request for an operation the Administrator does not hold is denied with a clear message naming the missing Permission, and the denial is audited. Unknown Control Plane operations require the Owner.
- The Owner cannot be deleted, disabled, or stripped of Full access, and the Project always keeps at least one usable Owner session path through local bootstrap login.
- Administrator management is audited in the same transaction as the change. Every audit entry names the acting Owner or Administrator.
- Mail delivery is a durable outbox. A verification or reset request writes an intent and returns immediately; a bounded worker delivers it with retries, records safe attempt metadata, and never stores the message body, the link token, or a Secret value. If the Mail Provider is unreachable, the intent stays retryable and the UI shows an actionable state.
- When the Mail Provider is not configured or is disabled, verification and password reset requests fail closed with a clear configuration hint. They never silently succeed, and Modelry never falls back to logging a link.
- Email verification is per Auth Collection: `off` keeps V0.1 behavior, `optional` lets App Users verify without blocking sign-in, and `required` blocks sign-in for unverified App Users with an actionable error until they verify.
- Password reset requests always answer the same way whether or not the email exists, so the flow cannot be used to enumerate accounts.
- Recovery links are single-use, expire, and are stored only as hashes. A used, expired, or unknown link is rejected with one safe error.

## Boundaries

- No OAuth or OIDC provider is implemented in Community V0.1.x: not generic OAuth2/OIDC, not GitHub, Google, WeChat, WeCom, DingTalk, or Feishu.
- No enterprise identity: no SAML, no enterprise SSO, no SCIM, no Organization/Team identity, no directory or group provisioning.
- Community V0.1.x stays one Runtime, one Project, SQLite only, with no external identity service and no distributed mail queue.
- Administrators are Control Plane identities only. They cannot sign in to the Application Data Plane, and App Users cannot reach the Control Plane.
- The Credential model keeps a provider seam: an Auth Collection could later gain an OAuth provider without changing Record, Credential, or Session semantics, but that work is not part of this package.
