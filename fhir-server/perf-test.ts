/**
 * Performance benchmark for the SMART Permission Tickets FHIR server.
 * Simulates the full viewer flow: bootstrap → register → sign ticket → token exchange
 * → resolve record locations → per-site token exchange → fetch all resources.
 *
 * Measures server-side latency by hitting localhost directly.
 */

const BASE = "http://localhost:8000";

async function fetchJson(url: string, init?: RequestInit) {
  const res = await fetch(url, init);
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`${res.status} ${res.statusText}: ${url}\n${body.slice(0, 500)}`);
  }
  return res.json();
}

async function timeIt<T>(label: string, fn: () => Promise<T>): Promise<{ result: T; ms: number }> {
  const start = performance.now();
  const result = await fn();
  const ms = performance.now() - start;
  return { result, ms };
}

// ---------- crypto helpers ----------

function b64u(bytes: Uint8Array) {
  let b = "";
  for (const byte of bytes) b += String.fromCharCode(byte);
  return btoa(b).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

async function generateKeyPair() {
  const keyPair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
  const publicJwk = await crypto.subtle.exportKey("jwk", keyPair.publicKey);
  const privateJwk = await crypto.subtle.exportKey("jwk", keyPair.privateKey);
  const canonical = JSON.stringify({ crv: publicJwk.crv, kty: publicJwk.kty, x: publicJwk.x, y: publicJwk.y });
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonical));
  const thumbprint = b64u(new Uint8Array(hash));
  return { publicJwk, privateJwk, privateKey: keyPair.privateKey, thumbprint };
}

async function signJwtClient(payload: Record<string, any>, privateKey: CryptoKey) {
  const enc = new TextEncoder();
  const headerB64 = b64u(enc.encode(JSON.stringify({ alg: "ES256", typ: "JWT" })));
  const payloadB64 = b64u(enc.encode(JSON.stringify(payload)));
  const signingInput = `${headerB64}.${payloadB64}`;
  const sig = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, privateKey, enc.encode(signingInput));
  return `${signingInput}.${b64u(new Uint8Array(sig))}`;
}

async function makeClientAssertion(clientId: string, audience: string, privateKey: CryptoKey) {
  return signJwtClient(
    {
      iss: clientId,
      sub: clientId,
      aud: audience,
      exp: Math.floor(Date.now() / 1000) + 300,
      iat: Math.floor(Date.now() / 1000),
      jti: crypto.randomUUID(),
    },
    privateKey,
  );
}

// ---------- Main benchmark ----------

const RESOURCE_TYPES = [
  "Patient", "Encounter", "Condition", "Observation", "Procedure",
  "MedicationRequest", "AllergyIntolerance", "Immunization",
  "DiagnosticReport", "DocumentReference", "ServiceRequest",
];

async function benchmarkPatient(person: any) {
  const { personId, displayName, familyName, givenNames, birthDate, sites } = person;
  console.log(`\n${'='.repeat(70)}`);
  console.log(`Patient: ${displayName} — ${sites.length} sites`);
  console.log('='.repeat(70));

  const timings: { label: string; ms: number }[] = [];

  // 1. Key generation
  const { result: keys, ms: keygenMs } = await timeIt("keygen", generateKeyPair);
  timings.push({ label: "Key generation", ms: keygenMs });

  // 2. Register client at network level
  const { result: reg, ms: regMs } = await timeIt("register", () =>
    fetchJson(`${BASE}/networks/reference/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        client_name: `perf-test-${displayName}`,
        token_endpoint_auth_method: "private_key_jwt",
        jwks: { keys: [keys.publicJwk] },
      }),
    })
  );
  timings.push({ label: "Client registration", ms: regMs });

  // 3. Sign permission ticket
  const ticketPayload = {
    iss: `${BASE}/issuer/reference-demo`,
    aud: BASE,
    exp: Math.floor(Date.now() / 1000) + 3600,
    jti: crypto.randomUUID(),
    ticket_type: "https://smarthealthit.org/permission-ticket-type/patient-self-access-v1",
    presenter_binding: { method: "jkt", jkt: keys.thumbprint },
    subject: {
      patient: { resourceType: "Patient", name: [{ family: familyName, given: givenNames }], birthDate },
    },
    access: {
      permissions: [{ kind: "data", resource_type: "*", interactions: ["read", "search"] }],
      sensitive_data: "include",
    },
  };

  const { result: signResult, ms: signMs } = await timeIt("sign-ticket", () =>
    fetchJson(`${BASE}/issuer/reference-demo/sign-ticket`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(ticketPayload),
    })
  );
  timings.push({ label: "Sign permission ticket", ms: signMs });
  const signedTicket = signResult.signed_ticket;

  // 4. Network-level token exchange
  const networkTokenEndpoint = `${BASE}/networks/reference/token`;
  const ca = await makeClientAssertion(reg.client_id, networkTokenEndpoint, keys.privateKey);
  const { result: networkToken, ms: networkTokenMs } = await timeIt("network-token-exchange", () =>
    fetchJson(networkTokenEndpoint, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "urn:ietf:params:oauth:grant-type:token-exchange",
        subject_token_type: "https://smarthealthit.org/token-type/permission-ticket",
        subject_token: signedTicket,
        client_id: reg.client_id,
        client_assertion_type: "urn:ietf:params:oauth:client-assertion-type:jwt-bearer",
        client_assertion: ca,
      }).toString(),
    })
  );
  timings.push({ label: "Network token exchange", ms: networkTokenMs });

  // 5. Resolve record locations
  const { result: recordLocations, ms: resolveMs } = await timeIt("resolve-record-locations", () =>
    fetchJson(`${BASE}/networks/reference/fhir/$resolve-record-locations`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${networkToken.access_token}`,
        "x-client-jkt": keys.thumbprint,
      },
    })
  );
  timings.push({ label: "Resolve record locations", ms: resolveMs });

  // Parse resolved site endpoints
  const siteEndpoints = (recordLocations.entry ?? [])
    .filter((e: any) => e.resource?.resourceType === "Endpoint" && e.resource?.address)
    .map((e: any) => {
      const addr = e.resource.address;
      const slug = addr.match(/\/sites\/([^/]+)\//)?.[1];
      return { slug, fhirBase: addr };
    })
    .filter((s: any) => s.slug);

  console.log(`  Resolved ${siteEndpoints.length} site endpoints`);

  // 6. Per-site: smart-config → token exchange → resource fetches
  let totalSiteTokenMs = 0;
  let totalResourceFetchMs = 0;
  let totalResources = 0;

  for (const site of siteEndpoints) {
    // Get smart config to find token endpoint
    const smartConfigUrl = `${site.fhirBase.replace(/\/fhir\/?$/, "")}/.well-known/smart-configuration`;
    // Actually the fhir base is like /sites/{slug}/fhir, smart-config is at /sites/{slug}/fhir/.well-known/smart-configuration
    const { result: smartConfig, ms: smartConfigMs } = await timeIt(`smart-config[${site.slug}]`, () =>
      fetchJson(`${site.fhirBase.replace(/\/$/, '')}/.well-known/smart-configuration`)
    );

    const siteTokenEndpoint = smartConfig.token_endpoint;

    // Site-level token exchange
    const siteCa = await makeClientAssertion(reg.client_id, siteTokenEndpoint, keys.privateKey);
    const { result: siteToken, ms: siteTokenMs } = await timeIt(`site-token[${site.slug}]`, () =>
      fetchJson(siteTokenEndpoint, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "urn:ietf:params:oauth:grant-type:token-exchange",
          subject_token_type: "https://smarthealthit.org/token-type/permission-ticket",
          subject_token: signedTicket,
          client_id: reg.client_id,
          client_assertion_type: "urn:ietf:params:oauth:client-assertion-type:jwt-bearer",
          client_assertion: siteCa,
        }).toString(),
      })
    );
    totalSiteTokenMs += siteTokenMs;

    // Fetch all resource types
    let siteResourceCount = 0;
    const siteQueryTimings: { type: string; ms: number; count: number }[] = [];
    const patientId = siteToken.patient;
    const fhirBase = smartConfig.fhir_base_url ?? site.fhirBase;

    for (const rt of RESOURCE_TYPES) {
      const searchUrl = rt === "Patient"
        ? `${fhirBase}/${rt}?_id=${patientId}&_count=100`
        : `${fhirBase}/${rt}?patient=${patientId}&_count=100`;
      try {
        const { result: bundle, ms: queryMs } = await timeIt(`query[${site.slug}/${rt}]`, () =>
          fetchJson(searchUrl, {
            headers: {
              authorization: `Bearer ${siteToken.access_token}`,
              "x-client-jkt": keys.thumbprint,
            },
          })
        );
        const count = bundle.entry?.length ?? 0;
        siteResourceCount += count;
        totalResourceFetchMs += queryMs;
        siteQueryTimings.push({ type: rt, ms: queryMs, count });
      } catch {
        // resource type may not exist at this site
      }
    }

    totalResources += siteResourceCount;
    const queryTotal = siteQueryTimings.reduce((s, t) => s + t.ms, 0);
    console.log(`  Site: ${site.slug}`);
    console.log(`    Smart config:   ${smartConfigMs.toFixed(1)}ms`);
    console.log(`    Token exchange: ${siteTokenMs.toFixed(1)}ms`);
    console.log(`    Queries (${siteQueryTimings.length} types): ${queryTotal.toFixed(1)}ms total, ${siteResourceCount} resources`);
    for (const q of siteQueryTimings) {
      console.log(`      ${q.type.padEnd(22)} ${q.ms.toFixed(1).padStart(7)}ms  ${String(q.count).padStart(4)} resources`);
    }
  }

  timings.push({ label: `Site token exchanges (${siteEndpoints.length} sites)`, ms: totalSiteTokenMs });
  timings.push({ label: `Resource queries (${siteEndpoints.length}×${RESOURCE_TYPES.length} types)`, ms: totalResourceFetchMs });

  const grandTotal = timings.reduce((s, t) => s + t.ms, 0);
  console.log(`\n  Summary:`);
  for (const t of timings) {
    console.log(`    ${t.label.padEnd(55)} ${t.ms.toFixed(1).padStart(8)}ms`);
  }
  console.log(`    ${'─'.repeat(65)}`);
  console.log(`    ${'TOTAL'.padEnd(55)} ${grandTotal.toFixed(1).padStart(8)}ms`);
  console.log(`    Total resources fetched: ${totalResources}`);

  return { displayName, grandTotal, totalResources, siteCount: siteEndpoints.length };
}

async function main() {
  console.log("SMART Permission Tickets — Server Performance Benchmark");
  console.log(`Target: ${BASE}`);
  console.log(`Timestamp: ${new Date().toISOString()}\n`);

  const bootstrap = await fetchJson(`${BASE}/demo/bootstrap`);
  const persons = bootstrap.persons as any[];
  console.log(`Loaded ${persons.length} patients from bootstrap\n`);

  // Pick representative patients: fewest sites, median, all 5-site patients
  const sorted = [...persons].sort((a: any, b: any) => a.sites.length - b.sites.length);
  const picks = [
    sorted[0],                              // 1 site
    sorted[Math.floor(sorted.length / 2)],  // ~3 sites
    ...sorted.filter((p: any) => p.sites.length === 5), // all 5-site patients
  ];

  const results = [];
  for (const person of picks) {
    try {
      const r = await benchmarkPatient(person);
      results.push(r);
    } catch (err) {
      console.error(`  FAILED: ${err}`);
    }
  }

  console.log(`\n${'='.repeat(70)}`);
  console.log("OVERALL RESULTS");
  console.log('='.repeat(70));
  for (const r of results) {
    console.log(`  ${r.displayName.padEnd(30)} ${r.siteCount} sites  ${String(r.totalResources).padStart(4)} resources  ${r.grandTotal.toFixed(0).padStart(6)}ms total`);
  }
}

main().catch(console.error);
