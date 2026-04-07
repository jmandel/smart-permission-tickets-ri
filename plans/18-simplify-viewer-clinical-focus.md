# Plan 18: Simplify Viewer to Focus on Clinical Data

Status: complete

## Goal

Strip the viewer down to focus on clinical data display. The Protocol Trace now handles the authorization/protocol story (registration, token exchange, validation steps). The viewer should show "what data did we get" — not duplicate the protocol flow.

## What to Remove

### Per-site interaction table
The table with columns: Site | SMART discovery | Token response | Introspection | Access token | Patient/RLS. This is fully covered by the Protocol Trace swimlane grid. Remove it.

### OAuth artifact inspection
Buttons to open token responses, introspection results, client assertions, JWKS in the artifact viewer. These are protocol artifacts — they belong in the trace, not the data viewer.

### Registration/token status details
Phase indicators (loading-config, exchanging-token, introspecting-token) and error details for auth steps. The trace shows this.

## What to Keep

### Clinical data by site
Per-site resource lists showing what was loaded. Group by resource type (Conditions, Observations, MedicationRequests, etc.) with counts. Click to expand and see individual resources.

### Patient summary
Name, DOB, identifiers at a glance per site.

### Cross-site query tool
The ad-hoc query input that runs a FHIR path across all sites in parallel. This is useful for exploring what data is available and doesn't belong in the trace.

### Resource detail
Click a resource to see its full JSON. This is the clinical data inspection story.

### Link to Protocol Trace
Easy navigation from viewer to trace for the same session. "View Protocol Trace" link.

## What to Simplify

### Site cards
Instead of a complex table, show each site as a simple card: site name, jurisdiction badge, resource count, patient ID. Expand to see resource type breakdown.

### Loading state
Simple per-site loading indicator (spinner → ready → error). No need to show which auth substep is in progress — that's in the trace.

## Checklist

- [x] Remove per-site interaction table from Viewer.tsx
- [x] Remove OAuth artifact buttons (token, introspection, JWKS, client assertion)
- [x] Remove phase substep display (loading-config, exchanging-token, etc.)
- [x] Simplify site rows to: name, jurisdiction, status, resource count
- [x] Keep clinical resource list per site
- [x] Keep patient summary display
- [x] Keep cross-site query tool
- [x] Keep resource detail (click to view JSON)
- [x] Add "View Protocol Trace" link
- [x] Clean up unused imports/types/CSS
- [x] All tests pass
- [x] Smoke test passes
