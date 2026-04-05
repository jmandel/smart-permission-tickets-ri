# Plan 10: Demo Client Types and Just-In-Time Registration

## Goal

Refine the built-in demo so that client identity is a first-class user choice in the **strict-mode demo flow**, not an implementation detail hidden inside the viewer handoff.

The intended strict-mode demo flow becomes:

1. choose a patient
2. choose a client type
3. configure Permission Ticket constraints
4. launch the viewer

This should exercise three distinct client stories already supported by the reference implementation:

- **Unaffiliated registered client**: dynamic JWK registration just before token exchange
- **Well-known client**: no registration, `client_id=well-known:<uri>`
- **UDAP client**: just-in-time UDAP registration, then token-time UDAP client auth

The goal is both educational and practical:

- educational, because the UI should show that the same ticket can be redeemed through materially different client trust models
- practical, because the demo should actually exercise the code paths introduced in Plan 8 rather than always defaulting to the unaffiliated JWK path

This plan is intentionally **strict-mode-first** because that is the mode used in real demos today. Extending the same UX to other modes can come later if it proves useful.

## Why This Plan Exists

The current UI has a strong patient-and-consent story, but the client identity story is still implicit:

- patient selection happens in [App.tsx](../fhir-server/ui/src/App.tsx)
- ticket configuration happens in [PermissionWorkbench.tsx](../fhir-server/ui/src/components/PermissionWorkbench.tsx)
- the viewer launch currently derives client bootstrap internally via `createViewerClientBootstrap(...)` and `registerViewerClient(...)`

That means:

- the user cannot intentionally choose a `well-known` client path
- the user cannot intentionally choose a UDAP path
- the viewer mostly demonstrates the old registered-JWK workflow even though the backend now supports more

Plans [06-demo-client.md](./06-demo-client.md), [07-demo-client-remediation.md](./07-demo-client-remediation.md), and [08-trust-frameworks-client-binding.md](./08-trust-frameworks-client-binding.md) together imply this next step:

- the demo UX needs to expose client identity and registration mode as part of the live workflow

## User Experience Target

### Primary Flow

On the landing page for strict-mode demos:

- **Step 1** stays: choose patient
- **Step 2** becomes: choose client type
- **Step 3** becomes: configure ticket constraints
- **Step 4** remains: launch viewer / inspect artifacts

Recommended client-type cards:

1. **Unaffiliated App**
   - label: "Unaffiliated registered client"
   - explanation: "Registers a one-off JWK just before token exchange."
   - registration behavior: dynamic registration at `/register`
   - ticket binding shape: `cnf.jkt` when the selected mode requires key binding

2. **Well-Known App**
   - label: "Well-known client"
   - explanation: "Uses `well-known:<uri>` and resolves keys from `/.well-known/jwks.json`."
   - registration behavior: none
   - ticket binding shape: `client_binding` for framework/entity binding

3. **UDAP App**
   - label: "UDAP client"
   - explanation: "Performs just-in-time UDAP registration, then authenticates with `x5c` at token time."
   - registration behavior: UDAP DCR at `/register`
   - ticket binding shape: `client_binding`

### UX Principles

- the client type choice should appear **before** the ticket is built, because it affects ticket binding
- the UI should explain why the choice matters
- the artifact viewer should make the chosen client path obvious:
  - whether registration happened
  - which `client_id` was used
  - whether the ticket used `cnf.jkt`, `client_binding`, or neither
- for the framework-affiliated well-known path, the UI should also show the framework-published client details that were used to describe the app
- the well-known and UDAP stories should be runnable without extra manual setup

## Proposed UX Shape

### New Step Layout

Current:

- Step 1: patient
- Step 2: build ticket

Proposed for strict mode:

- Step 1: patient
- Step 2: client type
- Step 3: build ticket
- Step 4: launch / inspect artifacts

### Step 2 Content

Each client-type choice should show:

- short description
- trust model
- whether registration is required
- whether key binding or framework binding is expected

Recommended detail copy:

- **Unaffiliated registered client**
  - "This app generates a one-off key pair and dynamically registers it with the server."

- **Well-known client**
  - "This app is identified by a `well-known:<uri>` client id. The server resolves current keys from the entity's JWKS."

- **UDAP client**
  - "This app performs UDAP dynamic registration, then authenticates using a certificate chain and client assertion."

### Artifact Visibility

The artifact panel should include a client section with:

- selected client type
- effective `client_id`
- whether registration occurred
- registration request / response payload when applicable
- client assertion JWT
- for UDAP:
  - software statement
  - registration response
  - token-time assertion
- for well-known:
  - resolved entity URI
  - resolved JWKS URL
- for unaffiliated:
  - registered JWK thumbprint

## Scope

### Implement

- a new client-type selection step in the landing/workbench UI
- a typed client-selection model in the demo state and viewer handoff
- just-in-time client preparation based on that selected type
- artifact inspection that clearly shows the chosen client path
- docs that explain the three demo client stories and how to exercise them
- a server-published demo framework JSON document for well-known demo clients

### Defer

- OpenID Federation demo flow
- manual entry of arbitrary well-known URIs or arbitrary UDAP cert material
- multi-client or multi-binding composition in one launch
- an admin UI for managing demo trust-framework fixtures
- exposing the client-type step across every non-strict mode

## Client Types To Support

### 1. Unaffiliated Registered Client

This is the current viewer-friendly story and remains the fallback.

Behavior:

- generate JWK pair in-browser
- dynamically register at the selected auth surface
- authenticate with `private_key_jwt`
- use `cnf.jkt` when the selected mode / ticket story wants exact-key binding

This is the best fit for:

- existing strict / registered / key-bound flows
- showing the old baseline behavior

### 2. Well-Known Client

Behavior:

- no registration call
- use a known demo entity URI from a server-published demo framework document
- send `client_id=well-known:<uri>`
- authenticate with the entity's key
- let the server resolve JWKS from `/.well-known/jwks.json`
- display framework-published client details in the workbench and artifact viewer

This is the best fit for:

- showing implicit registration / URL-based client identity
- showing framework-backed well-known behavior without a `/register` call

Recommended initial story:

- the default demo well-known client should be **framework-affiliated**
- the framework itself should be represented by a JSON document hosted on the reference server
- that document should advertise:
  - client display details
  - a small set of sample client entities
  - relative client URLs / entity URIs that resolve back to the same server

Recommended demo shape:

- framework URL: a server-local JSON page such as `/demo/frameworks/well-known-reference.json`
- client entities: server-local subpaths such as `/demo/clients/well-known-alpha` and `/demo/clients/well-known-beta`
- entity JWKS resolution: still via the existing well-known client path rules

This keeps the demo self-contained while making the framework-affiliation story visible in the UI.

Example:

```txt
well-known:http://127.0.0.1:8091/demo/clients/well-known-alpha
```

The entity should be chosen from the framework-published list, not typed manually by the demo user.

### 3. UDAP Client

Behavior:

- use bundled demo UDAP client certificate/key material
- construct a software statement
- register just in time with UDAP DCR
- receive server-issued `client_id`
- use UDAP token-time client assertion with `x5c`

This is the best fit for:

- demonstrating trust-framework-backed client registration
- showing how UDAP registration and token auth differ from JWK registration
- proving the live stack now supports the same flow Inferno validated

## Recommended Data Model Changes

### UI Model

Add a new demo-facing client type:

```ts
type DemoClientType = "unaffiliated" | "well-known" | "udap";
```

This should live in [types.ts](../fhir-server/ui/src/types.ts) and be stored in the app-level UI state.

### Consent / Workbench State

Do not overload `ConsentState` with client selection.

Instead, keep client choice adjacent to consent as its own selection, for example:

```ts
type ClientSelection = {
  type: DemoClientType;
  label: string;
  description: string;
};
```

Reason:

- consent state is about ticket semantics
- client selection is about client identity and transport/auth behavior

Those should remain conceptually separate.

### Viewer Launch Payload

The viewer launch payload should stop assuming only a generic `clientBootstrap`.

Recommended shape:

```ts
type ViewerLaunch = {
  ...
  clientPlan: {
    type: "unaffiliated" | "well-known" | "udap";
    displayLabel: string;
    registrationMode: "dynamic-jwk" | "implicit-well-known" | "udap-dcr";
    bootstrap?: ...;
    wellKnown?: ...;
    udap?: ...;
  };
};
```

This is the key handoff change.

The viewer should receive enough information to:

- know which prep path to execute
- know whether it should register
- know how to build the client assertion
- display the client story back to the user

## Ticket Construction Rules

Client type must influence ticket binding.

### Unaffiliated

Default behavior:

- `cnf.jkt` when the chosen mode expects key-bound behavior
- no `client_binding`

### Well-Known

Default behavior:

- include `client_binding`
- use the selected well-known framework/entity pair
- usually do **not** include `cnf.jkt`
- source client display details from framework metadata rather than the entity's own untrusted metadata

Possible exception:

- for very strict demo variants, allow `cnf.jkt` too, but this should not be the default

### UDAP

Default behavior:

- include `client_binding`
- bind to the demo UDAP framework and client entity URI
- do not rely on `cnf.jkt` by default

## Execution Model

### Current Preparation Model

Today [PermissionWorkbench.tsx](../fhir-server/ui/src/components/PermissionWorkbench.tsx) computes artifacts roughly like this:

- decide whether a bound client is needed from mode alone
- if needed, generate viewer client bootstrap
- build ticket payload
- sign ticket
- build viewer launch

That is too mode-centric now.

### Proposed Preparation Model

Replace mode-only client prep with client-type-aware prep:

1. read selected client type
2. create a client plan
3. build ticket payload using that plan's binding data
4. sign ticket
5. build viewer launch with the full client plan

Then, in the viewer:

1. inspect `launch.clientPlan.type`
2. execute the matching setup path
3. exchange token using the resulting client identity

### Viewer-Side Execution Paths

#### Unaffiliated

- generate/register JWK if not already provided in the launch
- use `private_key_jwt`

#### Well-Known

- skip `/register`
- use `well-known:<uri>` as `client_id`
- sign assertions with the bundled well-known private key
- use framework-published metadata for display and artifact labeling

#### UDAP

- POST `udap=1` + `software_statement` to `/register`
- store returned `client_id`
- use UDAP `client_assertion` with `x5c` and `udap=1`

## Recommended File Targets

### UI Shell / App State

- [App.tsx](../fhir-server/ui/src/App.tsx)
- [store.ts](../fhir-server/ui/src/store.ts)
- [types.ts](../fhir-server/ui/src/types.ts)

### Demo State / Launch Construction

- [demo.ts](../fhir-server/ui/src/demo.ts)
- [PermissionWorkbench.tsx](../fhir-server/ui/src/components/PermissionWorkbench.tsx)

### Viewer Runtime

- [viewer-store.ts](../fhir-server/ui/src/lib/viewer-store.ts)
- [viewer-client.ts](../fhir-server/ui/src/lib/viewer-client.ts)
- [Viewer.tsx](../fhir-server/ui/src/components/Viewer.tsx)

### Server / Bootstrap

- [app.ts](../fhir-server/src/app.ts)
- `/demo/bootstrap` payload for predeclared demo client options
- a server-published JSON document for demo well-known framework metadata and sample clients

### Docs

- [README.md](../fhir-server/README.md)
- [06-demo-client.md](./06-demo-client.md)
- [07-demo-client-remediation.md](./07-demo-client-remediation.md)
- [08-trust-frameworks-client-binding.md](./08-trust-frameworks-client-binding.md)

## Recommendation: Source of Truth for Demo Client Options

There are two reasonable designs.

### Option A: Hardcode Demo Client Options in the UI

Pros:

- simpler
- fewer server changes
- fast to implement

Cons:

- duplicates backend demo-framework knowledge
- more brittle if demo fixtures change

### Option B: Include Demo Client Options in `/demo/bootstrap`

Pros:

- server remains source of truth
- UI can adapt to configured frameworks
- easier to evolve later

Cons:

- slightly broader server/bootstrap contract

### Recommendation

Use **Option B**.

`/demo/bootstrap` should advertise the supported demo client choices and the metadata needed to exercise them.

Recommended shape:

```json
{
  "demoClientOptions": [
    {
      "type": "unaffiliated",
      "label": "Unaffiliated registered client",
      "registrationMode": "dynamic-jwk"
    },
    {
      "type": "well-known",
      "label": "Well-known client",
      "registrationMode": "implicit-well-known",
      "entityUri": "https://..."
    },
    {
      "type": "udap",
      "label": "UDAP client",
      "registrationMode": "udap-dcr",
      "framework": "https://..."
    }
  ]
}
```

This keeps the UI honest and lets the backend control what the demo can actually exercise.

## Open Questions

These do not block the plan, but they should be answered before implementation.

### 1. Should the workbench allow switching client type after configuring consent?

Recommended answer:

- yes
- switching client type should invalidate prepared artifacts and rebuild on demand

That matches the current `preparePromiseRef` pattern already used in [PermissionWorkbench.tsx](../fhir-server/ui/src/components/PermissionWorkbench.tsx).

### 2. What exact server-published framework JSON shape should the well-known demo use?

Recommended answer:

- keep it intentionally small and demo-specific
- include:
  - framework URI
  - framework display name
  - sample clients with:
    - label
    - description
    - relative entity URI
    - optional JWKS-relative hint if needed for display

The important requirement is that the document is readable by the UI and visibly anchors the well-known client as framework-affiliated.

### 3. Should UDAP registration happen in the workbench or only inside the viewer?

Two options:

- register in the workbench and hand the viewer a ready `client_id`
- keep registration inside the viewer for parity with the actual app handoff

Recommended answer:

- keep it in the **viewer**

Reason:

- the viewer should own the actual client execution path
- the workbench should prepare intent and inspectable artifacts, not fully execute the auth flow

## Phased Implementation

### Phase 1: State Model and UX Scaffolding

- add `DemoClientType`
- add strict-mode client-type selection UI
- add `/demo/bootstrap` support for demo client options
- add server-published framework JSON for well-known demo clients
- thread the selected client type through app state and workbench props

Status:

- implemented

Exit criteria:

- the strict-mode landing flow visibly shows patient → client type → ticket steps
- switching client type updates the workbench state

### Phase 2: Viewer Launch Contract

- replace `clientBootstrap`-only assumptions with `clientPlan`
- update launch encoding/decoding
- update artifact viewer to display client-plan details

Status:

- implemented

Exit criteria:

- the launch payload clearly distinguishes unaffiliated, well-known, and UDAP

### Phase 3: Runtime Client Prep Paths

- implement viewer runtime for:
  - unaffiliated dynamic JWK registration
  - well-known no-registration flow
  - UDAP just-in-time registration

Status:

- implemented

Exit criteria:

- all three paths can obtain tokens in the demo

### Phase 4: Binding-Aware Ticket UX

- make the ticket artifact clearly show whether it uses:
  - `cnf.jkt`
  - `client_binding`
  - both
- show why that shape was chosen from the selected client type

Status:

- implemented

Exit criteria:

- a user can see the client/ticket relationship without reading the code

### Phase 5: Docs and Demo Polish

- update README and demo docs
- add explicit “what this path demonstrates” language
- add copyable curls or artifact views for each client type

Status:

- implemented

Exit criteria:

- a user can intentionally demo each client story without prior repo knowledge

## Testing Plan

### Unit Tests

- `demo.ts`
  - client-plan creation
  - ticket binding shape by client type
  - launch payload encoding/decoding

- `viewer-client.ts`
  - well-known assertion path
  - UDAP registration request construction
  - unaffiliated registration request construction

### UI Tests

- `App.tsx`
  - strict-mode client-type step appears after patient selection
  - non-strict modes continue to behave sensibly without requiring the new step

- `PermissionWorkbench.tsx`
  - changing client type invalidates stale artifacts
  - artifact panel reflects the selected client type

### Integration Tests

- unaffiliated demo launch succeeds
- well-known demo launch succeeds without registration
- UDAP demo launch succeeds with just-in-time registration
- well-known demo client metadata is loaded from the server-published framework JSON

### Smoke / Manual Demo Checks

- patient access + unaffiliated client
- patient access + well-known client
- patient access + UDAP client
- confirm artifact viewer shows:
  - registration present/absent correctly
  - chosen `client_id`
  - ticket binding shape

## Recommendation

This change makes sense and should be implemented.

It is a natural continuation of Plan 8:

- the backend already supports the three client stories
- the current demo does not expose them clearly
- the workbench already has the right structural seam to insert the new step

The strongest first slice is:

1. add the client-type selection step
2. drive ticket binding shape from that selection
3. implement the well-known and UDAP viewer paths
4. improve artifact visibility

That will make the demo materially better without changing the underlying trust-framework model again.
