# Extension Runtime Spike

- **Scope:** Community V0.1.x Extension Runtime selection for Issue #23
- **Status:** Candidate selected after an executable Windows spike; repository adapter tests remain part of implementation
- **Date:** 2026-09-25

## Decision evidence

Use QuickJS-NG through Wazero, with a small Modelry-maintained adapter over `github.com/fastschema/qjs` v0.0.6 (`461716f4f380f81ffd09378751f1812919cddbca`). Do not use the upstream adapter's default filesystem or shutdown configuration. Its embedded `qjs.wasm` and Go implementation provide a useful ES2023 engine, while the local adapter must supply the resource and host boundaries below.

This is a bounded execution environment for Owner-managed project extensions. It is not a hostile-code or multi-tenant serverless sandbox. The application must not pass database handles, project-root filesystem access, process control, environment variables, or unrestricted network access into the guest.

### Alternatives and upstream facts

- Goja is pure Go and cross-platform. Its project documents complete ES5.1 support, most ES6 work in progress, and `Runtime.Interrupt` for stopping executing script. Its public API has no VM heap limit. Treat that last point as an API limitation, not a claim that Goja never releases memory. Sources: [Goja README](https://github.com/dop251/goja/blob/master/README.md), [Goja API](https://pkg.go.dev/github.com/dop251/goja).
- Wazero is a pure-Go WebAssembly runtime. `WithMemoryLimitPages` limits guest linear memory. `WithCloseOnContextDone(true)` interrupts a guest call when its context ends and closes its module. A closed module cannot be reused. Source: [Wazero v1.9.0 RuntimeConfig](https://github.com/tetratelabs/wazero/blob/v1.9.0/config.go).
- QuickJS-NG exposes heap and stack limits. The pinned QJS shim passes `MemoryLimit` and `MaxStackSize` to those APIs, but does not use its `MaxExecutionTime` argument. It also registers `qjs:std` and `qjs:os`. Sources: [pinned QJS runtime](https://github.com/fastschema/qjs/blob/461716f4f380f81ffd09378751f1812919cddbca/runtime.go), [pinned QJS options](https://github.com/fastschema/qjs/blob/461716f4f380f81ffd09378751f1812919cddbca/options.go), [pinned QJS shim](https://github.com/fastschema/qjs/blob/461716f4f380f81ffd09378751f1812919cddbca/qjswasm/qjs.c).
- Wazero explicitly warns that `WithDirMount` allows guest path traversal above the mounted directory via relative paths such as `../../`. A temporary host directory is therefore not a filesystem sandbox. Use a pure in-memory, read-only `fs.FS` that never forwards to the host filesystem. Source: [Wazero v1.9.0 filesystem configuration](https://github.com/tetratelabs/wazero/blob/v1.9.0/fsconfig.go).
- The upstream QJS adapter caches its Wazero `RuntimeConfig`, does not set a Wazero memory-page ceiling, and may panic while freeing QJS values after Wazero closes a module on cancellation. A local adapter must use one fixed process-wide config, set `WithCloseOnContextDone(true)` and a finite page limit, skip guest cleanup after module closure, and drop cancelled runtimes rather than pooling them.
- esbuild's Go `api.Transform` removes TypeScript syntax but does not type-check it. Reject imports and external package loading; keep canonical TypeScript source and derive bounded JavaScript output at activation. Source: [esbuild Go Transform API](https://github.com/evanw/esbuild/blob/main/pkg/api/api.go).

### Executable spike on the project Windows toolchain

A temporary adapter fork used an empty `testing/fstest.MapFS` mounted as guest `/`, forced context cancellation and a 2,048-page Wazero memory ceiling, and skipped QJS cleanup when Wazero had already closed the module. It ran on Go 1.25.10 / Windows:

- A `for (;;) {}` guest stopped at a 250 ms context deadline; the wrapper returned a generic interruption error and `Runtime.Close` completed without panic.
- `new ArrayBuffer(64 MiB)` failed with QuickJS's 8 MiB heap limit.
- With QuickJS's heap limit disabled, `new ArrayBuffer(512 MiB)` failed under the Wazero 128 MiB per-instance page ceiling.
- A guest import of `qjs:std` could neither read a sentinel file outside the guest FS nor open a file for writing.

This verifies the adapter technique, not the final checked-in integration. The implementation must preserve these cases as repository tests, add bounded concurrency and host-callback cancellation coverage, and compile on supported operating systems.

### Runtime boundary for ADR-0003

1. Keep the guest interface behind Modelry's versioned Extension Runtime API. Pass bounded JSON values only. Never expose a storage handle, arbitrary Go object, file descriptor, project path, environment variable, database, or process API.
2. Use a fresh QuickJS runtime for each invocation, a 32 MiB QuickJS heap limit, a 1 MiB stack limit, a 128 MiB Wazero linear-memory ceiling per guest, a 2-second pre-commit budget, a 5-second post-commit budget, a project-wide four-invocation concurrency limit, and bounded source, payload, response, and log sizes. Cancelled instances are closed and discarded.
3. Mount an empty in-memory read-only filesystem. Discard guest stdout/stderr. Do not expose ambient network APIs. If a post-commit extension is granted outbound HTTP, route requests through a narrow host function with an explicit per-extension HTTPS origin allowlist, private-address/redirect/proxy protections, deadlines and byte caps. Pre-commit hooks receive no HTTP or Secret API.
4. Run pre-commit hooks before opening the SQLite write transaction. They may reject or transform only the pending Record. Revalidate the result against the current Applied Model, then verify the source Record / model has not changed before committing.
5. Record the post-commit intent in the same transaction as the Record Event. Execute it once after commit. Its failure cannot undo the committed Record and it is never automatically retried in #23. On restart, unfinished intents become `interrupted`; later retry/delivery policy belongs to #24.
6. Keep Secret values encrypted outside ordinary Records and requests. Resolve only explicit per-Extension aliases, and only for post-commit invocations. Never include source exceptions, secret values, request headers/bodies, or guest stdout in logs or errors.
7. Store one TypeScript/JavaScript source per Extension revision. Do not resolve imports or packages from disk or the network. Activation validates/transforms source and stores the active durable revision; Runtime restart loads that revision from the Project database.

### Secret key boundary

Use AES-256-GCM with a random 32-byte key in a separate file under `.modelry`; SQLite stores ciphertext, nonce, and format version. Bind ciphertext authentication to Project ID, Secret ID, and Secret version. A missing, malformed, or authentication-failing key fails closed and is never silently replaced. This protects a separately disclosed SQLite file; a copy of the entire Project root includes its local key and requires a protected backup policy in #28.

Create the key file exclusively and reject symlinks. On POSIX, create it with `0600` and require a private managed directory. On Windows, `0600` does not create a private ACL; create a protected DACL for the file owner and verify that ACL when reading. This repository permits arbitrary existing Project Roots, so inherited directory permissions alone are insufficient. Sources: [Go `os.FileMode`](https://pkg.go.dev/os#FileMode), [Windows file security](https://learn.microsoft.com/en-us/windows/win32/fileio/file-security-and-access-rights).

### Remaining checked-in verification

- Keep deadlines active through a host callback, and make the HTTP host implementation enforce the same deadline independently; Wazero cannot interrupt a Go callback that ignores its own context.
- Verify the 128 MiB page ceiling, 32 MiB QuickJS heap, stack cap, cancellation cleanup, empty filesystem read/write denial, origin allowlist and loopback/private/link-local IPv4/IPv6 denial with integration tests.
- Exercise bounded concurrent invocations and ensure failures cannot hold up normal Runtime startup or Record mutations.
- Verify encrypted-at-rest Secrets, key creation/race/restart/upgrade, POSIX permissions, Windows DACL, key loss, secret replacement without reveal, safe diagnostics and backup/restore contract compatibility.
- Verify JavaScript and TypeScript activation, no imports, source quotas and all lifecycle call sites including Auth's caller-owned transaction path.
