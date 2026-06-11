import { useEffect, useRef, useState } from "react";

import {
  buildAuthorizeUrl,
  CALLBACK_MESSAGE_TYPE,
  decodeJwtPayload,
  discoverIssuer,
  generateAppIdentity,
  generatePkce,
  LAUNCH_APP_NAME,
  LAUNCH_SCOPE,
  redeemAuthorizationCode,
  redeemTicketAtSite,
  registerApp,
  sampleSiteData,
  type EndpointHint,
  type RecordedCall,
} from "../lib/launch-flow.ts";
import type { ClientKeyMaterial } from "../../../shared/private-key-jwt.ts";

// Guided, scripted walk through Proposal 003: an app obtains Permission
// Tickets from the issuer via SMART App Launch, then redeems them across the
// patient's sites. Every step performs the real protocol call against this
// server; the only pre-baked parts are the app persona and the scopes.

const ISSUER_SLUG = "reference-demo";

type StepStatus = "pending" | "ready" | "running" | "done" | "error";

type SiteProgress = {
  hint: EndpointHint;
  // Which minted ticket this endpoint's hint points at (ticket_indices[0]).
  ticketIndex: number;
  status: StepStatus;
  grantedScope?: string;
  encounters?: number;
  observations?: number;
  error?: string;
};

export function GuidedLaunch() {
  const origin = window.location.origin;
  const [keys, setKeys] = useState<ClientKeyMaterial | null>(null);
  const [discovery, setDiscovery] = useState<RecordedCall | null>(null);
  const [registration, setRegistration] = useState<(RecordedCall & { clientId: string }) | null>(null);
  const [authorizeUrl, setAuthorizeUrl] = useState<string | null>(null);
  const [code, setCode] = useState<string | null>(null);
  const [tokenCall, setTokenCall] = useState<(RecordedCall & { tickets: string[]; endpoints: EndpointHint[] }) | null>(null);
  const [sites, setSites] = useState<SiteProgress[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const pkceRef = useRef<{ verifier: string; challenge: string } | null>(null);
  const stateRef = useRef<string>(crypto.randomUUID());
  const sessionRef = useRef<string>(crypto.randomUUID());
  const popupRef = useRef<Window | null>(null);
  const traceHref = `/trace?session=${sessionRef.current}`;

  useEffect(() => {
    generateAppIdentity().then(setKeys).catch((cause) => setError(String(cause)));
  }, []);

  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      if (event.origin !== origin) return;
      const data = event.data;
      if (!data || data.type !== CALLBACK_MESSAGE_TYPE) return;
      if (data.state !== stateRef.current) return;
      setCode(data.code);
      popupRef.current?.close();
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [origin]);

  const run = (work: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    work().catch((cause) => setError(cause instanceof Error ? cause.message : String(cause))).finally(() => setBusy(false));
  };

  const onDiscover = () => run(async () => {
    setDiscovery(await discoverIssuer(origin, ISSUER_SLUG, sessionRef.current));
  });

  const onRegister = () => run(async () => {
    if (!keys) throw new Error("App keys not ready yet");
    setRegistration(await registerApp(origin, keys, sessionRef.current));
  });

  const onAuthorize = () => run(async () => {
    if (!registration) throw new Error("Register the app first");
    const pkce = await generatePkce();
    pkceRef.current = pkce;
    const url = buildAuthorizeUrl({
      origin,
      issuerSlug: ISSUER_SLUG,
      clientId: registration.clientId,
      challenge: pkce.challenge,
      state: stateRef.current,
    });
    setAuthorizeUrl(url);
    popupRef.current = window.open(url, "issuance-authorize", "width=560,height=680");
  });

  const onRedeemCode = () => run(async () => {
    if (!registration || !code || !pkceRef.current) throw new Error("Complete the authorize step first");
    const result = await redeemAuthorizationCode({
      origin,
      issuerSlug: ISSUER_SLUG,
      code,
      clientId: registration.clientId,
      verifier: pkceRef.current.verifier,
      demoSessionId: sessionRef.current,
    });
    setTokenCall(result);
    setSites(result.endpoints.map((hint) => ({ hint, ticketIndex: hint.ticket_indices[0] ?? 0, status: "ready" })));
  });

  const onRedeemSites = () => run(async () => {
    if (!tokenCall || !registration || !keys) throw new Error("Get tickets first");
    for (const [index, site] of sites.entries()) {
      setSites((current) => current.map((entry, i) => (i === index ? { ...entry, status: "running" } : entry)));
      try {
        // Each endpoint hint names its own ticket via ticket_indices; with
        // per-site tickets these differ, so we never assume a single ticket.
        const ticket = tokenCall.tickets[site.ticketIndex];
        if (!ticket) throw new Error(`No ticket at index ${site.ticketIndex} for ${site.hint.organization.name}`);
        const exchange = await redeemTicketAtSite({ hint: site.hint, ticket, keys, demoSessionId: sessionRef.current });
        const sample = await sampleSiteData(site.hint, exchange.accessToken, sessionRef.current);
        setSites((current) => current.map((entry, i) => (
          i === index
            ? { ...entry, status: "done", grantedScope: exchange.grantedScope, encounters: sample.encounters, observations: sample.observations }
            : entry
        )));
      } catch (cause) {
        setSites((current) => current.map((entry, i) => (
          i === index ? { ...entry, status: "error", error: cause instanceof Error ? cause.message : String(cause) } : entry
        )));
      }
    }
  });

  const ticketPayloads = tokenCall?.tickets.map((ticket) => decodeJwtPayload(ticket)) ?? [];
  const ticketCount = tokenCall?.tickets.length ?? 0;
  const doneSites = sites.filter((site) => site.status === "done");

  return (
    <main className="shell">
      <section className="panel section">
        <div className="section-header">
          <div>
            <p className="eyebrow">Guided demo</p>
            <h2>An app gets Permission Tickets via SMART App Launch</h2>
          </div>
          <div style={{ display: "flex", gap: 8 }}>
            <a className="button" href={traceHref} target="_blank" rel="noreferrer">Watch in protocol trace</a>
            <a className="button" href="/">Back to workbench</a>
          </div>
        </div>
        <p className="subtle">
          The cast: <strong>Elena Reyes</strong>, a patient with records at five sites across Texas and
          California; <strong>{LAUNCH_APP_NAME}</strong>, which generated a fresh P-256 keypair when this page
          loaded; and this server's demo <strong>ticket issuer</strong>. Every step below runs the real protocol
          call — nothing is canned. Requested scope: <code>{LAUNCH_SCOPE}</code>.
        </p>
      </section>

      <StepCard
        index={1}
        title="App discovers the issuer"
        narration="The app fetches the issuer's SMART configuration and sees permission-ticket-issuance in capabilities: this authorization server mints Permission Tickets in its token response."
        status={discovery ? "done" : "ready"}
        actionLabel="GET .well-known/smart-configuration"
        onAction={onDiscover}
        busy={busy}
        call={discovery}
      />

      <StepCard
        index={2}
        title="App registers itself"
        narration="Dynamic registration: the app presents its public key and gets a client_id. The issuer now knows which key to bind tickets to — individual-access tickets must be presenter-bound."
        status={registration ? "done" : discovery ? "ready" : "pending"}
        actionLabel="POST /register"
        onAction={onRegister}
        busy={busy}
        call={registration}
      />

      <StepCard
        index={3}
        title="Elena authorizes at the issuer"
        narration="The app sends Elena to the issuer's authorize endpoint with PKCE — nothing in this request says what she chooses to share. Those decisions happen at the issuer: the popup is Elena's consent screen, where she chooses whether to include sensitive categories and whether to share with any site in the network or only specific sites. The choices shape everything downstream: without including sensitive categories, her women's health site is not even named, because naming it would reveal what the withholding protects; choosing specific sites mints one ticket per site instead of a single blanket ticket."
        status={code ? "done" : registration ? "ready" : "pending"}
        actionLabel="Open authorize popup"
        onAction={onAuthorize}
        busy={busy}
        call={null}
      >
        {authorizeUrl && (
          <pre className="launch-pre">{`GET ${authorizeUrl}`}</pre>
        )}
        {authorizeUrl && !code && <p className="subtle">Waiting for the redirect… in the popup, this is <strong>Elena Reyes</strong>'s consent screen. Try it with and without <strong>Include sensitive categories</strong>, and with <strong>Any site</strong> vs <strong>Only these sites</strong> — the ticket count and endpoint hints in step 4 change.</p>}
        {code && <p className="subtle">Received <code>code={code.slice(0, 8)}…</code> at the app's redirect_uri.</p>}
      </StepCard>

      <StepCard
        index={4}
        title="App redeems the code for tickets"
        narration="A standard token request with the PKCE verifier. The response is a SMART token response whose extra fields carry the signed Permission Ticket and hints about where it should work."
        status={tokenCall ? "done" : code ? "ready" : "pending"}
        actionLabel="POST issuer /token"
        onAction={onRedeemCode}
        busy={busy}
        call={tokenCall}
      >
        {ticketCount > 0 && (
          <div>
            <p className="subtle">
              The issuer minted <strong>{ticketCount}</strong> ticket{ticketCount === 1 ? "" : "s"}.{" "}
              {ticketCount === 1
                ? "One blanket ticket (no data_holder_filter): Elena shared with any site in the network."
                : "One ticket per chosen site, each carrying access.data_holder_filter for its Organization; the endpoint hints' ticket_indices point each site at its own ticket."}
            </p>
            {ticketPayloads.map((payload, index) => (
              <details key={index} open={ticketCount === 1}>
                <summary>Ticket index <code>{index}</code> — <code>ticket_type</code>, <code>presenter_binding</code>, <code>subject</code>, <code>subject_identity_evidence</code>, <code>access</code></summary>
                <pre className="launch-pre">{JSON.stringify(payload, null, 2)}</pre>
              </details>
            ))}
          </div>
        )}
      </StepCard>

      <section className="panel section">
        <div className="section-header">
          <div>
            <p className="eyebrow">Step 5</p>
            <h2>App presents the right ticket at every site</h2>
          </div>
          <button
            type="button"
            className="button"
            disabled={!tokenCall || busy || sites.every((site) => site.status !== "ready")}
            onClick={onRedeemSites}
          >
            Run token exchange at {sites.length || "…"} sites
          </button>
        </div>
        <p className="subtle">
          One authorization, many doors: for each endpoint hint the app discovers the site's
          smart-configuration, registers its key (registration is local to each Data Holder),
          authenticates, and presents the ticket named by that hint's <code>ticket_indices</code> via
          RFC 8693 token exchange. Each site verifies the issuer signature and the key binding, and
          matches Elena locally — no portal account, no per-site authorization screens, and Elena
          never reappears.
        </p>
        <div className="patient-picker-grid">
          {sites.map((site) => (
            <div key={site.hint.fhir_base_url} className="panel launch-site-card">
              <strong>{site.hint.organization.name}</strong>
              <p className="subtle launch-card-url">{site.hint.fhir_base_url}</p>
              <p className="subtle">Redeems ticket index <code>{site.ticketIndex}</code></p>
              {site.status === "ready" && <p className="subtle">Waiting…</p>}
              {site.status === "running" && <p>Exchanging ticket…</p>}
              {site.status === "done" && (
                <p>
                  ✓ token granted · <strong>{site.encounters}</strong> encounters, <strong>{site.observations}</strong> observations visible
                </p>
              )}
              {site.status === "error" && <p style={{ color: "var(--warn)" }}>{site.error}</p>}
            </div>
          ))}
          {!sites.length && <p className="subtle">Endpoint hints appear here after step 4.</p>}
        </div>
        {doneSites.length > 0 && doneSites.length === sites.length && (
          <p>
            <strong>That's the whole story:</strong> one issuer ceremony produced one signed, presenter-bound,
            time-limited ticket, and {doneSites.length} independent sites each said yes to it on their own
            terms. See the <a href={traceHref} target="_blank" rel="noreferrer">protocol trace</a> for every request this page just made.
          </p>
        )}
      </section>

      {error && (
        <section className="panel section">
          <p style={{ color: "var(--warn)" }}>{error}</p>
        </section>
      )}
    </main>
  );
}

function StepCard(props: {
  index: number;
  title: string;
  narration: string;
  status: StepStatus;
  actionLabel: string;
  onAction: () => void;
  busy: boolean;
  call: RecordedCall | null;
  children?: React.ReactNode;
}) {
  return (
    <section className="panel section">
      <div className="section-header">
        <div>
          <p className="eyebrow">Step {props.index}{props.status === "done" ? " · done" : ""}</p>
          <h2>{props.title}</h2>
        </div>
        <button
          type="button"
          className="button"
          disabled={props.status === "pending" || props.busy}
          onClick={props.onAction}
        >
          {props.actionLabel}
        </button>
      </div>
      <p className="subtle">{props.narration}</p>
      {props.call && (
        <div>
          <pre className="launch-pre">{`${props.call.request.method} ${props.call.request.url}${props.call.request.body ? `\n\n${props.call.request.body}` : ""}`}</pre>
          <pre className="launch-pre">{`HTTP ${props.call.status}\n${JSON.stringify(props.call.response, null, 2)}`}</pre>
        </div>
      )}
      {props.children}
    </section>
  );
}
