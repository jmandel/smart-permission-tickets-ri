import { type DemoEvent, type DemoPatientMatchDetail, type DemoQueryFailedEvent, type DemoQueryResultEvent, type DemoRegistrationRequestEvent, type DemoSitesDiscoveredEvent, type DemoTicketCreatedEvent, type DemoTokenExchangeEvent } from "../../../shared/demo-events";

export type TraceColumn = "ticket" | "resolve-match" | "client-setup" | "token" | "data";
export type TraceCellId = {
  row: "network" | string;
  column: TraceColumn;
};

export type SiteStatus = "pending" | "matching" | "setting-up" | "exchanging" | "ready" | "error";

export type SiteTraceState = {
  siteSlug: string;
  siteName: string;
  jurisdiction?: string | null;
  resolveMatchEvent: DemoTokenExchangeEvent | null;
  resolveMatch: DemoPatientMatchDetail | null;
  clientSetupEvents: DemoRegistrationRequestEvent[];
  tokenEvents: DemoTokenExchangeEvent[];
  queries: Array<DemoQueryResultEvent | DemoQueryFailedEvent>;
  totalResources: number;
  status: SiteStatus;
  error?: string;
  updatedAt: number | null;
};

export type NetworkTraceState = {
  resolveMatchEvent: DemoSitesDiscoveredEvent | null;
  clientSetupEvents: DemoRegistrationRequestEvent[];
  tokenEvents: DemoTokenExchangeEvent[];
  sites: Array<{
    siteSlug: string;
    siteName: string;
    jurisdiction?: string | null;
  }>;
  updatedAt: number | null;
};

export type TraceState = {
  ticket: DemoTicketCreatedEvent | null;
  network: NetworkTraceState;
  sites: Map<string, SiteTraceState>;
  selectedCell: TraceCellId | null;
  selectedQuery: number | null;
};

export type TraceOverview = {
  checksPassed: number;
  readySites: number;
  totalSites: number;
  totalResources: number;
  networkSteps: DemoTokenExchangeEvent["detail"]["steps"];
  networkToken: DemoTokenExchangeEvent | null;
  patientMatched: DemoPatientMatchDetail | null;
};

export function createEmptyTraceState(): TraceState {
  return {
    ticket: null,
    network: {
      resolveMatchEvent: null,
      clientSetupEvents: [],
      tokenEvents: [],
      sites: [],
      updatedAt: null,
    },
    sites: new Map(),
    selectedCell: null,
    selectedQuery: null,
  };
}

export function filterTraceQueryEvents(events: Array<DemoQueryResultEvent | DemoQueryFailedEvent>) {
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

export function accumulateTraceState(events: DemoEvent[], previousSelection: TraceCellId | null = null): TraceState {
  const state = createEmptyTraceState();
  for (const event of [...events].sort((left, right) => left.seq - right.seq)) {
    applyTraceEvent(state, event);
  }
  state.selectedCell = defaultSelectedCell(state, previousSelection);
  return state;
}

export function applyTraceEvent(state: TraceState, event: DemoEvent) {
  switch (event.type) {
    case "ticket-created":
      state.ticket = event;
      break;
    case "sites-discovered":
      state.network.resolveMatchEvent = event;
      state.network.sites = event.detail.sites;
      state.network.updatedAt = event.timestamp;
      for (const site of event.detail.sites) {
        ensureSite(state, site.siteSlug, site.siteName, site.jurisdiction ?? null);
      }
      break;
    case "registration-request":
      if (event.detail.siteSlug) {
        const site = ensureSite(state, event.detail.siteSlug, event.detail.siteName ?? event.detail.siteSlug, null);
        site.clientSetupEvents.push(event);
        site.updatedAt = event.timestamp;
      } else {
        state.network.clientSetupEvents.push(event);
        state.network.updatedAt = event.timestamp;
      }
      break;
    case "token-exchange":
      if (event.detail.siteSlug) {
        const site = ensureSite(state, event.detail.siteSlug, event.detail.siteName ?? event.detail.siteSlug, null);
        site.tokenEvents.push(event);
        site.updatedAt = event.timestamp;
        if (event.detail.patientMatch) {
          site.resolveMatchEvent = event;
          site.resolveMatch = event.detail.patientMatch;
        }
        if (event.detail.outcome === "rejected") {
          site.error = event.detail.error ?? "Token exchange rejected";
        }
      } else {
        state.network.tokenEvents.push(event);
        state.network.updatedAt = event.timestamp;
      }
      break;
    case "query-result": {
      const site = ensureSite(state, event.detail.siteSlug, event.detail.siteName, null);
      site.queries.push(event);
      site.updatedAt = event.timestamp;
      if (isVisibleTraceQueryEvent(event)) {
        site.totalResources += event.detail.count;
      }
      break;
    }
    case "query-failed": {
      const site = ensureSite(state, event.detail.siteSlug, event.detail.siteName, null);
      site.queries.push(event);
      site.updatedAt = event.timestamp;
      site.error = event.detail.reason;
      break;
    }
    case "udap-discovery":
    case "session-complete":
      break;
  }
  for (const site of state.sites.values()) {
    site.status = deriveSiteStatus(site);
  }
}

export function defaultSelectedCell(state: TraceState, previousSelection: TraceCellId | null = null): TraceCellId | null {
  if (previousSelection && traceCellIsVisible(state, previousSelection) && traceCellHasContent(state, previousSelection)) return previousSelection;

  const networkCandidates: TraceCellId[] = [
    { row: "network", column: "token" },
    { row: "network", column: "resolve-match" },
    { row: "network", column: "ticket" },
  ];
  for (const candidate of networkCandidates) {
    if (traceCellHasContent(state, candidate)) return candidate;
  }

  let latestSiteCell: { cell: TraceCellId; updatedAt: number } | null = null;
  for (const site of state.sites.values()) {
    const candidates: Array<{ cell: TraceCellId; updatedAt: number | null }> = [
      { cell: { row: site.siteSlug, column: "data" }, updatedAt: latestTimestamp(filterTraceQueryEvents(site.queries)) },
      { cell: { row: site.siteSlug, column: "token" }, updatedAt: latestTimestamp(site.tokenEvents) },
      { cell: { row: site.siteSlug, column: "client-setup" }, updatedAt: latestTimestamp(site.clientSetupEvents) },
    ];
    for (const candidate of candidates) {
      if (!candidate.updatedAt || !traceCellHasContent(state, candidate.cell)) continue;
      if (!latestSiteCell || candidate.updatedAt > latestSiteCell.updatedAt) {
        latestSiteCell = { cell: candidate.cell, updatedAt: candidate.updatedAt };
      }
    }
  }
  return latestSiteCell?.cell ?? null;
}

function traceCellIsVisible(state: TraceState, cell: TraceCellId) {
  if (cell.row === "network") return cell.column !== "data";
  if (cell.column === "client-setup") return true;
  if (cell.column === "resolve-match") return false;
  return cell.column === "token" || cell.column === "data";
}

export function hasVisibleSiteClientSetup(state: TraceState) {
  for (const site of state.sites.values()) {
    if (site.clientSetupEvents.length > 0) return true;
  }
  return false;
}

export function buildTraceOverview(state: TraceState): TraceOverview {
  const networkToken = latestEvent(state.network.tokenEvents);
  const networkSteps = networkToken?.detail.steps ?? [];
  let readySites = 0;
  let totalResources = 0;
  for (const site of state.sites.values()) {
    if (site.status === "ready") readySites += 1;
    totalResources += site.totalResources;
  }
  return {
    checksPassed: networkSteps.filter((step) => step.passed).length,
    readySites,
    totalSites: state.sites.size,
    totalResources,
    networkSteps,
    networkToken,
    patientMatched: networkToken?.detail.patientMatch ?? null,
  };
}

export function traceCellHasContent(state: TraceState, cell: TraceCellId) {
  if (cell.row === "network") {
    switch (cell.column) {
      case "ticket":
        return Boolean(state.ticket);
      case "resolve-match":
        return Boolean(state.network.resolveMatchEvent);
      case "client-setup":
        return state.network.clientSetupEvents.length > 0;
      case "token":
        return state.network.tokenEvents.length > 0;
      case "data":
        return false;
    }
  }
  const site = state.sites.get(cell.row);
  if (!site) return false;
  switch (cell.column) {
    case "ticket":
      return false;
    case "resolve-match":
      return Boolean(site.resolveMatchEvent);
    case "client-setup":
      return site.clientSetupEvents.length > 0;
    case "token":
      return site.tokenEvents.length > 0;
    case "data":
      return filterTraceQueryEvents(site.queries).length > 0;
  }
}

export function cellEventsForTrace(state: TraceState, cell: TraceCellId): DemoEvent[] {
  if (cell.row === "network") {
    switch (cell.column) {
      case "ticket":
        return state.ticket ? [state.ticket] : [];
      case "resolve-match":
        return state.network.resolveMatchEvent ? [state.network.resolveMatchEvent] : [];
      case "client-setup":
        return state.network.clientSetupEvents;
      case "token":
        return state.network.tokenEvents;
      case "data":
        return [];
    }
  }
  const site = state.sites.get(cell.row);
  if (!site) return [];
  switch (cell.column) {
    case "ticket":
      return [];
    case "resolve-match":
      return site.resolveMatchEvent ? [site.resolveMatchEvent] : [];
    case "client-setup":
      return site.clientSetupEvents;
    case "token":
      return site.tokenEvents;
    case "data":
      return filterTraceQueryEvents(site.queries);
  }
}

function ensureSite(state: TraceState, siteSlug: string, siteName: string, jurisdiction?: string | null) {
  const current = state.sites.get(siteSlug);
  if (current) {
    if (!current.siteName && siteName) current.siteName = siteName;
    if (!current.jurisdiction && jurisdiction) current.jurisdiction = jurisdiction;
    return current;
  }
  const created: SiteTraceState = {
    siteSlug,
    siteName,
    jurisdiction,
    resolveMatchEvent: null,
    resolveMatch: null,
    clientSetupEvents: [],
    tokenEvents: [],
    queries: [],
    totalResources: 0,
    status: "pending",
    updatedAt: null,
  };
  state.sites.set(siteSlug, created);
  return created;
}

function deriveSiteStatus(site: SiteTraceState): SiteStatus {
  if (site.error || latestEvent(site.tokenEvents)?.detail.outcome === "rejected") return "error";
  if (filterTraceQueryEvents(site.queries).length > 0 || latestEvent(site.tokenEvents)?.detail.outcome === "issued") return "ready";
  if (site.tokenEvents.length > 0) return "exchanging";
  if (site.clientSetupEvents.length > 0) return "setting-up";
  if (site.resolveMatchEvent) return "matching";
  return "pending";
}

function isVisibleTraceQueryEvent(event: DemoQueryResultEvent | DemoQueryFailedEvent) {
  return filterTraceQueryEvents([event]).length > 0;
}

function latestTimestamp(events: Array<{ timestamp: number }>) {
  return events.length ? events[events.length - 1]!.timestamp : null;
}

function latestEvent<T>(events: T[]) {
  return events.length ? events[events.length - 1]! : null;
}
