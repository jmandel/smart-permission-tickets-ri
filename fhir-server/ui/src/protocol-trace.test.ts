import { describe, expect, test } from "bun:test";

import type { DemoEvent } from "../../shared/demo-events";
import { buildCellPresentation, buildDetailModel } from "./components/ProtocolTrace";
import { buildDemoEventArtifactTabs } from "./lib/demo-event-tabs";
import { accumulateTraceState, buildTraceOverview, cellEventsForTrace, filterTraceQueryEvents, hasVisibleSiteClientSetup } from "./lib/protocol-trace-state";

describe("protocol trace state", () => {
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

    const state = accumulateTraceState(events);
    const summary = buildTraceOverview(state);
    expect(summary.checksPassed).toBe(1);
    expect(summary.networkSteps).toHaveLength(1);
    expect(summary.readySites).toBe(1);
    expect(state.selectedCell).toEqual({ row: "network", column: "token" });
  });

  test("query filtering hides zero-result and supporting-context query noise", () => {
    const events = filterTraceQueryEvents([
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
    ]);

    expect(events.map((event) => event.seq)).toEqual([1]);
  });

  test("site registration events map into the correct site row and preserve history", () => {
    const events: DemoEvent[] = [
      {
        seq: 1,
        timestamp: 1,
        source: "server",
        phase: "discovery",
        type: "sites-discovered",
        label: "Sites discovered",
        detail: {
          sites: [{ siteSlug: "alpha", siteName: "Alpha Health" }],
        },
      },
      {
        seq: 2,
        timestamp: 2,
        source: "server",
        phase: "registration",
        type: "registration-request",
        label: "Client registration",
        detail: {
          authMode: "unaffiliated",
          endpoint: "http://example.test/sites/alpha/register",
          outcome: "rejected",
          siteSlug: "alpha",
          siteName: "Alpha Health",
          algorithm: "none",
          steps: [],
          error: "bad request",
        },
      },
      {
        seq: 3,
        timestamp: 3,
        source: "server",
        phase: "registration",
        type: "registration-request",
        label: "Client registration",
        detail: {
          authMode: "unaffiliated",
          endpoint: "http://example.test/sites/alpha/register",
          outcome: "registered",
          siteSlug: "alpha",
          siteName: "Alpha Health",
          clientId: "client-123",
          algorithm: "none",
          steps: [],
        },
      },
    ];

    const state = accumulateTraceState(events);
    const alpha = state.sites.get("alpha");
    expect(alpha?.clientSetupEvents).toHaveLength(2);
    expect(alpha?.clientSetupEvents[1]?.detail.clientId).toBe("client-123");
    expect(cellEventsForTrace(state, { row: "alpha", column: "client-setup" })).toHaveLength(2);
    expect(hasVisibleSiteClientSetup(state)).toBe(true);
    expect(state.selectedCell).toEqual({ row: "network", column: "resolve-match" });
  });

  test("network client setup shows automatic registration when OIDF skips /register", () => {
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
          clientAuthMode: "oidf",
          clientId: "https://example.test/federation/leafs/demo-app",
          scopes: ["patient/*.rs"],
          scopeSummary: "patient/*.rs",
          steps: [],
        },
      },
    ];

    const state = accumulateTraceState(events);
    const cell = buildCellPresentation(state, { row: "network", column: "client-setup" });
    expect(cell?.primary).toBe("Automatic registration");
    expect(cell?.secondary).toBe("OIDF trust_chain in client_assertion");

    const detail = buildDetailModel(state, { row: "network", column: "client-setup" }, null);
    expect(detail?.kind).toBe("event");
    expect(detail?.title).toBe("Automatic registration");
  });

  test("site client setup shows framework-identified when well-known skips /register", () => {
    const events: DemoEvent[] = [
      {
        seq: 1,
        timestamp: 1,
        source: "server",
        phase: "site-auth",
        type: "token-exchange",
        label: "Site token issued",
        detail: {
          grantType: "urn:ietf:params:oauth:grant-type:token-exchange",
          endpoint: "http://example.test/sites/alpha/token",
          mode: "strict",
          outcome: "issued",
          clientAuthMode: "well-known",
          clientId: "well-known:https://example.test/demo/clients/alpha",
          siteSlug: "alpha",
          siteName: "Alpha Health",
          scopes: ["patient/*.rs"],
          scopeSummary: "patient/*.rs",
          steps: [],
        },
      },
    ];

    const state = accumulateTraceState(events);
    const cell = buildCellPresentation(state, { row: "alpha", column: "client-setup" });
    expect(cell?.primary).toBe("Framework-identified");
    expect(cell?.secondary).toContain("well-known:");
  });

  test("default selection preserves an existing valid cell", () => {
    const events: DemoEvent[] = [
      {
        seq: 1,
        timestamp: 1,
        source: "server",
        phase: "ticket",
        type: "ticket-created",
        label: "Permission Ticket created",
        detail: {
          patientName: "Elena Reyes",
          patientDob: "1989-09-14",
          scopes: ["Observation", "Condition"],
          dateSummary: "All dates",
          sensitiveSummary: "Sensitive excluded",
          expirySummary: "1 hour",
          bindingSummary: "Proof-key client",
        },
      },
      {
        seq: 2,
        timestamp: 2,
        source: "server",
        phase: "discovery",
        type: "sites-discovered",
        label: "Sites discovered",
        detail: {
          sites: [{ siteSlug: "alpha", siteName: "Alpha Health" }],
        },
      },
    ];

    const state = accumulateTraceState(events, { row: "network", column: "ticket" });
    expect(state.selectedCell).toEqual({ row: "network", column: "ticket" });
  });

  test("default selection preserves visible site client-setup cells when site registration exists", () => {
    const events: DemoEvent[] = [
      {
        seq: 1,
        timestamp: 1,
        source: "server",
        phase: "discovery",
        type: "sites-discovered",
        label: "Sites discovered",
        detail: {
          sites: [{ siteSlug: "alpha", siteName: "Alpha Health" }],
        },
      },
      {
        seq: 2,
        timestamp: 2,
        source: "server",
        phase: "registration",
        type: "registration-request",
        label: "Client registration",
        detail: {
          authMode: "unaffiliated",
          endpoint: "http://example.test/sites/alpha/register",
          outcome: "registered",
          siteSlug: "alpha",
          siteName: "Alpha Health",
          clientId: "client-123",
          algorithm: "none",
          steps: [],
        },
      },
    ];

    const state = accumulateTraceState(events, { row: "alpha", column: "client-setup" });
    expect(state.selectedCell).toEqual({ row: "alpha", column: "client-setup" });
  });

  test("data cell detail keeps the list visible while appending selected query detail", () => {
    const events: DemoEvent[] = [
      {
        seq: 1,
        timestamp: 1,
        source: "server",
        phase: "discovery",
        type: "sites-discovered",
        label: "Sites discovered",
        detail: {
          sites: [{ siteSlug: "alpha", siteName: "Alpha Health" }],
        },
      },
      {
        seq: 2,
        timestamp: 2,
        source: "server",
        phase: "data",
        type: "query-result",
        label: "Observation",
        detail: {
          siteSlug: "alpha",
          siteName: "Alpha Health",
          resourceType: "Observation",
          count: 3,
          queryPath: "Observation?_count=100",
        },
        artifacts: {
          request: {
            method: "GET",
            url: "http://example.test/sites/alpha/fhir/Observation?_count=100",
            headers: {},
          },
          response: {
            status: 200,
            headers: { "content-type": "application/fhir+json" },
            body: { resourceType: "Bundle", total: 3, entry: [] },
          },
        },
      },
      {
        seq: 3,
        timestamp: 3,
        source: "server",
        phase: "data",
        type: "query-result",
        label: "Patient",
        detail: {
          siteSlug: "alpha",
          siteName: "Alpha Health",
          resourceType: "Patient",
          count: 1,
          queryPath: "Patient",
        },
      },
    ];

    const state = accumulateTraceState(events, { row: "alpha", column: "data" });
    const listDetail = buildDetailModel(state, { row: "alpha", column: "data" }, null);
    expect(listDetail?.kind).toBe("data-list");
    if (!listDetail || listDetail.kind !== "data-list") throw new Error("Expected data-list detail");
    expect(listDetail.history).toHaveLength(1);
    expect(listDetail.queries).toHaveLength(1);
    expect(listDetail.selectedQueryDetail).toBeNull();

    const queryDetail = buildDetailModel(state, { row: "alpha", column: "data" }, 0);
    expect(queryDetail?.kind).toBe("data-list");
    if (!queryDetail || queryDetail.kind !== "data-list") throw new Error("Expected data-list detail");
    expect(queryDetail.queries).toHaveLength(1);
    expect(queryDetail.selectedQueryDetail?.tabs.map((tab) => tab.key)).toEqual(["summary", "request", "response"]);
  });

  test("token detail includes a summary tab before protocol artifacts", () => {
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
          steps: [{ check: "Signature", passed: true, evidence: "ES256" }],
        },
        artifacts: {
          request: {
            method: "POST",
            url: "http://example.test/token",
            headers: { "content-type": "application/x-www-form-urlencoded" },
            body: "grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Atoken-exchange",
          },
          response: {
            status: 200,
            headers: { "content-type": "application/json" },
            body: { access_token: "abc", token_type: "Bearer" },
          },
        },
      },
    ];

    const state = accumulateTraceState(events, { row: "network", column: "token" });
    const detail = buildDetailModel(state, { row: "network", column: "token" }, null);
    expect(detail?.kind).toBe("event");
    if (!detail || detail.kind !== "event") throw new Error("Expected event detail");
    expect(detail.tabs.map((tab) => tab.key)).toEqual(["summary", "request", "response"]);
  });

  test("duplicate related JSON artifacts are suppressed when they repeat the HTTP body", () => {
    const event: DemoEvent = {
      seq: 1,
      timestamp: 1,
      source: "server",
      phase: "discovery",
      type: "sites-discovered",
      label: "Sites discovered",
      detail: {
        sites: [{ siteSlug: "alpha", siteName: "Alpha Health" }],
      },
      artifacts: {
        request: {
          method: "POST",
          url: "http://example.test/networks/reference/fhir/$resolve-record-locations",
          headers: { "content-type": "application/fhir+json" },
          body: { resourceType: "Parameters" },
        },
        response: {
          status: 200,
          headers: { "content-type": "application/fhir+json" },
          body: { resourceType: "Bundle", total: 1, entry: [] },
        },
        related: [
          {
            label: "Resolve record locations bundle",
            kind: "json",
            content: { resourceType: "Bundle", total: 1, entry: [] },
          },
        ],
      },
    };

    const tabs = buildDemoEventArtifactTabs(event);
    expect(tabs.map((tab) => tab.key)).toEqual(["request", "response"]);
  });
});
