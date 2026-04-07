# Plan 17: Protocol Trace Swimlane Redesign

Status: implemented

## Goal

Replace the current Protocol Trace chronological feed with a swimlane-based layout that shows the full protocol flow per site, with inline HTTP request/response detail. The design is based on mockup 7 (`/tmp/trace-mockup-7.html`).

## Design Reference

See `/tmp/trace-mockup-7.html` (served at `http://localhost:8198/trace-mockup-7.html`) for the target layout. Key properties:

- **Widescreen**: Swimlane grid on left (~40%), detail panel on right (~60%). Narrow: stacked.
- **Swimlane grid**: Rows = Network + per-site. Columns = protocol phases (Ticket, Resolve-Match, Client Setup, Token, Data). Two-line cells: line 1 = method + endpoint + status, line 2 = contextual info.
- **Detail panel**: Shows full HTTP exchange for selected cell. Request and Response as **tabs** (not side-by-side). Each tab: method/status badge, URL, headers table, JSON/form body.
- **Data query drill-in**: Clicking data queries cell shows summary (total queries, total resources) + clickable list of individual queries. Clicking a query shows its request/response. "Back to query list" to return.
- **Internal events**: Synthetic/server-internal events (ticket signing, patient matching) show a "Summary" tab with structured info instead of HTTP request/response.
- **Summary tab everywhere it helps**: token-exchange and registration details should also expose a Summary tab, not just raw Request/Response, so validation steps and patient-match details remain visible.
- **No smooth scrolling**: All view transitions are instant cuts.

## What This Replaces

The current `ProtocolTrace.tsx` has:
- Left sidebar: Ticket summary, Client summary, Verification badges, Sites list
- Right panel: Chronological event feed with phase dividers, each event as a card

This plan replaces both with the swimlane grid + detail panel. The left sidebar summaries become **the grid cells themselves** — the ticket cell IS the ticket summary, the token exchange cells ARE the per-site auth summary, etc.

The Viewer's per-site interaction table (SMART discovery | Token response | Introspection | Access token | Patient/RLS) is conceptually subsumed by the trace's swimlane, but that simplification is deferred until after the swimlane trace is stable.

## Architecture

### State Model

The trace maintains a `Map<string, SiteTraceState>` accumulated from SSE events, plus a network-level state:

```typescript
interface TraceState {
  ticket: TicketSummary | null;                 // from ticket-created event
  network: NetworkTraceState | null;            // network row
  sites: Map<string, SiteTraceState>;           // keyed by siteSlug
  selectedCell: CellId | null;                  // which grid cell is selected
  selectedQuery: number | null;                 // which query within data detail
}

interface NetworkTraceState {
  resolveMatch: EventArtifacts | null;          // from sites-discovered
  clientSetupEvents: RegistrationInfo[];        // usually empty for network row
  tokenEvents: TokenExchangeInfo[];             // latest network token is primary cell content
  sites: SiteInfo[];                            // from sites-discovered detail
}

interface SiteTraceState {
  siteSlug: string;
  siteName: string;
  jurisdiction?: string;
  resolveMatch?: PatientMatchInfo | null;       // derived from token event patientMatch or future explicit event
  clientSetupEvents: RegistrationInfo[];        // retain history; latest drives cell summary
  tokenEvents: TokenExchangeInfo[];             // retain history; latest drives cell summary
  queries: QueryInfo[];                         // from query-result/query-failed for this site
  totalResources: number;
  status: "pending" | "matching" | "setting-up" | "exchanging" | "querying" | "ready" | "error";
  error?: string;
}
```

### Event → State Mapping

| Event Type | Updates |
|-----------|---------|
| `ticket-created` | `state.ticket` — extract patient, permissions, binding, period |
| `sites-discovered` | `state.network.resolveMatch` + `state.network.sites` + create empty `SiteTraceState` per site |
| `registration-request` | Append to `network.clientSetupEvents` or `sites[slug].clientSetupEvents` |
| `token-exchange` phase=network-auth | Append to `state.network.tokenEvents` |
| `token-exchange` phase=site-auth | Append to `state.sites[slug].tokenEvents`; also derive `resolveMatch` if `patientMatch` is present |
| `query-result` | Append to `state.sites[slug].queries`, increment totalResources |
| `query-failed` | Append to `state.sites[slug].queries` with error |
| `session-complete` | Mark all sites as ready (or error if they have errors) |

### Grid Cell IDs

Each cell is identified by `{ row: "network" | siteSlug, column: "ticket" | "resolve-match" | "client-setup" | "token" | "data" }`. Clicking a cell sets `selectedCell`; the detail panel renders based on the selected cell's data.

### Default Selection

On initial render for a session:

1. Select the latest meaningful network cell in this priority order:
   - network token
   - resolve-match
   - ticket
2. If no network cell exists yet, select the most recently updated site cell.
3. If the user has already selected a cell, preserve it as long as that row/column still exists.
4. Reset `selectedQuery` to `null` whenever `selectedCell` changes.

### Scrolling and Sticky Layout

- The swimlane grid and detail panel should scroll independently on wide screens.
- Column headers should be sticky.
- Row labels should be sticky on horizontal overflow.
- The selected cell should remain visible during vertical scrolling.
- On narrow screens, the grid stacks above the detail panel and sticky behavior may simplify to sticky headers only.

### What the Server Needs to Change

Current required change:

1. **Per-site registration identity**: the `registration-request` event must include `siteSlug` and `siteName` when the registration occurs on a site surface, so the swimlane can place it in the correct row.

Already in place:

- `sites-discovered` now has request and response artifacts.
- `query-result` already carries request and response artifacts with body content.
- token-exchange events already carry request/response plus nested steps.

Deferred / optional:

- No new event types for now.
- No explicit per-site SMART discovery lane item for now; any such detail can remain implicit in existing setup/token information unless later judged necessary.

## Phases

### Phase 1: Event Audit + State Model Revision

- [x] Extend `registration-request` event detail with `siteSlug` and `siteName` where applicable
- [x] Define exact reducer/state shape for network and site rows
- [x] Store arrays for client setup and token events, not single slots
- [x] Define latest-event selection rules for each cell
- [x] Define default selected-cell behavior
- [x] Keep current session UX: recent-session picker, auto-select latest session, manual input, new-session toast

### Phase 2: Swimlane Grid Component

- [x] Create new `ProtocolTrace.tsx` (replace current implementation)
- [x] Implement `TraceState` accumulation from SSE events
- [x] Render swimlane grid: header row (phase columns) + network row + site rows
- [x] Two-line cell rendering with status icons, method badges, summary text
- [x] Cell selection (click to highlight, set selectedCell)
- [x] Responsive layout: side-by-side on widescreen, stacked on narrow
- [x] Sticky column headers and sticky row labels on wide screens
- [x] Ticket remains a network-row cell; do not row-span it across all site rows

### Phase 3: Detail Panel — Shared HTTP/JWT Renderers

- [x] Build detail panel around existing HTTP/JWT rendering patterns from `Viewer.tsx`
- [x] Request tab: method badge, URL, headers table, body (JSON syntax-highlighted or form-encoded)
- [x] Response tab: status badge, headers table, body (JSON syntax-highlighted)
- [x] Summary tab for internal events
- [x] Summary tab for token-exchange and registration events
- [x] Ticket cell can render Summary + JWT-oriented detail
- [x] Wire cell selection to detail panel content

### Phase 4: Detail Panel — Data Query Drill-In

- [x] Data queries cell shows summary (N queries, M resources)
- [x] Detail panel for data queries: summary line + clickable query list
- [x] Each query row: GET badge, resource type, path, status, count
- [x] Clicking query row shows its request/response tabs
- [x] "Back to query list" navigation
- [x] selectedQuery state management
- [x] Keep current query filtering rules (hide zero-result/supporting-context noise unless intentionally expanded later)

### Phase 5: Tests + Polish

- [x] Update ProtocolTrace tests for new component structure
- [x] Verify SSE event consumption still works
- [x] Test responsive layout (wide vs narrow)
- [x] Test cell selection, tab switching, query drill-in
- [x] All existing tests pass
- [x] Smoke test passes
- [ ] Visual review: does it match mockup 7?

### Phase 6: Optional Viewer Simplification

- [ ] Reassess the Viewer's per-site interaction table after the swimlane trace is stable
- [ ] If simplified, Viewer focuses on clinical data display (resource list by type, resource detail)
- [ ] Keep the "cross-site query" tool if still useful, or move it to trace
- [ ] Update any links between trace and viewer

## Non-Goals

- Real-time animation of events arriving (cells can just appear/update instantly)
- Replaying historical sessions with timing
- Exporting trace data
- Modifying the event bus or SSE protocol (just the rendering)
- Viewer simplification in the first implementation slice

## Files Likely Touched

**UI (main work):**
- `ui/src/components/ProtocolTrace.tsx` — full rewrite
- `ui/src/components/Viewer.tsx` — reuse request/response/JWT renderers; Viewer simplification optional later
- `ui/src/lib/artifact-viewer.ts` — may need updates for inline detail

**Server (event enrichment):**
- `src/app.ts` — add `siteSlug` / `siteName` to site-level registration events

**Tests:**
- `test/demo-events.test.ts` — update for any event shape changes
- UI component tests if they exist for ProtocolTrace

## Completion Gates

### Gate A: Grid renders from live events
- Swimlane grid populates from SSE
- Cells show correct status and summary text
- Selection works
- Session picker UX still works

### Gate B: Detail panel shows HTTP exchanges
- Request/Response tabs work
- Headers, bodies, method badges all render
- Internal events show Summary tab
- Token and registration cells show Summary tab alongside HTTP detail

### Gate C: Data drill-in works
- Query list renders
- Drill-in to individual query works
- Back navigation works

### Gate D: Event model supports swimlanes
- Site-level registration events include `siteSlug` / `siteName`
- Cell history arrays work without losing retries/failures
- All tests pass

### Gate E: Optional Viewer simplification
- Interaction table removed
- Viewer focuses on clinical data
- Trace and viewer link cleanly
