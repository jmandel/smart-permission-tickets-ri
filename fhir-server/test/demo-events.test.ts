import { describe, expect, test } from "bun:test";

import { createAppContext, handleRequest } from "../src/app.ts";
import type { DemoEvent } from "../shared/demo-events.ts";
import { generateClientKeyMaterial, signPrivateKeyJwt } from "../shared/private-key-jwt.ts";
import { PERMISSION_TICKET_SUBJECT_TOKEN_TYPE } from "../shared/permission-tickets.ts";

describe("demo event stream", () => {
  test("replays buffered events after Last-Event-ID and preserves session scoping", async () => {
    const context = createAppContext({ port: 0 });

    await postDemoEvent(context, "session-a", {
      source: "viewer",
      phase: "ticket",
      type: "ticket-created",
      label: "Ticket A",
      detail: {
        patientName: "Elena Reyes",
        patientDob: "1989-09-14",
        scopes: ["patient/*.rs"],
        dateSummary: "All dates",
        sensitiveSummary: "Sensitive excluded",
        expirySummary: "1 hour",
        bindingSummary: "Proof key",
      },
    });
    await postDemoEvent(context, "session-a", {
      source: "viewer",
      phase: "complete",
      type: "session-complete",
      label: "Done A",
      detail: {
        totalSites: 2,
        totalResources: 9,
        queryCount: 4,
      },
    });
    await postDemoEvent(context, "session-b", {
      source: "viewer",
      phase: "ticket",
      type: "ticket-created",
      label: "Ticket B",
      detail: {
        patientName: "Milo Brooks",
        patientDob: "1980-01-01",
        scopes: ["patient/*.rs"],
        dateSummary: "All dates",
        sensitiveSummary: "Sensitive excluded",
        expirySummary: "1 hour",
        bindingSummary: "Proof key",
      },
    });

    const response = await handleRequest(
      context,
      new Request("http://example.test/demo/events/session-a", {
        headers: { "last-event-id": "1" },
      }),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/event-stream");

    const events = await readSseEvents(response, 1);
    expect(events).toHaveLength(1);
    expect(events[0]?.label).toBe("Done A");
    expect(events[0]?.seq).toBe(2);
  });

  test("lists recent sessions with metadata sorted by last activity", async () => {
    const context = createAppContext({ port: 0 });
    await postDemoEvent(context, "session-a", {
      source: "viewer",
      phase: "ticket",
      type: "ticket-created",
      label: "Ticket A",
      detail: {
        patientName: "Elena Reyes",
        patientDob: "1989-09-14",
        scopes: ["patient/*.rs"],
        dateSummary: "All dates",
        sensitiveSummary: "Sensitive excluded",
        expirySummary: "1 hour",
        bindingSummary: "Proof key",
      },
    });
    await Bun.sleep(5);
    await postDemoEvent(context, "session-b", {
      source: "viewer",
      phase: "ticket",
      type: "ticket-created",
      label: "Ticket B",
      detail: {
        patientName: "Milo Brooks",
        patientDob: "1980-01-01",
        scopes: ["patient/*.rs"],
        dateSummary: "All dates",
        sensitiveSummary: "Sensitive excluded",
        expirySummary: "1 hour",
        bindingSummary: "Proof key",
      },
    });

    const response = await handleRequest(
      context,
      new Request("http://example.test/demo/sessions"),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const body = await response.json() as { sessions: Array<{ sessionId: string; patientName?: string | null; eventCount: number }> };
    expect(body.sessions.map((session) => session.sessionId)).toEqual(["session-b", "session-a"]);
    expect(body.sessions[0]?.patientName).toBe("Milo Brooks");
    expect(body.sessions[1]?.patientName).toBe("Elena Reyes");
    expect(body.sessions[0]?.eventCount).toBe(1);
  });

  test("SSE framing uses unnamed events so EventSource onmessage receives them", async () => {
    const context = createAppContext({ port: 0 });
    const response = await handleRequest(
      context,
      new Request("http://example.test/demo/events/session-a"),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/event-stream");

    const streamTextPromise = readRawSseText(response, 2);
    await Bun.sleep(10);
    await postDemoEvent(context, "session-a", {
      source: "viewer",
      phase: "ticket",
      type: "ticket-created",
      label: "Ticket A1",
      detail: {
        patientName: "Elena Reyes",
        patientDob: "1989-09-14",
        scopes: ["patient/*.rs"],
        dateSummary: "All dates",
        sensitiveSummary: "Sensitive excluded",
        expirySummary: "1 hour",
        bindingSummary: "Proof key",
      },
    });

    const raw = await streamTextPromise;
    expect(raw).toContain("id: 1");
    expect(raw).toContain("data: ");
    expect(raw).not.toContain("\nevent:");
  });

  test("replay plus live SSE subscription has no gaps, duplicates, or cross-session leakage", async () => {
    const context = createAppContext({ port: 0 });

    await postDemoEvent(context, "session-a", {
      source: "viewer",
      phase: "ticket",
      type: "ticket-created",
      label: "Ticket A1",
      detail: {
        patientName: "Elena Reyes",
        patientDob: "1989-09-14",
        scopes: ["patient/*.rs"],
        dateSummary: "All dates",
        sensitiveSummary: "Sensitive excluded",
        expirySummary: "1 hour",
        bindingSummary: "Proof key",
      },
    });
    await postDemoEvent(context, "session-a", {
      source: "viewer",
      phase: "registration",
      type: "udap-discovery",
      label: "Ticket A2",
      detail: { endpoint: "http://example.test/.well-known/udap" },
    });

    const response = await handleRequest(
      context,
      new Request("http://example.test/demo/events/session-a", {
        headers: { "last-event-id": "1" },
      }),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    expect(response.headers.get("cache-control")).toBe("no-cache");

    const eventsPromise = readSseEvents(response, 2);
    await Bun.sleep(10);
    await postDemoEvent(context, "session-b", {
      source: "viewer",
      phase: "complete",
      type: "session-complete",
      label: "Ticket B1",
      detail: {
        totalSites: 9,
        totalResources: 99,
        queryCount: 99,
      },
    });
    await postDemoEvent(context, "session-a", {
      source: "viewer",
      phase: "complete",
      type: "session-complete",
      label: "Ticket A3",
      detail: {
        totalSites: 2,
        totalResources: 9,
        queryCount: 4,
      },
    });

    const events = await eventsPromise;
    expect(events.map((event) => event.seq)).toEqual([2, 3]);
    expect(events.map((event) => event.label)).toEqual(["Ticket A2", "Ticket A3"]);
  });

  test("accepts viewer draft posts and normalizes them through the shared bus", async () => {
    const context = createAppContext({ port: 0 });
    const before = Date.now();
    const postResponse = await handleRequest(
      context,
      new Request("http://example.test/demo/events/session-x", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          seq: 999,
          timestamp: 123,
          source: "server",
          phase: "registration",
          type: "udap-discovery",
          label: "Discovery",
          detail: { endpoint: "http://example.test/.well-known/udap" },
        }),
      }),
    );
    const after = Date.now();

    expect(postResponse.status).toBe(202);
    const posted = await postResponse.json();
    expect(posted.source).toBe("viewer");
    expect(posted.seq).toBe(1);
    expect(posted.timestamp).toBeGreaterThanOrEqual(before);
    expect(posted.timestamp).toBeLessThanOrEqual(after);

    const events = context.demoEvents.getEvents("session-x");
    expect(events).toHaveLength(1);
    expect(events[0]?.source).toBe("viewer");
    expect(events[0]?.type).toBe("udap-discovery");
    expect(events[0]?.seq).toBe(1);
    expect(events[0]?.timestamp).not.toBe(123);
  });

  test("rejects malformed viewer event drafts", async () => {
    const context = createAppContext({ port: 0 });
    const response = await handleRequest(
      context,
      new Request("http://example.test/demo/events/session-x", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ hello: "world" }),
      }),
    );

    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error).toBe("invalid_demo_event");
    expect(body.error_description).toContain("expected shape");
  });

  test("sign-ticket with an explicit demo session creates a visible session and ticket-created event", async () => {
    const context = createAppContext({ port: 0 });
    const response = await handleRequest(
      context,
      new Request("http://example.test/issuer/reference-demo/sign-ticket", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-demo-session": "session-ticket",
        },
        body: JSON.stringify({
          iss: "http://example.test/issuer/reference-demo",
          aud: "http://example.test/networks/reference/token",
          exp: Math.floor(Date.now() / 1000) + 3600,
          jti: crypto.randomUUID(),
          ticket_type: "https://smarthealthit.org/permission-ticket-type/public-health-investigation-v1",
          requester: {
            resourceType: "Organization",
            identifier: [{ system: "urn:example:org", value: "public-health-dept" }],
            name: "Public Health Department",
          },
          subject: {
            patient: {
              resourceType: "Patient",
              name: [{ family: "Reyes", given: ["Elena", "Marisol"] }],
              birthDate: "1989-09-14",
            },
          },
          access: {
            permissions: [{ kind: "data", resource_type: "*", interactions: ["read", "search"] }],
            sensitive_data: "exclude",
          },
          context: {
            kind: "public-health",
            reportable_condition: { text: "Public health investigation" },
          },
        }),
      }),
    );

    expect(response.status).toBe(201);
    const sessionsResponse = await handleRequest(context, new Request("http://example.test/demo/sessions"));
    const sessionsBody = await sessionsResponse.json() as { sessions: Array<{ sessionId: string; patientName?: string | null; eventCount: number }> };
    expect(sessionsBody.sessions[0]?.sessionId).toBe("session-ticket");
    expect(sessionsBody.sessions[0]?.patientName).toBe("Elena Marisol Reyes");
    expect(context.demoEvents.getEvents("session-ticket").map((event) => event.type)).toContain("ticket-created");
  });

  test("downstream token and FHIR requests inherit the session from ticket, client, and access-token links", async () => {
    const context = createAppContext({ port: 0 });
    context.config.publicBaseUrl = "http://example.test";
    context.config.issuer = "http://example.test";
    const { publicJwk, privateJwk, thumbprint } = await generateClientKeyMaterial();

    const signResponse = await handleRequest(
      context,
      new Request("http://example.test/issuer/reference-demo/sign-ticket", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-demo-session": "session-flow",
        },
        body: JSON.stringify({
          iss: "http://example.test/issuer/reference-demo",
          aud: "http://example.test",
          exp: Math.floor(Date.now() / 1000) + 3600,
          jti: crypto.randomUUID(),
          ticket_type: "https://smarthealthit.org/permission-ticket-type/network-patient-access-v1",
          presenter_binding: { key: { jkt: thumbprint } },
          subject: {
            patient: {
              resourceType: "Patient",
              name: [{ family: "Reyes", given: ["Elena", "Marisol"] }],
              birthDate: "1989-09-14",
            },
          },
          access: {
            permissions: [
              { kind: "data", resource_type: "Patient", interactions: ["read", "search"] },
              { kind: "data", resource_type: "Observation", interactions: ["read", "search"] },
            ],
            sensitive_data: "exclude",
          },
          context: { kind: "patient-access" },
        }),
      }),
    );
    expect(signResponse.status).toBe(201);
    const signBody = await signResponse.json() as { signed_ticket: string };

    const registerResponse = await handleRequest(
      context,
      new Request("http://example.test/networks/reference/register", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-demo-session": "session-flow",
        },
        body: JSON.stringify({
          client_name: "Demo session-linked client",
          token_endpoint_auth_method: "private_key_jwt",
          jwk: publicJwk,
        }),
      }),
    );
    expect(registerResponse.status).toBe(201);
    const registered = await registerResponse.json() as { client_id: string };

    const networkAudience = "http://example.test/networks/reference/token";
    const networkAssertion = await signPrivateKeyJwt(
      {
        iss: registered.client_id,
        sub: registered.client_id,
        aud: networkAudience,
        iat: Math.floor(Date.now() / 1000),
        exp: Math.floor(Date.now() / 1000) + 300,
        jti: crypto.randomUUID(),
      },
      privateJwk as JsonWebKey & { kty: "EC"; crv: "P-256"; x: string; y: string; d: string },
    );

    const networkTokenResponse = await handleRequest(
      context,
      new Request(networkAudience, {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          "x-client-jkt": thumbprint,
        },
        body: new URLSearchParams({
          grant_type: "urn:ietf:params:oauth:grant-type:token-exchange",
          subject_token_type: PERMISSION_TICKET_SUBJECT_TOKEN_TYPE,
          subject_token: signBody.signed_ticket,
          client_id: registered.client_id,
          client_assertion_type: "urn:ietf:params:oauth:client-assertion-type:jwt-bearer",
          client_assertion: networkAssertion,
        }).toString(),
      }),
    );
    expect(networkTokenResponse.status).toBe(200);
    const networkTokenBody = await networkTokenResponse.json() as { access_token: string };
    const networkTokenClaims = decodeJwtPayload(networkTokenBody.access_token);

    const resolveResponse = await handleRequest(
      context,
      new Request("http://example.test/networks/reference/fhir/$resolve-record-locations", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${networkTokenBody.access_token}`,
          "x-client-jkt": thumbprint,
        },
        body: JSON.stringify({ resourceType: "Parameters" }),
      }),
    );
    expect(resolveResponse.status).toBe(200);
    const flowEvents = context.demoEvents.getEvents("session-flow");
    const eventTypes = flowEvents.map((event) => event.type);
    expect(eventTypes).toContain("ticket-created");
    expect(eventTypes).toContain("registration-request");
    expect(eventTypes).toContain("sites-discovered");
    expect(eventTypes).toContain("token-exchange");
    const sitesDiscovered = flowEvents.find((event) => event.type === "sites-discovered");
    expect(sitesDiscovered?.artifacts?.request?.method).toBe("POST");
    expect(sitesDiscovered?.artifacts?.request?.url).toContain("/networks/reference/fhir/$resolve-record-locations");
    expect(sitesDiscovered?.artifacts?.response?.status).toBe(200);
  });

  test("site registration events carry site identity for swimlane placement", async () => {
    const context = createAppContext({ port: 0 });
    const response = await handleRequest(
      context,
      new Request("http://example.test/sites/lone-star-womens-health/register", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-demo-session": "session-site-registration",
        },
        body: JSON.stringify({
          client_name: "Site-bound demo client",
          token_endpoint_auth_method: "private_key_jwt",
          jwk: (await generateClientKeyMaterial()).publicJwk,
        }),
      }),
    );

    expect(response.status).toBe(201);
    const event = context.demoEvents.getEvents("session-site-registration").find((candidate) => candidate.type === "registration-request");
    expect(event?.type).toBe("registration-request");
    expect(event?.detail.siteSlug).toBe("lone-star-womens-health");
    expect(event?.detail.siteName).toBe("Lone Star Women's Health");
  });
});

async function postDemoEvent(context: ReturnType<typeof createAppContext>, sessionId: string, event: Record<string, unknown>) {
  const response = await handleRequest(
    context,
    new Request(`http://example.test/demo/events/${sessionId}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(event),
    }),
  );
  expect(response.status).toBe(202);
  return response.json();
}

async function readSseEvents(response: Response, count: number) {
  const reader = response.body?.getReader();
  if (!reader) throw new Error("SSE response body is missing");
  const decoder = new TextDecoder();
  const events: DemoEvent[] = [];
  let buffer = "";
  try {
    while (events.length < count) {
      const readResult = await Promise.race([
        reader.read(),
        new Promise<never>((_, reject) => {
          setTimeout(() => reject(new Error("Timed out waiting for SSE event")), 1000);
        }),
      ]);
      if (readResult.done) break;
      buffer += decoder.decode(readResult.value, { stream: true });
      let boundary = buffer.indexOf("\n\n");
      while (boundary >= 0) {
        const chunk = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        const data = chunk
          .split("\n")
          .filter((line) => line.startsWith("data: "))
          .map((line) => line.slice("data: ".length))
          .join("\n");
        if (data) {
          events.push(JSON.parse(data) as DemoEvent);
          if (events.length >= count) break;
        }
        boundary = buffer.indexOf("\n\n");
      }
    }
    return events;
  } finally {
    await reader.cancel();
  }
}

async function readRawSseText(response: Response, blockCount: number) {
  const reader = response.body?.getReader();
  if (!reader) throw new Error("SSE response body is missing");
  const decoder = new TextDecoder();
  let buffer = "";
  let seenBlocks = 0;
  try {
    while (seenBlocks < blockCount) {
      const readResult = await Promise.race([
        reader.read(),
        new Promise<never>((_, reject) => {
          setTimeout(() => reject(new Error("Timed out waiting for SSE text")), 1000);
        }),
      ]);
      if (readResult.done) break;
      buffer += decoder.decode(readResult.value, { stream: true });
      seenBlocks = buffer.split("\n\n").filter(Boolean).length;
    }
    return buffer;
  } finally {
    await reader.cancel();
  }
}

function decodeJwtPayload(token: string) {
  const payload = token.split(".")[1];
  if (!payload) throw new Error("JWT payload missing");
  return JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as Record<string, any>;
}
