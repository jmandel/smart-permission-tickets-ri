# Plan 13: Demo Event Visualization

## Goal

Add a live event visualization to the reference server so that every authorization decision, token exchange, FHIR query, and trust verification is observable in real time during a demo. The visualization should be educational — making the protocol's trust chain, fan-out pattern, and per-site independent verification tangible and inspectable.

## Why This Plan Exists

The reference server has strong API coverage and a functional demo UI, but the authorization mechanics are invisible. A presenter can show the patient data that comes back, but not:

- the 7-step ticket verification cascade
- the per-site independent re-verification
- the scope narrowing from ticket ceiling to actual data
- the client identity binding and why it matters
- the fan-out from one ticket to N site tokens to N×M FHIR queries

This plan makes those mechanics visible, inspectable, and educational.

## Design: Summary + Audit Feed (Hybrid)

Selected from 14+ prototype iterations. The winning design is a two-panel layout:

- **Left panel (35%): Living summary** — compact, always-visible, accumulates persistent state
- **Right panel (65%): Detail feed** — scrollable audit trail with rich inline context per event

Every important event leaves lasting visual state. Small events leave small traces. Nothing important is transient-only.

Reference prototype: [viz-hybrid-prototype.html](./references/viz-hybrid-prototype.html)

### Left Panel Sections

**Ticket** (amber left border): Patient name, scope pills (colored by resource type), constraints (date range, sensitivity, expiry, binding). Appears when ticket is created.

**Client** (blue left border): Registration status, client_id. Accumulates as registration completes.

**Verification** (purple left border): 7 check badges appearing one at a time — Signature, Type, Expiration, Audience, Issuer Trust, Client Binding, Revocation. Then patient-match count and network token status.

**Sites** (teal left border): Compact rows with colored status dots (gray → amber → green). Each row shows site name and running resource count. Clicking a site expands to show resource type pills and scrolls the feed to that site's first event.

**Totals**: Summary line at bottom.

### Right Panel Feed

Chronological audit trail. Each entry is a compact card with:
- Phase-colored left border
- Icon, bold label, detail text
- Inline colored pills for resource types and counts
- Phase divider headers when phase changes

Auto-scrolls to bottom unless user has scrolled up to read earlier events.

### Artifact Inspection

Every visual element is clickable. Clicking opens the artifact viewer (existing `buildArtifactViewerHref` infrastructure) showing the full detail:

- Ticket pills → opens signed ticket JWT (header, payload, signature)
- Verification check badges → opens the validation detail (issuer JWKS, signature verification, audience comparison, CRL response)
- Site status → opens the site token exchange request/response (full HTTP)
- Resource pills → opens the FHIR Bundle response
- Client status → opens registration request/response
- Feed entries → opens the full request/response pair for that event

This reuses the existing artifact viewer infrastructure from Plan 10.

## Architecture

### Event Bus

An in-process `DemoEventBus` class owned by the server process, with per-session state stored internally in a `Map<sessionId, SessionState>`.

The event schema should be a **shared typed union** in a file that both server and UI can import, for example:

- `reference-implementation/fhir-server/shared/demo-events.ts`

The union should include:

- a shared envelope: `seq`, `timestamp`, `source`, `phase`, `type`, `label`
- typed event variants with event-specific `detail`
- optional `artifacts` for inspection

Use one shared union for both server and viewer events, with:

- `source: "server" | "viewer"`

The server is authoritative for:

- assigning `seq`
- assigning `timestamp`
- replaying buffered events

Client-posted events are accepted as drafts and normalized by the server before they enter the bus.

The bus stores events in a per-session array (no ring buffer — demo sessions should stay well under a few hundred events). It fans out to all SSE listeners for that session.

### Session Scoping

Each demo viewer launch creates a unique session ID (UUID). The session ID flows through the system as:

1. The workbench generates `sessionId` at launch time and includes it in the viewer launch payload
2. The viewer passes `X-Demo-Session: <sessionId>` on every HTTP request to the server
3. The server associates events with the session ID from this header
4. The visualization connects to `/demo/events/<sessionId>` SSE endpoint
5. Multiple browser windows can observe the same session

Session buffers are cleaned up after 30 minutes of inactivity. Activity means:

- event emission
- SSE subscribe/replay
- client-side event POST

Events from different sessions never mix. If no `X-Demo-Session` header is present, no events are emitted (zero overhead for non-demo usage).

### Transport: Server-Sent Events

SSE is the right choice for this use case:

- Unidirectional (server → client only)
- Built-in reconnection via `EventSource` API
- `Last-Event-ID` header enables replay on reconnect
- Bun has first-class support via `ReadableStream` + `text/event-stream`
- No external dependencies

Endpoint: `GET /demo/events/:sessionId`

```ts
// Bun route handler
if (pathname.startsWith("/demo/events/")) {
  const sessionId = pathname.split("/")[3];
  const lastId = parseInt(req.headers.get("last-event-id") ?? "0", 10);

  const stream = new ReadableStream({
    start(controller) {
      const cleanup = eventBus.subscribe(sessionId, (event) => {
        controller.enqueue(`id: ${event.seq}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
      }, lastId);
      // Store cleanup for connection close
    },
    cancel() { cleanup(); }
  });

  return new Response(stream, {
    headers: { "content-type": "text/event-stream", "cache-control": "no-cache" }
  });
}
```

Important Bun detail: call `server.timeout(req, 0)` to prevent Bun's default 10-second idle timeout from closing the SSE connection.

### Server-Side Instrumentation

Add event emission at natural decision points in the existing code. Each instrumentation point should stay small and explicit.

Use an **optional observer** instead of importing the bus into low-level auth logic.

Recommended shape:

```ts
type DemoObserver = {
  sessionId: string;
  emit(event: DemoEventDraft): void;
};
```

The request handler derives `observer` from `X-Demo-Session` and passes it down to the functions participating in the demo flow. Low-level auth and ticket code should only see `observer?.emit(...)`, not the bus, request, or session registry.

**In `app.ts`:**

| Event | Location | Data |
|-------|----------|------|
| `ticket-presented` | Before `validatePermissionTicket()` | grant_type, endpoint |
| `token-issued` | After `signJwt()` for access token | scopes, sites, mode |
| `client-registered` | After dynamic/UDAP registration | client_id, auth_mode |
| `site-token-exchange` | At start of per-site token handling | site name |
| `site-token-issued` | After per-site token issuance | site, scopes |
| `check-passed`: Client Binding | After `enforceClientRequirements()` | binding type, why |
| `check-failed` / `site-token-failed` | Error branches worth showing in demos | reason, site, request path |

**In `tickets.ts`:**

| Event | Location | Data |
|-------|----------|------|
| `check-passed`: Signature | After `verifyPermissionTicketSignature()` | alg, kid |
| `check-passed`: Type | After ticket_type check | ticket_type |
| `check-passed`: Expiration | After exp check | exp, remaining |
| `check-passed`: Audience | After aud check | aud values |
| `check-passed`: Issuer | After `resolveTrustedIssuer()` | issuer URL, trust source |
| `check-passed`: Revocation | After `assertActive()` | revocation URL, status |
| `patient-matched` | After subject resolution in `compileAuthorizationEnvelope()` | patient, site count |
| `check-failed` | Validation failures worth showing | check name, reason |

**In `frameworks/udap.ts`:**

| Event | Location | Data |
|-------|----------|------|
| `udap-register` | After UDAP registration | framework, SAN |
| `registration-failed` | UDAP registration failures | framework, reason |

**Artifact capture**: For events where inspection is valuable, capture request/response artifacts on the event object. Prefer capturing already-parsed payloads and known response bodies at natural decision points rather than cloning streams everywhere. Only do this when a `X-Demo-Session` header is present to avoid overhead in non-demo usage.

### Wrapper Pattern

To keep handlers clean, use a thin wrapper that captures artifacts:

```ts
function withEventCapture(
  sessionId: string | null,
  eventType: string,
  detail: Record<string, unknown>,
  artifacts?: DemoEvent["artifacts"],
) {
  if (!sessionId) return;
  eventBus.emit(sessionId, eventType, detail, artifacts);
}
```

Called inline at instrumentation points — not as middleware wrapping the whole handler.

### Client-Side Instrumentation

The viewer (`viewer-store.ts`, `viewer-client.ts`) also emits events for client-side actions:

| Event | Location | Data |
|-------|----------|------|
| `ticket-created` | Viewer init, synthesized from launch payload | scopes, patient, constraints |
| `udap-discovery` | Before UDAP metadata fetch in `prepareViewerClient()` | endpoint |
| `sites-discovered` | After `$resolve-record-locations` | site list |
| `query-result` | After logical all-pages fetch completes per site/resource type | resource_type, count, site |
| `query-failed` | Viewer-side data retrieval failures | site, resource type, reason |
| `session-complete` | After all site pipelines finish | totals |

Client-side events are sent to the server via `POST /demo/events/:sessionId` and merged into the same stream. This keeps the single SSE endpoint as the source of truth for the visualization.

The viewer should post synthetic bootstrap events from the launch payload on init. In particular, `ticket-created` should be reconstructed from the launch payload instead of requiring the workbench to post its own event before navigation.

### Visualization Component

The visualization is a new route at `/demo/visualizer?session=<sessionId>`.

It renders the hybrid layout from the prototype, consuming events via `EventSource`:

```ts
const source = new EventSource(`/demo/events/${sessionId}`);
source.onmessage = (e) => {
  const event = JSON.parse(e.data);
  processEvent(event); // same handler pattern as the prototype
};
```

Every visual element gets a `data-event-seq` attribute linking it to the event that created it. Clicking any element opens the artifact viewer with `event.artifacts` data.

## Artifact Inspection Detail

When a user clicks any visual element:

1. Look up the `DemoEvent` by its `seq` number
2. If `event.artifacts` exists, open the artifact viewer showing:
   - **Request tab**: method, URL, headers (formatted), body (syntax-highlighted JSON/JWT)
   - **Response tab**: status, headers, body
   - **Event tab**: the full event object as formatted JSON
3. For JWT artifacts (tickets, assertions, tokens): use the existing `buildJwtArtifactPayload` to show header/payload/signature decomposition
4. For FHIR Bundles: show the Bundle JSON with resource count and type breakdown

The artifact viewer already exists (`ui/src/lib/artifact-viewer.ts`). The extension is adding the ability to pass a `DemoEvent` and render its artifacts tab.

## Scope

### Implement

- `DemoEventBus` class with per-session buffering and SSE fan-out
- SSE endpoint at `/demo/events/:sessionId`
- Server-side instrumentation (~20 emit points across `app.ts`, `tickets.ts`, `udap.ts`)
- Client-side event posting from viewer
- Visualization page at `/demo/visualizer`
- Artifact inspection on click (request/response/JWT detail)
- Session ID flow through viewer launch → HTTP headers → event scoping
- Session cleanup after 30 minutes

### Defer

- Persistent event storage (events are in-memory only, lost on restart)
- Multi-user event isolation beyond session scoping
- Recorded demo replay from saved event logs
- Production telemetry / OpenTelemetry integration
- Custom event filtering or search
- Diff view comparing two demo runs

## Phased Implementation

### Phase 1: Event Bus, Session Plumbing, and Raw Feed Infrastructure

- Create shared typed event union in `shared/demo-events.ts`
- Create `DemoEventBus` class in `src/demo/event-bus.ts`
- Add SSE endpoint to `app.ts`
- Add session ID extraction from `X-Demo-Session` header
- Add client-side event POST endpoint
- Thread session ID through viewer request helpers
- Add session cleanup timer
- Add a minimal raw event feed for development/debugging
- Test: connect `EventSource`, emit test event, verify receipt and replay

### Phase 2: Server-Side Instrumentation

- Add observer plumbing from request handlers into ticket/auth code
- Add ~20 instrumentation points across `app.ts`, `tickets.ts`, `frameworks/udap.ts`
- Capture artifacts where useful using parsed payloads / known response bodies
- Verify zero overhead when no session header
- Test: run a demo flow, verify complete event stream

### Phase 3: Client-Side Instrumentation

- Add session ID to viewer launch payload and viewer-store
- Add `X-Demo-Session` header to all viewer HTTP requests
- Add client-side event posts for ticket bootstrap, discovery, logical query completion, and completion
- Test: full demo produces a coherent event sequence with per-site interleaving

### Phase 4: Visualization UI

- Create visualization page component (port prototype HTML/CSS/JS into React)
- Left panel: ticket, client, verification, sites sections
- Right panel: scrollable feed with phase dividers and inline pills
- Summary banner with running totals
- Auto-scroll behavior (pin to bottom unless user scrolled up)
- Test: open visualizer alongside viewer, run demo, verify real-time updates

### Phase 5: Artifact Inspection

- Make every visual element clickable with `data-event-seq`
- Extend artifact viewer to accept `DemoEvent.artifacts`
- Add request/response tabs alongside JWT decomposition
- For FHIR Bundles: show type breakdown
- Test: click a check badge → see the validation detail; click a resource pill → see the FHIR Bundle

### Phase 6: Polish and Integration

- Add "Open Visualizer" button to the workbench (opens in new window with session ID)
- Add visualizer link to the demo landing page
- Ensure visualizer works when opened mid-demo (replays buffered events)
- Responsive layout for different viewport sizes
- Update README with visualizer documentation

### Follow-on / Deferred

- Recorded replay mode
- Play/pause/step/speed controls
- Keyboard shortcuts for replay navigation

## Testing Strategy

### Unit

- `DemoEventBus`: emit, subscribe, replay from seq, session cleanup
- SSE endpoint: correct `text/event-stream` headers, `Last-Event-ID` replay
- Session scoping: events from different sessions don't mix

### Integration

- Full demo flow → visualizer shows complete event sequence
- Mid-demo visualizer open → replays buffered events then streams live
- Multiple visualizer windows on same session → both receive events
- No `X-Demo-Session` header → zero event overhead
- Parallel site pipelines interleave naturally while staying coherent within each site

### Smoke

- Run demo end-to-end with visualizer open
- Click every visual element → artifact viewer opens with correct data
- Verify the educational narrative is coherent: trust chain → fan-out → data access

## Open Questions

### 1. Should the visualizer be a separate React component or a standalone HTML page?

Recommended: **React component** served from the existing UI build. This reuses the existing artifact viewer, Zustand state management, and styling infrastructure. The prototype's vanilla JS architecture maps cleanly to React (each section becomes a component, the event handler becomes a Zustand store action).

### 2. Should events include full HTTP artifacts or just summaries?

Recommended: **Rich artifacts when `X-Demo-Session` is present, but only at logical boundaries.** The inspection value of seeing actual JWTs, FHIR Bundles, and HTTP headers is high, but capture should happen from parsed request/response objects and logical fetch completions, not by cloning every stream indiscriminately.

### 3. Should the visualizer support recorded replay?

Recommended: **Defer to a follow-on plan.** The SSE infrastructure naturally supports this (save events to a JSON file, replay them through the same `processEvent` handler), but the live demo use case should land first.

## Relationship to Existing Plans

- Plan 10 established the demo client type selection and artifact viewer infrastructure
- Plan 12 aligned the server's validation behavior with the spec (the checks the visualizer displays)
- This plan builds on both: it makes Plan 12's validation chain visible and extends Plan 10's artifact viewer for event inspection

## Implementation Notes

- The event feed should accept that per-site authorization and data retrieval events will interleave in real time. This is not a bug; it demonstrates the actual fan-out behavior of the viewer and server.
- The prototype's visually serial presentation is still useful as a design reference, but the live implementation should not force false serialization once site pipelines begin.
