# Plan 16: Rename Visualizer to Protocol Trace

Status: complete

## Goal

Rename "Visualizer" / "Demo Visualizer" to "Protocol Trace" everywhere — code, UI, routes, components, comments. The current naming ("visualizer" vs "viewer") is confusing for both developers and users.

## Naming Convention

| Old | New |
|-----|-----|
| Visualizer | Protocol Trace |
| DemoVisualizer | ProtocolTrace |
| Demo Visualizer | Protocol Trace |
| /demo/visualizer | /trace |
| "Open Visualizer" | "Open Protocol Trace" |

The **Viewer** stays as "Viewer" — it shows clinical records. The **Protocol Trace** shows the authorization flow, trust chain, and protocol events.

## Scope

### Code renames (files + symbols)

- `ui/src/components/DemoVisualizer.tsx` → `ui/src/components/ProtocolTrace.tsx`
- Component name `DemoVisualizer` → `ProtocolTrace`
- Route `/demo/visualizer` → `/trace`
- Any CSS classes, test files, or imports referencing "visualizer" or "demo-visualizer"
- Server-side route in `src/app.ts`
- Demo event types/constants if they reference "visualizer"

### UI text

- Button/link labels: "Open Visualizer" → "Open Protocol Trace"
- Page titles, headers
- Any help text or descriptions

### Also fix

- "Open Permission Ticket JWT" button in the Protocol Trace feed — it appears to be a dead link. Either wire it to scroll to the artifact in the viewer, or open an inline detail panel.

## Checklist

- [x] Rename component file and component
- [x] Update route from `/demo/visualizer` to `/trace`
- [x] Update server-side route
- [x] Update all imports
- [x] Update UI text (buttons, labels, titles)
- [x] Update test files
- [x] Fix "Open Permission Ticket JWT" button behavior
- [x] Protocol Trace events should show both HTTP request and response for network interactions (sites-discovered currently only shows the response Bundle, not the request method/URL/headers). Audit all event types and ensure request details are captured alongside responses.
- [x] All tests pass
- [x] Smoke test passes
