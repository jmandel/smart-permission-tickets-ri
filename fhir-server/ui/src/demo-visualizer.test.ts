import { describe, expect, test } from "bun:test";

import type { DemoEvent } from "../../shared/demo-events";
import { buildSummary, filterFeedEvents } from "./components/DemoVisualizer";
import { expandScopeLabels } from "./lib/viewer-store";

describe("demo visualizer helpers", () => {
  test("network verification count excludes per-site re-verification checks", () => {
    const events: DemoEvent[] = [
      {
        seq: 1,
        timestamp: 1,
        source: "server",
        phase: "network-auth",
        type: "token-exchange",
        label: "Network token issued",
        detail: {
          grantType: "urn:ietf:params:oauth:grant-type:token-exchange",
          endpoint: "http://example.test/token",
          mode: "strict",
          outcome: "issued",
          scopes: ["patient/*.rs"],
          scopeSummary: "patient/*.rs",
          steps: [
            {
              check: "Signature",
              passed: true,
              evidence: "ES256",
              why: "Network check",
            },
          ],
        },
      },
      {
        seq: 2,
        timestamp: 2,
        source: "server",
        phase: "site-auth",
        type: "token-exchange",
        label: "Site token issued",
        detail: {
          grantType: "urn:ietf:params:oauth:grant-type:token-exchange",
          endpoint: "http://example.test/sites/alpha/token",
          mode: "strict",
          outcome: "issued",
          scopes: ["patient/*.rs"],
          scopeSummary: "patient/*.rs",
          siteSlug: "alpha",
          siteName: "Alpha Health",
          steps: [
            {
              check: "Signature",
              passed: true,
              evidence: "ES256",
              why: "Site check",
            },
          ],
        },
      },
    ];

    const summary = buildSummary(events);
    expect(summary.checksPassed).toBe(1);
    expect(summary.networkSteps).toHaveLength(1);
    expect(summary.readySites).toBe(1);
  });

  test("feed filtering hides zero-result and supporting-context query noise", () => {
    const events: DemoEvent[] = [
      {
        seq: 1,
        timestamp: 1,
        source: "viewer",
        phase: "data",
        type: "query-result",
        label: "Observation query",
        detail: {
          siteSlug: "alpha",
          siteName: "Alpha Health",
          resourceType: "Observation",
          count: 4,
          queryPath: "Observation",
        },
      },
      {
        seq: 2,
        timestamp: 2,
        source: "viewer",
        phase: "data",
        type: "query-result",
        label: "ServiceRequest query",
        detail: {
          siteSlug: "alpha",
          siteName: "Alpha Health",
          resourceType: "ServiceRequest",
          count: 0,
          queryPath: "ServiceRequest",
        },
      },
      {
        seq: 3,
        timestamp: 3,
        source: "viewer",
        phase: "data",
        type: "query-result",
        label: "Practitioner query",
        detail: {
          siteSlug: "alpha",
          siteName: "Alpha Health",
          resourceType: "Practitioner",
          count: 1,
          queryPath: "Practitioner",
        },
      },
      {
        seq: 4,
        timestamp: 4,
        source: "viewer",
        phase: "data",
        type: "query-result",
        label: "Patient query",
        detail: {
          siteSlug: "alpha",
          siteName: "Alpha Health",
          resourceType: "Patient",
          count: 1,
          queryPath: "Patient",
        },
      },
    ];

    const visible = filterFeedEvents(events);
    expect(visible.map((event) => event.seq)).toEqual([1]);
  });

  test("patient-matched site count aligns with site rows that actually become ready", () => {
    const events: DemoEvent[] = [
      {
        seq: 1,
        timestamp: 1,
        source: "viewer",
        phase: "discovery",
        type: "sites-discovered",
        label: "Sites discovered",
        detail: {
          sites: [
            { siteSlug: "alpha", siteName: "Alpha Health" },
            { siteSlug: "bravo", siteName: "Bravo Clinic" },
            { siteSlug: "charlie", siteName: "Charlie Medical" },
            { siteSlug: "delta", siteName: "Delta Care" },
          ],
        },
      },
      {
        seq: 2,
        timestamp: 2,
        source: "server",
        phase: "network-auth",
        type: "token-exchange",
        label: "Network token issued",
        detail: {
          grantType: "urn:ietf:params:oauth:grant-type:token-exchange",
          endpoint: "http://example.test/token",
          mode: "strict",
          outcome: "issued",
          scopes: ["patient/*.rs"],
          scopeSummary: "patient/*.rs",
          steps: [
            {
              check: "Signature",
              passed: true,
              evidence: "ES256",
            },
          ],
          patientMatch: {
            patientName: "Elena Reyes",
            siteCount: 4,
          },
        },
      },
      {
        seq: 3,
        timestamp: 3,
        source: "viewer",
        phase: "site-auth",
        type: "token-exchange",
        label: "Site token issued",
        detail: {
          grantType: "urn:ietf:params:oauth:grant-type:token-exchange",
          endpoint: "http://example.test/sites/alpha/token",
          mode: "strict",
          outcome: "issued",
          scopes: ["patient/*.rs"],
          siteSlug: "alpha",
          siteName: "Alpha Health",
          scopeSummary: "patient/*.rs",
          steps: [],
        },
      },
      {
        seq: 4,
        timestamp: 4,
        source: "viewer",
        phase: "site-auth",
        type: "token-exchange",
        label: "Site token issued",
        detail: {
          grantType: "urn:ietf:params:oauth:grant-type:token-exchange",
          endpoint: "http://example.test/sites/bravo/token",
          mode: "strict",
          outcome: "issued",
          scopes: ["patient/*.rs"],
          siteSlug: "bravo",
          siteName: "Bravo Clinic",
          scopeSummary: "patient/*.rs",
          steps: [],
        },
      },
      {
        seq: 5,
        timestamp: 5,
        source: "viewer",
        phase: "site-auth",
        type: "token-exchange",
        label: "Site token issued",
        detail: {
          grantType: "urn:ietf:params:oauth:grant-type:token-exchange",
          endpoint: "http://example.test/sites/charlie/token",
          mode: "strict",
          outcome: "issued",
          scopes: ["patient/*.rs"],
          siteSlug: "charlie",
          siteName: "Charlie Medical",
          scopeSummary: "patient/*.rs",
          steps: [],
        },
      },
      {
        seq: 6,
        timestamp: 6,
        source: "viewer",
        phase: "site-auth",
        type: "token-exchange",
        label: "Site token issued",
        detail: {
          grantType: "urn:ietf:params:oauth:grant-type:token-exchange",
          endpoint: "http://example.test/sites/delta/token",
          mode: "strict",
          outcome: "issued",
          scopes: ["patient/*.rs"],
          siteSlug: "delta",
          siteName: "Delta Care",
          scopeSummary: "patient/*.rs",
          steps: [],
        },
      },
    ];

    const summary = buildSummary(events);
    expect(summary.patientMatched?.siteCount).toBe(summary.siteRows.length);
    expect(summary.readySites).toBe(summary.siteRows.length);
  });

  test("wildcard SMART scopes expand to resource labels for ticket pills", () => {
    expect(expandScopeLabels(["patient/*.rs"])).toContain("Patient");
    expect(expandScopeLabels(["patient/*.rs"])).toContain("Observation");
    expect(expandScopeLabels(["patient/Condition.rs", "patient/Observation.rs"])).toEqual(["Observation", "Condition"]);
  });
});
