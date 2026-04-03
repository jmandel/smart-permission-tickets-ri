import { useEffect, useRef, useState } from "react";

import {
  buildTicketPayload,
  buildViewerLaunch,
  buildViewerLaunchUrl,
  constrainedSites,
  createViewerClientBootstrap,
  defaultConsentState,
  scopeOptionsForPerson,
  summarizeConsent,
  validateConsent,
} from "../demo";
import type { ConsentState, ModeName, NetworkInfo, PersonInfo, TicketIssuerInfo, ViewerLaunch } from "../types";
import { buildArtifactViewerHref } from "../lib/artifact-viewer";
import { signPermissionTicket } from "../lib/ticket-client";
import { SplitAction } from "./SplitAction";

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
}: {
  person: PersonInfo | null;
  mode: ModeName;
  defaultTicketIssuer: TicketIssuerInfo | null;
  defaultNetwork: NetworkInfo | null;
}) {
  const [consent, setConsent] = useState<ConsentState | null>(null);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [artifacts, setArtifacts] = useState<ArtifactState | null>(null);
  const preparePromiseRef = useRef<Promise<ArtifactState | null> | null>(null);

  useEffect(() => {
    if (!person) {
      setConsent(null);
      setArtifacts(null);
      setError(null);
      preparePromiseRef.current = null;
      return;
    }
    setConsent(defaultConsentState(person));
    setArtifacts(null);
    setError(null);
    preparePromiseRef.current = null;
  }, [person?.personId]);

  useEffect(() => {
    if (!consent) return;
    setArtifacts(null);
    setError(null);
    preparePromiseRef.current = null;
  }, [consent, mode]);

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

  function openArtifact(title: string, content: unknown, copyText?: string, subtitle?: string) {
    const href = buildArtifactViewerHref({ title, content, copyText, subtitle });
    window.open(href, "_blank", "noopener,noreferrer");
  }

  async function buildArtifacts() {
    const needsBoundClient = mode === "strict" || mode === "registered" || mode === "key-bound";
    const clientBootstrap = needsBoundClient ? await createViewerClientBootstrap(currentPerson) : null;
    const proofJkt = mode === "strict" || mode === "key-bound" ? clientBootstrap?.jwkThumbprint ?? null : null;

    if (!defaultTicketIssuer) {
      throw new Error("No default Permission Ticket issuer is configured");
    }
    if (!defaultNetwork) {
      throw new Error("No default network is configured");
    }

    const ticketPayload = buildTicketPayload(defaultTicketIssuer.issuerBaseUrl, origin, currentPerson, currentConsent, { proofJkt });
    const signedTicket = (await signPermissionTicket(origin, defaultTicketIssuer, ticketPayload)).signedTicket;

    const viewerLaunch = buildViewerLaunch(
      origin,
      mode,
      currentPerson,
      defaultNetwork,
      defaultTicketIssuer,
      ticketPayload,
      signedTicket,
      proofJkt,
      clientBootstrap,
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
    if (!nextArtifacts?.ticketPayload) return;
    openArtifact("Permission Ticket Payload", nextArtifacts.ticketPayload);
  }

  async function openAppHandoff() {
    const nextArtifacts = await ensureArtifacts();
    if (!nextArtifacts) return;
    openArtifact("Viewer Handoff Payload", nextArtifacts.viewerLaunch, `${origin}${nextArtifacts.viewerUrl}`);
  }

  return (
    <>
      <section className="panel section">
        <div className="workbench-header">
          <div>
            <p className="eyebrow">Step 2 · Build Ticket</p>
            <h2>Decide which sites and data the app may request</h2>
            <p className="subtle workbench-copy">
              Start with sites and dates, then narrow resources only if needed.
            </p>
          </div>
        </div>

        <section className="subpanel ticket-constraints-panel">
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
                  <span className="control-label">Generated start</span>
                  <input
                    type="date"
                    value={consent.dateRange.start ?? ""}
                    onChange={(event) =>
                      setConsent((current) =>
                        current
                          ? { ...current, dateRange: { ...current.dateRange, start: event.target.value || null } }
                          : current,
                      )
                    }
                  />
                </label>
                <label className="field">
                  <span className="control-label">Generated end</span>
                  <input
                    type="date"
                    value={consent.dateRange.end ?? ""}
                    onChange={(event) =>
                      setConsent((current) =>
                        current
                          ? { ...current, dateRange: { ...current.dateRange, end: event.target.value || null } }
                          : current,
                      )
                    }
                  />
                </label>
              </div>
            )}
            {dateIssue && <p className="validation-hint">{dateIssue.message}</p>}
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
          <p className="eyebrow">Step 3 · Launch App</p>
          <h2>Review and launch</h2>
          <p className="subtle">
            This summary stays stable while you edit the ticket. The app opens in a new tab and performs the network and site exchanges there.
          </p>

          <div className="summary-grid">
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
                      {
                        label: "Copy ticket JWT",
                        onSelect: copyTicketJwt,
                        feedbackLabel: "Copied",
                        disabled: !canRun || running,
                      },
                      {
                        label: "Open ticket payload ↗",
                        onSelect: openTicketPayload,
                        disabled: !canRun || running,
                      },
                    ]
                  : []),
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
