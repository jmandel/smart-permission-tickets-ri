import { useEffect, useMemo, useRef, useState, type CSSProperties, type FormEvent, type ReactNode } from "react";

import { deriveDemoEventPhase, type DemoAuditStep, type DemoEvent, type DemoSessionSummary } from "../../../shared/demo-events";
import { buildArtifactViewerHref, buildDemoEventArtifactPayload } from "../lib/artifact-viewer";

export function DemoVisualizer() {
  const params = useMemo(() => new URLSearchParams(window.location.search), []);
  const initialSessionId = params.get("session");
  const [selectedSessionId, setSelectedSessionId] = useState(initialSessionId);
  const [sessionInput, setSessionInput] = useState(initialSessionId ?? "");
  const [sessions, setSessions] = useState<DemoSessionSummary[]>([]);
  const [sessionsStatus, setSessionsStatus] = useState<"loading" | "ready" | "error">("loading");
  const [newSessionNotice, setNewSessionNotice] = useState<DemoSessionSummary | null>(null);
  const [events, setEvents] = useState<DemoEvent[]>([]);
  const [status, setStatus] = useState<"connecting" | "open" | "error">("connecting");
  const [stickToBottom, setStickToBottom] = useState(true);
  const feedRef = useRef<HTMLDivElement | null>(null);
  const selectedSessionRef = useRef<string | null>(initialSessionId);
  const newestSessionRef = useRef<string | null>(null);

  useEffect(() => {
    selectedSessionRef.current = selectedSessionId;
  }, [selectedSessionId]);

  useEffect(() => {
    let cancelled = false;

    async function loadSessions() {
      try {
        const response = await fetch("/demo/sessions");
        if (!response.ok) throw new Error(`Session lookup failed: ${response.status}`);
        const body = await response.json() as { sessions?: DemoSessionSummary[] };
        if (cancelled) return;
        const nextSessions = Array.isArray(body.sessions) ? body.sessions : [];
        setSessions(nextSessions);
        setSessionsStatus("ready");
        const newest = nextSessions[0] ?? null;
        if (!selectedSessionRef.current && newest) {
          selectSession(newest.sessionId, { syncInput: true });
          newestSessionRef.current = newest.sessionId;
          return;
        }
        if (newest && newestSessionRef.current && newest.sessionId !== newestSessionRef.current && newest.sessionId !== selectedSessionRef.current) {
          setNewSessionNotice(newest);
        }
        newestSessionRef.current = newest?.sessionId ?? newestSessionRef.current;
      } catch {
        if (!cancelled) setSessionsStatus("error");
      }
    }

    void loadSessions();
    const timer = window.setInterval(() => {
      void loadSessions();
    }, 5000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, []);

  useEffect(() => {
    if (!selectedSessionId) return;
    setEvents([]);
    setStatus("connecting");
    const source = new EventSource(`/demo/events/${encodeURIComponent(selectedSessionId)}`);
    source.onopen = () => setStatus("open");
    source.onerror = () => setStatus("error");
    source.onmessage = (message) => {
      try {
        const event = JSON.parse(message.data) as DemoEvent;
        setEvents((current) => upsertEvent(current, event));
      } catch {
        // Ignore malformed demo events.
      }
    };
    return () => source.close();
  }, [selectedSessionId]);

  useEffect(() => {
    if (!stickToBottom) return;
    const feed = feedRef.current;
    if (!feed) return;
    feed.scrollTop = feed.scrollHeight;
  }, [events, stickToBottom]);

  const summary = useMemo(() => buildSummary(events), [events]);
  const visibleEvents = useMemo(() => filterFeedEvents(events), [events]);
  const phaseHeaders = useMemo(() => firstPhaseSequence(visibleEvents), [visibleEvents]);
  const currentSession = sessions.find((session) => session.sessionId === selectedSessionId) ?? null;
  const currentSessionStatus = sessionLiveness(currentSession);

  return (
    <main className="shell visualizer-shell">
      <section className="panel visualizer-banner">
        <div>
          <p className="eyebrow">Live Demo Visualizer</p>
          <h2>Trust chain, fan-out, and data retrieval</h2>
          <p className="subtle mono-value">Session {selectedSessionId ?? "auto-selecting latest active demo"}</p>
        </div>
        <div className="visualizer-banner-stats">
          <div className="summary-card compact">
            <span className="summary-label">Status</span>
            <strong>{selectedSessionId ? (status === "open" ? "Live" : status === "connecting" ? "Connecting" : "Reconnecting") : sessionsStatus === "loading" ? "Finding session" : "Idle"}</strong>
          </div>
          <div className="summary-card compact">
            <span className="summary-label">Checks</span>
            <strong>{summary.checksPassed}/7</strong>
          </div>
          <div className="summary-card compact">
            <span className="summary-label">Sites</span>
            <strong>{summary.readySites}/{summary.siteRows.length}</strong>
          </div>
          <div className="summary-card compact">
            <span className="summary-label">Resources</span>
            <strong>{summary.totalResources}</strong>
          </div>
        </div>
      </section>

      <section className="panel visualizer-session-bar">
        <div className="visualizer-session-current">
          <span className={`visualizer-live-dot ${currentSessionStatus}`} />
          <div className="visualizer-session-copy">
            <strong>{currentSession?.patientName ?? "Current session"}</strong>
            <span className="subtle mono-value">
              {selectedSessionId ? truncateSessionId(selectedSessionId) : "No session selected"}
            </span>
          </div>
        </div>
        <label className="visualizer-session-picker">
          <span className="summary-label">Recent</span>
          <select
            value={selectedSessionId ?? ""}
            onChange={(event) => {
              const next = event.currentTarget.value || null;
              if (next) selectSession(next, { syncInput: true });
            }}
          >
            {!selectedSessionId && <option value="">Select a session</option>}
            {sessions.map((session) => (
              <option key={session.sessionId} value={session.sessionId}>
                {formatSessionOption(session)}
              </option>
            ))}
          </select>
        </label>
        <form
          className="visualizer-session-manual"
          onSubmit={(event) => {
            event.preventDefault();
            const trimmed = sessionInput.trim();
            if (!trimmed) return;
            selectSession(trimmed, { syncInput: true });
          }}
        >
          <label>
            <span className="summary-label">Paste session</span>
            <input
              type="text"
              value={sessionInput}
              onChange={(event) => setSessionInput(event.currentTarget.value)}
              placeholder="session UUID"
            />
          </label>
          <button type="submit" className="button mini">Open</button>
        </form>
      </section>

      {newSessionNotice && (
        <div className="visualizer-toast" role="status">
          <div>
            <strong>New session available</strong>
            <div className="subtle">
              {newSessionNotice.patientName ?? truncateSessionId(newSessionNotice.sessionId)} · {formatRelativeTime(newSessionNotice.lastActivityAt)}
            </div>
          </div>
          <div className="visualizer-toast-actions">
            <button
              type="button"
              className="button mini primary"
              onClick={() => {
                selectSession(newSessionNotice.sessionId, { syncInput: true });
                setNewSessionNotice(null);
              }}
            >
              Switch
            </button>
            <button type="button" className="button mini" onClick={() => setNewSessionNotice(null)}>Dismiss</button>
          </div>
        </div>
      )}

      <section className="visualizer-layout">
        <aside className="panel visualizer-summary">
          <SummarySection
            tone="amber"
            title="Ticket"
            event={summary.ticketEvent}
            empty="Waiting for ticket bootstrap…"
          >
            {summary.ticketEvent && (
              <>
                <div className="summary-field">
                  <strong>{summary.ticketEvent.detail.patientName}</strong>
                  {summary.ticketEvent.detail.patientDob && <span className="subtle"> · DOB {summary.ticketEvent.detail.patientDob}</span>}
                </div>
                <div className="scope-pill-row">
                  {summary.ticketEvent.detail.scopes.map((scope) => (
                    <span key={scope} className="visualizer-pill" style={scopePillStyle(scope)}>{scope}</span>
                  ))}
                </div>
                <div className="summary-field subtle">
                  {summary.ticketEvent.detail.dateSummary} · {summary.ticketEvent.detail.sensitiveSummary} · {summary.ticketEvent.detail.expirySummary}
                </div>
                <div className="summary-field subtle">{summary.ticketEvent.detail.bindingSummary}</div>
              </>
            )}
          </SummarySection>

          <SummarySection
            tone="blue"
            title="Client"
            event={summary.clientEvent}
            empty="Waiting for client registration…"
          >
            {summary.clientEvent && (
              <>
                <div className="summary-field"><strong>{summary.clientEvent.label}</strong></div>
                {summary.clientEvent.detail.clientId && <div className="summary-field mono-value truncate-value">{summary.clientEvent.detail.clientId}</div>}
                {summary.clientEvent.detail.frameworkUri && (
                  <div className="summary-field subtle truncate-value">{summary.clientEvent.detail.frameworkUri}</div>
                )}
                {summary.clientEvent.detail.error && <div className="summary-field subtle">{summary.clientEvent.detail.error}</div>}
              </>
            )}
          </SummarySection>

          <SummarySection tone="purple" title="Verification" empty="Waiting for validation checks…">
            <div className="scope-pill-row">
              {summary.networkSteps.filter((step) => step.passed).map((step, index) => (
                <button key={`${step.check}:${index}`} type="button" className="visualizer-pill success" onClick={() => summary.networkToken && openEventArtifact(summary.networkToken)}>
                  {step.check}
                </button>
              ))}
            </div>
            {summary.patientMatched && (
              <button type="button" className="summary-line-link" onClick={() => summary.networkToken && openEventArtifact(summary.networkToken)}>
                Patient matched across {summary.patientMatched.siteCount} sites
              </button>
            )}
            {summary.networkToken && (
              <button type="button" className="summary-line-link" onClick={() => summary.networkToken && openEventArtifact(summary.networkToken)}>
                Network token issued
              </button>
            )}
          </SummarySection>

          <SummarySection tone="teal" title="Sites" empty="Waiting for site discovery…">
            <div className="visualizer-site-list">
              {summary.siteRows.map((site) => (
                <button
                  key={site.siteSlug}
                  type="button"
                  className="visualizer-site-row"
                  onClick={() => scrollToSite(site.siteSlug)}
                >
                  <span className={`visualizer-site-dot ${site.status}`} />
                  <span className="visualizer-site-name">{site.siteName}</span>
                  <span className="visualizer-site-count">{site.resourceCount}</span>
                </button>
              ))}
            </div>
          </SummarySection>

          <div className="visualizer-summary-footer">
            {summary.totalResources} resources · {summary.siteRows.length} sites · {events.length} events
          </div>
        </aside>

        <section
          ref={feedRef}
          className="panel visualizer-feed"
          onScroll={(event) => {
            const target = event.currentTarget;
            const atBottom = target.scrollHeight - target.scrollTop - target.clientHeight < 64;
            setStickToBottom(atBottom);
          }}
        >
          {!selectedSessionId ? (
            <p className="subtle">
              {sessionsStatus === "loading"
                ? "Looking for recent demo sessions…"
                : "No active demo sessions yet. Open the health app from Step 4, or paste a session id above to attach."}
            </p>
          ) : visibleEvents.length === 0 ? (
            <p className="subtle">Waiting for events… Open the health app with this session to watch the flow.</p>
          ) : (
            <div className="visualizer-feed-list">
              {visibleEvents.map((event) => {
                const phase = deriveDemoEventPhase(event);
                const showPhase = phaseHeaders.has(event.seq);
                const siteSlug = eventSiteSlug(event);
                return (
                  <div key={event.seq} id={`demo-event-${event.seq}`} data-site-slug={siteSlug ?? undefined}>
                    {showPhase && (
                      <div className={`visualizer-phase-divider phase-${phase}`}>
                        <span>{phaseTitle(phase)}</span>
                      </div>
                    )}
                    <div className={`visualizer-feed-entry-shell phase-${phase}`}>
                      <button
                        type="button"
                        className={`visualizer-feed-entry phase-${phase}`}
                        onClick={() => openEventArtifact(event)}
                      >
                        <span className="visualizer-feed-icon" aria-hidden="true">{eventIcon(event)}</span>
                        <span className="visualizer-feed-body">
                          <span className="visualizer-feed-label">{event.label}</span>
                          <span className="visualizer-feed-detail">{describeEvent(event)}</span>
                        </span>
                      </button>
                      {eventHasSubsteps(event) && (
                        <details className="visualizer-feed-substeps">
                          <summary>Details</summary>
                          {"patientMatch" in event.detail && event.detail.patientMatch && (
                            <div className="visualizer-feed-substep-note">
                              Patient match: {event.detail.patientMatch.siteName
                                ? `${event.detail.patientMatch.patientName} at ${event.detail.patientMatch.siteName}`
                                : `${event.detail.patientMatch.patientName} at ${event.detail.patientMatch.siteCount} sites`}
                            </div>
                          )}
                          <div className="visualizer-feed-substep-list">
                            {event.detail.steps.map((step, index) => (
                              <div key={`${event.seq}:${step.check}:${index}`} className={`visualizer-feed-substep ${step.passed ? "success" : "failure"}`}>
                                <strong>{step.check}</strong>
                                <span>{step.passed ? "Passed" : "Failed"}</span>
                                {step.evidence && <span className="subtle mono-wrap">{step.evidence}</span>}
                                {step.why && <span className="subtle">{step.why}</span>}
                                {step.reason && <span className="subtle">{step.reason}</span>}
                              </div>
                            ))}
                          </div>
                        </details>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </section>
      </section>
    </main>
  );

  function scrollToSite(siteSlug: string) {
    const node = document.querySelector<HTMLElement>(`[data-site-slug="${CSS.escape(siteSlug)}"]`);
    node?.scrollIntoView({ behavior: "smooth", block: "center" });
  }

  function selectSession(nextSessionId: string, options: { syncInput: boolean }) {
    setSelectedSessionId(nextSessionId);
    if (options.syncInput) setSessionInput(nextSessionId);
    const nextParams = new URLSearchParams(window.location.search);
    nextParams.set("session", nextSessionId);
    window.history.replaceState(null, "", `${window.location.pathname}?${nextParams.toString()}`);
  }
}

function SummarySection({
  tone,
  title,
  children,
  empty,
  event,
}: {
  tone: "amber" | "blue" | "purple" | "teal";
  title: string;
  children?: ReactNode;
  empty: string;
  event?: DemoEvent | null;
}) {
  const content = (
    <>
      <div className="summary-title">{title}</div>
      <div className="summary-content">{children ?? <p className="subtle">{empty}</p>}</div>
    </>
  );
  if (event) {
    return (
      <button
        type="button"
        className={`visualizer-summary-section ${tone} clickable`}
        onClick={() => openEventArtifact(event)}
      >
        {content}
      </button>
    );
  }
  return <div className={`visualizer-summary-section ${tone}`}>{content}</div>;
}

function openEventArtifact(event: DemoEvent) {
  const href = buildArtifactViewerHref(buildDemoEventArtifactPayload(event));
  window.open(href, "_blank", "noopener,noreferrer");
}

function upsertEvent(current: DemoEvent[], next: DemoEvent) {
  if (current.some((event) => event.seq === next.seq)) return current;
  return [...current, next].sort((left, right) => left.seq - right.seq);
}

export function buildSummary(events: DemoEvent[]) {
  const ticketEvent = events.find((event): event is Extract<DemoEvent, { type: "ticket-created" }> => event.type === "ticket-created") ?? null;
  const clientEvent = [...events]
    .reverse()
    .find((event): event is Extract<DemoEvent, { type: "registration-request" }> => event.type === "registration-request")
    ?? null;
  const networkToken = [...events].reverse().find((event): event is Extract<DemoEvent, { type: "token-exchange" }> => event.type === "token-exchange" && deriveDemoEventPhase(event) === "network-auth") ?? null;
  const networkSteps = networkToken?.detail.steps ?? [];
  const patientMatched = networkToken?.detail.patientMatch ?? null;
  const siteRows = buildSiteRows(events);
  const totalResources = [...events]
    .filter((event): event is Extract<DemoEvent, { type: "query-result" }> => event.type === "query-result")
    .reduce((count, event) => count + event.detail.count, 0);
  const readySites = siteRows.filter((site) => site.status === "green").length;
  return {
    ticketEvent,
    clientEvent,
    networkSteps,
    checksPassed: networkSteps.filter((step) => step.passed).length,
    patientMatched,
    networkToken,
    siteRows,
    readySites,
    totalResources,
  };
}

export function filterFeedEvents(events: DemoEvent[]) {
  return events.filter((event) => {
    if (event.type !== "query-result") return true;
    if (event.detail.count <= 0) return false;
    if (
      event.detail.resourceType === "Patient"
      || event.detail.resourceType === "Organization"
      || event.detail.resourceType === "Practitioner"
      || event.detail.resourceType === "Location"
    ) {
      return false;
    }
    return true;
  });
}

function buildSiteRows(events: DemoEvent[]) {
  const rows = new Map<string, { siteSlug: string; siteName: string; status: "gray" | "amber" | "green" | "red"; resourceCount: number }>();
  for (const event of events) {
    if (event.type === "sites-discovered") {
      for (const site of event.detail.sites) {
        rows.set(site.siteSlug, {
          siteSlug: site.siteSlug,
          siteName: site.siteName,
          status: "gray",
          resourceCount: 0,
        });
      }
      continue;
    }
    const siteSlug = eventSiteSlug(event);
    if (!siteSlug) continue;
    const current = rows.get(siteSlug) ?? {
      siteSlug,
      siteName: eventSiteName(event) ?? siteSlug,
      status: "gray" as const,
      resourceCount: 0,
    };
    if (event.type === "token-exchange" && event.detail.siteSlug) current.status = event.detail.outcome === "issued" ? "green" : "red";
    if (event.type === "query-result") current.resourceCount += event.detail.count;
    rows.set(siteSlug, current);
  }
  return [...rows.values()];
}

function firstPhaseSequence(events: DemoEvent[]) {
  const firstSeqs = new Set<number>();
  const seen = new Set<string>();
  for (const event of events) {
    const phase = deriveDemoEventPhase(event);
    if (seen.has(phase)) continue;
    seen.add(phase);
    firstSeqs.add(event.seq);
  }
  return firstSeqs;
}

function phaseTitle(phase: ReturnType<typeof deriveDemoEventPhase>) {
  switch (phase) {
    case "ticket": return "Ticket";
    case "registration": return "Registration";
    case "network-auth": return "Network Auth";
    case "discovery": return "Discovery";
    case "site-auth": return "Site Auth";
    case "data": return "Data";
    case "complete": return "Complete";
  }
}

function eventIcon(event: DemoEvent) {
  switch (event.type) {
    case "ticket-created": return "📜";
    case "token-exchange": return "🔑";
    case "udap-discovery": return "🔎";
    case "registration-request": return "🪪";
    case "sites-discovered": return "🏥";
    case "query-result": return "📦";
    case "query-failed": return "⚠";
    case "session-complete": return "🏁";
  }
}

function describeEvent(event: DemoEvent) {
  switch (event.type) {
    case "ticket-created":
      return `${event.detail.patientName} · ${event.detail.scopes.length} scopes · ${event.detail.expirySummary}`;
    case "token-exchange":
      return event.detail.siteName
        ? `${event.detail.siteName} · ${event.detail.outcome === "issued" ? event.detail.scopeSummary ?? event.detail.grantType : event.detail.error ?? "rejected"}`
        : `${event.detail.grantType} · ${event.detail.outcome === "issued" ? event.detail.scopeSummary ?? `${event.detail.steps.filter((step) => step.passed).length} checks` : event.detail.error ?? "rejected"}`;
    case "udap-discovery":
      return event.detail.endpoint;
    case "registration-request":
      return `${event.detail.authMode} · ${event.detail.outcome}${event.detail.clientId ? ` · ${event.detail.clientId}` : ""}`;
    case "sites-discovered":
      return event.detail.sites.map((site) => site.siteName).join(" · ");
    case "query-result":
      return `${event.detail.siteName} · ${event.detail.resourceType} ${event.detail.count}`;
    case "query-failed":
      return `${event.detail.siteName} · ${event.detail.resourceType} failed: ${event.detail.reason}`;
    case "session-complete":
      return `${event.detail.totalResources} resources across ${event.detail.totalSites} sites`;
  }
}

function eventSiteSlug(event: DemoEvent) {
  switch (event.type) {
    case "token-exchange":
    case "query-result":
    case "query-failed":
      return event.detail.siteSlug ?? null;
    default:
      return null;
  }
}

function eventSiteName(event: DemoEvent) {
  switch (event.type) {
    case "token-exchange":
    case "query-result":
    case "query-failed":
      return event.detail.siteName ?? null;
    default:
      return null;
  }
}

function eventHasSubsteps(event: DemoEvent): event is Extract<DemoEvent, { type: "token-exchange" | "registration-request" }> {
  return (event.type === "token-exchange" || event.type === "registration-request") && event.detail.steps.length > 0;
}

function scopePillStyle(label: string): CSSProperties {
  const palette = [
    { background: "#eef4ff", borderColor: "#9bb7ff", color: "#23408e" },
    { background: "#f5efff", borderColor: "#bea5ff", color: "#5c3db3" },
    { background: "#ecfbf5", borderColor: "#8fd5b3", color: "#1f6b47" },
    { background: "#fff5e9", borderColor: "#f4b56e", color: "#8b4b00" },
    { background: "#fff0f2", borderColor: "#f0a2b1", color: "#9a2943" },
  ];
  const hash = [...label].reduce((value, char) => ((value * 33) ^ char.charCodeAt(0)) >>> 0, 5381);
  const tone = palette[hash % palette.length]!;
  return {
    background: tone.background,
    borderColor: tone.borderColor,
    color: tone.color,
  };
}

function truncateSessionId(sessionId: string) {
  return sessionId.length <= 14 ? sessionId : `${sessionId.slice(0, 8)}…${sessionId.slice(-4)}`;
}

function sessionLiveness(session: DemoSessionSummary | null) {
  if (!session?.lastEventAt) return "stale";
  return Date.now() - session.lastEventAt <= 60_000 ? "live" : "stale";
}

function formatSessionOption(session: DemoSessionSummary) {
  const patient = session.patientName ? `${session.patientName} · ` : "";
  return `${patient}${truncateSessionId(session.sessionId)} · ${formatRelativeTime(session.lastActivityAt)}`;
}

function formatRelativeTime(timestamp: number) {
  const deltaMs = Math.max(0, Date.now() - timestamp);
  const minutes = Math.floor(deltaMs / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}
