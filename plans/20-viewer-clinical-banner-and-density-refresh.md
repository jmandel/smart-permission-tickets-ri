# Plan 20: Viewer Clinical Banner and Density Refresh

Status: implemented

## Goal

Make the viewer feel more like a compact clinical application and less like a generic demo shell, while keeping it focused on clinical data rather than protocol mechanics.

This plan is explicitly downstream of:
- Plan 18, which removed most protocol/auth clutter from the viewer
- Plan 17, which moved protocol detail into Protocol Trace
- Plan 19, which simplified the ticket model

## Core Principle

The viewer should derive patient identity context from the Permission Ticket and the loaded clinical data, not from duplicated launch-only fields.

That means:
- `ticket.subject.patient` is the canonical initial patient banner source
- loaded `Patient` resources from connected sites may enrich missing banner fields after load
- `ViewerLaunch` should carry session/runtime routing data, not a second patient profile model

This is a greenfield cleanup. Do not add compatibility shims or new duplicated context fields just to make the header easier to render.

## Target Outcome

The viewer should open into a tighter clinical layout with:
- a patient-banner style header
- clearer primary vs secondary actions
- denser summary cards with less empty space
- calmer site status presentation
- better hierarchy between timeline, selected-clinical-data workspace, and longitudinal/supporting context

## What Should Change

### 1. Patient banner

Replace the generic viewer header with a clinical-banner pattern.

Primary content:
- patient name
- DOB if available
- age if DOB available
- gender if available
- MR identifier only, if present

Behavior:
- render from `ticket.subject.patient` immediately
- enrich from loaded `Patient` resources when fields are missing
- do not require new launch payload fields for DOB / gender / identifiers
- if no ticket `HumanName` is present and no `Patient` resource has loaded yet, render a muted placeholder such as `Patient record`
- for identifier, show the first `ticket.subject.patient.identifier` entry whose `type.coding[*].code === "MR"`; otherwise show no identifier

### 2. Action hierarchy

Promote navigation actions:
- `Back to workbench`
- `View protocol trace`

Demote operational utilities:
- `Copy app link`
- `Reload app`

Preferred pattern:
- keep the two navigation actions visible
- move operational actions into a small overflow / more-actions menu or equivalent secondary treatment

### 3. Overview strip -> insight cards

The current overview strip is too sparse.

Refine it into compact, info-dense insight cards:
- sites: show count plus state/site summary instead of only a number
- encounters: show count plus date span
- resources: show count and, if helpful, a secondary `DocumentReference` line rather than a separate notes tile

These do not need interactive filtering in the first pass. Better density and hierarchy come first.

Target card count:
- `Sites`
- `Encounters`
- `Resources`

### 4. Site summary area

Keep the simplified site list from Plan 18, but tighten it further.

Desired presentation:
- site name
- jurisdiction/state pill
- status pill
- total resource count

Avoid:
- slugs
- redundant status text
- per-resource-type pill explosions
- decorative card chrome that adds noise without information

### 5. Selection workspace

The timeline and selection workspace should feel connected.

Improve:
- selection summary should clearly reflect the active timeline window and selected encounters
- empty states should tell the user what to do next
- notes should visually read as documents, not generic boxes

Do not reintroduce protocol-phase detail here.

### 6. Longitudinal clinical data vs supporting context

Keep the new split:
- longitudinal clinical data
- supporting context

But treat true clinical data such as:
- `AllergyIntolerance`
- `Condition`
- `MedicationRequest`

as clinical data, not support-only context, even when not encounter-bound.

## Data-Source Rules

### Canonical initial identity source

Use the signed ticket payload:
- `ticket.subject.patient.name`
- `ticket.subject.patient.birthDate`
- `ticket.subject.patient.gender`
- `ticket.subject.patient.identifier`

### Enrichment source

Use loaded `Patient` resources from returned site data to fill gaps only.

Required merge rule:
- prefer ticket values when present
- fill only missing banner fields from site `Patient` resources
- if a loaded `Patient` value conflicts with a present ticket value, keep the ticket value silently
- do not surface conflicts in this pass

If conflicts need to be surfaced later, that should be a separate explicit design choice, not implicit replacement.

### Demo narrative summary

The current narrative `Patient Context` paragraph is demo content, not protocol or clinical identity data.

Decision:
- remove it entirely
- remove the render site
- remove the launch field that carries it

## What Should Not Change

- Do not add more patient demographic fields to `ViewerLaunch` just to feed the banner
- Do not reintroduce protocol status tables, token artifacts, or auth substeps into the viewer
- Do not make the viewer responsible for explaining trust or validation; that belongs in Protocol Trace
- Do not add compatibility support for old launch shapes or older ticket models

## Implementation Phases

### Phase 1: Data-source cleanup

- [x] Audit `ViewerLaunch` and `Viewer.tsx` for duplicated patient context
- [x] Define one banner model derived from `ticket.subject.patient`
- [x] Add enrichment from loaded `Patient` resources for missing fields only
- [x] Delete dead launch-only patient fields instead of merely ignoring them
- [x] Remove `launch.person.summary`
- [x] Remove `launch.person.displayName`
- [x] No concrete surviving non-banner consumer was found for `launch.person.displayName`

### Phase 2: Banner and actions

- [x] Replace the generic header with a clinical banner
- [x] Promote `Back to workbench` and `View protocol trace`
- [x] Demote `Copy app link` and `Reload app` into secondary actions
- [x] Improve header visual hierarchy without adding decorative noise

### Phase 3: Insight strip

- [x] Replace the sparse overview strip with denser insight cards
- [x] Show encounter date span using min `Encounter.period.start` and max `Encounter.period.end` across loaded encounters
- [x] Improve site/resource summaries
- [x] Remove low-value duplicate metrics
- [x] Keep exactly three cards: `Sites`, `Encounters`, `Resources`
- [x] Do not render a separate `Clinical notes` card

### Phase 4: Site and workspace polish

- [x] Tighten the site list presentation
- [x] Improve selection-workspace empty states
- [x] Make note/document cards read more like documents
- [x] Ensure longitudinal clinical data and supporting context remain clearly separated

### Phase 5: Tests and docs

- [x] Add focused banner tests only:
  - [x] renders ticket name / DOB / gender when present
  - [x] fills missing fields from loaded `Patient`
  - [x] does not override ticket values when loaded `Patient` disagrees
  - [x] renders muted placeholder when ticket has no name and no `Patient` is loaded yet
  - [x] picks MR-coded identifier only
- [x] Update README/screenshots/docs if needed

## Acceptance Criteria

- The viewer header renders a usable patient banner directly from the signed ticket, without requiring expanded launch demographics
- Loaded `Patient` resources enrich missing banner fields without overriding explicit ticket values
- The viewer contains no `launch.person.summary`
- `launch.person.displayName` is deleted unless a concrete surviving consumer was identified and documented during implementation
- The viewer has fewer visible buttons competing for attention
- Site summaries are compact and clinically readable
- No protocol/detail regressions are introduced back into the viewer
- All existing viewer, demo, and server tests remain green
