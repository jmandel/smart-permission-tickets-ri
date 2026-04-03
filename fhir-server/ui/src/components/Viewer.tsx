import { useEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent } from "react";

import { buildFetchCurl, decodeJwtPayload } from "../demo";
import { fetchJson } from "../lib/viewer-client";
import { buildArtifactViewerHref, loadArtifactViewerPayload, renderArtifactText, type ArtifactViewerPayload } from "../lib/artifact-viewer";
import { SplitAction } from "./SplitAction";
import {
  addDaysUtc,
  buildEncounterDashboard,
  buildEncounterScale,
  diffDaysUtc,
  encounterIntersects,
  groupResourcesByType,
  type ViewerSiteRun,
} from "../lib/viewer-model";
import { useViewerStore } from "../lib/viewer-store";

type TimelineDragState = {
  mode: "start" | "end" | "window";
  originIndex: number;
  start: number;
  end: number;
};

export function Viewer() {
  const params = useMemo(() => new URLSearchParams(window.location.search), []);
  const session = params.get("session");
  const artifactKey = params.get("artifact_key");

  if (session) {
    return <ViewerApp encodedSession={session} />;
  }

  if (artifactKey) {
    return <ArtifactViewer artifactKey={artifactKey} />;
  }

  return (
    <main className="shell viewer-shell">
      <section className="panel section">
        <h2>Health App Viewer</h2>
        <p className="error-text">Missing viewer session or artifact payload.</p>
      </section>
    </main>
  );
}

function ViewerApp({ encodedSession }: { encodedSession: string }) {
  const launch = useViewerStore((state) => state.launch);
  const loading = useViewerStore((state) => state.loading);
  const error = useViewerStore((state) => state.error);
  const sharedClient = useViewerStore((state) => state.sharedClient);
  const networkSmartConfig = useViewerStore((state) => state.networkSmartConfig);
  const networkTokenResponse = useViewerStore((state) => state.networkTokenResponse);
  const networkTokenClaims = useViewerStore((state) => state.networkTokenClaims);
  const networkIntrospection = useViewerStore((state) => state.networkIntrospection);
  const networkRecordLocations = useViewerStore((state) => state.networkRecordLocations);
  const siteRuns = useViewerStore((state) => state.siteRuns);
  const queryPath = useViewerStore((state) => state.queryPath);
  const queryRunning = useViewerStore((state) => state.queryRunning);
  const queryResults = useViewerStore((state) => state.queryResults);
  const timelineStartIndex = useViewerStore((state) => state.timelineStartIndex);
  const timelineEndIndex = useViewerStore((state) => state.timelineEndIndex);
  const selectedEncounterKeys = useViewerStore((state) => state.selectedEncounterKeys);
  const initSession = useViewerStore((state) => state.initSession);
  const setQueryPath = useViewerStore((state) => state.setQueryPath);
  const runCrossSiteQuery = useViewerStore((state) => state.runCrossSiteQuery);
  const setTimelineWindow = useViewerStore((state) => state.setTimelineWindow);
  const setSelectedEncounterKeys = useViewerStore((state) => state.setSelectedEncounterKeys);
  const brushRef = useRef<HTMLDivElement | null>(null);
  const [dragState, setDragState] = useState<TimelineDragState | null>(null);

  useEffect(() => {
    void initSession(encodedSession);
  }, [encodedSession, initSession]);

  const aggregatedResources = useMemo(() => siteRuns.flatMap((run) => run.resources), [siteRuns]);
  const encounterDashboard = useMemo(() => buildEncounterDashboard(aggregatedResources), [aggregatedResources]);
  const timelineScale = useMemo(() => buildEncounterScale(encounterDashboard.encounters), [encounterDashboard.encounters]);
  const maxTimelineIndex = timelineScale ? Math.max(timelineScale.totalDays - 1, 0) : 0;
  const safeTimelineStartIndex = Math.min(timelineStartIndex, maxTimelineIndex);
  const safeTimelineEndIndex = Math.min(Math.max(timelineEndIndex, safeTimelineStartIndex), maxTimelineIndex);
  const timelineStart = timelineScale ? addDaysUtc(timelineScale.start, safeTimelineStartIndex) : "";
  const timelineEnd = timelineScale ? addDaysUtc(timelineScale.start, safeTimelineEndIndex) : "";
  const visibleEncounters = useMemo(
    () => encounterDashboard.encounters.filter((encounter) => encounterIntersects(encounter, timelineStart, timelineEnd)),
    [encounterDashboard.encounters, timelineStart, timelineEnd],
  );
  const visibleEncounterKeySet = useMemo(() => new Set(visibleEncounters.map((encounter) => encounter.key)), [visibleEncounters]);
  const effectiveSelectedEncounterKeys = useMemo(() => {
    const explicitVisible = selectedEncounterKeys.filter((key) => visibleEncounterKeySet.has(key));
    return explicitVisible.length > 0 ? explicitVisible : visibleEncounters.map((encounter) => encounter.key);
  }, [selectedEncounterKeys, visibleEncounterKeySet, visibleEncounters]);
  const selectedEncounters = useMemo(
    () => visibleEncounters.filter((encounter) => effectiveSelectedEncounterKeys.includes(encounter.key)),
    [effectiveSelectedEncounterKeys, visibleEncounters],
  );
  const selectedEncounterKeySet = useMemo(() => new Set(selectedEncounters.map((encounter) => encounter.key)), [selectedEncounters]);
  const selectedEncounterGroups = useMemo(
    () =>
      groupResourcesByType(
        selectedEncounters
          .flatMap((encounter) => encounter.resources)
          .filter((resource, index, items) => items.findIndex((candidate) => candidate.key === resource.key) === index)
          .filter((resource) => resource.resourceType !== "DocumentReference"),
      ),
    [selectedEncounters],
  );
  const selectedEncounterNotes = useMemo(
    () =>
      selectedEncounters
        .flatMap((encounter) => encounter.notes)
        .filter((resource, index, items) => items.findIndex((candidate) => candidate.key === resource.key) === index),
    [selectedEncounters],
  );
  const selectedEncounterResourceCount = useMemo(
    () => selectedEncounters.reduce((count, encounter) => count + encounter.resources.length, 0),
    [selectedEncounters],
  );
  const selectedEncounterSiteCount = useMemo(
    () => new Set(selectedEncounters.map((encounter) => encounter.siteSlug)).size,
    [selectedEncounters],
  );
  const selectedEncounterSiteSet = useMemo(
    () => new Set(selectedEncounters.map((encounter) => encounter.siteSlug)),
    [selectedEncounters],
  );
  const outsideEncounterGroups = useMemo(
    () =>
      groupResourcesByType(
        encounterDashboard.unassignedResources.filter((resource) => selectedEncounterSiteSet.has(resource.siteSlug)),
      ),
    [encounterDashboard.unassignedResources, selectedEncounterSiteSet],
  );
  const timelineTicks = useMemo(() => (timelineScale ? buildTimelineTicks(timelineScale) : []), [timelineScale]);
  const siteStyles = useMemo(
    () =>
      Object.fromEntries(
        siteRuns.map((run) => [run.site.siteSlug, buildSiteTone(run.site.siteSlug)]),
      ),
    [siteRuns],
  );
  const selectionLeft = maxTimelineIndex === 0 ? 0 : (safeTimelineStartIndex / maxTimelineIndex) * 100;
  const selectionRight = maxTimelineIndex === 0 ? 100 : (safeTimelineEndIndex / maxTimelineIndex) * 100;
  const selectionWidth = Math.max(selectionRight - selectionLeft, 1.5);

  const handleToggleEncounterSelection = (encounterKey: string) => {
    // If the encounter is outside the visible window, expand the window to include it
    if (timelineScale) {
      const encounter = encounterDashboard.encounters.find((e) => e.key === encounterKey);
      if (encounter && !encounterIntersects(encounter, timelineStart, timelineEnd)) {
        const encStart = (encounter.startDate ?? encounter.endDate ?? "").slice(0, 10);
        const encEnd = (encounter.endDate ?? encounter.startDate ?? encStart).slice(0, 10);
        if (encStart) {
          const encStartIndex = diffDaysUtc(timelineScale.start, encStart);
          const encEndIndex = diffDaysUtc(timelineScale.start, encEnd);
          const newStart = Math.min(safeTimelineStartIndex, encStartIndex);
          const newEnd = Math.max(safeTimelineEndIndex, encEndIndex);
          setTimelineWindow(newStart, newEnd);
        }
        // Add to selection after expanding
        setSelectedEncounterKeys([...effectiveSelectedEncounterKeys, encounterKey]);
        return;
      }
    }
    const nextSelectedKeys = effectiveSelectedEncounterKeys.includes(encounterKey)
      ? effectiveSelectedEncounterKeys.filter((key) => key !== encounterKey)
      : [...effectiveSelectedEncounterKeys, encounterKey];
    setSelectedEncounterKeys(nextSelectedKeys);
  };

  const handleEncounterCardKeyDown = (event: ReactKeyboardEvent<HTMLElement>, encounterKey: string) => {
    if (event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    handleToggleEncounterSelection(encounterKey);
  };

  const selectAllVisibleEncounters = () => {
    setSelectedEncounterKeys(visibleEncounters.map((encounter) => encounter.key));
  };

  useEffect(() => {
    if (!dragState) return;
    const clampIndex = (value: number) => Math.max(0, Math.min(maxTimelineIndex, value));
    const clientXToIndex = (clientX: number) => {
      if (!brushRef.current || maxTimelineIndex === 0) return 0;
      const rect = brushRef.current.getBoundingClientRect();
      const ratio = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
      return clampIndex(Math.round(ratio * maxTimelineIndex));
    };

    const handlePointerMove = (event: PointerEvent) => {
      const nextIndex = clientXToIndex(event.clientX);
      if (dragState.mode === "start") {
        setTimelineWindow(Math.min(nextIndex, dragState.end), dragState.end);
        return;
      }
      if (dragState.mode === "end") {
        setTimelineWindow(dragState.start, Math.max(nextIndex, dragState.start));
        return;
      }
      const width = dragState.end - dragState.start;
      const delta = nextIndex - dragState.originIndex;
      const maxStart = Math.max(maxTimelineIndex - width, 0);
      const nextStart = Math.max(0, Math.min(maxStart, dragState.start + delta));
      setTimelineWindow(nextStart, nextStart + width);
    };

    const handlePointerUp = () => {
      setDragState(null);
    };

    window.addEventListener("pointermove", handlePointerMove);
    window.addEventListener("pointerup", handlePointerUp);
    return () => {
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", handlePointerUp);
    };
  }, [dragState, maxTimelineIndex, setTimelineWindow]);

  const beginBrushDrag = (mode: TimelineDragState["mode"]) => (event: ReactPointerEvent<HTMLButtonElement | HTMLDivElement>) => {
    if (!timelineScale) return;
    if (maxTimelineIndex <= 0) return;
    if (!brushRef.current) return;
    const rect = brushRef.current.getBoundingClientRect();
    const ratio = Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width));
    const originIndex = Math.round(ratio * maxTimelineIndex);
    setDragState({
      mode,
      originIndex,
      start: safeTimelineStartIndex,
      end: safeTimelineEndIndex,
    });
  };

  if (!launch && loading) {
    return (
      <main className="shell viewer-shell">
        <section className="panel section">
          <h2>Health App Viewer</h2>
          <p className="subtle">Loading viewer session…</p>
        </section>
      </main>
    );
  }

  if (!launch) {
    return (
      <main className="shell viewer-shell">
        <section className="panel section">
          <h2>Health App Viewer</h2>
          <p className="error-text">{error ?? "Invalid session payload."}</p>
        </section>
      </main>
    );
  }

  return (
    <main className="shell viewer-shell">
      <section className="panel section">
        <div className="section-header">
          <div>
            <p className="eyebrow">Health App</p>
            <h2>{launch.person.displayName}</h2>
            <p className="subtle viewer-target">
              One signed ticket, {siteRuns.length} connected site{siteRuns.length !== 1 && "s"}, and a site-by-site token exchange trail.
            </p>
          </div>
          <div className="button-row">
            <button type="button" className="button" onClick={() => void navigator.clipboard.writeText(window.location.href)}>
              Copy app link
            </button>
            <button type="button" className="button" onClick={() => window.location.reload()}>
              Reload app
            </button>
          </div>
        </div>

        <div className="summary-grid">
          <div className="summary-card">
            <span className="summary-label">Connected sites</span>
            <strong>{siteRuns.length}</strong>
          </div>
          <div className="summary-card">
            <span className="summary-label">Resources loaded</span>
            <strong>{aggregatedResources.length}</strong>
          </div>
          <div className="summary-card">
            <span className="summary-label">Client registration</span>
            <strong>{sharedClient ? sharedClient.clientName : launch.mode === "anonymous" || launch.mode === "open" ? "Not required" : "Pending"}</strong>
          </div>
          <div className="summary-card">
            <span className="summary-label">Access flow</span>
            <strong>{launch.mode === "anonymous" ? "Preview links only" : "Per-site token exchange"}</strong>
          </div>
        </div>

        {launch.person.summary && (
          <section className="subpanel viewer-section">
            <h3>Patient Context</h3>
            <div className="viewer-copy-block">
              {renderSummaryParagraphs(launch.person.summary)}
            </div>
          </section>
        )}

        <section className="subpanel viewer-section">
          <h3>Sites</h3>
          {error && <p className="error-text">{error}</p>}
          <div className="site-session-grid">
            {siteRuns.map((run) => {
              const patientId = run.patientId ?? run.tokenClaims?.patient ?? run.site.patientId ?? null;
              const previewTarget = patientId
                ? `${launch.origin}${run.site.authSurface.previewFhirBasePath}/Patient/${patientId}`
                : null;
              const tone = siteStyles[run.site.siteSlug];
              return (
                <article key={run.site.siteSlug} className="site-session-card" style={siteCardStyle(tone)}>
                  <div className="site-session-head">
                    <div className="site-session-title">
                      <div className="site-session-heading-row">
                        <span className="site-color-dot" style={{ background: tone.solid }} aria-hidden="true" />
                        <h4>{run.site.orgName}</h4>
                      </div>
                      <div className="site-session-meta-row">
                        <span className="state-pill">{run.site.jurisdiction || "No state"}</span>
                      </div>
                    </div>
                    <div className="site-session-toolbar">
                      <span className={`session-phase session-phase-${run.phase}`}>{humanizePhase(run.phase)}</span>
                      <SplitAction
                        primary={{
                          label: "Open",
                          onSelect: previewTarget
                            ? () =>
                                void inspectRemoteArtifact({
                                  title: `${run.site.orgName} preview patient`,
                                  subtitle: run.site.authSurface.previewFhirBasePath,
                                  targetUrl: previewTarget,
                                  metadata: buildInspectionMetadata({
                                    url: previewTarget,
                                    curl: buildFetchCurl(previewTarget),
                                  }),
                                })
                            : undefined,
                          disabled: !previewTarget,
                        }}
                        secondary={[
                          {
                            label: "Copy preview curl",
                            onSelect: () => previewTarget ? void navigator.clipboard.writeText(buildFetchCurl(previewTarget)) : undefined,
                            feedbackLabel: "Copied",
                          },
                          ...(run.tokenResponse?.access_token
                            ? [
                                {
                                  label: "Copy token",
                                  onSelect: () => void navigator.clipboard.writeText(run.tokenResponse!.access_token),
                                  feedbackLabel: "Copied",
                                },
                              ]
                            : []),
                        ]}
                      />
                    </div>
                  </div>
                  <div className="site-session-stats">
                    <div className="site-session-stat">
                      <span className="summary-label">Loaded</span>
                      <strong>{run.resources.length}</strong>
                    </div>
                    <div className="site-session-stat">
                      <span className="summary-label">Skipped</span>
                      <strong>{run.queryErrors.length}</strong>
                    </div>
                  </div>
                  <details className="site-session-technical">
                    <summary>Technical details</summary>
                    <dl className="mini-definition-list site-session-details">
                      <div>
                        <dt>FHIR base</dt>
                        <dd className="mini-definition-value mono-value truncate-value" title={run.site.authSurface.fhirBasePath}>
                          {compactDisplayValue(run.site.authSurface.fhirBasePath, 18, 10)}
                        </dd>
                      </div>
                      <div>
                        <dt>Token endpoint</dt>
                        <dd className="mini-definition-value mono-value truncate-value" title={run.site.authSurface.tokenPath}>
                          {compactDisplayValue(run.site.authSurface.tokenPath, 18, 10)}
                        </dd>
                      </div>
                      <div>
                        <dt>Patient ID</dt>
                        <dd className="mini-definition-value mono-value truncate-value" title={`Patient/${patientId}`}>
                          {patientId ? compactDisplayValue(patientId, 8, 8) : "Unavailable"}
                        </dd>
                      </div>
                    </dl>
                  </details>
                  {run.queryErrors.length > 0 && (
                    <details className="site-query-errors">
                      <summary>Skipped or failed queries</summary>
                      <ul>
                        {run.queryErrors.map((item) => (
                          <li key={`${item.relativePath}:${item.message}`}>
                            <strong>{item.label}</strong>: {item.message}
                          </li>
                        ))}
                      </ul>
                    </details>
                  )}
                  {run.error && <p className="error-text">{run.error}</p>}
                </article>
              );
            })}
          </div>
        </section>

        <section className="subpanel viewer-section">
          <h3>Authorization Artifacts</h3>
          <p className="subtle">Inspect the network-level authorization flow first, then the site-by-site exchanges that follow from it.</p>
          <div className="artifact-toolbar">
            {launch.signedTicket && (
              <SplitAction
                primary={{
                  label: "Ticket",
                  onSelect: () => {
                    const signedTicket = launch.signedTicket!;
                    openArtifactViewer({
                      title: "Signed Ticket JWT",
                      content: {
                        signedTicket,
                        claims: decodeJwtPayload(signedTicket),
                      },
                      copyText: signedTicket,
                    });
                  },
                }}
                secondary={[
                  ...(launch.ticketPayload
                    ? [
                        {
                          label: "Open payload ↗",
                          onSelect: () => openArtifactViewer({ title: "Permission Ticket Payload", content: launch.ticketPayload }),
                        },
                      ]
                    : []),
                  {
                    label: "Copy ticket",
                    onSelect: () => void navigator.clipboard.writeText(launch.signedTicket!),
                    feedbackLabel: "Copied",
                  },
                ]}
              />
            )}
            {sharedClient && (
              <SplitAction
                primary={{
                  label: "Client",
                  onSelect: () => openArtifactViewer({ title: "Viewer Client Registration", content: sharedClient }),
                }}
                secondary={[
                  {
                    label: "Copy client JSON",
                    onSelect: () => void navigator.clipboard.writeText(JSON.stringify(sharedClient, null, 2)),
                    feedbackLabel: "Copied",
                  },
                ]}
              />
            )}
          </div>
          <div className="artifact-matrix-wrap">
            <table className="compact-table artifact-matrix">
              <thead>
                <tr>
                  <th>Site</th>
                  <th>SMART discovery</th>
                  <th>Token response</th>
                  <th>Introspection</th>
                  <th>Access token</th>
                  <th>Patient / RLS</th>
                </tr>
              </thead>
              <tbody>
                <tr className="artifact-band-row">
                  <th colSpan={6}>Network-level RLS</th>
                </tr>
                <tr>
                  <td>
                    <div className="artifact-site-cell artifact-network-cell">
                      <strong>{launch.network.name}</strong>
                      <span className="subtle mono-value">{launch.network.authSurface.fhirBasePath}</span>
                    </div>
                  </td>
                  <td>
                    {renderArtifactCell(
                      "Network SMART Discovery",
                      networkSmartConfig,
                      networkSmartConfig
                        ? {
                            metadata: buildInspectionMetadata({
                              url: `${launch.origin}${launch.network.authSurface.smartConfigPath}`,
                              curl: buildFetchCurl(`${launch.origin}${launch.network.authSurface.smartConfigPath}`),
                            }),
                          }
                        : undefined,
                    )}
                  </td>
                  <td>{renderArtifactCell("Network Token Response", networkTokenResponse)}</td>
                  <td>{renderArtifactCell("Network Introspection", networkIntrospection)}</td>
                  <td>
                    {networkTokenResponse?.access_token ? (
                      <SplitAction
                        primary={{
                          label: "Open",
                          onSelect: () =>
                            openArtifactViewer({
                              title: "Network Access Token",
                              subtitle: launch.network.authSurface.tokenPath,
                              content: {
                                access_token: networkTokenResponse.access_token,
                                claims: networkTokenClaims,
                              },
                              copyText: networkTokenResponse.access_token,
                            }),
                        }}
                        secondary={[
                          {
                            label: "Copy token",
                            onSelect: () => void navigator.clipboard.writeText(networkTokenResponse.access_token),
                            feedbackLabel: "Copied",
                          },
                        ]}
                      />
                    ) : (
                      <span className="subtle">Not issued</span>
                    )}
                  </td>
                  <td>
                    {renderArtifactCell(
                      "Record Location Resolution",
                      networkRecordLocations,
                      networkTokenResponse?.access_token
                        ? {
                            label: "RLS result",
                            metadata: buildInspectionMetadata({
                              url: `${launch.origin}${launch.network.authSurface.fhirBasePath}/$resolve-record-locations`,
                              curl: buildPostJsonCurl(
                                `${launch.origin}${launch.network.authSurface.fhirBasePath}/$resolve-record-locations`,
                                { resourceType: "Parameters" },
                                networkTokenResponse.access_token,
                                launch.proofJkt,
                              ),
                            }),
                          }
                        : undefined,
                    )}
                  </td>
                </tr>
                <tr className="artifact-band-row">
                  <th colSpan={6}>Site-level access</th>
                </tr>
                {siteRuns.map((run) => (
                  <tr key={`${run.site.siteSlug}-artifact-row`}>
                    <td>
                      <div className="artifact-site-cell">
                        <strong>{run.site.orgName}</strong>
                        <span className="state-pill">{run.site.jurisdiction || "No state"}</span>
                      </div>
                    </td>
                    <td>{renderArtifactCell(`SMART discovery · ${run.site.orgName}`, run.smartConfig)}</td>
                    <td>{renderArtifactCell(`Token response · ${run.site.orgName}`, run.tokenResponse)}</td>
                    <td>{renderArtifactCell(`Introspection · ${run.site.orgName}`, run.introspection)}</td>
                    <td>
                      {run.tokenResponse?.access_token ? (
                        <SplitAction
                          primary={{
                            label: "Open",
                            onSelect: () =>
                              openArtifactViewer({
                                title: `Access token · ${run.site.orgName}`,
                                subtitle: run.site.authSurface.tokenPath,
                                content: {
                                  access_token: run.tokenResponse?.access_token,
                                  claims: run.tokenClaims,
                                },
                                copyText: run.tokenResponse?.access_token,
                              }),
                          }}
                          secondary={[
                            {
                              label: "Copy token",
                              onSelect: () => void navigator.clipboard.writeText(run.tokenResponse!.access_token),
                              feedbackLabel: "Copied",
                            },
                          ]}
                        />
                      ) : (
                        <span className="subtle">Not issued</span>
                      )}
                    </td>
                    <td>
                      <SplitAction
                          primary={{
                            label: "Patient",
                            onSelect: run.patientId
                              ? () => {
                                  const previewUrl = `${launch.origin}${run.site.authSurface.previewFhirBasePath}/Patient/${run.patientId}`;
                                  return void inspectRemoteArtifact({
                                    title: `${run.site.orgName} preview patient`,
                                    subtitle: run.site.authSurface.previewFhirBasePath,
                                    targetUrl: previewUrl,
                                    metadata: buildInspectionMetadata({
                                      url: previewUrl,
                                      curl: buildFetchCurl(previewUrl),
                                    }),
                                  });
                                }
                              : undefined,
                            disabled: !run.patientId,
                          }}
                          secondary={[
                            {
                              label: "Copy preview curl",
                              onSelect: () =>
                                run.patientId
                                  ? void navigator.clipboard.writeText(
                                      buildFetchCurl(`${launch.origin}${run.site.authSurface.previewFhirBasePath}/Patient/${run.patientId}`),
                                    )
                                  : undefined,
                              feedbackLabel: "Copied",
                            },
                        ]}
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>

        <section className="subpanel viewer-section">
          <h3>Encounter Timeline</h3>
          <p className="subtle">Browse encounters across sites, drag the window to focus on a period, and inspect each encounter with its linked notes and resources.</p>
          {timelineScale ? (
            <>
              <div className="timeline-range-card">
                <div className="timeline-range-header">
                  <div>
                    <span className="summary-label">Window</span>
                    <strong>{formatTimelineWindow(timelineStart, timelineEnd)}</strong>
                  </div>
                  <div className="subtle">
                    {visibleEncounters.length} encounter{visibleEncounters.length !== 1 && "s"} visible · {encounterDashboard.encounters.length} total
                  </div>
                </div>
                <div className="timeline-overview">
                  <div className="timeline-overview-shell">
                    <div className="timeline-overview-label-column">
                      {encounterDashboard.lanes.map((lane) => {
                        const visibleCount = visibleEncounters.filter((encounter) => encounter.siteSlug === lane.siteSlug).length;
                        const tone = siteStyles[lane.siteSlug];
                        return (
                          <div key={`${lane.siteSlug}:label`} className="timeline-overview-label">
                            <div className="timeline-lane-heading">
                              <span className="site-color-dot" style={{ background: tone.solid }} aria-hidden="true" />
                              <strong>{lane.siteName}</strong>
                              {lane.siteJurisdiction && <span className="state-pill">{lane.siteJurisdiction}</span>}
                            </div>
                            <span className="timeline-count-badge">{visibleCount}</span>
                          </div>
                        );
                      })}
                    </div>
                    <div className="timeline-overview-track" ref={brushRef}>
                      <div className="timeline-overview-mask" style={{ width: `${selectionLeft}%` }} />
                      <div
                        className="timeline-overview-selection"
                        style={{
                          left: `${selectionLeft}%`,
                          width: `${selectionWidth}%`,
                        }}
                        onPointerDown={beginBrushDrag("window")}
                      />
                      <div
                        className="timeline-overview-mask timeline-overview-mask-right"
                        style={{ width: `${Math.max(100 - selectionRight, 0)}%` }}
                      />
                      {encounterDashboard.lanes.map((lane) => (
                        <div key={`${lane.siteSlug}:overview`} className="timeline-overview-row">
                          <div className="timeline-overview-rail" />
                          {lane.encounters.map((encounter) => {
                            const position = encounterBarPosition(encounter, timelineScale);
                            const tone = siteStyles[encounter.siteSlug];
                            return (
                              <button
                                key={`${encounter.key}:overview`}
                                type="button"
                                className={`timeline-overview-event${selectedEncounterKeySet.has(encounter.key) ? " active" : ""}`}
                                style={{
                                  left: `${position.left}%`,
                                  width: `${Math.max(position.width, 1.2)}%`,
                                  ...siteEventStyle(tone, selectedEncounterKeySet.has(encounter.key)),
                                }}
                                onClick={() => handleToggleEncounterSelection(encounter.key)}
                                title={`${encounter.siteName} · ${encounter.title}`}
                              />
                            );
                          })}
                        </div>
                      ))}
                      <button
                        type="button"
                        className="timeline-overview-handle timeline-overview-handle-start"
                        style={{ left: `${selectionLeft}%` }}
                        onPointerDown={beginBrushDrag("start")}
                        aria-label="Adjust timeline start"
                      />
                      <button
                        type="button"
                        className="timeline-overview-handle timeline-overview-handle-end"
                        style={{ left: `${selectionRight}%` }}
                        onPointerDown={beginBrushDrag("end")}
                        aria-label="Adjust timeline end"
                      />
                    </div>
                  </div>
                  <div className="timeline-scale-shell">
                    <div />
                    <div className="timeline-scale-labels">
                      {timelineTicks.map((tick) => (
                        <span key={`${tick.left}:${tick.label}`} style={{ left: `${tick.left}%` }}>
                          {tick.label}
                        </span>
                      ))}
                    </div>
                  </div>
                </div>
              </div>

              <div className="encounter-detail-grid">
                <section className="encounter-detail-card">
                  <div className="section-header">
                    <div>
                      <h4>Encounters in window</h4>
                      <p className="subtle">
                        Click encounter cards or timeline pills to include or exclude them from the resource pane.
                      </p>
                    </div>
                    {visibleEncounters.length > 0 && (
                      <button
                        type="button"
                        className="button mini"
                        onClick={selectAllVisibleEncounters}
                        disabled={selectedEncounters.length === visibleEncounters.length}
                      >
                        Use all visible
                      </button>
                    )}
                  </div>
                  {visibleEncounters.length > 0 ? (
                    <div className="encounter-selection-list">
                      {visibleEncounters.map((encounter) => {
                        const isSelected = selectedEncounterKeySet.has(encounter.key);
                        const tone = siteStyles[encounter.siteSlug];
                        return (
                          <article
                            key={encounter.key}
                            className={`encounter-selection-card${isSelected ? " active" : ""}`}
                            style={siteCardStyle(tone)}
                            role="button"
                            tabIndex={0}
                            aria-pressed={isSelected}
                            onClick={() => handleToggleEncounterSelection(encounter.key)}
                            onKeyDown={(event) => handleEncounterCardKeyDown(event, encounter.key)}
                          >
                            <div className={`encounter-selection-state${isSelected ? " active" : ""}`}>
                              {isSelected ? "Included" : "Excluded"}
                            </div>
                            {encounter.fullUrl && (
                              <div
                                className="encounter-selection-actions"
                                onClick={(event) => event.stopPropagation()}
                                onKeyDown={(event) => event.stopPropagation()}
                              >
                                <SplitAction
                                  primary={{
                                    label: "Inspect",
                                            onSelect: () =>
                                              void inspectRemoteArtifact({
                                                title: `${encounter.siteName} encounter`,
                                                subtitle: `${encounter.encounter.resourceType}/${encounter.encounter.id}`,
                                                targetUrl: encounter.fullUrl!,
                                                accessToken: accessTokenForSite(siteRuns, encounter.siteSlug),
                                                proofJkt: proofForSite(siteRuns, encounter.siteSlug),
                                                metadata: buildInspectionMetadata({
                                                  url: encounter.fullUrl!,
                                                  curl: buildFetchCurl(
                                                    encounter.fullUrl!,
                                                    accessTokenForSite(siteRuns, encounter.siteSlug),
                                                    proofForSite(siteRuns, encounter.siteSlug),
                                                  ),
                                                }),
                                              }),
                                          }}
                                  secondary={[
                                    {
                                      label: "Copy curl",
                                      onSelect: () =>
                                        void navigator.clipboard.writeText(
                                          buildFetchCurl(
                                            encounter.fullUrl!,
                                            accessTokenForSite(siteRuns, encounter.siteSlug),
                                            proofForSite(siteRuns, encounter.siteSlug),
                                          ),
                                        ),
                                      feedbackLabel: "Copied",
                                    },
                                  ]}
                                />
                              </div>
                            )}
                            <div className="encounter-selection-main">
                              <div className="encounter-selection-topline">
                                <div className="encounter-selection-heading">
                                  <strong>{encounter.title}</strong>
                                  {encounter.siteJurisdiction && <span className="state-pill">{encounter.siteJurisdiction}</span>}
                                </div>
                              </div>
                              <p className="subtle">
                                {encounter.siteName} · {formatTimelineWindow(encounter.startDate ?? "", encounter.endDate ?? "")}
                              </p>
                              <div className="encounter-selection-metrics">
                                <span>{encounter.resources.length} resources</span>
                                <span>{encounter.notes.length} note{encounter.notes.length === 1 ? "" : "s"}</span>
                              </div>
                              {encounter.summary && <p className="subtle encounter-selection-summary">{encounter.summary}</p>}
                            </div>
                          </article>
                        );
                      })}
                    </div>
                  ) : (
                    <p className="subtle">No encounters fall inside the selected window.</p>
                  )}
                </section>

                <section className="encounter-detail-card">
                  <div className="section-header">
                    <div>
                      <h4>Resources from selected encounters</h4>
                      <p className="subtle">
                        {selectedEncounters.length} encounter{selectedEncounters.length !== 1 && "s"} selected across {selectedEncounterSiteCount} site{selectedEncounterSiteCount !== 1 && "s"}.
                      </p>
                    </div>
                  </div>
                  {selectedEncounters.length > 0 ? (
                    <>
                      <div className="encounter-detail-stats">
                        <div className="summary-card">
                          <span className="summary-label">Selected encounters</span>
                          <strong>{selectedEncounters.length}</strong>
                        </div>
                        <div className="summary-card">
                          <span className="summary-label">Linked resources</span>
                          <strong>{selectedEncounterResourceCount}</strong>
                        </div>
                        <div className="summary-card">
                          <span className="summary-label">Notes</span>
                          <strong>{selectedEncounterNotes.length}</strong>
                        </div>
                        <div className="summary-card">
                          <span className="summary-label">Sites represented</span>
                          <strong>{selectedEncounterSiteCount}</strong>
                        </div>
                      </div>
                    </>
                  ) : null}
                  {selectedEncounters.length > 0 ? (
                    selectedEncounterNotes.length > 0 || selectedEncounterGroups.length > 0 ? (
                      <div className="encounter-resource-groups">
                        {selectedEncounterNotes.length > 0 && (
                          <details className="resource-group" open>
                            <summary>
                              <span>DocumentReference</span>
                              <span className="subtle">{selectedEncounterNotes.length}</span>
                            </summary>
                            <div className="result-list">
                              {selectedEncounterNotes.map((note) => (
                                <article key={note.key} className="result-item" style={siteListItemStyle(siteStyles[note.siteSlug])}>
                                  <div>
                                    <h4>{note.label}</h4>
                                    {note.sublabel && <p className="subtle">{note.sublabel}</p>}
                                  </div>
                                  <div className="result-meta">
                                    <span>{note.resourceType}/{note.id}</span>
                                    <div className="result-actions">
                                      {note.fullUrl && (
                                        <SplitAction
                                          primary={{
                                            label: "Inspect",
                                            onSelect: () =>
                                              void inspectRemoteArtifact({
                                                title: `${note.resourceType} ${note.id}`,
                                                subtitle: note.siteName,
                                                targetUrl: note.fullUrl!,
                                                accessToken: accessTokenForSite(siteRuns, note.siteSlug),
                                                proofJkt: proofForSite(siteRuns, note.siteSlug),
                                                metadata: buildInspectionMetadata({
                                                  url: note.fullUrl!,
                                                  curl: buildFetchCurl(
                                                    note.fullUrl!,
                                                    accessTokenForSite(siteRuns, note.siteSlug),
                                                    proofForSite(siteRuns, note.siteSlug),
                                                  ),
                                                }),
                                              }),
                                          }}
                                          secondary={[
                                            {
                                              label: "Copy curl",
                                              onSelect: () =>
                                                void navigator.clipboard.writeText(
                                                  buildFetchCurl(
                                                    note.fullUrl!,
                                                    accessTokenForSite(siteRuns, note.siteSlug),
                                                    proofForSite(siteRuns, note.siteSlug),
                                                  ),
                                                ),
                                              feedbackLabel: "Copied",
                                            },
                                          ]}
                                        />
                                      )}
                                    </div>
                                  </div>
                                </article>
                              ))}
                            </div>
                          </details>
                        )}
                        {selectedEncounterGroups.map((group) => (
                          <details key={`selected:${group.resourceType}`} className="resource-group" open>
                            <summary>
                              <span>{group.resourceType}</span>
                              <span className="subtle">{group.count}</span>
                            </summary>
                            <div className="result-list">
                              {group.items.map((item) => (
                                <article key={item.key} className="result-item" style={siteListItemStyle(siteStyles[item.siteSlug])}>
                                  <div>
                                    <h4>{item.label}</h4>
                                    {item.sublabel && <p className="subtle">{item.sublabel}</p>}
                                  </div>
                                  <div className="result-meta">
                                    <span>{item.resourceType}/{item.id}</span>
                                    <div className="result-actions">
                                      {item.fullUrl && (
                                        <SplitAction
                                          primary={{
                                            label: "Open",
                                            onSelect: () =>
                                              void inspectRemoteArtifact({
                                                title: `${item.resourceType} ${item.id}`,
                                                subtitle: item.siteName,
                                                targetUrl: item.fullUrl!,
                                                accessToken: accessTokenForSite(siteRuns, item.siteSlug),
                                                proofJkt: proofForSite(siteRuns, item.siteSlug),
                                                metadata: buildInspectionMetadata({
                                                  url: item.fullUrl!,
                                                  curl: buildFetchCurl(
                                                    item.fullUrl!,
                                                    accessTokenForSite(siteRuns, item.siteSlug),
                                                    proofForSite(siteRuns, item.siteSlug),
                                                  ),
                                                }),
                                              }),
                                          }}
                                          secondary={[
                                            {
                                              label: "Copy curl",
                                              onSelect: () =>
                                                void navigator.clipboard.writeText(
                                                  buildFetchCurl(
                                                    item.fullUrl!,
                                                    accessTokenForSite(siteRuns, item.siteSlug),
                                                    proofForSite(siteRuns, item.siteSlug),
                                                  ),
                                                ),
                                              feedbackLabel: "Copied",
                                            },
                                          ]}
                                        />
                                      )}
                                    </div>
                                  </div>
                                </article>
                              ))}
                            </div>
                          </details>
                        ))}
                      </div>
                    ) : (
                      <p className="subtle">No linked non-note resources were loaded for the selected encounters.</p>
                    )
                  ) : (
                    <p className="subtle">No encounters are currently selected.</p>
                  )}
                </section>
              </div>
            </>
          ) : (
            <p className="subtle">No encounter timeline is available yet.</p>
          )}
        </section>

        <section className="subpanel viewer-section">
          <h3>Outside Encounter Context</h3>
          <p className="subtle">Longitudinal resources without an encounter link are grouped here for the sites currently represented in your encounter selection.</p>
          <div className="resource-library">
            {outsideEncounterGroups.map((group) => (
              <details key={group.resourceType} className="resource-group">
                <summary>
                  <span>{group.resourceType}</span>
                  <span className="subtle">{group.count}</span>
                </summary>
                <div className="result-list">
                  {group.items.map((item) => (
                    <article key={item.key} className="result-item" style={siteListItemStyle(siteStyles[item.siteSlug])}>
                      <div>
                        <h4>{item.label}</h4>
                        <p className="subtle">{item.sublabel}</p>
                      </div>
                      <div className="result-meta">
                        <span>{item.resourceType}/{item.id}</span>
                        <span>{item.siteName}</span>
                        <div className="result-actions">
                          {item.fullUrl && (
                            <SplitAction
                              primary={{
                                label: "Open",
                                onSelect: () =>
                                  void inspectRemoteArtifact({
                                    title: `${item.resourceType} ${item.id}`,
                                    subtitle: item.siteName,
                                    targetUrl: item.fullUrl!,
                                    accessToken: accessTokenForSite(siteRuns, item.siteSlug),
                                    proofJkt: proofForSite(siteRuns, item.siteSlug),
                                    metadata: buildInspectionMetadata({
                                      url: item.fullUrl!,
                                      curl: buildFetchCurl(
                                        item.fullUrl!,
                                        accessTokenForSite(siteRuns, item.siteSlug),
                                        proofForSite(siteRuns, item.siteSlug),
                                      ),
                                    }),
                                  }),
                              }}
                              secondary={[
                                {
                                  label: "Copy curl",
                                  onSelect: () =>
                                    void navigator.clipboard.writeText(
                                      buildFetchCurl(
                                        item.fullUrl!,
                                        accessTokenForSite(siteRuns, item.siteSlug),
                                        proofForSite(siteRuns, item.siteSlug),
                                      ),
                                    ),
                                  feedbackLabel: "Copied",
                                },
                              ]}
                            />
                          )}
                        </div>
                      </div>
                    </article>
                  ))}
                </div>
              </details>
            ))}
            {!outsideEncounterGroups.length && <p className="subtle">All loaded resources are attached to encounters.</p>}
          </div>
        </section>

        <section className="subpanel viewer-section">
          <h3>Cross-Site Query Console</h3>
            <p className="subtle">Run the same relative FHIR query against every connected site currently in the app.</p>
            <div className="viewer-query-row">
              <input
                type="text"
                className="viewer-query-input"
                value={queryPath}
                onChange={(event) => setQueryPath(event.target.value)}
                placeholder="Observation"
              />
              <button type="button" className="button primary" onClick={() => void runCrossSiteQuery()} disabled={queryRunning || loading}>
                {queryRunning ? "Running…" : "Run across sites"}
              </button>
            </div>
            {queryResults && (
              <div className="viewer-query-results-list">
                {queryResults.map((result) => (
                  <article key={`${result.siteSlug}:${result.relativePath}`} className="artifact-card query-result-card">
                    <div className="query-result-header">
                      <div>
                        <strong>{result.siteName}</strong>
                        <div className="subtle">{formatResultCounts(result.shownCount, result.totalCount)}</div>
                      </div>
                      {!result.error && (
                        <SplitAction
                          primary={{
                            label: "Inspect",
                            onSelect: () =>
                              void inspectRemoteArtifact({
                                title: `${result.siteName} · ${result.relativePath}`,
                                subtitle: result.relativePath,
                                targetUrl: result.fullUrl,
                                accessToken: accessTokenForSite(siteRuns, result.siteSlug),
                                proofJkt: proofForSite(siteRuns, result.siteSlug),
                                metadata: buildInspectionMetadata({
                                  url: result.fullUrl,
                                  curl: buildFetchCurl(
                                    result.fullUrl,
                                    accessTokenForSite(siteRuns, result.siteSlug),
                                    proofForSite(siteRuns, result.siteSlug),
                                  ),
                                }),
                              }),
                          }}
                          secondary={[
                            {
                              label: "Copy curl",
                              onSelect: () =>
                                void navigator.clipboard.writeText(
                                  buildFetchCurl(
                                    result.fullUrl,
                                    accessTokenForSite(siteRuns, result.siteSlug),
                                    proofForSite(siteRuns, result.siteSlug),
                                  ),
                                ),
                              feedbackLabel: "Copied",
                            },
                          ]}
                        />
                      )}
                    </div>
                    <div className="query-result-meta">
                      <span className="summary-label">Query</span>
                      <code>{result.relativePath}</code>
                    </div>
                    {result.error ? (
                      <p className="error-text">{result.error}</p>
                    ) : (
                      <details className="query-result-details">
                        <summary>Inspect response body</summary>
                        <pre>{JSON.stringify(result.payload, null, 2)}</pre>
                      </details>
                    )}
                  </article>
                ))}
              </div>
            )}
        </section>
      </section>
    </main>
  );
}

function ArtifactViewer({ artifactKey }: { artifactKey: string }) {
  const payload = useMemo(() => loadArtifactViewerPayload(artifactKey), [artifactKey]);
  const [copiedAction, setCopiedAction] = useState<string | null>(null);

  if (!payload) {
    return (
      <main className="shell viewer-shell">
        <section className="panel section">
          <h2>Artifact Viewer</h2>
          <p className="error-text">Artifact payload is missing or expired.</p>
        </section>
      </main>
    );
  }

  const text = renderArtifactText(payload);
  const prettyHtml = renderHighlightedJson(text);

  const copyWithFeedback = async (key: string, value: string) => {
    await navigator.clipboard.writeText(value);
    setCopiedAction(key);
    window.setTimeout(() => {
      setCopiedAction((current) => (current === key ? null : current));
    }, 1200);
  };

  return (
    <main className="shell viewer-shell">
      <section className="panel section">
        <div className="section-header">
          <div>
            <p className="eyebrow">Artifact Viewer</p>
            <h2>{payload.title}</h2>
            {payload.subtitle && <p className="subtle viewer-target">{payload.subtitle}</p>}
          </div>
        </div>
        {payload.metadata?.length ? (
          <section className="artifact-metadata">
            <dl className="artifact-metadata-grid">
              {payload.metadata.map((entry) => (
                <div key={`${entry.label}:${entry.value}`} className="artifact-metadata-item">
                  <div className="artifact-metadata-item-head">
                    <dt>{entry.label}</dt>
                    {isCompactMetadataLabel(entry.label) && (
                      <button type="button" className="button mini artifact-metadata-copy" onClick={() => void copyWithFeedback("curl", entry.value)}>
                        {copiedAction === "curl" ? "Copied" : "Copy as curl"}
                      </button>
                    )}
                  </div>
                  <dd
                    className={`mini-definition-value mono-value${isCompactMetadataLabel(entry.label) ? " truncate-value" : ""}`}
                    title={entry.value}
                  >
                    {isCompactMetadataLabel(entry.label) ? compactDisplayValue(entry.value, 64, 16) : entry.value}
                  </dd>
                </div>
              ))}
            </dl>
          </section>
        ) : null}
        {payload.noteText ? (
          <section className="artifact-note-text">
            <h3>Rendered note text</h3>
            <div className="viewer-copy-block">
              {payload.noteText.split(/\n\s*\n/g).map((paragraph, index) => (
                <p key={`${index}:${paragraph.slice(0, 24)}`}>{paragraph.trim()}</p>
              ))}
            </div>
          </section>
        ) : null}
        <section className="artifact-json-panel">
          <div className="artifact-json-head">
            <h3>JSON</h3>
            <button type="button" className="button mini" onClick={() => void copyWithFeedback("json", text)}>
              {copiedAction === "json" ? "Copied JSON" : "Copy JSON"}
            </button>
          </div>
          <pre className="viewer-json" dangerouslySetInnerHTML={{ __html: prettyHtml }} />
        </section>
      </section>
    </main>
  );
}

function accessTokenForSite(siteRuns: ViewerSiteRun[], siteSlug: string) {
  return siteRuns.find((run) => run.site.siteSlug === siteSlug)?.tokenResponse?.access_token ?? null;
}

function proofForSite(siteRuns: ViewerSiteRun[], siteSlug: string) {
  return siteRuns.find((run) => run.site.siteSlug === siteSlug)?.proofJkt ?? null;
}

function normalizeTarget(target: string) {
  const url = new URL(target, window.location.origin);
  if (url.origin !== window.location.origin) throw new Error("Viewer only supports same-origin targets");
  return url.toString();
}

function formatTimelineWindow(start: string, end: string) {
  if (!start && !end) return "All dates";
  if (start && end && start === end) return formatCompactDate(start);
  return `${formatCompactDate(start)} → ${formatCompactDate(end)}`;
}

function formatCompactDate(value: string) {
  if (!value) return "—";
  const date = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(date.getTime())) return value.slice(0, 10) || "—";
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  }).format(date);
}

const MIN_PILL_PCT = 3.5;

function encounterBarPosition(encounter: { startDate: string | null; endDate: string | null }, scale: { start: string; totalDays: number }) {
  const startDay = (encounter.startDate ?? encounter.endDate ?? scale.start).slice(0, 10);
  const endDay = (encounter.endDate ?? encounter.startDate ?? startDay).slice(0, 10);
  const startOffset = diffDaysUtc(scale.start, startDay);
  const endOffset = diffDaysUtc(scale.start, endDay);
  // Map positions to [0, 100 - MIN_PILL_PCT] so the rightmost pill fits within the container
  const usable = 100 - MIN_PILL_PCT;
  const left = scale.totalDays <= 1 ? 0 : (startOffset / Math.max(scale.totalDays - 1, 1)) * usable;
  const width = Math.max((((endOffset - startOffset) + 1) / Math.max(scale.totalDays, 1)) * 100, MIN_PILL_PCT);
  return {
    left: Math.max(0, Math.min(usable, left)),
    width: Math.max(MIN_PILL_PCT, Math.min(100 - Math.max(0, left), width)),
  };
}

function buildTimelineTicks(scale: { start: string; end: string; totalDays: number }) {
  const steps = Math.min(Math.max(Math.floor(scale.totalDays / 150) + 4, 4), 7);
  const ticks = Array.from({ length: steps }, (_, index) => {
    const ratio = steps === 1 ? 0 : index / (steps - 1);
    const dayOffset = Math.round(ratio * Math.max(scale.totalDays - 1, 0));
    const value = addDaysUtc(scale.start, dayOffset);
    return {
      left: ratio * 100,
      label: formatCompactDate(value),
    };
  });
  return dedupeTimelineTicks(ticks);
}

function dedupeTimelineTicks(ticks: Array<{ left: number; label: string }>) {
  const seen = new Set<string>();
  return ticks.filter((tick) => {
    if (seen.has(tick.label)) return false;
    seen.add(tick.label);
    return true;
  });
}

function normalizeRelativeQuery(value: string) {
  return value.trim().replace(/^\/+/, "");
}

function inferPayloadCounts(payload: any) {
  if (!payload) return { shownCount: 0, totalCount: 0 };
  if (payload.resourceType === "Bundle") {
    return {
      shownCount: Number(payload.entry?.length ?? 0),
      totalCount: Number(payload.total ?? payload.entry?.length ?? 0),
    };
  }
  return { shownCount: 1, totalCount: 1 };
}

function humanizePhase(phase: ViewerSiteRun["phase"]) {
  switch (phase) {
    case "loading-config":
      return "Loading SMART config";
    case "registering-client":
      return "Registering client";
    case "exchanging-token":
      return "Exchanging ticket";
    case "introspecting-token":
      return "Introspecting token";
    case "loading-data":
      return "Loading site data";
    case "ready":
      return "Ready";
    case "error":
      return "Error";
    default:
      return "Idle";
  }
}

function formatResultCounts(shownCount: number, totalCount: number) {
  if (totalCount > shownCount) return `${shownCount} shown · ${totalCount} total`;
  return `${shownCount} result${shownCount !== 1 ? "s" : ""}`;
}

function renderSummaryParagraphs(summary: string) {
  return summary
    .split(/\n\s*\n/g)
    .map((paragraph) => paragraph.trim())
    .filter(Boolean)
    .map((paragraph, index) => <p key={`${index}:${paragraph.slice(0, 24)}`}>{paragraph}</p>);
}

function openArtifactViewer(payload: ArtifactViewerPayload) {
  const href = buildArtifactViewerHref(payload);
  window.open(href, "_blank", "noopener,noreferrer");
}

async function inspectRemoteArtifact(input: {
  title: string;
  subtitle?: string;
  targetUrl: string;
  accessToken?: string | null;
  proofJkt?: string | null;
  metadata?: Array<{ label: string; value: string }>;
}) {
  try {
    const normalizedTarget = normalizeTarget(input.targetUrl);
    const content = await fetchJson<unknown>(normalizedTarget, {
      headers: {
        ...(input.accessToken ? { authorization: `Bearer ${input.accessToken}` } : {}),
        ...(input.proofJkt ? { "x-client-jkt": input.proofJkt } : {}),
      },
    });
    const payload: ArtifactViewerPayload = {
      title: input.title,
      subtitle: input.subtitle,
      content,
      metadata: input.metadata,
      noteText: extractDocumentReferenceText(content),
    };
    openArtifactViewer(payload);
  } catch (error) {
    openArtifactViewer({
      title: `${input.title} · Error`,
      subtitle: input.subtitle,
      content: {
        error: error instanceof Error ? error.message : "Failed to load remote artifact",
      },
      metadata: input.metadata,
    });
  }
}

function renderArtifactCell(
  title: string,
  content: unknown,
  options?: { metadata?: Array<{ label: string; value: string }>; copyText?: string; label?: string },
) {
  if (!content) return <span className="subtle">Not available</span>;
  return (
    <SplitAction
      primary={{
        label: options?.label ?? "Open",
        onSelect: () => openArtifactViewer({ title, content, metadata: options?.metadata, copyText: options?.copyText }),
      }}
      secondary={[
        {
          label: "Copy",
          onSelect: () => void navigator.clipboard.writeText(options?.copyText ?? (typeof content === "string" ? content : JSON.stringify(content, null, 2))),
          feedbackLabel: "Copied",
        },
      ]}
    />
  );
}

function buildInspectionMetadata(input: {
  url: string;
  curl: string;
  previewUrl?: string | null;
  previewCurl?: string | null;
}) {
  return [
    { label: "URL", value: input.url },
    { label: "Curl", value: input.curl },
    ...(input.previewUrl ? [{ label: "Preview URL", value: input.previewUrl }] : []),
    ...(input.previewCurl ? [{ label: "Preview curl", value: input.previewCurl }] : []),
  ];
}

function isCompactMetadataLabel(label: string) {
  const normalized = label.trim().toLowerCase();
  return normalized.includes("curl");
}

function renderHighlightedJson(text: string) {
  const escaped = escapeHtml(text);
  return escaped.replace(
    /("(?:\\u[\da-fA-F]{4}|\\[^u]|[^\\"])*"\s*:?)|\b(true|false|null)\b|\b-?\d+(?:\.\d+)?(?:[eE][+\-]?\d+)?\b/g,
    (match) => {
      if (/^"/.test(match)) {
        const className = /:\s*$/.test(match) ? "json-key" : "json-string";
        return `<span class="${className}">${match}</span>`;
      }
      if (/true|false/.test(match)) return `<span class="json-boolean">${match}</span>`;
      if (/null/.test(match)) return `<span class="json-null">${match}</span>`;
      return `<span class="json-number">${match}</span>`;
    },
  );
}

function escapeHtml(text: string) {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function buildPostJsonCurl(url: string, body: unknown, accessToken?: string | null, proofJkt?: string | null) {
  const headers = [
    accessToken ? `-H 'authorization: Bearer ${accessToken}'` : "",
    proofJkt ? `-H 'x-client-jkt: ${proofJkt}'` : "",
    `-H 'content-type: application/json'`,
  ]
    .filter(Boolean)
    .join(" ");
  return `curl -X POST ${headers} --data '${JSON.stringify(body)}' '${url}'`;
}

function extractDocumentReferenceText(content: unknown) {
  const resource = unwrapResource(content);
  if (!resource || resource.resourceType !== "DocumentReference") return null;
  for (const attachment of resource.content ?? []) {
    const candidate = attachment?.attachment;
    if (typeof candidate?.data !== "string") continue;
    const contentType = typeof candidate.contentType === "string" ? candidate.contentType : "";
    if (contentType && !contentType.startsWith("text/") && contentType !== "application/markdown") continue;
    try {
      const binary = atob(candidate.data);
      return binary;
    } catch {
      return null;
    }
  }
  return null;
}

function unwrapResource(content: unknown): any | null {
  if (!content || typeof content !== "object") return null;
  if ((content as any).resourceType === "Bundle") {
    const entries = (content as any).entry;
    if (Array.isArray(entries) && entries.length === 1) {
      return entries[0]?.resource ?? null;
    }
    return null;
  }
  return content as any;
}

function compactDisplayValue(value: string, head = 20, tail = 8) {
  if (value.length <= head + tail + 1) return value;
  return `${value.slice(0, head)}…${value.slice(-tail)}`;
}

type SiteTone = {
  solid: string;
  soft: string;
  border: string;
  ink: string;
};

const SITE_TONES: SiteTone[] = [
  { solid: "#1a73e8", soft: "#e8f0fe", border: "#8ab4f8", ink: "#174ea6" },
  { solid: "#188038", soft: "#e6f4ea", border: "#81c995", ink: "#137333" },
  { solid: "#c5221f", soft: "#fce8e6", border: "#f28b82", ink: "#a50e0e" },
  { solid: "#a142f4", soft: "#f3e8fd", border: "#d7aefb", ink: "#8430ce" },
  { solid: "#0b57d0", soft: "#d3e3fd", border: "#a8c7fa", ink: "#174ea6" },
  { solid: "#e37400", soft: "#fef7e0", border: "#f6c453", ink: "#b06000" },
  { solid: "#00796b", soft: "#d7f8f3", border: "#7fdad0", ink: "#00695c" },
  { solid: "#7b1fa2", soft: "#f3e5f5", border: "#ce93d8", ink: "#6a1b9a" },
  { solid: "#5f6368", soft: "#f1f3f4", border: "#c4c7c5", ink: "#3c4043" },
  { solid: "#b3261e", soft: "#fce8e6", border: "#f6aea9", ink: "#8c1d18" },
  { solid: "#146c2e", soft: "#e6f4ea", border: "#9ad19d", ink: "#0f5223" },
  { solid: "#00639b", soft: "#d7efff", border: "#8bc4ff", ink: "#004a77" },
];

function buildSiteTone(siteSlug: string): SiteTone {
  const hash = [...siteSlug].reduce((value, char) => ((value * 33) ^ char.charCodeAt(0)) >>> 0, 5381);
  return SITE_TONES[hash % SITE_TONES.length]!;
}

function siteCardStyle(tone: SiteTone): CSSProperties {
  return {
    borderTop: `3px solid ${tone.border}`,
  };
}

function siteListItemStyle(tone: SiteTone): CSSProperties {
  return {
    borderLeft: `4px solid ${tone.border}`,
  };
}

function siteEventStyle(tone: SiteTone, active: boolean): CSSProperties {
  return active
    ? {
        background: tone.solid,
        boxShadow: `inset 0 0 0 1px ${tone.solid}`,
      }
    : {
        background: tone.soft,
        boxShadow: `inset 0 0 0 1px ${tone.border}`,
      };
}
