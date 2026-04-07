import { useEffect, useMemo, useRef, useState } from "react";

import {
  buildViewerClientPlan,
  buildTicketPayload,
  buildViewerLaunch,
  buildViewerLaunchUrl,
  clientBindingForPlan,
  constrainedSites,
  defaultConsentState,
  describeClientOption,
  describeClientPlan,
  proofJktForPlan,
  scopeOptionsForPerson,
  summarizeConsent,
  ticketLifetimeOptions,
  validateConsent,
} from "../demo";
import type { ConsentState, DemoClientOption, DemoClientType, ModeName, NetworkInfo, PersonInfo, TicketIssuerInfo, ViewerLaunch } from "../types";
import { buildArtifactViewerHref, buildJwtArtifactPayload } from "../lib/artifact-viewer";
import { signPermissionTicket } from "../lib/ticket-client";
import { SplitAction } from "./SplitAction";

function yearOptions(person: PersonInfo) {
  const years = [
    person.startDate ? Number.parseInt(person.startDate.slice(0, 4), 10) : null,
    person.endDate ? Number.parseInt(person.endDate.slice(0, 4), 10) : null,
    ...person.sites.flatMap((site) => [
      site.startDate ? Number.parseInt(site.startDate.slice(0, 4), 10) : null,
      site.endDate ? Number.parseInt(site.endDate.slice(0, 4), 10) : null,
    ]),
  ].filter((value): value is number => Number.isFinite(value));
  if (years.length === 0) return [new Date().getFullYear()];
  const minYear = Math.min(...years);
  const maxYear = Math.max(...years);
  return Array.from({ length: maxYear - minYear + 1 }, (_, index) => minYear + index);
}

type ArtifactState = {
  viewerLaunch: ViewerLaunch;
  viewerUrl: string;
  ticketPayload: Record<string, any> | null;
  signedTicket: string | null;
  proofJkt: string | null;
};

export function PermissionWorkbench({
  person,
  mode,
  defaultTicketIssuer,
  defaultNetwork,
  demoClientOptions,
}: {
  person: PersonInfo | null;
  mode: ModeName;
  defaultTicketIssuer: TicketIssuerInfo | null;
  defaultNetwork: NetworkInfo | null;
  demoClientOptions: DemoClientOption[];
}) {
  const [consent, setConsent] = useState<ConsentState | null>(null);
  const [selectedClientType, setSelectedClientType] = useState<DemoClientType | null>(null);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [artifacts, setArtifacts] = useState<ArtifactState | null>(null);
  const preparePromiseRef = useRef<Promise<ArtifactState | null> | null>(null);

  const availableClientOptions: DemoClientOption[] = useMemo(() => (
    mode === "strict"
      ? demoClientOptions
      : [demoClientOptions.find((option) => option.type === "unaffiliated") ?? {
        type: "unaffiliated",
        label: "Unaffiliated registered client",
        description: "Generates a one-off JWK pair and dynamically registers it just before token exchange.",
        registrationMode: "dynamic-jwk",
      }]
  ), [demoClientOptions, mode]);
  const selectedClientOption = availableClientOptions.find((option) => option.type === selectedClientType)
    ?? availableClientOptions[0]
    ?? null;

  useEffect(() => {
    if (!person) {
      setConsent(null);
      setSelectedClientType(null);
      setArtifacts(null);
      setError(null);
      preparePromiseRef.current = null;
      return;
    }
    setConsent(defaultConsentState(person));
    setSelectedClientType((current) => current ?? availableClientOptions[0]?.type ?? null);
    setArtifacts(null);
    setError(null);
    preparePromiseRef.current = null;
  }, [person?.personId, availableClientOptions]);

  useEffect(() => {
    if (!consent) return;
    setArtifacts(null);
    setError(null);
    preparePromiseRef.current = null;
  }, [consent, mode, selectedClientType]);

  if (!person || !consent) {
    return (
      <section className="panel section">
        <h2>Permission Workbench</h2>
        <p className="subtle">Select a patient to configure a Permission Ticket and hand it off to the multi-site viewer app.</p>
      </section>
    );
  }

  const currentPerson = person;
  const currentConsent = consent;
  const origin = window.location.origin;
  const sites = constrainedSites(currentPerson, currentConsent);
  const scopeGroups = scopeOptionsForPerson(currentPerson);
  const validationIssues = validateConsent(currentPerson, currentConsent);
  const canRun = validationIssues.length === 0;
  const consentSummary = summarizeConsent(currentPerson, currentConsent);
  const stateOptions = [
    ...new Set(currentPerson.sites.map((site) => site.jurisdiction).filter((state): state is string => Boolean(state))),
  ].sort();
  const resourceIssue = validationIssues.find((issue) => issue.section === "resources");
  const locationIssue = validationIssues.find((issue) => issue.section === "sites");
  const dateIssue = validationIssues.find((issue) => issue.section === "time");
  const generatedYears = yearOptions(currentPerson);
  const lifetimeOptions = ticketLifetimeOptions();
  const selectedStartYear = currentConsent.dateRange.start?.slice(0, 4) ?? "";
  const selectedEndYear = currentConsent.dateRange.end?.slice(0, 4) ?? "";
  const showClientSelection = mode === "strict" && availableClientOptions.length > 0;
  const selectedClientRegistration = selectedClientOption?.registrationMode === "dynamic-jwk"
    ? "Dynamic registration"
    : selectedClientOption?.registrationMode === "implicit-well-known"
      ? "No registration"
      : selectedClientOption?.registrationMode === "oidf-automatic"
        ? "No registration"
      : selectedClientOption?.registrationMode === "udap-dcr"
        ? "UDAP DCR"
        : "Not required";
  const selectedBindingSummary = selectedClientOption?.type === "unaffiliated"
    ? ((mode === "strict" || mode === "key-bound") ? "Ticket uses presenter_binding.method = jkt" : "No presenter binding in ticket")
    : selectedClientOption?.type === "well-known"
      ? "Ticket uses presenter_binding.method = framework_client"
      : selectedClientOption?.type === "udap"
        ? "Ticket uses presenter_binding.method = framework_client"
        : "No presenter binding";
  const selectedClientStory = selectedClientOption ? describeClientOption(mode, selectedClientOption) : null;

  function openArtifact(title: string, content: unknown, copyText?: string, subtitle?: string) {
    const href = buildArtifactViewerHref({ title, content, copyText, subtitle });
    window.open(href, "_blank", "noopener,noreferrer");
  }

  async function openRemoteArtifact(title: string, url: string) {
    try {
      const response = await fetch(url);
      const contentType = response.headers.get("content-type") ?? "";
      const content = contentType.includes("json") ? await response.json() : await response.text();
      if (!response.ok) throw new Error(typeof content === "string" ? content : `${response.status} ${url}`);
      openArtifact(title, content, undefined, url);
    } catch (remoteError) {
      setError(remoteError instanceof Error ? remoteError.message : `Failed to load ${url}`);
    }
  }

  async function buildArtifacts() {
    const sessionId = crypto.randomUUID();
    const clientPlan = selectedClientOption ? await buildViewerClientPlan(currentPerson, selectedClientOption) : null;
    const proofJkt = proofJktForPlan(mode, clientPlan);
    const frameworkPresenterBinding = clientBindingForPlan(clientPlan);

    if (!defaultTicketIssuer) {
      throw new Error("No default Permission Ticket issuer is configured");
    }
    if (!defaultNetwork) {
      throw new Error("No default network is configured");
    }

    const ticketPayload = buildTicketPayload(defaultTicketIssuer.issuerBaseUrl, origin, currentPerson, currentConsent, {
      proofJkt,
      frameworkClientBinding: frameworkPresenterBinding,
    });
    const signedTicket = (await signPermissionTicket(origin, defaultTicketIssuer, ticketPayload, sessionId)).signedTicket;

    const viewerLaunch = buildViewerLaunch(
      sessionId,
      origin,
      mode,
      currentPerson,
      defaultNetwork,
      defaultTicketIssuer,
      ticketPayload,
      signedTicket,
      proofJkt,
      clientPlan,
      {
        dateSummary: consentSummary.dates,
        sensitiveSummary: consentSummary.sensitive,
        expirySummary: consentSummary.lifetime,
        bindingSummary: selectedBindingSummary,
        clientLabel: selectedClientOption?.label ?? null,
      },
    );
    const viewerUrl = buildViewerLaunchUrl(viewerLaunch);
    return {
      viewerLaunch,
      viewerUrl,
      ticketPayload,
      signedTicket,
      proofJkt,
    };
  }

  async function ensureArtifacts() {
    if (!canRun) return null;
    if (artifacts) return artifacts;
    if (preparePromiseRef.current) return preparePromiseRef.current;

    const pending = (async () => {
      setRunning(true);
      setError(null);
      try {
        const nextArtifacts = await buildArtifacts();
        setArtifacts(nextArtifacts);
        return nextArtifacts;
      } catch (runError) {
        setError(runError instanceof Error ? runError.message : "Failed to prepare app handoff");
        return null;
      } finally {
        setRunning(false);
        preparePromiseRef.current = null;
      }
    })();

    preparePromiseRef.current = pending;
    return pending;
  }

  async function openHealthApp() {
    const nextArtifacts = await ensureArtifacts();
    if (!nextArtifacts) return;
    window.open(nextArtifacts.viewerUrl, "_blank", "noopener,noreferrer");
  }

  async function openProtocolTrace() {
    const nextArtifacts = await ensureArtifacts();
    if (!nextArtifacts) return;
    window.open(`/trace?session=${encodeURIComponent(nextArtifacts.viewerLaunch.sessionId)}`, "_blank", "noopener,noreferrer");
  }

  async function copyAppLink() {
    const nextArtifacts = await ensureArtifacts();
    if (!nextArtifacts) return;
    await navigator.clipboard.writeText(`${origin}${nextArtifacts.viewerUrl}`);
  }

  async function copyTicketJwt() {
    const nextArtifacts = await ensureArtifacts();
    if (!nextArtifacts?.signedTicket) return;
    await navigator.clipboard.writeText(nextArtifacts.signedTicket);
  }

  async function openTicketPayload() {
    const nextArtifacts = await ensureArtifacts();
    if (!nextArtifacts?.ticketPayload || !nextArtifacts?.signedTicket) return;
    const clientStory = nextArtifacts.viewerLaunch.clientPlan
      ? describeClientPlan(mode, nextArtifacts.viewerLaunch.clientPlan)
      : null;
    const metadata = [
      clientStory?.ticketBinding ? { label: "Binding", value: clientStory.ticketBinding.label } : null,
      clientStory?.ticketBinding?.rationale ? { label: "Rationale", value: clientStory.ticketBinding.rationale } : null,
      clientStory?.frameworkUri ? { label: "Framework", value: clientStory.frameworkUri } : null,
      clientStory?.entityUri ? { label: "Entity URI", value: clientStory.entityUri } : null,
    ].filter((entry): entry is { label: string; value: string } => Boolean(entry));
    const href = buildArtifactViewerHref(buildJwtArtifactPayload({
      title: "Permission Ticket JWT",
      jwt: nextArtifacts.signedTicket,
      metadata,
    }));
    window.open(href, "_blank", "noopener,noreferrer");
  }

  async function openAppHandoff() {
    const nextArtifacts = await ensureArtifacts();
    if (!nextArtifacts) return;
    openArtifact("Viewer Handoff Payload", nextArtifacts.viewerLaunch, `${origin}${nextArtifacts.viewerUrl}`);
  }

  async function openPreparedClientPlan() {
    const nextArtifacts = await ensureArtifacts();
    if (!nextArtifacts?.viewerLaunch.clientPlan) return;
    const clientPlan = nextArtifacts.viewerLaunch.clientPlan;
    if (!clientPlan) return;
    openArtifact("Client Plan", clientPlan);
  }

  return (
    <>
      {showClientSelection && selectedClientOption && (
        <section className="panel section demo-client-panel">
          <div className="section-header">
            <div>
              <p className="eyebrow">Step 2 · Choose Client Type</p>
              <h2>Pick how the app will identify itself</h2>
              <p className="subtle">This choice changes client authentication and ticket binding. Ticket-issuer trust is evaluated separately by the data holder.</p>
            </div>
          </div>
          <div className="demo-client-grid">
            {availableClientOptions.map((option) => (
              <button
                key={option.type}
                type="button"
                className={`demo-client-card${selectedClientOption.type === option.type ? " active" : ""}`}
                onClick={() => setSelectedClientType(option.type)}
              >
                <span className="demo-client-label">{option.label}</span>
                <strong>{option.registrationMode === "dynamic-jwk"
                  ? "Dynamic registration"
                  : option.registrationMode === "implicit-well-known"
                    ? "No registration"
                    : option.registrationMode === "oidf-automatic"
                      ? "No registration"
                    : "UDAP DCR"}</strong>
                <p>{option.description}</p>
                {option.framework && <span className="demo-client-meta">{option.framework.displayName}</span>}
              </button>
            ))}
          </div>
          {selectedClientStory && (
            <div className="demo-client-detail">
              <div>
                <span className="summary-label">What this path demonstrates</span>
                <p>{selectedClientStory.whatThisDemonstrates}</p>
              </div>
              <div className="demo-client-facts">
                <div className="demo-client-fact">
                  <span className="summary-label">Registration</span>
                  <strong>{selectedClientStory.registrationLabel}</strong>
                </div>
                <div className="demo-client-fact">
                  <span className="summary-label">Token auth</span>
                  <strong>{selectedClientStory.authenticationLabel}</strong>
                </div>
                <div className="demo-client-fact">
                  <span className="summary-label">Ticket binding</span>
                  <strong>{selectedClientStory.ticketBinding.label}</strong>
                </div>
                <div className="demo-client-fact">
                  <span className="summary-label">Client id on wire</span>
                  <strong className="mono-value mono-wrap">{selectedClientStory.effectiveClientId}</strong>
                </div>
                {selectedClientStory.frameworkDisplayName && (
                  <div className="demo-client-fact">
                    <span className="summary-label">Framework</span>
                    <strong>{selectedClientStory.frameworkDisplayName}</strong>
                  </div>
                )}
                {selectedClientStory.entityUri && (
                  <div className="demo-client-fact">
                    <span className="summary-label">{selectedClientStory.clientType === "udap" ? "Entity URI (certificate SAN)" : "Entity URI"}</span>
                    <strong className="mono-value mono-wrap">{selectedClientStory.entityUri}</strong>
                  </div>
                )}
              </div>
              <p className="subtle demo-client-binding-copy">{selectedClientStory.ticketBinding.rationale}</p>
              <p className="subtle demo-client-binding-copy">Client trust and ticket-issuer trust are shown separately in Protocol Trace and token diagnostics.</p>
              <div className="button-row demo-client-actions">
                <button type="button" className="secondary-button" onClick={() => openArtifact("Client Story", selectedClientStory)}>
                  Open client story ↗
                </button>
                {selectedClientOption?.framework?.documentUrl && (
                  <button
                    type="button"
                    className="secondary-button"
                    onClick={() => void openRemoteArtifact("Well-Known Framework Document", selectedClientOption.framework!.documentUrl!)}
                  >
                    Open framework doc ↗
                  </button>
                )}
                {selectedClientOption?.type !== "unaffiliated" && (selectedClientOption?.entityConfigurationUrl || selectedClientOption?.entityUri) && (
                  <button
                    type="button"
                    className="secondary-button"
                    onClick={() => void openRemoteArtifact(
                      selectedClientOption.type === "oidf"
                        ? "OIDF Entity Configuration"
                        : selectedClientOption.type === "udap"
                          ? "UDAP Client Entity"
                          : "Well-Known Entity",
                      selectedClientOption.type === "oidf"
                        ? selectedClientOption.entityConfigurationUrl!
                        : selectedClientOption.entityUri!,
                    )}
                  >
                    {selectedClientOption.type === "oidf" ? "Open entity configuration ↗" : "Open entity ↗"}
                  </button>
                )}
                {selectedClientOption?.type === "well-known" && selectedClientOption.jwksUrl && (
                  <button
                    type="button"
                    className="secondary-button"
                    onClick={() => void openRemoteArtifact("Well-Known Entity JWKS", selectedClientOption.jwksUrl!)}
                  >
                    Open entity JWKS ↗
                  </button>
                )}
              </div>
            </div>
          )}
        </section>
      )}

      <section className="panel section">
        <div className="workbench-header">
          <div>
            <p className="eyebrow">{showClientSelection ? "Step 3 · Build Ticket" : "Step 2 · Build Ticket"}</p>
            <h2>Decide which sites and data the app may request</h2>
            <p className="subtle workbench-copy">
              Start with sites and dates, then narrow resources only if needed.
            </p>
          </div>
        </div>
        <section className="ticket-constraints-panel">
          <div className="section-header">
            <div>
              <h3>Ticket Constraints</h3>
              <p className="subtle">Work top to bottom: choose sites first, then dates, then narrow resources only if needed.</p>
            </div>
          </div>
          <div className="ticket-constraint-list">
          <div className={`wizard-section wizard-section-resources${resourceIssue ? " invalid" : ""}`}>
            <div className="wizard-section-header">
              <div>
                <p className="eyebrow">Resources</p>
                <h4>All data or selected SMART scopes</h4>
              </div>
              <div className="choice-grid">
                <button
                  type="button"
                  className={`choice-button${consent.resourceScopeMode === "all" ? " active" : ""}`}
                  onClick={() => setConsent((current) => (current ? { ...current, resourceScopeMode: "all" } : current))}
                >
                  All resources
                </button>
                <button
                  type="button"
                  className={`choice-button${consent.resourceScopeMode === "selected" ? " active" : ""}${consent.resourceScopeMode === "selected" && resourceIssue ? " invalid" : ""}`}
                  onClick={() => setConsent((current) => (current ? { ...current, resourceScopeMode: "selected" } : current))}
                >
                  Choose SMART scopes
                </button>
              </div>
            </div>
            {consent.resourceScopeMode === "selected" && (
              <>
                <p className="subtle" style={{ marginTop: 12 }}>
                  Organizations, practitioners, and locations are included automatically as supporting context when returned references need them. They are not part of the patient-controlled release choice here.
                </p>
                {resourceIssue && <p className="validation-hint">{resourceIssue.message}</p>}
                <div className="scope-group-list">
                  {scopeGroups.map((group) => (
                    <section key={group.id} className="scope-group">
                      <div className="scope-group-header">
                        <div>
                          <h5>{group.label}</h5>
                          <p className="subtle scope-group-copy">{group.description}</p>
                        </div>
                      </div>
                      <div className="scope-option-list">
                        {group.options.map((option) => (
                          <div key={option.scope} className={`scope-option scope-option-${option.kind}`}>
                            <label className="scope-option-main">
                              <input
                                type="checkbox"
                                checked={consent.scopeSelections[option.scope] ?? false}
                                onChange={(event) =>
                                  setConsent((current) =>
                                    current
                                      ? {
                                          ...current,
                                          scopeSelections: {
                                            ...current.scopeSelections,
                                            [option.scope]: event.target.checked,
                                          },
                                        }
                                      : current,
                                  )
                                }
                              />
                              <div className="scope-option-body">
                                <div className="scope-option-topline">
                                  <span className="scope-option-title">{option.label}</span>
                                  {option.kind === "resource" && (
                                    <span className="scope-option-metric">
                                      {currentPerson.resourceCounts[option.resourceType] ?? 0} loaded
                                    </span>
                                  )}
                                </div>
                                {option.description && <span className="scope-option-copy">{option.description}</span>}
                              </div>
                            </label>
                            <details className="scope-option-details">
                              <summary className="scope-details-toggle" aria-label={`Show scope syntax for ${option.label}`} title="Show SMART scope syntax">
                                i
                              </summary>
                              <div className="scope-details-panel">
                                <span className="subtle">SMART scope syntax</span>
                                <code className="scope-option-code">{option.scope}</code>
                              </div>
                            </details>
                          </div>
                        ))}
                      </div>
                    </section>
                  ))}
                </div>
              </>
            )}
          </div>

          <div className={`wizard-section wizard-section-sites${locationIssue ? " invalid" : ""}`}>
            <div className="wizard-section-header">
              <div>
                <p className="eyebrow">Sites</p>
                <h4>Which sites may respond?</h4>
              </div>
              <div className="choice-grid choice-grid-three">
                <button
                  type="button"
                  className={`choice-button${consent.locationMode === "all" ? " active" : ""}`}
                  onClick={() => setConsent((current) => (current ? { ...current, locationMode: "all" } : current))}
                >
                  All sites
                </button>
                <button
                  type="button"
                  className={`choice-button${consent.locationMode === "states" ? " active" : ""}${consent.locationMode === "states" && locationIssue ? " invalid" : ""}`}
                  onClick={() => setConsent((current) => (current ? { ...current, locationMode: "states" } : current))}
                >
                  Limit by state
                </button>
                <button
                  type="button"
                  className={`choice-button${consent.locationMode === "organizations" ? " active" : ""}${consent.locationMode === "organizations" && locationIssue ? " invalid" : ""}`}
                  onClick={() => setConsent((current) => (current ? { ...current, locationMode: "organizations" } : current))}
                >
                  Limit by organization
                </button>
              </div>
            </div>
            {consent.locationMode === "states" && (
              <div className="checkbox-list">
                {stateOptions.map((state) => {
                  const siteCount = currentPerson.sites.filter((site) => site.jurisdiction === state).length;
                  return (
                    <label key={state} className="check-chip">
                      <input
                        type="checkbox"
                        checked={consent.selectedStateCodes[state] ?? false}
                        onChange={(event) =>
                          setConsent((current) =>
                            current
                              ? {
                                  ...current,
                                  selectedStateCodes: {
                                    ...current.selectedStateCodes,
                                    [state]: event.target.checked,
                                  },
                                }
                              : current,
                          )
                        }
                      />
                      <span>{state}</span>
                      <span className="subtle">{siteCount} site{siteCount !== 1 && "s"}</span>
                    </label>
                  );
                })}
              </div>
            )}
            {consent.locationMode === "organizations" && (
              <div className="checkbox-list">
                {currentPerson.sites.map((site) => (
                  <label key={site.siteSlug} className="check-chip">
                    <input
                      type="checkbox"
                      checked={consent.selectedSiteSlugs[site.siteSlug] ?? false}
                      onChange={(event) =>
                        setConsent((current) =>
                          current
                            ? {
                                ...current,
                                selectedSiteSlugs: {
                                  ...current.selectedSiteSlugs,
                                  [site.siteSlug]: event.target.checked,
                                },
                              }
                            : current,
                        )
                      }
                    />
                    <span>{site.orgName}</span>
                    <span className="subtle">{site.jurisdiction ?? "?"}</span>
                  </label>
                ))}
              </div>
            )}
            {locationIssue && <p className="validation-hint">{locationIssue.message}</p>}
          </div>

          <div className={`wizard-section wizard-section-time${dateIssue ? " invalid" : ""}`}>
            <div className="wizard-section-header">
              <div>
                <p className="eyebrow">Time</p>
                <h4>Which generated-date window applies?</h4>
              </div>
              <div className="choice-grid">
                <button
                  type="button"
                  className={`choice-button${consent.dateMode === "all" ? " active" : ""}`}
                  onClick={() => setConsent((current) => (current ? { ...current, dateMode: "all" } : current))}
                >
                  All dates
                </button>
                <button
                  type="button"
                  className={`choice-button${consent.dateMode === "window" ? " active" : ""}${consent.dateMode === "window" && dateIssue ? " invalid" : ""}`}
                  onClick={() => setConsent((current) => (current ? { ...current, dateMode: "window" } : current))}
                >
                  Limit by generated date
                </button>
              </div>
            </div>
            {consent.dateMode === "window" && (
              <div className="field-row">
                <label className="field">
                  <span className="control-label">Generated start year</span>
                  <select
                    value={selectedStartYear}
                    onChange={(event) =>
                      setConsent((current) =>
                        current
                          ? { ...current, dateRange: { ...current.dateRange, start: event.target.value ? `${event.target.value}-01-01` : null } }
                          : current,
                      )
                    }
                  >
                    <option value="">Select year</option>
                    {generatedYears.map((year) => (
                      <option key={`start:${year}`} value={String(year)}>
                        {year}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="field">
                  <span className="control-label">Generated end year</span>
                  <select
                    value={selectedEndYear}
                    onChange={(event) =>
                      setConsent((current) =>
                        current
                          ? { ...current, dateRange: { ...current.dateRange, end: event.target.value ? `${event.target.value}-12-31` : null } }
                          : current,
                      )
                    }
                  >
                    <option value="">Select year</option>
                    {generatedYears.map((year) => (
                      <option key={`end:${year}`} value={String(year)}>
                        {year}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
            )}
            {dateIssue && <p className="validation-hint">{dateIssue.message}</p>}
          </div>

          <div className="wizard-section wizard-section-lifetime">
            <div className="wizard-section-header">
              <div>
                <p className="eyebrow">Ticket Lifetime</p>
                <h4>How long should this Permission Ticket last?</h4>
              </div>
              <div className="choice-grid choice-grid-lifetime">
                {lifetimeOptions.map((option) => (
                  <button
                    key={option.key}
                    type="button"
                    className={`choice-button${consent.ticketLifetime === option.key ? " active" : ""}`}
                    onClick={() => setConsent((current) => (current ? { ...current, ticketLifetime: option.key } : current))}
                  >
                    {option.label}
                  </button>
                ))}
              </div>
            </div>
          </div>

          <div className="wizard-section wizard-section-sensitive">
            <div className="wizard-section-header">
              <div>
                <p className="eyebrow">Sensitive Data</p>
                <h4>Should sensitive data be included?</h4>
              </div>
              <div className="choice-grid">
                <button
                  type="button"
                  className={`choice-button${consent.sensitiveMode === "deny" ? " active" : ""}`}
                  onClick={() => setConsent((current) => (current ? { ...current, sensitiveMode: "deny" } : current))}
                >
                  Deny sensitive
                </button>
                <button
                  type="button"
                  className={`choice-button${consent.sensitiveMode === "allow" ? " active" : ""}`}
                  onClick={() => setConsent((current) => (current ? { ...current, sensitiveMode: "allow" } : current))}
                >
                  Allow sensitive
                </button>
              </div>
            </div>
            <p className="subtle" style={{ marginTop: 8 }}>
              Sensitive labels currently cover reproductive health, HIV, mental health, ethnicity, STI, substance abuse, and sexual/domestic violence when present.
            </p>
          </div>
          </div>
        </section>
      </section>

      <section className="panel section ticket-launch-section">
        <section className="subpanel run-panel ticket-launch-panel">
          <p className="eyebrow">{showClientSelection ? "Step 4 · Launch App" : "Step 3 · Launch App"}</p>
          <h2>Review and launch</h2>
          <p className="subtle">
            This summary stays stable while you edit the ticket. The app opens in a new tab and performs the network and site exchanges there.
          </p>

          <div className="summary-grid">
            <div className="summary-card">
              <span className="summary-label">Client type</span>
              <strong>{selectedClientOption?.label ?? "Not selected"}</strong>
            </div>
            <div className="summary-card">
              <span className="summary-label">Registration</span>
              <strong>{selectedClientRegistration}</strong>
            </div>
            <div className="summary-card">
              <span className="summary-label">Ticket binding</span>
              <strong>{selectedBindingSummary}</strong>
            </div>
            <div className="summary-card">
              <span className="summary-label">Sites</span>
              <strong>{consentSummary.sites}</strong>
            </div>
            <div className="summary-card">
              <span className="summary-label">Data</span>
              <strong>{consentSummary.resources}</strong>
            </div>
            <div className="summary-card">
              <span className="summary-label">Dates</span>
              <strong>{consentSummary.dates}</strong>
            </div>
            <div className="summary-card">
              <span className="summary-label">Sensitive</span>
              <strong>{consentSummary.sensitive}</strong>
            </div>
            <div className="summary-card">
              <span className="summary-label">Ticket lifetime</span>
              <strong>{consentSummary.lifetime}</strong>
            </div>
          </div>

          <div className="button-row handoff-actions">
            <SplitAction
              primary={{
                label: running ? "Preparing…" : "Open health app ↗",
                onSelect: openHealthApp,
                disabled: !canRun || running,
              }}
              secondary={[
                {
                  label: "Copy app link",
                  onSelect: copyAppLink,
                  feedbackLabel: "Copied",
                  disabled: !canRun || running,
                },
                ...(mode !== "anonymous"
                  ? [
                      ...(selectedClientOption
                        ? [
                            {
                              label: "Open client plan ↗",
                              onSelect: openPreparedClientPlan,
                              disabled: !canRun || running,
                            },
                            {
                              label: "Open client story ↗",
                              onSelect: async () => {
                                if (!selectedClientStory) return;
                                openArtifact("Client Story", selectedClientStory);
                              },
                              disabled: !canRun || running,
                            },
                          ]
                        : []),
                      {
                        label: "Copy ticket JWT",
                        onSelect: copyTicketJwt,
                        feedbackLabel: "Copied",
                        disabled: !canRun || running,
                      },
                      {
                        label: "Open ticket JWT ↗",
                        onSelect: openTicketPayload,
                        disabled: !canRun || running,
                      },
                    ]
                  : []),
                {
                  label: "Open Protocol Trace ↗",
                  onSelect: openProtocolTrace,
                  disabled: !canRun || running,
                },
                {
                  label: "Open app handoff ↗",
                  onSelect: openAppHandoff,
                  disabled: !canRun || running,
                },
              ]}
            />
          </div>
          {!canRun && (
            <div className="validation-banner">
              <strong>Finish the ticket constraints to continue.</strong>
              <ul>
                {validationIssues.map((issue) => (
                  <li key={`${issue.section}:${issue.message}`}>{issue.message}</li>
                ))}
              </ul>
            </div>
          )}
          {error && <p className="error-text">{error}</p>}

        </section>
      </section>
    </>
  );
}
