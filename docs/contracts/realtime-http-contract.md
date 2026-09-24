# Realtime Application HTTP Contract

- **Status:** Accepted — Community V0.1.x Work Package #21
- **Authority:** [Realtime Event Domain Spec](../specs/0004-realtime-event-domain-spec.md), [ADR-0002](../adr/0002-durable-record-events.md), [Core HTTP Contract](./core-http-contract.md)

## 1. Subscribe to One Collection

```http
GET /api/v1/{collectionName}/events
Authorization: Bearer <application-session>
Last-Event-ID: evt_Y29sXzAxMjM0NTY3ODlhYmNkZWYwMTIzNDU2Nzg5YWJjZGVm_00000000000000000042
Accept: text/event-stream
```

- `Authorization` is optional only when that Collection's Applied List Access Rule grants the anonymous Principal access. A supplied invalid, expired, or revoked Application Session fails closed; it never becomes anonymous.
- The request first passes the Collection-level List Access Rule. Before every protected Event, the Runtime revalidates a supplied Session and the current Collection-level List admission, then evaluates the current per-Record List rule using the Event's retained authorization snapshot. Session and Collection-level admission are rechecked on every heartbeat; a deny or evaluation failure closes the stream.
- The endpoint has no query filters, offset pagination, or token-in-URL alternative. Call the regular Records API for current query results.
- `occurredAt` is the UTC mutation timestamp sampled while the Record transaction is active. It is not a physical commit timestamp; Event sequence order is authoritative for delivery.
- The server sends `Cache-Control: no-store` and `Content-Type: text/event-stream; charset=utf-8`; it flushes the response and each complete frame. It does not set a hop-by-hop `Connection` header.
- `X-Request-Id` is the canonical ID for this HTTP connection. `X-Request-Record-Persisted` reports whether the stream's redacted RequestRecord was written before response headers.

## 2. Event IDs and Resume

Record Event IDs use `evt_` followed by the Collection ID's UTF-8 bytes encoded as unpadded Base64 URL-safe text, an underscore, and that Collection's 20-digit, zero-padded sequence. For example, `evt_Y29sXzAxMjM0NTY3ODlhYmNkZWYwMTIzNDU2Nzg5YWJjZGVm_00000000000000000042` encodes Collection ID `col_0123456789abcdef0123456789abcdef`. This preserves the opaque Collection ID contract without assuming an ID prefix or character set. The `id:` value on a Record Event frame equals its Event ID. A new `stream.ready` frame instead uses a baseline cursor with the same encoded Collection scope and sequence position under the `cur_` prefix. Its zero sequence represents the position before the first Event and never identifies a Record Event. Both forms are stable across Runtime restart where applicable; they are ordered within the Collection but not gap-free. Clients treat them as resume values and must not infer lost data from a numeric gap. The `Last-Event-ID` header carries either the baseline cursor or the Event ID most recently received, scoped to the Collection in the request path. Different Collections have no exposed total order.

- Without `Last-Event-ID`, the Runtime captures the requested Collection's current sequence head and first sends a `stream.ready` frame whose `id:` is a baseline Event Cursor under the `cur_` prefix. Its JSON `cursor` value equals the frame ID. The stream then sends committed Events for that Collection after the head. The client should establish the stream, load current Records, and then apply subsequent frames.
- With `Last-Event-ID`, the Runtime first flushes an SSE `: connected` comment without an `id:` so the client can observe the resumed HTTP stream while retained Events are replayed. This comment does not advance the client's cursor; replay begins strictly after the supplied cursor.
- With `Last-Event-ID`, the Runtime sends retained Events for the requested Collection strictly after that cursor, in that Collection's commit order. Access-denied Events are omitted and their Record IDs and values are not sent.
- Before the first prune for the requested Collection, no recovery watermark exists and its reserved zero cursor is valid. After pruning, a cursor strictly before the highest pruned sequence for that Collection returns HTTP `410 EVENT_CURSOR_EXPIRED` before any SSE headers. A cursor equal to the watermark can safely continue after it. The storage budget is Project-wide to keep event retention bounded; traffic in another Collection can shorten this Collection's replay window. Expiration reveals only that the requested cursor fell outside the retained window, not another Collection's event identity, type, or value. This bounded retention-pressure side channel is accepted in Community V0.1.x. The client opens without a cursor, waits for a new `stream.ready`, reloads current Records, then applies later frames.
- A malformed cursor, a cursor scoped to another Collection, or a future cursor returns HTTP `400 EVENT_CURSOR_INVALID` before stream headers.
- Every replay page compares its cursor with the retention watermark in the same SQLite read snapshot as its Events. If retention advances past an active stream's cursor, the stream closes; on reconnect the client receives `EVENT_CURSOR_EXPIRED` and performs the recovery above.
- SSE comments are heartbeats every 15 seconds. They have no `id:` and do not advance the cursor. Before a heartbeat, the Runtime revalidates a supplied Session and the current Collection-level List admission; a deny or evaluation failure closes the connection.

## 3. SSE Frames

Each named event frame uses standard Server-Sent Events framing: `id`, `event`, one JSON `data` line, and a blank line. A Record Event's `eventId` in JSON equals the `id:` field. `stream.ready` contains the Event Cursor in a `cursor` field. A heartbeat is an SSE comment line such as `: heartbeat`, followed by a blank line; it has no `id`, `event`, or `data`.

```text
event: stream.ready
id: cur_Y29sXzAxMjM0NTY3ODlhYmNkZWYwMTIzNDU2Nzg5YWJjZGVm_00000000000000000042
data: {"cursor":"cur_Y29sXzAxMjM0NTY3ODlhYmNkZWYwMTIzNDU2Nzg5YWJjZGVm_00000000000000000042","collectionId":"col_0123456789abcdef0123456789abcdef"}

event: record.created
id: evt_Y29sXzAxMjM0NTY3ODlhYmNkZWYwMTIzNDU2Nzg5YWJjZGVm_00000000000000000043
data: {"eventId":"evt_Y29sXzAxMjM0NTY3ODlhYmNkZWYwMTIzNDU2Nzg5YWJjZGVm_00000000000000000043","collectionId":"col_0123456789abcdef0123456789abcdef","recordId":"rec_8k1m4p2x","occurredAt":"2026-09-25T08:30:00Z","schemaVersion":3,"record":{"id":"rec_8k1m4p2x","createdAt":"2026-09-25T08:30:00Z","updatedAt":"2026-09-25T08:30:00Z","title":"Hello"}}

event: record.updated
id: evt_Y29sXzAxMjM0NTY3ODlhYmNkZWYwMTIzNDU2Nzg5YWJjZGVm_00000000000000000044
data: {"eventId":"evt_Y29sXzAxMjM0NTY3ODlhYmNkZWYwMTIzNDU2Nzg5YWJjZGVm_00000000000000000044","collectionId":"col_0123456789abcdef0123456789abcdef","recordId":"rec_8k1m4p2x","occurredAt":"2026-09-25T08:31:00Z","schemaVersion":3,"record":{"id":"rec_8k1m4p2x","createdAt":"2026-09-25T08:30:00Z","updatedAt":"2026-09-25T08:31:00Z","title":"Updated"}}

event: record.deleted
id: evt_Y29sXzAxMjM0NTY3ODlhYmNkZWYwMTIzNDU2Nzg5YWJjZGVm_00000000000000000045
data: {"eventId":"evt_Y29sXzAxMjM0NTY3ODlhYmNkZWYwMTIzNDU2Nzg5YWJjZGVm_00000000000000000045","collectionId":"col_0123456789abcdef0123456789abcdef","recordId":"rec_8k1m4p2x","occurredAt":"2026-09-25T08:32:00Z","schemaVersion":3}

event: record.removed
id: evt_Y29sXzAxMjM0NTY3ODlhYmNkZWYwMTIzNDU2Nzg5YWJjZGVm_00000000000000000046
data: {"eventId":"evt_Y29sXzAxMjM0NTY3ODlhYmNkZWYwMTIzNDU2Nzg5YWJjZGVm_00000000000000000046","collectionId":"col_0123456789abcdef0123456789abcdef","recordId":"rec_8k1m4p2x","occurredAt":"2026-09-25T08:33:00Z","schemaVersion":3}

: heartbeat

```

- `record.created` and `record.updated` include the resulting Record using the regular Record response field semantics after List authorization.
- `record.deleted` and `record.removed` contain only identity and event metadata, never the deleted or newly inaccessible Record values.
- `record.removed` means an Update made a previously listable Record fail the subscriber's currently Applied List rule. Clients should remove that Record from their local view.
- No frame contains credentials, Session tokens, API Keys, raw Authorization headers, request bodies, or internal Storage paths.
- After SSE headers are committed, a Session revocation, Access Rule evaluation failure, Runtime shutdown, or transport error closes the stream without a protected error frame. The client reconnects according to the response/cursor behavior above.

## 4. Bounded Connections and RequestRecord

- The Runtime accepts at most 64 active Realtime subscriptions. A full limit returns HTTP `429 STREAM_CAPACITY_REACHED` with `Retry-After: 5` before SSE headers.
- Each connection has one bounded wake signal and a 5-second write deadline. A slow client can be disconnected but cannot block Record mutation or another subscriber. Disconnect and request cancellation release the connection slot promptly.
- The durable event window is at most 10,000 Events and 64 MiB of Event plus authorization snapshot data across the Project, whichever limit is reached first. A single Event and a single replay page are each capped at 1 MiB of encoded Event data. At most eight replay pages are decoded or held for delivery concurrently; at most 64 subscriptions can be active. When old entries are pruned, the highest pruned sequence is retained per Collection; a resume cursor strictly before its watermark receives `EVENT_CURSOR_EXPIRED`. Project-wide capacity means activity in another Collection can shorten this Collection's replay window; the resulting expiration reveals retention pressure only, not another Collection's event data or identity. Each page checks the watermark and retained Events in one SQLite read snapshot, so a concurrent prune closes an affected stream instead of silently skipping its newly expired cursor.
- The HTTP middleware records one safe RequestRecord per stream. Its Endpoint is a route template with Collection parameters redacted. It attempts the initial durable write before `200` headers; `X-Request-Record-Persisted` reports the result. When the connection ends, it updates duration and response-byte count. SSE frames, Last-Event-ID, credentials, and request/response bodies are never copied into RequestRecord.
- Runtime shutdown cancels all streams within the existing Runtime shutdown deadline. Clients can reconnect after restart using the same Collection-scoped Event ID.

## 5. Application API Workspace Example

Use `fetch` because native `EventSource` cannot attach the Application Session Bearer header. Keep the Session in caller memory and pass an `AbortSignal`; never place the token in a URL or durable browser storage.

```js
async function watchCollectionEvents({
  collectionName,
  sessionToken,
  reloadRecords,
  onRecordEvent,
  signal,
}) {
  let lastEventId;
  let reloadAfterReady = true;
  let retryDelay = 1000;
  const pause = (milliseconds) => new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const finish = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', finish);
      resolve();
    };
    const timer = setTimeout(finish, milliseconds);
    signal.addEventListener('abort', finish, { once: true });
  });

  while (!signal.aborted) {
    const headers = { Accept: 'text/event-stream' };
    if (sessionToken) headers.Authorization = `Bearer ${sessionToken}`;
    if (lastEventId) headers['Last-Event-ID'] = lastEventId;

    let response;
    try {
      response = await fetch(`/api/v1/${encodeURIComponent(collectionName)}/events`, {
        headers,
        cache: 'no-store',
        signal,
      });
    } catch {
      if (signal.aborted) return;
      await pause(retryDelay);
      retryDelay = Math.min(retryDelay * 2, 15000);
      continue;
    }

    if (response.status === 410) {
      lastEventId = undefined;
      reloadAfterReady = true;
      continue;
    }
    if (response.status === 429) {
      const retryAfter = Number(response.headers.get('Retry-After')) * 1000;
      const wait = Number.isFinite(retryAfter) ? Math.min(Math.max(retryAfter, retryDelay), 15000) : retryDelay;
      await pause(wait);
      retryDelay = Math.min(wait * 2, 15000);
      continue;
    }
    if (!response.ok || !response.body) {
      throw new Error(`Realtime subscription failed with HTTP ${response.status}`);
    }

    retryDelay = 1000;
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    try {
      while (!signal.aborted) {
        let chunk;
        try {
          chunk = await reader.read();
        } catch {
          if (signal.aborted) return;
          break; // retry only after a transport read failure
        }
        const { value, done } = chunk;
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        buffer = buffer.replace(/\r\n/g, '\n');
        let boundary;
        while ((boundary = buffer.indexOf('\n\n')) >= 0) {
          const block = buffer.slice(0, boundary);
          buffer = buffer.slice(boundary + 2);
          let eventType = 'message';
          let eventId;
          let hasEventField = false;
          const data = [];
          for (const line of block.split('\n')) {
            if (line.startsWith('id:')) eventId = line.slice(3).trimStart();
            else if (line.startsWith('event:')) {
              eventType = line.slice(6).trimStart();
              hasEventField = true;
            }
            else if (line.startsWith('data:')) data.push(line.slice(5).trimStart());
          }
          if (data.length === 0 && !eventId && !hasEventField) continue; // heartbeat comment
          if (data.length === 0 || !eventId) throw new Error('Malformed realtime event frame');
          const payload = JSON.parse(data.join('\n'));
          if (eventType === 'stream.ready' && reloadAfterReady) {
            await reloadRecords();
            reloadAfterReady = false;
          } else if (['record.created', 'record.updated', 'record.deleted', 'record.removed'].includes(eventType)) {
            await onRecordEvent(eventType, payload);
          } else if (eventType !== 'stream.ready') {
            throw new Error('Unsupported realtime event frame');
          }
          // Advance only after parsing and the requested application work succeed.
          lastEventId = eventId;
        }
      }
    } finally {
      await reader.cancel().catch(() => undefined);
    }

    if (!signal.aborted) {
      await pause(retryDelay);
      retryDelay = Math.min(retryDelay * 2, 15000);
    }
  }
}
```

`reloadRecords` loads the existing Collection Records API. `onRecordEvent` applies create/update data, removes a deleted/removed ID, and may re-read a current Record when needed. The initial `stream.ready` precedes the reload so Events committed during that load remain ordered after its baseline cursor.
