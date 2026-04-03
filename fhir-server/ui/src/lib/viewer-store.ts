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

    let sharedClient: RegisteredClientInfo | null = null;

    try {
      if (launch.mode === "strict" || launch.mode === "registered" || launch.mode === "key-bound") {
        if (!launch.clientBootstrap) throw new Error("Missing viewer client bootstrap");
        sharedClient = await registerViewerClient(
          launch.origin,
          launch.network.authSurface,
          launch.clientBootstrap.clientName,
          launch.clientBootstrap.publicJwk,
        );
        if (get().sessionKey !== encodedSession) return;
        set({ sharedClient });
      }

      if (!launch.signedTicket) throw new Error("Missing signed Permission Ticket");
      const networkSmartConfig = await fetchSmartConfig(launch.origin, launch.network.authSurface);
      if (get().sessionKey !== encodedSession) return;
      set({ networkSmartConfig });

      const { tokenResponse: networkTokenResponse, tokenClaims: networkTokenClaims } = await exchangeSurfaceToken(
        launch.origin,
        launch.network.authSurface,
        launch.signedTicket,
        sharedClient,
        launch.clientBootstrap?.privateJwk ?? null,
        launch.proofJkt,
      );
      if (get().sessionKey !== encodedSession) return;
      set({ networkTokenResponse, networkTokenClaims });

      const networkIntrospection = await introspectSurfaceToken(
        launch.origin,
        launch.network.authSurface,
        networkTokenResponse.access_token,
        sharedClient,
        launch.clientBootstrap?.privateJwk ?? null,
        launch.proofJkt,
      );
      if (get().sessionKey !== encodedSession) return;
      set({ networkIntrospection });

      const recordLocationResolution = await resolveRecordLocations(
        launch.origin,
        launch.mode,
        launch.network.authSurface,
        networkTokenResponse.access_token,
        launch.proofJkt,
      );
      if (get().sessionKey !== encodedSession) return;
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

      for (const site of resolvedSites) {
        try {
          updateRun(encodedSession, site.siteSlug, { phase: "loading-config", error: null }, set, get);
          const siteFhirBaseUrl = site.fhirBaseUrl ?? `${launch.origin}${site.authSurface.fhirBasePath}`;
          const smartConfig = await fetchSmartConfigFromFhirBase(siteFhirBaseUrl);
          const capabilityStatement = await fetchCapabilityStatementFromFhirBase(siteFhirBaseUrl);
          if (get().sessionKey !== encodedSession) return;
          updateRun(encodedSession, site.siteSlug, { smartConfig, capabilityStatement }, set, get);

          const privateJwk = launch.clientBootstrap?.privateJwk ?? null;
          let accessToken: string | null = null;
          let proofJkt: string | null = launch.proofJkt;
          let patientId: string | null = null;

          if (launch.mode !== "anonymous") {
            if (!launch.signedTicket) throw new Error("Missing signed ticket for token exchange");
            updateRun(encodedSession, site.siteSlug, { phase: "exchanging-token" }, set, get);
            const { tokenResponse, tokenClaims } = await exchangeTokenAtEndpoint(
              String(smartConfig.token_endpoint),
              launch.signedTicket,
              sharedClient,
              privateJwk,
              proofJkt,
            );
            accessToken = tokenResponse.access_token;
            patientId =
              typeof tokenResponse.patient === "string"
                ? tokenResponse.patient
                : await resolveSitePatientId(launch, site, null, accessToken, proofJkt, smartConfig);
            if (get().sessionKey !== encodedSession) return;
            updateRun(encodedSession, site.siteSlug, { tokenResponse, tokenClaims, proofJkt, patientId }, set, get);

            updateRun(encodedSession, site.siteSlug, { phase: "introspecting-token" }, set, get);
            const introspection = await introspectTokenAtEndpoint(
              String(smartConfig.introspection_endpoint),
              accessToken,
              sharedClient,
              privateJwk,
              proofJkt,
            );
            if (get().sessionKey !== encodedSession) return;
            updateRun(encodedSession, site.siteSlug, { introspection }, set, get);
          } else {
            patientId = await resolveSitePatientId(launch, site, null, null, null, smartConfig);
          }

          if (!patientId) {
            throw new Error("Unable to resolve a site patient from the current ticket");
          }

          updateRun(encodedSession, site.siteSlug, { phase: "loading-data" }, set, get);
          const { resources, queryErrors } = await loadSiteResources(launch, site, patientId, capabilityStatement, accessToken, proofJkt, smartConfig);
          if (get().sessionKey !== encodedSession) return;
          updateRun(encodedSession, site.siteSlug, { phase: "ready", resources, queryErrors, error: null, patientId }, set, get);
        } catch (siteError) {
          if (get().sessionKey !== encodedSession) return;
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
      }

      if (get().sessionKey === encodedSession) {
        set({ loading: false, error: null, sharedClient });
      }
    } catch (error) {
      if (get().sessionKey === encodedSession) {
        set({
          loading: false,
          error: error instanceof Error ? error.message : "Failed to load viewer session",
        });
      }
    }
  },

  setQueryPath: (queryPath) => set({ queryPath }),

  runCrossSiteQuery: async () => {
    const { launch, queryPath, siteRuns, sessionKey } = get();
    if (!launch) return;
    const relativePath = normalizeRelativeQuery(queryPath);
    if (!relativePath) return;
    set({ queryRunning: true, queryResults: [] });

    const nextResults: ViewerQueryResult[] = [];
    try {
      for (const run of siteRuns) {
        try {
          const siteFhirBaseUrl = String(run.smartConfig?.fhir_base_url ?? `${launch.origin}${run.site.authSurface.fhirBasePath}`);
          const payload =
            launch.mode === "anonymous"
              ? await fetchPreviewSiteFhir(launch.origin, run.site, relativePath)
              : run.tokenResponse?.access_token
                ? await fetchFhirFromBase(siteFhirBaseUrl, relativePath, run.tokenResponse.access_token, run.proofJkt)
                : null;
          const { shownCount, totalCount } = inferPayloadCounts(payload);
          nextResults.push({
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
          });
        } catch (error) {
          nextResults.push({
            siteSlug: run.site.siteSlug,
            siteName: run.site.orgName,
            relativePath,
            fullUrl:
              launch.mode === "anonymous"
                ? `${launch.origin}${run.site.authSurface.previewFhirBasePath}/${relativePath}`
                : `${String(run.smartConfig?.fhir_base_url ?? `${launch.origin}${run.site.authSurface.fhirBasePath}`).replace(/\/+$/, "")}/${relativePath}`,
            payload: null,
            shownCount: 0,
            totalCount: 0,
            error: error instanceof Error ? error.message : "Query failed",
          });
        }
        if (get().sessionKey !== sessionKey) return;
        set({ queryResults: [...nextResults] });
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

async function loadSiteResources(
  launch: ViewerLaunch,
  site: ViewerLaunchSite,
  patientId: string,
  capabilityStatement: Record<string, any> | null,
  accessToken: string | null,
  proofJkt: string | null,
  smartConfig: Record<string, any> | null,
) {
  const resources: ViewerResourceItem[] = [];
  const queryErrors: Array<{ label: string; relativePath: string; message: string }> = [];
  const siteFhirBaseUrl = String(smartConfig?.fhir_base_url ?? `${launch.origin}${site.authSurface.fhirBasePath}`);

  for (const query of buildSiteQueryPlan(launch, site, patientId, capabilityStatement)) {
    const fullUrl =
      launch.mode === "anonymous"
        ? `${launch.origin}${site.authSurface.previewFhirBasePath}/${query.relativePath}`
        : `${siteFhirBaseUrl.replace(/\/+$/, "")}/${query.relativePath}`;
    try {
      const payload =
        launch.mode === "anonymous"
          ? await fetchPreviewSiteFhirAllPages(launch.origin, site, query.relativePath)
          : await fetchFhirAllPagesFromBase(siteFhirBaseUrl, query.relativePath, accessToken, proofJkt);
      resources.push(...summarizeSiteResources(site, payload, fullUrl));
    } catch (error) {
      queryErrors.push({
        label: query.label,
        relativePath: query.relativePath,
        message: error instanceof Error ? error.message : "Query failed",
      });
    }
  }

  return { resources: dedupeResources(resources), queryErrors };
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
