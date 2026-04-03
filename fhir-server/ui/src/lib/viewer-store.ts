import { create } from "zustand";

import { decodeViewerLaunch } from "../demo";
import type { RegisteredClientInfo, TokenResponseInfo, ViewerLaunch, ViewerLaunchSite } from "../types";
import {
  exchangeTokenAtEndpoint,
  exchangeSurfaceToken,
  fetchCapabilityStatementFromFhirBase,
  fetchFhirAllPagesFromBase,
  fetchFhirFromBase,
  fetchPreviewSiteFhir,
  fetchPreviewSiteFhirAllPages,
  fetchSmartConfig,
  fetchSmartConfigFromFhirBase,
  introspectTokenAtEndpoint,
  introspectSurfaceToken,
  registerViewerClient,
  resolveRecordLocations,
} from "./viewer-client";
import { CROSS_SITE_PATIENT_IDENTIFIER_SYSTEM } from "../../../src/store/model";
import {
  buildSiteQueryPlan,
  summarizeSiteResources,
  type ViewerResourceItem,
  type ViewerSiteRun,
} from "./viewer-model";

// ---------------------------------------------------------------------------
// Concurrency control
// ---------------------------------------------------------------------------

/**
 * Configurable concurrency limit for parallel fetches.
 *
 * Browser HTTP/2 multiplexes many streams over a single connection to the same
 * origin, so we don't need to worry about connection-pool exhaustion.  But we
 * still cap concurrency so the UI gets incremental updates and we don't flood
 * a single-threaded server.  The limit applies independently to:
 *   • site-level pipelines (config → token → data), and
 *   • FHIR resource queries within a single site.
 *
 * Set to `Infinity` to remove the cap entirely (fine when every request goes
 * to the same HTTP/2 origin).  Set to 1 to restore fully-serial behaviour.
 */
const SITE_CONCURRENCY = 6;
const QUERY_CONCURRENCY = 8;

/** Run an array of async tasks with at most `limit` in flight at once. */
async function mapConcurrent<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let nextIndex = 0;

  async function worker() {
    while (nextIndex < items.length) {
      const i = nextIndex++;
      results[i] = await fn(items[i]);
    }
  }

  const workers = Array.from({ length: Math.min(limit, items.length) }, () => worker());
  await Promise.all(workers);
  return results;
}

// ---------------------------------------------------------------------------
// Store types
// ---------------------------------------------------------------------------

export type ViewerQueryResult = {
  siteSlug: string;
  siteName: string;
  relativePath: string;
  fullUrl: string;
  payload: any;
  shownCount: number;
  totalCount: number;
  error: string | null;
};

type ViewerStore = {
  sessionKey: string | null;
  launch: ViewerLaunch | null;
  loading: boolean;
  error: string | null;
  sharedClient: RegisteredClientInfo | null;
  networkSmartConfig: Record<string, any> | null;
  networkTokenResponse: TokenResponseInfo | null;
  networkTokenClaims: Record<string, any> | null;
  networkIntrospection: Record<string, any> | null;
  networkRecordLocations: Record<string, any> | null;
  siteRuns: ViewerSiteRun[];
  queryPath: string;
  queryRunning: boolean;
  queryResults: ViewerQueryResult[] | null;
  timelineStartIndex: number;
  timelineEndIndex: number;
  selectedEncounterKeys: string[];
  initSession: (encodedSession: string) => Promise<void>;
  setQueryPath: (queryPath: string) => void;
  runCrossSiteQuery: () => Promise<void>;
  setTimelineWindow: (startIndex: number, endIndex: number) => void;
  setSelectedEncounterKeys: (encounterKeys: string[]) => void;
};

// ---------------------------------------------------------------------------
// Store implementation
// ---------------------------------------------------------------------------

export const useViewerStore = create<ViewerStore>((set, get) => ({
  sessionKey: null,
  launch: null,
  loading: false,
  error: null,
  sharedClient: null,
  networkSmartConfig: null,
  networkTokenResponse: null,
  networkTokenClaims: null,
  networkIntrospection: null,
  networkRecordLocations: null,
  siteRuns: [],
  queryPath: "Observation",
  queryRunning: false,
  queryResults: null,
  timelineStartIndex: 0,
  timelineEndIndex: Number.MAX_SAFE_INTEGER,
  selectedEncounterKeys: [],

  initSession: async (encodedSession) => {
    if (get().sessionKey === encodedSession && (get().launch || get().error)) return;

    let launch: ViewerLaunch | null = null;
    try {
      launch = decodeViewerLaunch(encodedSession);
    } catch {
      set({
        sessionKey: encodedSession,
        launch: null,
        loading: false,
        error: "Invalid session payload",
        sharedClient: null,
        networkSmartConfig: null,
        networkTokenResponse: null,
        networkTokenClaims: null,
        networkIntrospection: null,
        networkRecordLocations: null,
        siteRuns: [],
        queryResults: null,
        selectedEncounterKeys: [],
        timelineStartIndex: 0,
        timelineEndIndex: Number.MAX_SAFE_INTEGER,
      });
      return;
    }

    set({
      sessionKey: encodedSession,
      launch,
      loading: true,
      error: null,
      sharedClient: null,
      networkSmartConfig: null,
      networkTokenResponse: null,
      networkTokenClaims: null,
      networkIntrospection: null,
      networkRecordLocations: null,
      siteRuns: [],
      queryResults: null,
      selectedEncounterKeys: [],
      timelineStartIndex: 0,
      timelineEndIndex: Number.MAX_SAFE_INTEGER,
    });

    const cancelled = () => get().sessionKey !== encodedSession;

    let sharedClient: RegisteredClientInfo | null = null;

    try {
      // ---------------------------------------------------------------
      // Phase 1 — Network bootstrap (serial: each step needs the last)
      // ---------------------------------------------------------------

      if (launch.mode === "strict" || launch.mode === "registered" || launch.mode === "key-bound") {
        if (!launch.clientBootstrap) throw new Error("Missing viewer client bootstrap");
        sharedClient = await registerViewerClient(
          launch.origin,
          launch.network.authSurface,
          launch.clientBootstrap.clientName,
          launch.clientBootstrap.publicJwk,
        );
        if (cancelled()) return;
        set({ sharedClient });
      }

      if (!launch.signedTicket) throw new Error("Missing signed Permission Ticket");
      const networkSmartConfig = await fetchSmartConfig(launch.origin, launch.network.authSurface);
      if (cancelled()) return;
      set({ networkSmartConfig });

      const { tokenResponse: networkTokenResponse, tokenClaims: networkTokenClaims } = await exchangeSurfaceToken(
        launch.origin,
        launch.network.authSurface,
        launch.signedTicket,
        sharedClient,
        launch.clientBootstrap?.privateJwk ?? null,
        launch.proofJkt,
      );
      if (cancelled()) return;
      set({ networkTokenResponse, networkTokenClaims });

      // ║ Introspect and resolve-record-locations are independent — run
      // ║ them in parallel.  Both only need networkTokenResponse.
      const [networkIntrospection, recordLocationResolution] = await Promise.all([
        introspectSurfaceToken(
          launch.origin,
          launch.network.authSurface,
          networkTokenResponse.access_token,
          sharedClient,
          launch.clientBootstrap?.privateJwk ?? null,
          launch.proofJkt,
        ),
        resolveRecordLocations(
          launch.origin,
          launch.mode,
          launch.network.authSurface,
          networkTokenResponse.access_token,
          launch.proofJkt,
        ),
      ]);
      if (cancelled()) return;
      set({ networkIntrospection });

      const resolvedSites = recordLocationResolution.sites;
      set({ networkRecordLocations: recordLocationResolution.bundle });
      if (!resolvedSites.length) {
        set({
          loading: false,
          error: "No sites returned visible data under the current Permission Ticket.",
          siteRuns: [],
        });
        return;
      }

      set({
        siteRuns: resolvedSites.map(initialSiteRun),
      });

      // ---------------------------------------------------------------
      // Phase 2 — Per-site pipelines, all in parallel (capped)
      //
      // Dependency graph within each site:
      //
      //   smartConfig ┐
      //               ├→ tokenExchange → patientId ┐
      //   capability  ┘                            ├→ resource queries (parallel)
      //                   introspect (fire & forget)┘
      // ---------------------------------------------------------------

      await mapConcurrent(resolvedSites, SITE_CONCURRENCY, async (site) => {
        if (cancelled()) return;
        try {
          await loadOneSite(launch!, encodedSession, site, sharedClient, set, get);
        } catch (siteError) {
          if (cancelled()) return;
          updateRun(
            encodedSession,
            site.siteSlug,
            {
              phase: "error",
              error: siteError instanceof Error ? siteError.message : "Failed to load site",
            },
            set,
            get,
          );
        }
      });

      if (!cancelled()) {
        set({ loading: false, error: null, sharedClient });
      }
    } catch (error) {
      if (!cancelled()) {
        set({
          loading: false,
          error: error instanceof Error ? error.message : "Failed to load viewer session",
        });
      }
    }
  },

  setQueryPath: (queryPath) => set({ queryPath }),

  // Run the same ad-hoc FHIR query across all ready sites, in parallel.
  runCrossSiteQuery: async () => {
    const { launch, queryPath, siteRuns, sessionKey } = get();
    if (!launch) return;
    const relativePath = normalizeRelativeQuery(queryPath);
    if (!relativePath) return;
    set({ queryRunning: true, queryResults: [] });

    try {
      const results = await mapConcurrent(siteRuns, SITE_CONCURRENCY, async (run) => {
        if (get().sessionKey !== sessionKey) return null;
        try {
          const siteFhirBaseUrl = String(run.smartConfig?.fhir_base_url ?? `${launch.origin}${run.site.authSurface.fhirBasePath}`);
          const payload =
            launch.mode === "anonymous"
              ? await fetchPreviewSiteFhir(launch.origin, run.site, relativePath)
              : run.tokenResponse?.access_token
                ? await fetchFhirFromBase(siteFhirBaseUrl, relativePath, run.tokenResponse.access_token, run.proofJkt)
                : null;
          const { shownCount, totalCount } = inferPayloadCounts(payload);
          return {
            siteSlug: run.site.siteSlug,
            siteName: run.site.orgName,
            relativePath,
            fullUrl:
              launch.mode === "anonymous"
                ? `${launch.origin}${run.site.authSurface.previewFhirBasePath}/${relativePath}`
                : `${siteFhirBaseUrl.replace(/\/+$/, "")}/${relativePath}`,
            payload,
            shownCount,
            totalCount,
            error: payload ? null : "No access token issued for this site",
          } as ViewerQueryResult;
        } catch (error) {
          const siteFhirBaseUrl = String(run.smartConfig?.fhir_base_url ?? `${launch.origin}${run.site.authSurface.fhirBasePath}`);
          return {
            siteSlug: run.site.siteSlug,
            siteName: run.site.orgName,
            relativePath,
            fullUrl:
              launch.mode === "anonymous"
                ? `${launch.origin}${run.site.authSurface.previewFhirBasePath}/${relativePath}`
                : `${siteFhirBaseUrl.replace(/\/+$/, "")}/${relativePath}`,
            payload: null,
            shownCount: 0,
            totalCount: 0,
            error: error instanceof Error ? error.message : "Query failed",
          } as ViewerQueryResult;
        }
      });
      if (get().sessionKey === sessionKey) {
        set({ queryResults: results.filter((r): r is ViewerQueryResult => r !== null) });
      }
    } finally {
      set({ queryRunning: false });
    }
  },

  setTimelineWindow: (startIndex, endIndex) =>
    set({
      timelineStartIndex: Math.max(0, Math.min(startIndex, endIndex)),
      timelineEndIndex: Math.max(startIndex, endIndex),
    }),

  setSelectedEncounterKeys: (selectedEncounterKeys) => set({ selectedEncounterKeys }),
}));

// ---------------------------------------------------------------------------
// Per-site pipeline — maximally parallel within the dependency graph
// ---------------------------------------------------------------------------

async function loadOneSite(
  launch: ViewerLaunch,
  encodedSession: string,
  site: ViewerLaunchSite,
  sharedClient: RegisteredClientInfo | null,
  set: (partial: Partial<ViewerStore> | ((state: ViewerStore) => Partial<ViewerStore>)) => void,
  get: () => ViewerStore,
) {
  const cancelled = () => get().sessionKey !== encodedSession;

  updateRun(encodedSession, site.siteSlug, { phase: "loading-config", error: null }, set, get);
  const siteFhirBaseUrl = site.fhirBaseUrl ?? `${launch.origin}${site.authSurface.fhirBasePath}`;

  // smartConfig and capabilityStatement are independent — fetch in parallel.
  const [smartConfig, capabilityStatement] = await Promise.all([
    fetchSmartConfigFromFhirBase(siteFhirBaseUrl),
    fetchCapabilityStatementFromFhirBase(siteFhirBaseUrl),
  ]);
  if (cancelled()) return;
  updateRun(encodedSession, site.siteSlug, { smartConfig, capabilityStatement }, set, get);

  const privateJwk = launch.clientBootstrap?.privateJwk ?? null;
  let accessToken: string | null = null;
  let proofJkt: string | null = launch.proofJkt;
  let patientId: string | null = null;

  if (launch.mode !== "anonymous") {
    if (!launch.signedTicket) throw new Error("Missing signed ticket for token exchange");

    // Token exchange must complete before we can introspect or query.
    updateRun(encodedSession, site.siteSlug, { phase: "exchanging-token" }, set, get);
    const { tokenResponse, tokenClaims } = await exchangeTokenAtEndpoint(
      String(smartConfig.token_endpoint),
      launch.signedTicket,
      sharedClient,
      privateJwk,
      proofJkt,
    );
    accessToken = tokenResponse.access_token;
    if (cancelled()) return;
    updateRun(encodedSession, site.siteSlug, { tokenResponse, tokenClaims, proofJkt }, set, get);

    // Introspection and patient-id resolution are independent of each
    // other — both only need the access token.  Fire them in parallel.
    updateRun(encodedSession, site.siteSlug, { phase: "introspecting-token" }, set, get);
    const [introspection, resolvedPatientId] = await Promise.all([
      introspectTokenAtEndpoint(
        String(smartConfig.introspection_endpoint),
        accessToken,
        sharedClient,
        privateJwk,
        proofJkt,
      ),
      typeof tokenResponse.patient === "string"
        ? Promise.resolve(tokenResponse.patient)
        : resolveSitePatientId(launch, site, null, accessToken, proofJkt, smartConfig),
    ]);
    if (cancelled()) return;
    patientId = resolvedPatientId;
    updateRun(encodedSession, site.siteSlug, { introspection, patientId }, set, get);
  } else {
    patientId = await resolveSitePatientId(launch, site, null, null, null, smartConfig);
  }

  if (!patientId) {
    throw new Error("Unable to resolve a site patient from the current ticket");
  }

  // -----------------------------------------------------------------------
  // Load FHIR resources — all query types in parallel (capped).
  // -----------------------------------------------------------------------
  updateRun(encodedSession, site.siteSlug, { phase: "loading-data" }, set, get);
  const { resources, queryErrors } = await loadSiteResources(
    launch, site, patientId, capabilityStatement, accessToken, proofJkt, smartConfig,
  );
  if (cancelled()) return;
  updateRun(encodedSession, site.siteSlug, { phase: "ready", resources, queryErrors, error: null, patientId }, set, get);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function initialSiteRun(site: ViewerLaunchSite): ViewerSiteRun {
  return {
    site,
    patientId: site.patientId ?? null,
    phase: "idle",
    smartConfig: null,
    capabilityStatement: null,
    tokenResponse: null,
    tokenClaims: null,
    introspection: null,
    proofJkt: null,
    error: null,
    queryErrors: [],
    resources: [],
  };
}

function updateRun(
  encodedSession: string,
  siteSlug: string,
  patch: Partial<ViewerSiteRun>,
  set: (partial: Partial<ViewerStore> | ((state: ViewerStore) => Partial<ViewerStore>)) => void,
  get: () => ViewerStore,
) {
  if (get().sessionKey !== encodedSession) return;
  set((state) => ({
    siteRuns: state.siteRuns.map((run) => (run.site.siteSlug === siteSlug ? { ...run, ...patch } : run)),
  }));
}

/**
 * Load all FHIR resources for a site.  Each query from the plan is fired in
 * parallel up to QUERY_CONCURRENCY.
 */
async function loadSiteResources(
  launch: ViewerLaunch,
  site: ViewerLaunchSite,
  patientId: string,
  capabilityStatement: Record<string, any> | null,
  accessToken: string | null,
  proofJkt: string | null,
  smartConfig: Record<string, any> | null,
) {
  const allResources: ViewerResourceItem[] = [];
  const queryErrors: Array<{ label: string; relativePath: string; message: string }> = [];
  const siteFhirBaseUrl = String(smartConfig?.fhir_base_url ?? `${launch.origin}${site.authSurface.fhirBasePath}`);
  const queries = buildSiteQueryPlan(launch, site, patientId, capabilityStatement);

  await mapConcurrent(queries, QUERY_CONCURRENCY, async (query) => {
    const fullUrl =
      launch.mode === "anonymous"
        ? `${launch.origin}${site.authSurface.previewFhirBasePath}/${query.relativePath}`
        : `${siteFhirBaseUrl.replace(/\/+$/, "")}/${query.relativePath}`;
    try {
      const payload =
        launch.mode === "anonymous"
          ? await fetchPreviewSiteFhirAllPages(launch.origin, site, query.relativePath)
          : await fetchFhirAllPagesFromBase(siteFhirBaseUrl, query.relativePath, accessToken, proofJkt);
      allResources.push(...summarizeSiteResources(site, payload, fullUrl));
    } catch (error) {
      queryErrors.push({
        label: query.label,
        relativePath: query.relativePath,
        message: error instanceof Error ? error.message : "Query failed",
      });
    }
  });

  return { resources: dedupeResources(allResources), queryErrors };
}

function dedupeResources(resources: ViewerResourceItem[]) {
  const seen = new Map<string, ViewerResourceItem>();
  for (const item of resources) seen.set(item.key, item);
  return [...seen.values()];
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

async function resolveSitePatientId(
  launch: ViewerLaunch,
  site: ViewerLaunchSite,
  _capabilityStatement: Record<string, any> | null,
  accessToken: string | null,
  proofJkt: string | null,
  smartConfig: Record<string, any> | null,
) {
  const relativePath =
    `Patient?identifier=${encodeURIComponent(CROSS_SITE_PATIENT_IDENTIFIER_SYSTEM)}|${encodeURIComponent(launch.person.personId)}&_count=2`;
  const payload =
    launch.mode === "anonymous"
      ? await fetchPreviewSiteFhir(launch.origin, site, relativePath)
      : await fetchFhirFromBase(String(smartConfig?.fhir_base_url ?? `${launch.origin}${site.authSurface.fhirBasePath}`), relativePath, accessToken, proofJkt);
  const entries = payload?.entry ?? [];
  if (!entries.length) return null;
  const match = entries[0]?.resource;
  return typeof match?.id === "string" ? match.id : null;
}
