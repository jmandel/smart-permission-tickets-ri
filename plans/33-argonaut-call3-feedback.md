# Spec Work Plan — Post April 8, 2026 Call

## Overview

This document tracks spec changes driven by the April 8 call discussion. Each item is categorized as either a concrete change to make now or an item to park explicitly with an open-question flag. For each item, draft spec language is provided at the end of this document.

The goal is a spec that reads as a coherent whole, not as a pile of patches on older content. Where an item overlaps substantively with another (for example, the multiple facets of responder-filter semantics raised by Cooper Thompson, Bryan Frost, and Jason Vogt), it is consolidated into a single item so there is one authoritative treatment in the spec.

---

## Items to Change Now

### 1. Responder Filter Semantics: the Endpoint Gate / Custodian Model

**Source:** Cooper Thompson's extended discussion about what "site" means; Bryan Frost's chat comment about multi-hospital organizations with disease-area-specific sites; Jason Vogt's question about per-site permissions.

**Problem:** Patients think about their healthcare data in terms of physical locations, brands, or specific providers ("Main Street Clinic," "Downtown Women's Health"). To support that mental model, the spec includes `access.responder_filter` with jurisdiction and organization options. It also establishes a strict enforcement baseline: **Data Holders that cannot enforce a presented constraint SHALL reject the ticket.**

There is a fundamental impedance mismatch between the patient mental model and the architectural reality of modern EHRs. In major enterprise deployments a single FHIR endpoint typically fronts dozens of hospitals, clinics, and sometimes distinct legal entities operating on a shared software instance. Clinical data inside these shared deployments (Allergies, Problems, Medications, orphan lab results, etc.) is integrated into a unified patient chart and is **intentionally not attributed or strictly partitioned by leaf-node facility**.

If an Issuer mints a ticket constrained to a leaf facility, a shared EHR endpoint will receive it, realize it cannot securely filter the integrated chart down to only that leaf, and be forced by the current enforcement baseline to reject the ticket entirely. At scale this would produce systemic ticket rejections across the industry.

The spec currently does not address this mismatch at all, which means different readers interpret `responder_filter` in incompatible ways and the strict enforcement rule becomes a trap.

**Architectural decision — Endpoint Gate / Custodian Model.** To make Permission Tickets operational at scale, the spec adopts the following semantics:

- **The filter gates the Data Holder, not individual clinical resources.** `responder_filter` evaluates the Data Holder (custodial system or endpoint manager) as a whole. It answers: *"Is this system authorized to respond to this ticket?"*
- **Integrated records may be returned in their entirety.** If a Data Holder is authorized by the filter, it may return the integrated patient record it manages, even if that record contains data originating from multiple physical sites sharing the deployment. The filter is not a resource-by-resource clinical data filter.
- **Matching is at the FHIR endpoint level.** A Data Holder evaluates the filter against its own organizational identity and the jurisdiction(s) it operates in. A multi-jurisdiction Data Holder SHOULD answer a jurisdiction-filtered ticket if any of its jurisdictions match. It MAY apply internal filtering if its architecture supports facility-level attribution, but is not required to.
- **Indeterminate match rejects.** If a Data Holder cannot determine whether it matches a presented filter, it SHOULD reject the ticket with `invalid_grant` rather than guessing.
- **Organization filters are endpoint-agnostic.** A single ticket with `responder_filter.organization` authorizes access at any of that organization's endpoints that support the Permission Ticket grant type. A Data Holder operating multiple technical endpoints (e.g., FHIR and DICOMweb) under one organizational identity honors the filter at all of them.
- **Pre-minting resolution is the Issuer's job.** Because Data Holders cannot untangle the data, the burden of resolving leaf-node facilities to custodial Data Holder endpoints shifts **upstream to the Ticket Issuer**, before the ticket is minted. Issuers SHOULD consult endpoint directory information — published endpoint networks, trust framework directories, SMART Brands data — to map leaf-node facilities to their custodial Data Holder endpoints, and scope the resulting ticket to the encompassing organization.
- **Issuer UIs should surface the reality to users.** Non-normative guidance: when a user attempts to authorize sharing for a specific leaf facility, the Issuer's application should use directory information to tell them what they're actually authorizing, e.g., *"Main Street Clinic manages its records jointly with Regional Health System. Authorizing this connection will share your integrated health record from all Regional Health System locations."*
- **Sub-endpoint filtering remains an explicit open question (OQ-4).** Whether future versions of this spec should define a mechanism for intra-endpoint data attribution is unresolved and is flagged as an open question alongside the normative text.

**Location in spec:** Access Constraints → Responder Filters. This item touches multiple paragraphs in the same section:
- Update the `responder_filter` row in the Constraint Semantics table.
- Replace the existing Responder Filters prose with the Custodian Model framing.
- Add a new "Shared EHR Environments and Attribution" Implementation Note (rendered as a `callout-info` — see Item 4).
- Rewrite the Organization Filters bullet list to add the endpoint-agnostic point.
- Add normative Issuer guidance on pre-minting resolution.
- Embed the OQ-4 callout (rendered as a `callout-open-question` — see Item 4).

**Effort:** Medium. This is the largest single spec edit in the plan. It should land as one atomic commit to keep the section coherent and avoid internal merge conflicts.

---

### 2. Document Multi-Ticket Pattern

**Source:** Jason Vogt's question about per-site permissions; Josh's answer about issuing a stack of tickets.

**Problem:** The spec doesn't address how to handle heterogeneous permissions across different responders. The answer (mint multiple tickets) is implicit but not documented.

**Change:** Add a non-normative implementation guidance subsection. Cover: when to issue multiple tickets versus one, how clients manage a set of tickets, and the interaction with the protocol (each token exchange request carries exactly one `subject_token`, so different sites get different tickets). Keep the guidance descriptive — no JSON examples at this stage; worked examples can come in a later pass once the prose has settled.

**Location in spec:** New subsection in a non-normative Implementation Guidance section (or Developer Reference).

**Effort:** Small — a few paragraphs.

---

### 3. Clarify Reusability Semantics

**Source:** Jason Vogt's question about single-use vs. multi-use.

**Problem:** The conformance section says Data Holders are NOT REQUIRED to enforce single-use, but this isn't stated clearly enough in the main body. Implementers may default to single-use based on habits with other JWT-based flows.

**Change:** Add a clear statement early in the Ticket Lifecycle → Reusability subsection establishing that tickets are reusable within their validity period. A client MAY present the same ticket to the same or different Data Holders multiple times until the ticket expires or is revoked. Data Holders SHOULD NOT reject a ticket solely because they have previously seen its `jti`. Narrower profiles MAY impose single-use semantics; the base specification does not.

Do **not** conflate "short-lived" with "single-use" — they are independent properties. Short TTL is a separate lever for limiting reuse windows and does not replace single-use enforcement where that is actually required.

**Location in spec:** Ticket Lifecycle → Reusability subsection (already exists, but needs strengthening).

**Effort:** Tiny — a few sentences of prose.

---

### 4. Build a Reusable Callout System for the IG

**Source:** Multiple items from this plan (Items 1, 5, 6, 7) need visual markers — open questions, non-normative implementation notes, optional deep-dive detail. Earlier drafts of the plan proposed ad-hoc inline `<div style="...">` markup. That fights the IG publisher, doesn't theme, and drifts across authors.

**Problem:** The IG currently has no first-class callout vocabulary of its own. The HL7 template ships `.stu-note` and `.note-to-balloters`, but those are semantically wrong for what we want (they're balloting-process markers, not author-facing callouts), and their visual treatment is dated. We should build our own.

**Change:** Create a small, well-named, semantic callout system and use it consistently across the spec.

**Design principles:**
- **Semantically named classes.** A reader of the raw markdown should understand intent without rendering.
- **Reusable.** Defined once, used anywhere in any page.
- **Clean markup.** No inline styles per callout; prefer Kramdown attribute-block syntax on blockquotes so markdown stays readable.
- **Nice-looking.** Modern color palette, clear type hierarchy, an icon per variant, generous padding.

**Class vocabulary (initial):**
- `callout` — base class. Shared layout: padding, border-radius, accented left border, flex row for icon + body.
- `callout-open-question` — amber. For unresolved design decisions. Every instance carries a stable `id` (`oq-1`, `oq-2`, ...) for cross-reference.
- `callout-info` — blue. For non-normative implementation notes (e.g., the Shared EHR Environments note in Item 1).
- `callout-detail` — neutral/grey. For optional deep-dive content a casual reader can skip.

Names are reusable — we expect to add `callout-example` and similar variants as the spec grows.

**Delivery mechanism.** This IG already publishes custom HTML + CSS via Jekyll includes (see `input/includes/jwt-viewer.html`, which uses an inline `<style>` block inside an include file). We follow the same pattern:

- Create `input/includes/callouts.html` containing a single `<style>` block with the full class system. No JavaScript.
- Each markdown page that uses callouts begins with `{% include callouts.html %}` (once per page). The include emits the style tag; content below uses the classes freely.
- Authors attach classes to blockquotes using Kramdown attribute-block syntax, so the markdown source stays clean:

  ```markdown
  {% include callouts.html %}

  > **⚠️ Open Question (OQ-1): Sensitive Data Granularity.** The current two-value model (`"exclude"` / `"include"`) is intentionally coarse…
  {: .callout .callout-open-question #oq-1}
  ```

  Rendered HTML is a `<blockquote class="callout callout-open-question" id="oq-1">` — cross-referenceable, styleable, accessible.

- For more structured callouts that need a title row separate from body paragraphs, authors can use an explicit `<div class="callout callout-info">...</div>` with markdown inside (Kramdown supports markdown inside block HTML when `markdown="1"` is set on the wrapper, or when surrounded by blank lines).

**Sketch of the CSS** (final names and values settled during implementation — this is the intent, not the literal file):

```css
.callout {
  display: grid;
  grid-template-columns: auto 1fr;
  gap: 10px 14px;
  margin: 20px 0;
  padding: 14px 18px;
  border-radius: 8px;
  border: 1px solid transparent;
  border-left-width: 4px;
  background: #fafbfc;
  line-height: 1.55;
}
.callout::before {
  grid-row: 1 / span 99;
  font-size: 1.2rem;
  line-height: 1.4;
}
.callout > :first-child { margin-top: 0; }
.callout > :last-child  { margin-bottom: 0; }

.callout-open-question {
  background: #fff8e1;
  border-color: #e9c96a;
  border-left-color: #d19c1d;
}
.callout-open-question::before { content: "⚠️"; }

.callout-info {
  background: #eef3fd;
  border-color: #a3bdf0;
  border-left-color: #1a73e8;
}
.callout-info::before { content: "ℹ️"; }

.callout-detail {
  background: #f3f4f6;
  border-color: #d0d6dd;
  border-left-color: #6b7280;
}
.callout-detail::before { content: "📎"; }
```

**Adoption scope:** Use the new classes for every callout introduced by this plan (Items 1, 5, 6, 7). Do **not** migrate existing `stu-note` or `note-to-balloters` usages — those are template-provided balloting markers and serve a different purpose.

**Effort:** Small — one include file, a handful of class rules, and consistent use across the new callouts. Verify in a local IG publisher build that the include emits cleanly and the classes render as expected.

---

## Items to Park with Open-Question Flags

### 5. Sensitive Data Vocabulary (OQ-1)

**Source:** Hans Buitendijk's chat question; Josh's acknowledgment that the boolean is insufficient; Emma Jones and Jason Vogt's discussion about granular data control.

**Current state:** `sensitive_data` is `"exclude" | "include"`. The spec acknowledges recipients apply their own defaults when absent.

**Change:** Append a paragraph to the Sensitive Data subsection acknowledging the coarseness and sketching possible future directions. The two-value model is intentionally simple; real-world patient preferences often involve specific categories such as substance use treatment, reproductive health history, or behavioral health records. Future versions may define a richer vocabulary of sensitive-data categories. Do **not** name or cite a specific vocabulary or value set — the working group hasn't chosen one, and naming one speculatively will be read as endorsement. Instead, ask the working group for input on whether a categorical model is operationalizable given the current state of data tagging in production systems, and whether a middle ground exists between a single boolean and a full sensitivity taxonomy.

Wrap as a `callout-open-question` (see Item 4) with stable id `oq-1`.

**Location in spec:** Access Constraints → Sensitive Data.

---

### 6. Consent Resource Integration (OQ-2)

**Source:** Jason Vogt's observation that consent and authorization are converging; Emma Jones's suggestion about data tagging; the broader thread about patient preferences not mapping to SMART scopes.

**Change:** Add an open-question paragraph asking the concrete thing: **what concrete use cases require a FHIR Consent reference that the current ticket fields cannot express?** The ticket's explicit fields — `access.permissions`, `data_period`, `responder_filter`, `sensitive_data` — already model a significant portion of what patients and authorizing parties want to express. If specific scenarios surface where those fields are insufficient, the spec would need a mechanism to embed or reference a FHIR Consent resource. Working group input is sought on concrete gaps rather than theoretical ones — the callout should invite scenarios, not speculation.

Wrap as a `callout-open-question` with stable id `oq-2`.

**Location in spec:** New paragraph in the "Scope and Non-Goals" section or a new "Open Design Questions" section.

---

### 7. Ticket-as-Refresh-Credential Pattern (OQ-3)

**Source:** Michael Donnelly's suggestion about separating ticket expiration from access duration; subsequent design discussion concluding that long-lived revocable tickets may eliminate the need for site-specific refresh tokens entirely.

**Change:** Add an open-question callout in Ticket Lifecycle → Long-Lived Access describing the pattern at a high level: for long-lived access, a long-lived revocable ticket with presenter binding serves as the refresh credential. The client re-presents the ticket whenever it needs a fresh short-lived access token; the Data Holder validates the ticket (including a status-list check) and issues a new access token without maintaining refresh-token state. Benefits worth naming: single-point revocation (one bit flip in the issuer's status list terminates access everywhere), and the elimination of per-session refresh-token state at the Data Holder.

This is a **pure open question**, not a recommendation yet. Do **not** include:
- specific access-token lifetime recommendations (the spec has no lifetimes and doesn't need them here), or
- transition guidance (this is a greenfield spec with no adopters, so there's nothing to transition from).

Flag operational considerations worth discussing (revocation-check latency, status-list caching strategy) without resolving them. Wrap as a `callout-open-question` with stable id `oq-3`.

**Location in spec:** Ticket Lifecycle → Long-Lived Access.

---

### 8. Downstream Data Use

**Source:** Emma Jones's question about what happens after the client receives data.

**Change:** Add a sentence to the Scope and Non-Goals section explicitly stating that downstream data use, retention, and re-disclosure are governed by the trust framework and applicable law, not by the permission ticket.

**Location in spec:** Scope and Non-Goals → "This specification does not define" list.

**Note:** This is not an open question — it's a clean non-goal. Add it as a bullet in the existing list; no callout needed.

---

## Separate Deliverable: Public Health Companion Document

**Purpose:** Standalone briefing document for the Thursday (April 9) HL7 Public Health WG presentation.

**Scenario:** TB case investigation across state lines — index case diagnosed in Illinois, contacts traced to Missouri, PHA needs lab results and treatment data from providers with no prior relationship to the requesting agency.

**Audience:** Public health informaticists and program staff who may not be familiar with SMART on FHIR or OAuth but understand case investigation workflows.

**Deliverable:** See separate file `public-health-companion-tb-scenario.md`.

---

## Async Follow-Up (No Spec Change)

### Hunter Johnstone: OBO Token Exchange / CMS Aligned Networks

Hunter's chat question about how permission tickets interact with the OBO pattern deserves a direct response but doesn't require a spec change now. Josh should follow up with Hunter async to understand the specific interaction points and determine whether this needs future spec work.

---

## Delivery Order

Items should land in roughly this order to minimize churn and merge conflict:

1. **Item 4 first.** The callout system is a dependency of Items 1, 5, 6, and 7. Ship it as a standalone commit and verify it renders in a local IG publisher build before layering content on top.
2. **Item 1 next.** This is the largest single spec edit and touches multiple paragraphs in one section. Land it as one atomic commit so the section stays internally consistent.
3. **Items 2, 3, 8.** Small, independent edits. Any order.
4. **Items 5, 6, 7.** Open-question callouts. Any order, after Item 4 is in place.

**Spec-only plan.** This plan does not change the reference implementation. No RI code changes, no RI test changes. Item 1's new `SHOULD reject with invalid_grant when match is indeterminate` clause is a future RI-behavior question, not a current one — if and when the RI grows responder-filter enforcement, the test updates will be a separate plan.

---

## Draft Spec Language

All draft language below is keyed to the item numbers above.

### Item 1: Responder Filter Semantics (Endpoint Gate / Custodian Model)

*The draft text below replaces the existing Responder Filters subsection end-to-end. It is written to read as a coherent whole, not as patches.*

**Update 1a — Constraint Semantics table row.** Replace the existing `responder_filter` row:

> Which responding Data Holders (custodial systems or endpoint managers) may answer. In shared systems, authorizing the Data Holder authorizes access to the integrated record it manages. | Jurisdiction address match or organization identity match

**Update 1b — Responder Filters prose.** Replace the existing Responder Filters paragraph(s) with:

> **Responder Filters**
>
> `responder_filter` positively scopes which Data Holders may respond to a ticket. A Data Holder that accepts a ticket evaluates the filter against its own organizational identity and the jurisdiction(s) in which it operates; the filter is not a resource-by-resource clinical data filter.
>
> Matching is evaluated at the FHIR endpoint level. A Data Holder that spans multiple jurisdictions SHOULD answer a jurisdiction-filtered ticket if any of its jurisdictions match the filter, and MAY apply internal filtering to restrict returned data to the matching jurisdiction(s) if its architecture supports attribution at that level. It is not required to do so. If a Data Holder cannot determine whether it matches a presented filter, it SHOULD reject the ticket with `invalid_grant` rather than guessing.

**Update 1c — Insert a new "Shared EHR Environments and Attribution" subsection** using the callout system (Item 4):

```markdown
{% include callouts.html %}

#### Shared EHR Environments and Attribution

<div class="callout callout-info" markdown="1">

**Implementation Note: Shared Data Holders and Issuer UIs**

In the real-world ecosystem, a single Data Holder (e.g., a centralized FHIR endpoint) frequently serves multiple independent physical clinics, hospitals, and sometimes entirely distinct organizations operating on a shared EHR deployment. Within these shared systems, clinical data such as Allergies, Problems, and Medications is integrated into a unified patient chart and often cannot be reliably attributed to or filtered by a specific leaf-node facility.

Because `responder_filter.organization` evaluates whether the Data Holder *as a whole* is authorized to answer, a Data Holder that accepts a ticket will typically return the integrated patient record it holds. If an Issuer mints a ticket heavily constrained to a specific leaf-node facility, and the shared Data Holder cannot filter the data to match that constraint, the Data Holder is required by this specification to reject the request.

**Pre-Minting Resolution.** To prevent unexpected ticket rejections, Ticket Issuers SHOULD consult endpoint directory information (e.g., published endpoint networks, trust framework directories, or SMART Brands data) to map leaf-node facilities to their custodial Data Holder endpoints before minting a ticket. The resulting ticket should be scoped to the encompassing Data Holder organization.

**Issuer UI Considerations.** While this specification does not dictate user interface design, Ticket Issuers should consider this architectural reality when presenting choices to users. For example, if a patient attempts to authorize data sharing for "Main Street Clinic," the Issuer's application might use directory information to inform the patient: *"Main Street Clinic manages its records jointly with Regional Health System. Authorizing this connection will share your integrated health record from all Regional Health System locations."*

</div>
```

**Update 1d — Organization Filters bullet list.** Replace the existing bullet list with:

> * Organization filters positively scope which Data Holders (custodial organizations) may answer.
> * Matching is by organizational identity (e.g., a national provider identifier or registry ID carried in `organization.identifier`).
> * This filter is endpoint-agnostic. If a Data Holder operates multiple technical endpoints (for example, a FHIR endpoint and a distinct DICOMweb endpoint), a single ticket using an organization filter authorizes access at any of that organization's endpoints that support the Permission Ticket grant type.
> * Data Holders that manage integrated records across multiple facilities evaluate this filter at the custodial level, not as a resource-by-resource clinical data filter. See *Shared EHR Environments and Attribution* above.

**Update 1e — OQ-4 open-question callout** (appended to the Responder Filters subsection):

```markdown
> **⚠️ Open Question (OQ-4): Sub-Endpoint Filtering.** Many health systems operate a single FHIR endpoint that serves data from multiple hospitals, clinics, and care settings — including specialized sites (e.g., behavioral health, reproductive health) that a patient may want to exclude from sharing. Because data within a single endpoint is often not attributed to individual facilities, a patient who deselects a specific site in a consent UI may not get the expected result if that site shares a FHIR endpoint with other facilities. This specification currently operates at endpoint granularity and does not require sub-endpoint filtering. The working group is seeking input on whether future versions should define a mechanism for intra-endpoint data attribution, and whether existing infrastructure (e.g., FHIR Organization references on clinical resources, Provenance records) could support such filtering at operational scale.
{: .callout .callout-open-question #oq-4}
```

### Item 2: Multi-Ticket Pattern

*New subsection in Implementation Guidance (non-normative):*

> **Using Multiple Tickets**
>
> A single permission ticket confers one set of access constraints that applies uniformly to all responders in its audience. When a patient (or other authorizing party) requires different access constraints for different responders — for example, sharing lab results from one site but only conditions from another — the issuer should mint separate tickets, each with its own `access` block and, optionally, a narrow `aud` or `responder_filter` targeting specific data holders.
>
> Clients managing multiple tickets present the appropriate ticket in each token exchange request. Since each request carries exactly one `subject_token`, the client selects which ticket to present based on which data holder it is connecting to.
>
> This pattern also applies when a patient wants some sites to receive a broad grant and others to receive a narrow one. Rather than modeling heterogeneous permissions within a single ticket, issuing a set of tickets keeps each individual ticket simple and its constraints unambiguous.

### Item 3: Reusability Semantics

*Replace the existing Reusability subsection in Ticket Lifecycle with:*

> **Reusability**
>
> Tickets are reusable within their validity period. A client MAY present the same ticket to the same or different Data Holders multiple times until the ticket expires or is revoked. Data Holders SHOULD NOT reject a ticket solely because they have previously seen its `jti`. Narrower profiles MAY impose single-use semantics for specific use cases; the base specification does not.
>
> Short ticket lifetimes and single-use semantics are independent properties. Shortening a ticket's TTL limits the window in which it can be reused but does not make it single-use; conversely, a multi-use ticket may have a long lifetime. Profiles that genuinely require single-use enforcement should not rely on short TTLs to approximate it.

### Item 4: Callout System

*New include file at `input/includes/callouts.html`:*

```html
<style>
  .callout {
    display: grid;
    grid-template-columns: auto 1fr;
    gap: 10px 14px;
    margin: 20px 0;
    padding: 14px 18px;
    border-radius: 8px;
    border: 1px solid transparent;
    border-left-width: 4px;
    background: #fafbfc;
    line-height: 1.55;
  }
  .callout::before {
    grid-row: 1 / span 99;
    font-size: 1.2rem;
    line-height: 1.4;
  }
  .callout > :first-child { margin-top: 0; }
  .callout > :last-child  { margin-bottom: 0; }

  .callout-open-question {
    background: #fff8e1;
    border-color: #e9c96a;
    border-left-color: #d19c1d;
  }
  .callout-open-question::before { content: "⚠️"; }

  .callout-info {
    background: #eef3fd;
    border-color: #a3bdf0;
    border-left-color: #1a73e8;
  }
  .callout-info::before { content: "ℹ️"; }

  .callout-detail {
    background: #f3f4f6;
    border-color: #d0d6dd;
    border-left-color: #6b7280;
  }
  .callout-detail::before { content: "📎"; }
</style>
```

*Usage pattern in markdown pages:*

```markdown
{% include callouts.html %}

> **⚠️ Open Question (OQ-1): Sensitive Data Granularity.** …body…
{: .callout .callout-open-question #oq-1}
```

*Or, for callouts that want a title row separate from body paragraphs:*

```markdown
<div class="callout callout-info" markdown="1">

**Implementation Note: Title Here**

Body paragraph one.

Body paragraph two.

</div>
```

### Item 5: Sensitive Data Vocabulary (OQ-1)

*Append to the existing Sensitive Data subsection:*

```markdown
> **⚠️ Open Question (OQ-1): Sensitive Data Granularity.** The current two-value model (`"exclude"` / `"include"`) is intentionally coarse. Real-world patient preferences often involve specific categories — for example, sharing general medical data but excluding substance use treatment records, reproductive health history, or behavioral health records. Future versions of this specification may define a richer vocabulary of sensitive-data categories. The working group is seeking feedback on whether a categorical model is operationalizable given the current state of data tagging in production systems, and whether a middle ground exists between a single boolean and a full sensitivity taxonomy.
{: .callout .callout-open-question #oq-1}
```

### Item 6: Consent Resource Integration (OQ-2)

*Add to Scope and Non-Goals or a new Open Design Questions section:*

```markdown
> **⚠️ Open Question (OQ-2): Consent Beyond Ticket Fields.** What concrete use cases would require a FHIR Consent reference that the current ticket fields cannot express? The ticket's explicit fields — `access.permissions`, `data_period`, `responder_filter`, `sensitive_data` — already model a substantial portion of what patients and authorizing parties want to express about data sharing. If specific scenarios surface where these fields are insufficient, the specification would need a mechanism to embed or reference a FHIR Consent resource within the ticket. The working group is seeking concrete scenarios rather than theoretical ones.
{: .callout .callout-open-question #oq-2}
```

### Item 7: Ticket-as-Refresh-Credential Pattern (OQ-3)

*Add to Ticket Lifecycle → Long-Lived Access:*

```markdown
> **⚠️ Open Question (OQ-3): Tickets as Refresh Credentials.** For long-lived access, a promising pattern may eliminate site-specific refresh tokens entirely. A long-lived revocable ticket with presenter binding serves as the refresh credential: the client re-presents the ticket whenever it needs a fresh short-lived access token. The Data Holder validates the ticket (including a revocation check against the status list) and issues a new access token without maintaining refresh-token state. This provides single-point revocation — one bit flip in the issuer's status list terminates access everywhere — and keeps the Data Holder stateless with respect to per-session refresh-token state. Open operational questions: revocation-check latency and status-list caching strategy. The working group is seeking input on whether this pattern should be developed into normative guidance.
{: .callout .callout-open-question #oq-3}
```

### Item 8: Downstream Data Use

*Add to the "This specification does not define" list in Scope and Non-Goals:*

> * Constraints on downstream data use, retention, or re-disclosure by the client after data has been received — these are governed by the trust framework under which the client operates and applicable law.
