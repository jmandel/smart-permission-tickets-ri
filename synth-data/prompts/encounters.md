# Encounter Timeline Generator

You are generating a detailed encounter timeline for a synthetic patient. You'll receive their biography (with clinical arc and provider map). Your job is to expand that into a visit-by-visit timeline.

## What to produce

A markdown document organized by provider site, then chronologically within each site. For each encounter, write a section with:

### Header format

Use H3 headers with this pattern so downstream parsers can find them:

```
### YYYY-MM-DD — Type — Brief reason
```

Example:
```
### 2018-03-15 — Office Visit — Annual wellness, diabetes diagnosed
### 2024-05-14 — ED Visit — Chest pain, atrial fibrillation found
### 2025-01-02 — Telephone — Lab results review
```

### Per-encounter content

For each encounter, write a paragraph describing what happened clinically. Be specific:
- What vitals were taken? (Give actual values — BP 138/82, HR 76, etc.)
- What labs were ordered and what were the results? (A1c 7.8%, fasting glucose 142)
- What conditions were assessed, diagnosed, or updated?
- What medications were started, changed, or stopped? (Include doses)
- What immunizations were given?
- What screening tools were used? (PHQ-2 score, etc.)
- What documents were generated? (Progress note, patient instructions, etc.)
- What referrals or follow-up was planned?

Also note:
- The encounter type (office visit, telephone, lab, ED, telemedicine, imaging, etc.)
- The clinician (use names from the biography's provider map)
- The location/site

## Clinical coherence

Lab values should trend realistically across time:
- A1c should improve after starting metformin, fluctuate with adherence
- BP should respond to antihypertensives
- Don't have values jumping wildly between visits
- Conditions should be diagnosed at specific encounters and persist

Medications should have clear start/stop points tied to clinical decisions.

Follow-ups should be spaced realistically (diabetes f/u every 3-6 months, post-ED cardiology in 2-4 weeks, annual wellness yearly, etc.).

## Clinical notes

Every in-person encounter (office visit, ED visit, consult) should produce a progress note. Telephone encounters and lab-only visits may or may not have notes. Briefly describe what the note would contain — we'll generate actual note text later.

## Scope and Focus

The biography is intentionally richer than what we need to generate. Your job is to **select the most important encounters** that tell the patient's story and exercise the demo's filtering dimensions. You do NOT need to generate every visit implied by the biography.

Unless you receive other guidance, aim for **~15-25 encounters** across the patient's provider sites. Pick the encounters that matter most:
- Key diagnostic moments
- Sensitive data points
- Treatment milestones
- Enough routine visits to show monitoring rhythms
- At least one encounter per provider site

Skip routine encounters that don't add new clinical information. A single well-described annual wellness visit can stand in for several. The goal is a representative dataset — not an exhaustive chart.

If you receive additional guidance (e.g., "limit to 10 encounters" or "focus on California sites only"), follow that guidance instead of these defaults.

## Calibration

- Encounter type mix: ~30% office, ~25% telephone, ~15% lab, ~10% ED, ~10% telemedicine
- Office visits: full vitals (BP, HR, weight, height/BMI, temp, resp, SpO2) + PHQ-2 screening + relevant labs
- Telephone: usually 0 observations, just a clinical discussion
- Lab visits: just lab results (5-15 observations), no vitals
- ED visits: full vitals + labs + possibly imaging/procedures

## Style

Write the timeline as a clinical chart summary that another AI agent will use to generate FHIR resources. Be specific about values, codes, and dates. Include narrative color about the clinical reasoning — it helps downstream agents make better FHIR.
