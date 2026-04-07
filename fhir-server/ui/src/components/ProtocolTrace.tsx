import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";

import type { DemoEvent, DemoQueryFailedEvent, DemoQueryResultEvent, DemoSessionSummary, DemoTokenExchangeEvent } from "../../../shared/demo-events";
import { buildDemoEventSummary } from "../lib/artifact-viewer";
import { buildDemoEventArtifactTabs, type EventArtifactTab } from "../lib/demo-event-tabs";
import {
  accumulateTraceState,
  buildTraceOverview,
  cellEventsForTrace,
  filterTraceQueryEvents,
  type SiteTraceState,
  type TraceCellId,
  type TraceColumn,
} from "../lib/protocol-trace-state";
import {
  formatHttpRequestForCopy,
  formatHttpResponseForCopy,
  HttpRequestArtifactPanel,
  HttpResponseArtifactPanel,
  JsonArtifactPanel,
  JwtArtifactPanel,
} from "./ArtifactPanels";

const NETWORK_TRACE_COLUMNS: TraceColumn[] = ["client-setup", "token", "resolve-match"];
const SITE_TRACE_COLUMNS: TraceColumn[] = ["client-setup", "token", "data"];
const TRACE_COLUMN_LABELS: Record<TraceColumn, string> = {
  ticket: "Ticket",
  "resolve-match": "Resolve-Match",
  "client-setup": "Client Setup",
  token: "Token",
  data: "Data",
};

export function ProtocolTrace() {
  const params = useMemo(() => new URLSearchParams(window.location.search), []);
  const initialSessionId = params.get("session");
  const [selectedSessionId, setSelectedSessionId] = useState(initialSessionId);
  const [sessionInput, setSessionInput] = useState(initialSessionId ?? "");
  const [sessions, setSessions] = useState<DemoSessionSummary[]>([]);
  const [sessionsStatus, setSessionsStatus] = useState<"loading" | "ready" | "error">("loading");
  const [newSessionNotice, setNewSessionNotice] = useState<DemoSessionSummary | null>(null);
  const [events, setEvents] = useState<DemoEvent[]>([]);
  const [status, setStatus] = useState<"connecting" | "open" | "error">("connecting");
  const [selectedCell, setSelectedCell] = useState<TraceCellId | null>(null);
  const [selectedQuery, setSelectedQuery] = useState<number | null>(null);
  const detailPanelRef = useRef<HTMLElement | null>(null);
  const selectedSessionRef = useRef<string | null>(selectedSessionId);
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
          selectSession(newest.sessionId, true);
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
  }, [selectedSessionRef]);

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

  const traceState = useMemo(() => accumulateTraceState(events, selectedCell), [events, selectedCell]);
  const selectedCellKey = selectedCell ? traceCellKey(selectedCell) : null;
  const resolvedSelectedCell = traceState.selectedCell;
  const resolvedSelectedCellKey = resolvedSelectedCell ? traceCellKey(resolvedSelectedCell) : null;

  useEffect(() => {
    if (resolvedSelectedCellKey !== selectedCellKey) {
      setSelectedCell(resolvedSelectedCell);
    }
  }, [resolvedSelectedCell, resolvedSelectedCellKey, selectedCellKey]);

  useEffect(() => {
    setSelectedQuery(null);
  }, [resolvedSelectedCellKey]);

  const overview = useMemo(() => buildTraceOverview(traceState), [traceState]);
  const currentSession = sessions.find((session) => session.sessionId === selectedSessionId) ?? null;
  const currentSessionStatus = sessionLiveness(currentSession);
  const siteRows = useMemo(() => orderedSiteRows(traceState), [traceState]);
  const detailModel = useMemo(
    () => buildDetailModel(traceState, resolvedSelectedCell, selectedQuery),
    [traceState, resolvedSelectedCell, selectedQuery],
  );

  return (
    <main className="shell protocol-trace-shell">
      <section className="panel protocol-trace-banner">
        <div>
          <p className="eyebrow">Protocol Trace</p>
          <h2>Trust chain, fan-out, and data retrieval</h2>
          <p className="subtle mono-value">Session {selectedSessionId ?? "auto-selecting latest active demo"}</p>
        </div>
        <div className="protocol-trace-banner-stats">
          <div className="summary-card compact">
            <span className="summary-label">Status</span>
            <strong>{selectedSessionId ? (status === "open" ? "Live" : status === "connecting" ? "Connecting" : "Reconnecting") : sessionsStatus === "loading" ? "Finding session" : "Idle"}</strong>
          </div>
          <div className="summary-card compact">
            <span className="summary-label">Checks</span>
            <strong>{overview.checksPassed}/7</strong>
          </div>
          <div className="summary-card compact">
            <span className="summary-label">Sites</span>
            <strong>{overview.readySites}/{overview.totalSites}</strong>
          </div>
          <div className="summary-card compact">
            <span className="summary-label">Resources</span>
            <strong>{overview.totalResources}</strong>
          </div>
        </div>
      </section>

      <section className="panel protocol-trace-session-bar">
        <div className="protocol-trace-session-current">
          <span className={`protocol-trace-live-dot ${currentSessionStatus}`} />
          <div className="protocol-trace-session-copy">
            <strong>{currentSession?.patientName ?? "Current session"}</strong>
            <span className="subtle mono-value">
              {selectedSessionId ? truncateSessionId(selectedSessionId) : "No session selected"}
            </span>
          </div>
        </div>
        <label className="protocol-trace-session-picker">
          <span className="summary-label">Recent</span>
          <select
            value={selectedSessionId ?? ""}
            onChange={(event) => {
              const next = event.currentTarget.value || null;
              if (next) selectSession(next, true);
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
        <form className="protocol-trace-session-manual" onSubmit={handleSessionSubmit}>
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
        <div className="protocol-trace-toast" role="status">
          <div>
            <strong>New session available</strong>
            <div className="subtle">
              {newSessionNotice.patientName ?? truncateSessionId(newSessionNotice.sessionId)} · {formatRelativeTime(newSessionNotice.lastActivityAt)}
            </div>
          </div>
          <div className="protocol-trace-toast-actions">
            <button
              type="button"
              className="button mini primary"
              onClick={() => {
                selectSession(newSessionNotice.sessionId, true);
                setNewSessionNotice(null);
              }}
            >
              Switch
            </button>
            <button type="button" className="button mini" onClick={() => setNewSessionNotice(null)}>Dismiss</button>
          </div>
        </div>
      )}

      <section className="protocol-trace-main">
        <section className="panel protocol-trace-grid-panel">
          {!selectedSessionId ? (
            <div className="protocol-trace-empty-state">
              <p className="subtle">
                {sessionsStatus === "loading"
                  ? "Looking for recent demo sessions…"
                  : "No active demo sessions yet. Open the health app from the workbench, or paste a session id above to attach."}
              </p>
            </div>
          ) : (
            <div className="protocol-trace-grid-scroll">
              <div className="protocol-trace-grid-stack">
                <section className="protocol-trace-ticket-section">
                  <div className="protocol-trace-grid-section-title">Ticket</div>
                  <TicketTraceCard
                    cell={buildCellPresentation(traceState, { row: "network", column: "ticket" })}
                    selected={resolvedSelectedCell?.row === "network" && resolvedSelectedCell.column === "ticket"}
                    onSelect={() => selectTraceCell({ row: "network", column: "ticket" })}
                  />
                </section>

                <TraceSection
                  title="Network"
                  columns={NETWORK_TRACE_COLUMNS}
                  rows={[
                    {
                      rowKey: "network",
                      label: "Network",
                      subtitle: traceState.network.sites.length ? `${traceState.network.sites.length} sites discovered` : "Waiting for record locations",
                      cellMap: {
                        "resolve-match": buildCellPresentation(traceState, { row: "network", column: "resolve-match" }),
                        "client-setup": buildCellPresentation(traceState, { row: "network", column: "client-setup" }),
                        token: buildCellPresentation(traceState, { row: "network", column: "token" }),
                      },
                    },
                  ]}
                  selectedCell={resolvedSelectedCell}
                  onSelectCell={selectTraceCell}
                />

                {siteRows.length > 0 && (
                  <TraceSection
                    title="Sites"
                    columns={SITE_TRACE_COLUMNS}
                    rows={siteRows.map((site) => ({
                      rowKey: site.siteSlug,
                      label: site.siteName,
                      subtitle: site.jurisdiction ?? humanizeSiteStatus(site.status),
                      status: site.status,
                      cellMap: {
                        "client-setup": buildCellPresentation(traceState, { row: site.siteSlug, column: "client-setup" }),
                        token: buildCellPresentation(traceState, { row: site.siteSlug, column: "token" }),
                        data: buildCellPresentation(traceState, { row: site.siteSlug, column: "data" }),
                      },
                    }))}
                    selectedCell={resolvedSelectedCell}
                    onSelectCell={selectTraceCell}
                  />
                )}
              </div>
            </div>
          )}
        </section>

        <section ref={detailPanelRef} className="panel protocol-trace-detail-panel">
          {!selectedSessionId ? (
            <div className="protocol-trace-empty-state">
              <p className="subtle">Select a recent session or paste a session UUID to load its trace.</p>
            </div>
          ) : !detailModel ? (
            <div className="protocol-trace-empty-state">
              <p className="subtle">Waiting for trace activity… once the ticket is signed and the app starts moving, details will appear here.</p>
            </div>
          ) : (
            <div className="protocol-trace-detail-scroll">
              <div className="protocol-trace-detail-head">
                <div>
                  <p className="eyebrow">Selected Step</p>
                  <h3>{detailModel.title}</h3>
                  {detailModel.subtitle && <p className="subtle">{detailModel.subtitle}</p>}
                </div>
              </div>

              {detailModel.kind === "data-list" ? (
                <DataQueryListPanel
                  siteName={detailModel.siteName}
                  queries={detailModel.queries}
                  totalResources={detailModel.totalResources}
                  selectedQueryDetail={detailModel.selectedQueryDetail}
                  onSelectQuery={(index) => {
                    setSelectedQuery(index);
                  }}
                />
              ) : (
                <>
                  <div className="protocol-trace-detail-stack">
                    <TraceSummaryPanel detailModel={detailModel} />
                    {detailModel.tabs
                      .filter((tab) => tab.key !== "summary")
                      .map((tab) => (
                        <TraceArtifactTabPanel key={tab.key} tab={tab} />
                      ))}
                  </div>

                </>
              )}
            </div>
          )}
        </section>
      </section>
    </main>
  );

  function handleSessionSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const trimmed = sessionInput.trim();
    if (!trimmed) return;
    selectSession(trimmed, true);
  }

  function selectSession(nextSessionId: string, syncInput: boolean) {
    setSelectedSessionId(nextSessionId);
    if (syncInput) setSessionInput(nextSessionId);
    setSelectedCell(null);
    setSelectedQuery(null);
    const nextParams = new URLSearchParams(window.location.search);
    nextParams.set("session", nextSessionId);
    window.history.replaceState(null, "", `${window.location.pathname}?${nextParams.toString()}`);
  }

  function selectTraceCell(cell: TraceCellId) {
    setSelectedCell(cell);
    detailPanelRef.current?.scrollIntoView({ behavior: "instant" as ScrollBehavior, block: "start" });
  }
}

function TraceSection({
  title,
  columns,
  rows,
  selectedCell,
  onSelectCell,
}: {
  title: string;
  columns: TraceColumn[];
  rows: Array<{
    rowKey: string;
    label: string;
    subtitle?: string | null;
    status?: string;
    cellMap: Partial<Record<TraceColumn, TraceCellPresentation | null>>;
  }>;
  selectedCell: TraceCellId | null;
  onSelectCell: (cell: TraceCellId) => void;
}) {
  return (
    <section className="protocol-trace-grid-section">
      <div className="protocol-trace-grid-section-title">{title}</div>
      <div
        className="protocol-trace-swimlane-grid"
        style={{ gridTemplateColumns: `minmax(170px, 210px) repeat(${columns.length}, minmax(210px, 1fr))` }}
      >
        <div className="protocol-trace-grid-corner">Lane</div>
        {columns.map((column) => (
          <div key={column} className="protocol-trace-column-header">{TRACE_COLUMN_LABELS[column]}</div>
        ))}
        {rows.map((row) => (
          <TraceRow
            key={row.rowKey}
            rowKey={row.rowKey}
            label={row.label}
            subtitle={row.subtitle}
            status={row.status}
            columns={columns}
            cellMap={row.cellMap}
            selectedCell={selectedCell}
            onSelectCell={onSelectCell}
          />
        ))}
      </div>
    </section>
  );
}

function TicketTraceCard({
  cell,
  selected,
  onSelect,
}: {
  cell: TraceCellPresentation | null;
  selected: boolean;
  onSelect: () => void;
}) {
  if (!cell) {
    return (
      <div className="protocol-trace-ticket-card pending">
        <div>
          <strong>Waiting for ticket</strong>
          <div className="subtle">The trace will populate once a permission ticket is signed.</div>
        </div>
      </div>
    );
  }
  return (
    <button
      type="button"
      className={`protocol-trace-ticket-card ${cell.tone}${selected ? " selected" : ""}`}
      onClick={onSelect}
    >
      <div className="protocol-trace-ticket-copy">
        <div className="protocol-trace-cell-line">
          <div className="protocol-trace-cell-line-main">
            <span className={`protocol-trace-cell-badge ${cell.badgeTone}`}>{cell.badge}</span>
            <span className="protocol-trace-cell-primary" title={cell.primary}>{cell.primary}</span>
          </div>
        </div>
        <div className="protocol-trace-cell-secondary" title={cell.secondary}>{cell.secondary}</div>
        {cell.meta && <div className="protocol-trace-cell-meta" title={cell.meta}>{cell.meta}</div>}
      </div>
    </button>
  );
}

function TraceRow({
  rowKey,
  label,
  subtitle,
  status,
  columns,
  cellMap,
  selectedCell,
  onSelectCell,
}: {
  rowKey: string;
  label: string;
  subtitle?: string | null;
  status?: string;
  columns: TraceColumn[];
  cellMap: Partial<Record<TraceColumn, TraceCellPresentation | null>>;
  selectedCell: TraceCellId | null;
  onSelectCell: (cell: TraceCellId) => void;
}) {
  return (
    <>
      <div className={`protocol-trace-row-label ${status ? `status-${status}` : ""}`}>
        <div className="protocol-trace-row-title">{label}</div>
        {subtitle && <div className="protocol-trace-row-subtitle">{subtitle}</div>}
      </div>
      {columns.map((column) => {
        const cell = cellMap[column];
        const selected = selectedCell?.row === rowKey && selectedCell.column === column;
        if (!cell) {
          return (
            <div key={`${rowKey}:${column}`} className="protocol-trace-cell pending" aria-hidden="true">
              <div className="protocol-trace-cell-line">
                <div className="protocol-trace-cell-line-main">
                  <span className="protocol-trace-cell-badge neutral">…</span>
                  <span className="protocol-trace-cell-primary">Waiting</span>
                </div>
              </div>
              <div className="protocol-trace-cell-secondary">No event yet</div>
            </div>
          );
        }
        return (
          <button
            key={`${rowKey}:${column}`}
            type="button"
            className={`protocol-trace-cell ${cell.tone}${selected ? " selected" : ""}`}
            onClick={() => onSelectCell({ row: rowKey === "network" ? "network" : rowKey, column })}
          >
            <div className="protocol-trace-cell-line">
              <div className="protocol-trace-cell-line-main">
                <span className={`protocol-trace-cell-badge ${cell.badgeTone}`}>{cell.badge}</span>
                <span className="protocol-trace-cell-primary" title={cell.primary}>{cell.primary}</span>
              </div>
              {cell.statusCode && <span className={`protocol-trace-cell-status ${cell.statusTone ?? "neutral"}`}>{cell.statusCode}</span>}
            </div>
            <div className="protocol-trace-cell-secondary" title={cell.secondary}>{cell.secondary}</div>
            {cell.meta && <div className="protocol-trace-cell-meta" title={cell.meta}>{cell.meta}</div>}
          </button>
        );
      })}
    </>
  );
}

function DataQueryListPanel({
  siteName,
  queries,
  totalResources,
  selectedQueryDetail,
  onSelectQuery,
}: {
  siteName: string;
  queries: Array<DemoQueryResultEvent | DemoQueryFailedEvent>;
  totalResources: number;
  selectedQueryDetail: Extract<TraceDetailModel, { kind: "data-list" }>["selectedQueryDetail"];
  onSelectQuery: (index: number) => void;
}) {
  return (
    <section className="artifact-event-summary">
      <div className="artifact-event-summary-head">
        <div>
          <h3>{siteName} data activity</h3>
          <p className="subtle">{queries.length} quer{queries.length === 1 ? "y" : "ies"} · {totalResources} resources returned</p>
        </div>
      </div>
      <section className="protocol-trace-query-summary">
        <h4>Resource summary</h4>
        <table className="compact-table protocol-trace-query-summary-table">
          <thead>
            <tr>
              <th scope="col">Resource</th>
              <th scope="col">Requests</th>
              <th scope="col">Results</th>
              <th scope="col">Last outcome</th>
            </tr>
          </thead>
          <tbody>
            {summarizeQueryResources(queries).map((entry) => (
              <tr key={entry.resourceType}>
                <th scope="row">{entry.resourceType}</th>
                <td>{entry.requestCount}</td>
                <td>{entry.resultCount}</td>
                <td>{entry.lastOutcome}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
      <section className="protocol-trace-query-requests">
        <div className="artifact-event-summary-head">
          <div>
            <h4>Requests</h4>
            <p className="subtle">Select an individual query to inspect the exact request and response.</p>
          </div>
        </div>
      <div className="protocol-trace-query-list">
        {queries.map((query, index) => (
          <button key={`${query.seq}:${index}`} type="button" className="protocol-trace-query-row" onClick={() => onSelectQuery(index)}>
            <span className="protocol-trace-cell-badge neutral">{query.type === "query-failed" ? "ERR" : "GET"}</span>
            <div className="protocol-trace-query-copy">
              <strong>{query.detail.resourceType}</strong>
              <span className="subtle mono-wrap">{query.detail.queryPath}</span>
            </div>
            <div className="protocol-trace-query-stats">
              {query.type === "query-result" ? `${query.detail.count} results` : query.detail.reason}
            </div>
          </button>
        ))}
      </div>
      </section>
      {selectedQueryDetail && (
        <section className="protocol-trace-query-selected">
          <div className="artifact-event-summary-head">
            <div>
              <h4>{selectedQueryDetail.title}</h4>
              {selectedQueryDetail.subtitle && <p className="subtle mono-wrap">{selectedQueryDetail.subtitle}</p>}
            </div>
          </div>
          <div className="protocol-trace-detail-stack">
            <TraceEventSummarySection summary={selectedQueryDetail.summary} />
            {selectedQueryDetail.tabs
              .filter((tab) => tab.key !== "summary")
              .map((tab) => (
                <TraceArtifactTabPanel key={tab.key} tab={tab} />
              ))}
          </div>
        </section>
      )}
    </section>
  );
}

function TraceSummaryPanel({ detailModel }: { detailModel: TraceDetailModel }) {
  if (!detailModel.summary) {
    return <p className="subtle">No summary is available for this cell.</p>;
  }
  return <TraceEventSummarySection summary={detailModel.summary} history={detailModel.history} />;
}

function TraceEventSummarySection({
  summary,
  history,
}: {
  summary: ReturnType<typeof buildDemoEventSummary>;
  history?: DemoEvent[];
}) {
  return (
    <section className="artifact-event-summary">
      <div className="artifact-event-summary-head">
        <div>
          <h3>Summary</h3>
          <p className="subtle">{summary.description}</p>
        </div>
      </div>
      <dl className="artifact-metadata-grid">
        {summary.fields.map((entry) => (
          <div key={`${entry.label}:${entry.value}`} className="artifact-metadata-item">
            <dt>{entry.label}</dt>
            <dd className="mini-definition-value mono-wrap">{entry.value}</dd>
          </div>
        ))}
      </dl>
      {summary.patientMatch && (
        <div className="artifact-event-callout">
          <strong>Patient match</strong>
          <span>{summary.patientMatch}</span>
        </div>
      )}
      {summary.steps?.length ? (
        <details className="artifact-event-steps" open>
          <summary>Validation steps</summary>
          <div className="artifact-event-step-list">
            {summary.steps.map((step, index) => (
              <div key={`${step.check}:${index}`} className={`artifact-event-step ${step.passed ? "success" : "failure"}`}>
                <div className="artifact-event-step-head">
                  <strong>{step.check}</strong>
                  <span>{step.passed ? "Passed" : "Failed"}</span>
                </div>
                {step.evidence && <div className="subtle mono-wrap">{step.evidence}</div>}
                {step.why && <div className="subtle">{step.why}</div>}
                {step.reason && <div className="subtle">{step.reason}</div>}
              </div>
            ))}
          </div>
        </details>
      ) : null}
      {history && history.length > 1 && (
        <section className="protocol-trace-history">
          <h4>Recent activity</h4>
          <div className="protocol-trace-history-list">
            {history.map((event) => (
              <div key={event.seq} className="protocol-trace-history-item">
                <strong>{event.label}</strong>
                <span className="subtle">{historyLabel(event)}</span>
              </div>
            ))}
          </div>
        </section>
      )}
      <p className="artifact-event-note subtle">{summary.noteText}</p>
    </section>
  );
}

function TraceArtifactTabPanel({ tab }: { tab: EventArtifactTab }) {
  if (tab.kind === "http-request") {
    return (
      <section className="artifact-json-panel">
        <div className="artifact-json-head">
          <h3>{tab.label}</h3>
          <button type="button" className="button mini" onClick={() => void navigator.clipboard.writeText(formatHttpRequestForCopy(tab.content as any))}>
            Copy HTTP
          </button>
        </div>
        <HttpRequestArtifactPanel artifact={tab.content as any} />
      </section>
    );
  }
  if (tab.kind === "http-response") {
    return (
      <section className="artifact-json-panel">
        <div className="artifact-json-head">
          <h3>{tab.label}</h3>
          <button type="button" className="button mini" onClick={() => void navigator.clipboard.writeText(formatHttpResponseForCopy(tab.content as any))}>
            Copy HTTP
          </button>
        </div>
        <HttpResponseArtifactPanel artifact={tab.content as any} />
      </section>
    );
  }
  if (tab.kind === "jwt" && typeof tab.content === "string") {
    try {
      return <JwtArtifactPanel jwt={tab.content} titlePrefix={tab.label} />;
    } catch {
      return <JsonArtifactPanel title={tab.label} content={tab.content} plainText />;
    }
  }
  return <JsonArtifactPanel title={tab.label} content={tab.content} plainText={tab.kind === "text"} />;
}

type TraceCellPresentation = {
  badge: string;
  badgeTone: "neutral" | "success" | "warn" | "error";
  primary: string;
  secondary: string;
  meta?: string;
  statusCode?: string;
  statusTone?: "neutral" | "success" | "error";
  tone: "tone-ticket" | "tone-discovery" | "tone-setup" | "tone-token" | "tone-data" | "tone-error";
};

type TraceDetailModel =
  | {
      kind: "event";
      title: string;
      subtitle?: string | null;
      summary: ReturnType<typeof buildDemoEventSummary>;
      tabs: EventArtifactTab[];
      history: DemoEvent[];
    }
  | {
      kind: "data-list";
      title: string;
      subtitle?: string | null;
      siteName: string;
      queries: Array<DemoQueryResultEvent | DemoQueryFailedEvent>;
      totalResources: number;
      selectedQueryDetail: {
        title: string;
        subtitle?: string | null;
        summary: ReturnType<typeof buildDemoEventSummary>;
        tabs: EventArtifactTab[];
      } | null;
      tabs: [];
      history: Array<DemoQueryResultEvent | DemoQueryFailedEvent>;
      summary: null;
    };

export function buildDetailModel(
  traceState: ReturnType<typeof accumulateTraceState>,
  selectedCell: TraceCellId | null,
  selectedQuery: number | null,
): TraceDetailModel | null {
  if (!selectedCell) return null;
  const cellEvents = cellEventsForTrace(traceState, selectedCell);
  if (!cellEvents.length) return null;

  if (selectedCell.column === "data") {
    const queries = filterTraceQueryEvents(cellEvents as Array<DemoQueryResultEvent | DemoQueryFailedEvent>);
    if (!queries.length) return null;
    const site = traceState.sites.get(selectedCell.row);
    if (!site) return null;
    return {
      kind: "data-list",
      title: `${site.siteName} data queries`,
      subtitle: site.jurisdiction ?? null,
      siteName: site.siteName,
      queries,
      totalResources: site.totalResources,
      selectedQueryDetail: selectedQuery === null || !queries[selectedQuery]
        ? null
        : {
            title: `${site.siteName} · ${queries[selectedQuery]!.detail.resourceType}`,
            subtitle: queries[selectedQuery]!.detail.queryPath,
            summary: buildDemoEventSummary(queries[selectedQuery]!),
            tabs: [{ key: "summary", label: "Summary", kind: "text", content: "" }, ...buildDemoEventArtifactTabs(queries[selectedQuery]!)],
          },
      tabs: [],
      history: queries,
      summary: null,
    };
  }

  const latestEvent = cellEvents[cellEvents.length - 1]!;
  return {
    kind: "event",
    title: latestEvent.label,
    subtitle: eventSubtitle(latestEvent),
    summary: buildDemoEventSummary(latestEvent),
    tabs: [{ key: "summary", label: "Summary", kind: "text", content: "" }, ...buildDemoEventArtifactTabs(latestEvent)],
    history: [...cellEvents].reverse(),
  };
}

function buildCellPresentation(traceState: ReturnType<typeof accumulateTraceState>, cell: TraceCellId): TraceCellPresentation | null {
  const events = cellEventsForTrace(traceState, cell);
  if (!events.length) return null;

  if (cell.column === "ticket") {
    const event = events[0]!;
    const resourceLabel = "detail" in event && Array.isArray((event as any).detail.scopes)
      ? `${(event as any).detail.scopes.length} permissions`
      : "Permission ticket";
    return {
      badge: "JWT",
      badgeTone: "warn",
      primary: "Signed ticket",
      secondary: `${resourceLabel} · ${(event as any).detail.expirySummary}`,
      meta: (event as any).detail.patientName,
      tone: "tone-ticket",
    };
  }

  if (cell.column === "data") {
    const queries = filterTraceQueryEvents(events as Array<DemoQueryResultEvent | DemoQueryFailedEvent>);
    if (!queries.length) return null;
    const site = traceState.sites.get(cell.row);
    const topTypes = summarizeQueryTypes(queries);
    return {
      badge: "Data",
      badgeTone: "success",
      primary: `${site?.totalResources ?? 0} resources`,
      secondary: `${queries.length} quer${queries.length === 1 ? "y" : "ies"} · ${topTypes}`,
      meta: latestEventStatus(queries[queries.length - 1]!),
      tone: "tone-data",
    };
  }

  const latestEvent = events[events.length - 1]!;
  const line = eventLine(latestEvent, cell.column);
  return {
    badge: line.badge,
    badgeTone: line.badgeTone,
    primary: line.primary,
    secondary: line.secondary,
    meta: events.length > 1 ? `${events.length} attempts` : line.meta,
    tone: line.tone,
  };
}

function eventLine(event: DemoEvent, column: Exclude<TraceColumn, "ticket" | "data">): TraceCellPresentation {
  const method = event.artifacts?.request?.method?.toUpperCase();
  const fallbackEndpoint =
    event.type === "registration-request"
      ? event.detail.endpoint
      : event.type === "token-exchange"
        ? event.detail.endpoint
        : "";
  const target = compactEndpointLabel(event.artifacts?.request?.url ?? fallbackEndpoint);
  const status = event.artifacts?.response?.status;

  if (column === "resolve-match") {
    if (event.type === "sites-discovered") {
      return {
        badge: method ?? "POST",
        badgeTone: "neutral",
        primary: target || "/$resolve-record-locations",
        secondary: `${event.detail.sites.length} sites resolved`,
        ...(status ? { statusCode: String(status), statusTone: status >= 400 ? "error" : "success" } : {}),
        tone: "tone-discovery",
      };
    }
  }

  if (column === "client-setup" && event.type === "registration-request") {
    const setupSummary = event.detail.outcome === "registered"
      ? event.detail.registrationMode === "udap-dcr"
        ? "UDAP DCR complete"
        : event.detail.registrationMode === "dynamic-jwk"
          ? "Dynamic registration complete"
          : "Client setup complete"
      : event.detail.error ?? `${event.detail.outcome}`;
    return {
      badge: method ?? "POST",
      badgeTone: event.detail.outcome === "registered" ? "success" : "error",
      primary: target || "/register",
      secondary: setupSummary,
      meta: event.detail.registrationMode === "udap-dcr" ? "UDAP" : event.detail.authMode,
      ...(status ? { statusCode: String(status), statusTone: status >= 400 ? "error" : "success" } : {}),
      tone: event.detail.outcome === "registered" ? "tone-setup" : "tone-error",
    };
  }

  if (column === "token" && event.type === "token-exchange") {
    const scopeCount = event.detail.scopes?.length ?? countScopeSummaryEntries(event.detail.scopeSummary);
    return {
      badge: method ?? "POST",
      badgeTone: event.detail.outcome === "issued" ? "success" : "error",
      primary: target || "/token",
      secondary: event.detail.outcome === "issued"
        ? scopeCount > 0
          ? `${scopeCount} permission${scopeCount === 1 ? "" : "s"} granted`
          : "Access token issued"
        : event.detail.error ?? "Rejected",
      meta: event.detail.siteName ?? (typeof event.detail.authorizedSiteCount === "number" ? `${event.detail.authorizedSiteCount} sites authorized` : event.detail.mode),
      ...(status ? { statusCode: String(status), statusTone: status >= 400 ? "error" : "success" } : {}),
      tone: event.detail.outcome === "issued" ? "tone-token" : "tone-error",
    };
  }

  return {
    badge: method ?? "INFO",
    badgeTone: "neutral",
    primary: event.label,
    secondary: column,
    tone: "tone-discovery",
  };
}

function orderedSiteRows(traceState: ReturnType<typeof accumulateTraceState>) {
  const ordered: SiteTraceState[] = [];
  const seen = new Set<string>();
  for (const site of traceState.network.sites) {
    const row = traceState.sites.get(site.siteSlug);
    if (!row) continue;
    ordered.push(row);
    seen.add(site.siteSlug);
  }
  const extras = [...traceState.sites.values()]
    .filter((site) => !seen.has(site.siteSlug))
    .sort((left, right) => left.siteName.localeCompare(right.siteName));
  return [...ordered, ...extras];
}

function summarizeQueryTypes(queries: Array<DemoQueryResultEvent | DemoQueryFailedEvent>) {
  const counts = new Map<string, number>();
  for (const query of queries) {
    counts.set(query.detail.resourceType, (counts.get(query.detail.resourceType) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .slice(0, 2)
    .map(([resourceType, count]) => `${resourceType}${count > 1 ? ` ×${count}` : ""}`)
    .join(" · ");
}

function summarizeQueryResources(queries: Array<DemoQueryResultEvent | DemoQueryFailedEvent>) {
  const grouped = new Map<string, {
    resourceType: string;
    requestCount: number;
    resultCount: number;
    lastOutcome: string;
  }>();
  for (const query of queries) {
    const current = grouped.get(query.detail.resourceType) ?? {
      resourceType: query.detail.resourceType,
      requestCount: 0,
      resultCount: 0,
      lastOutcome: "",
    };
    current.requestCount += 1;
    if (query.type === "query-result") {
      current.resultCount += query.detail.count;
      current.lastOutcome = `${query.detail.count} results`;
    } else {
      current.lastOutcome = query.detail.reason;
    }
    grouped.set(query.detail.resourceType, current);
  }
  return [...grouped.values()].sort((left, right) => right.resultCount - left.resultCount || left.resourceType.localeCompare(right.resourceType));
}

function latestEventStatus(event: DemoQueryResultEvent | DemoQueryFailedEvent) {
  return event.type === "query-result" ? `${event.detail.count} returned` : event.detail.reason;
}

function eventSubtitle(event: DemoEvent) {
  return `${formatRelativeTime(event.timestamp)} · ${event.type}`;
}

function historyLabel(event: DemoEvent) {
  switch (event.type) {
    case "registration-request":
      return `${event.detail.outcome}${event.detail.clientId ? ` · ${event.detail.clientId}` : ""}`;
    case "token-exchange":
      return event.detail.outcome === "issued" ? event.detail.scopeSummary ?? "issued" : event.detail.error ?? "rejected";
    case "query-result":
      return `${event.detail.resourceType} · ${event.detail.count}`;
    case "query-failed":
      return `${event.detail.resourceType} · ${event.detail.reason}`;
    default:
      return formatRelativeTime(event.timestamp);
  }
}

function humanizeSiteStatus(status: SiteTraceState["status"]) {
  switch (status) {
    case "pending":
      return "Pending";
    case "matching":
      return "Matched";
    case "setting-up":
      return "Client setup";
    case "exchanging":
      return "Exchanging";
    case "ready":
      return "Ready";
    case "error":
      return "Error";
  }
}

function shortenUrl(url: string) {
  if (!url) return "";
  try {
    const parsed = new URL(url, window.location.origin);
    return parsed.origin === window.location.origin ? `${parsed.pathname}${parsed.search}` : parsed.toString();
  } catch {
    return url;
  }
}

function compactEndpointLabel(url: string) {
  if (!url) return "";
  try {
    const parsed = new URL(url, window.location.origin);
    const segments = parsed.pathname.split("/").filter(Boolean);
    const last = segments.at(-1);
    if (!last) return parsed.pathname || "/";
    if (last === "$resolve-record-locations") return "/$resolve-record-locations";
    if (last === "token") return "/token";
    if (last === "register") return "/register";
    return `/${last}`;
  } catch {
    return url;
  }
}

function countScopeSummaryEntries(scopeSummary?: string) {
  if (!scopeSummary) return 0;
  return scopeSummary
    .split(/\s+/)
    .map((value) => value.trim())
    .filter(Boolean).length;
}

function upsertEvent(current: DemoEvent[], next: DemoEvent) {
  if (current.some((event) => event.seq === next.seq)) return current;
  return [...current, next].sort((left, right) => left.seq - right.seq);
}

function traceCellKey(cell: TraceCellId) {
  return `${cell.row}:${cell.column}`;
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
