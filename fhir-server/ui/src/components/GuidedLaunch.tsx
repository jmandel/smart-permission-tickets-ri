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
  const popupRef = useRef<Window | null>(null);

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
    setDiscovery(await discoverIssuer(origin, ISSUER_SLUG));
  });

  const onRegister = () => run(async () => {
    if (!keys) throw new Error("App keys not ready yet");
    setRegistration(await registerApp(origin, keys));
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
    });
    setTokenCall(result);
    setSites(result.endpoints.map((hint) => ({ hint, status: "ready" })));
  });

  const onRedeemSites = () => run(async () => {
    if (!tokenCall || !registration || !keys) throw new Error("Get tickets first");
    const ticket = tokenCall.tickets[0];
    for (const [index, site] of sites.entries()) {
      setSites((current) => current.map((entry, i) => (i === index ? { ...entry, status: "running" } : entry)));
      try {
        const exchange = await redeemTicketAtSite({ hint: site.hint, ticket, keys });
        const sample = await sampleSiteData(site.hint, exchange.accessToken);
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

  const ticketPayload = tokenCall?.tickets[0] ? decodeJwtPayload(tokenCall.tickets[0]) : null;
  const doneSites = sites.filter((site) => site.status === "done");

  return (
    <main className="shell">
      <section className="panel section">
        <div className="section-header">
          <div>
            <p className="eyebrow">Guided demo</p>
            <h2>An app gets Permission Tickets via SMART App Launch</h2>
          </div>
          <a className="button" href="/">Back to workbench</a>
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
        narration="The app sends Elena to the issuer's authorize endpoint with PKCE — nothing in this request says who is authorizing or what they choose to share. Those decisions happen at the issuer: in the popup, pick Elena and check the sensitive-categories box (her women's health records stay withheld without it). The issuer redirects back with an authorization code."
        status={code ? "done" : registration ? "ready" : "pending"}
        actionLabel="Open authorize popup"
        onAction={onAuthorize}
        busy={busy}
        call={null}
      >
        {authorizeUrl && (
          <pre className="launch-pre">{`GET ${authorizeUrl}`}</pre>
        )}
        {authorizeUrl && !code && <p className="subtle">Waiting for the redirect… in the popup, pick <strong>Elena Reyes</strong> and check <strong>Include sensitive categories</strong>.</p>}
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
        {ticketPayload && (
          <div>
            <p className="subtle">Decoded ticket payload — note <code>ticket_type</code>, <code>presenter_binding</code> (bound to the app's key), <code>subject</code>, and <code>access</code>:</p>
            <pre className="launch-pre">{JSON.stringify(ticketPayload, null, 2)}</pre>
          </div>
        )}
      </StepCard>

      <section className="panel section">
        <div className="section-header">
          <div>
            <p className="eyebrow">Step 5</p>
            <h2>App presents the same ticket at every site</h2>
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
          authenticates, and presents the same ticket via RFC 8693 token exchange. Each
          site verifies the issuer signature and the key binding, and matches Elena locally — no portal
          account, no per-site authorization screens, and Elena never reappears.
        </p>
        <div className="patient-picker-grid">
          {sites.map((site) => (
            <div key={site.hint.fhir_base_url} className="panel" style={{ padding: 12 }}>
              <strong>{site.hint.organization.name}</strong>
              <p className="subtle" style={{ margin: "4px 0" }}>{site.hint.fhir_base_url}</p>
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
            terms. See the <a href="/trace">protocol trace</a> for every request this page just made.
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
