export type DemoEventSource = "server" | "viewer";
export type DemoEventPhase = "ticket" | "registration" | "network-auth" | "discovery" | "site-auth" | "data" | "complete";

export type DemoHttpRequestArtifact = {
  method: string;
  url: string;
  headers: Record<string, string>;
  body?: unknown;
};

export type DemoHttpResponseArtifact = {
  status: number;
  headers: Record<string, string>;
  body?: unknown;
};

export type DemoRelatedArtifact = {
  label: string;
  kind: "jwt" | "json" | "text";
  content: unknown;
  copyText?: string;
  subtitle?: string;
};

export type DemoAuditStep = {
  check: string;
  passed: boolean;
  evidence?: string;
  why?: string;
  reason?: string;
};

export type DemoPatientMatchDetail = {
  patientName: string;
  siteCount: number;
  siteSlug?: string;
  siteName?: string;
};

export type DemoEventArtifacts = {
  request?: DemoHttpRequestArtifact;
  response?: DemoHttpResponseArtifact;
  related?: DemoRelatedArtifact[];
};

type DemoEventEnvelope<TType extends string, TPhase extends DemoEventPhase, TDetail> = {
  seq: number;
  timestamp: number;
  source: DemoEventSource;
  phase: TPhase;
  type: TType;
  label: string;
  detail: TDetail;
  artifacts?: DemoEventArtifacts;
};

type DemoEventDraftEnvelope<TType extends string, TPhase extends DemoEventPhase, TDetail> = Omit<
  DemoEventEnvelope<TType, TPhase, TDetail>,
  "seq" | "timestamp" | "phase"
> & {
  phase?: TPhase;
};

export type DemoTicketCreatedEvent = DemoEventEnvelope<
  "ticket-created",
  "ticket",
  {
    patientName: string;
    patientDob?: string | null;
    scopes: string[];
    dateSummary: string;
    sensitiveSummary: string;
    expirySummary: string;
    bindingSummary: string;
  }
>;

export type DemoTokenExchangeEvent = DemoEventEnvelope<
  "token-exchange",
  "network-auth" | "site-auth",
  {
    grantType: string;
    endpoint: string;
    mode: string;
    outcome: "issued" | "rejected";
    clientAuthMode?: string;
    clientId?: string;
    scopes?: string[];
    scopeSummary?: string;
    siteSlug?: string;
    siteName?: string;
    authorizedSiteCount?: number;
    patientMatch?: DemoPatientMatchDetail;
    steps: DemoAuditStep[];
    error?: string;
  }
>;

export type DemoRegistrationRequestEvent = DemoEventEnvelope<
  "registration-request",
  "registration",
  {
    authMode: string;
    endpoint: string;
    outcome: "registered" | "rejected" | "cancelled";
    siteSlug?: string;
    siteName?: string;
    clientId?: string;
    registrationMode?: string;
    frameworkUri?: string;
    entityUri?: string;
    algorithm: string;
    steps: DemoAuditStep[];
    error?: string;
  }
>;

export type DemoUdapDiscoveryEvent = DemoEventEnvelope<
  "udap-discovery",
  "registration",
  {
    endpoint: string;
  }
>;

export type DemoSitesDiscoveredEvent = DemoEventEnvelope<
  "sites-discovered",
  "discovery",
  {
    sites: Array<{
      siteSlug: string;
      siteName: string;
      jurisdiction?: string | null;
    }>;
  }
>;

export type DemoQueryResultEvent = DemoEventEnvelope<
  "query-result",
  "data",
  {
    siteSlug: string;
    siteName: string;
    resourceType: string;
    count: number;
    queryPath: string;
  }
>;

export type DemoQueryFailedEvent = DemoEventEnvelope<
  "query-failed",
  "data",
  {
    siteSlug: string;
    siteName: string;
    resourceType: string;
    queryPath: string;
    reason: string;
  }
>;

export type DemoSessionCompleteEvent = DemoEventEnvelope<
  "session-complete",
  "complete",
  {
    totalSites: number;
    totalResources: number;
    queryCount: number;
  }
>;

export type DemoEvent =
  | DemoTicketCreatedEvent
  | DemoTokenExchangeEvent
  | DemoRegistrationRequestEvent
  | DemoUdapDiscoveryEvent
  | DemoSitesDiscoveredEvent
  | DemoQueryResultEvent
  | DemoQueryFailedEvent
  | DemoSessionCompleteEvent;

export type DemoEventDraft =
  | DemoEventDraftEnvelope<"ticket-created", "ticket", DemoTicketCreatedEvent["detail"]>
  | DemoEventDraftEnvelope<"token-exchange", "network-auth" | "site-auth", DemoTokenExchangeEvent["detail"]>
  | DemoEventDraftEnvelope<"registration-request", "registration", DemoRegistrationRequestEvent["detail"]>
  | DemoEventDraftEnvelope<"udap-discovery", "registration", DemoUdapDiscoveryEvent["detail"]>
  | DemoEventDraftEnvelope<"sites-discovered", "discovery", DemoSitesDiscoveredEvent["detail"]>
  | DemoEventDraftEnvelope<"query-result", "data", DemoQueryResultEvent["detail"]>
  | DemoEventDraftEnvelope<"query-failed", "data", DemoQueryFailedEvent["detail"]>
  | DemoEventDraftEnvelope<"session-complete", "complete", DemoSessionCompleteEvent["detail"]>;

export type DemoObserver = {
  sessionId: string;
  emit: (event: DemoEventDraft) => DemoEvent;
};

export type DemoSessionSummary = {
  sessionId: string;
  createdAt: number;
  lastActivityAt: number;
  lastEventAt: number | null;
  eventCount: number;
  patientName?: string | null;
};

export function isDemoEventDraft(value: unknown): value is DemoEventDraft {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<DemoEventDraft>;
  return (
    typeof candidate.type === "string"
    && typeof candidate.label === "string"
    && typeof candidate.source === "string"
    && candidate.detail !== undefined
  );
}

export function deriveDemoEventPhase(event: Pick<DemoEvent | DemoEventDraft, "type" | "detail"> & { phase?: DemoEventPhase }) {
  const detailWithSite = event.detail as { siteSlug?: string };
  switch (event.type) {
    case "ticket-created":
      return "ticket";
    case "registration-request":
    case "udap-discovery":
      return "registration";
    case "sites-discovered":
      return "discovery";
    case "query-result":
    case "query-failed":
      return "data";
    case "session-complete":
      return "complete";
    case "token-exchange":
      return detailWithSite.siteSlug ? "site-auth" : "network-auth";
  }
}
