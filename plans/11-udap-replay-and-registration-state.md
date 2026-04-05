# Plan 11: UDAP Replay Protection and Registration State

## Goal

Address two real UDAP hardening gaps without abandoning the reference implementation's lightweight, mostly stateless design:

- `jti` replay prevention for UDAP software statements and UDAP client assertions
- active-registration state for UDAP re-registration and cancellation semantics

The design should stay intentionally modest:

- in-memory only
- no persistent database
- explicit documentation that a server restart clears the state

## Scope

### Implement

- an in-memory TTL replay cache for UDAP `jti` values
- an in-memory active-registration map for UDAP clients keyed by `(framework, entity_uri)`
- re-registration that replaces the prior active registration for the same entity
- old UDAP `client_id` rejection once superseded in the current process
- empty-`grant_types` cancellation for UDAP registrations
- docs/tests that make the restart limitation explicit

### Defer

- persistence across process restarts
- clustered/shared replay or registration state
- generalized replay prevention for every OAuth JWT in the server
- full registration history or audit-log retention

## Design

### 1. Replay Cache

Use an in-memory TTL cache keyed by:

```txt
<purpose>|<iss>|<jti>
```

Where `purpose` is one of:

- `udap-dcr`
- `udap-authn`

Behavior:

- accept the first seen tuple
- reject re-use until the JWT expires
- evict on read/write when expired

This is sufficient for the reference implementation and aligns with the existing 5-minute JWT lifetime rules.

Known limitation:

- a process restart clears the replay cache, so previously used `jti` values may become valid again

### 2. UDAP Active Registration State

Keep UDAP client descriptors as signed self-contained JWTs, but add a small active-registration index in memory.

Recommended keys:

- primary registration key: `(framework, entity_uri)`
- active client record value: hash of the most recent `client_id`

Behavior:

- first registration stores the hash for the entity
- re-registration updates the hash
- a decoded UDAP `client_id` is considered active only if its hash matches the current value in the map
- cancellation removes the active hash entry

This gives us supersession and cancellation without storing the whole registration object server-side.

Known limitation:

- a process restart clears the active-registration map, so older still-valid signed UDAP `client_id`s become accepted again until superseded by a fresh registration

That tradeoff should be documented explicitly as acceptable for the reference implementation but not sufficient for production.

## Recommended File Targets

- [clients.ts](../fhir-server/src/auth/clients.ts)
- [udap.ts](../fhir-server/src/auth/frameworks/udap.ts)
- [model.ts](../fhir-server/src/store/model.ts) if we need small metadata additions
- [08-trust-frameworks-client-binding.md](./08-trust-frameworks-client-binding.md)
- [README.md](../fhir-server/README.md)

## Phases

### Phase 1: `jti` Replay Cache

- add a small reusable TTL cache utility
- enforce replay checks on:
  - UDAP software statements
  - UDAP client assertions
- add targeted tests for replay rejection and TTL expiry

Exit criteria:

- the same UDAP software statement cannot be replayed within its validity window
- the same UDAP client assertion cannot be replayed within its validity window

Status:

- implemented

### Phase 2: Active UDAP Registration State

- add in-memory active-registration map keyed by `(framework, entity_uri)`
- store current active `client_id` hash on successful registration
- reject superseded UDAP `client_id`s at token time
- implement empty-`grant_types` cancellation
- document restart limitation

Exit criteria:

- re-registration supersedes the previous UDAP `client_id` in-process
- cancellation invalidates the current UDAP `client_id` in-process
- tests lock down the restart caveat as an intentional reference-implementation tradeoff

Status:

- implemented

## Testing Plan

- unit tests for replay-cache TTL behavior
- UDAP registration tests:
  - first registration succeeds
  - second registration for same entity supersedes prior `client_id`
  - old `client_id` is rejected after supersession
  - empty-`grant_types` cancels active registration
- UDAP token-auth tests:
  - replayed client assertion rejected
  - replayed software statement rejected

## Recommendation

Implement this plan soon, but it does not need to block Plan 10.

The recommended order is:

1. finish the demo UX work in Plan 10
2. apply this hardening slice next

That keeps momentum on the demo while still acknowledging the two remaining real UDAP security gaps.
