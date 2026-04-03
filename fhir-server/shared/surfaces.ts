export type SurfaceMode = "strict" | "registered" | "key-bound" | "open" | "anonymous";

export type SurfaceContext = {
  mode: SurfaceMode;
  siteSlug?: string;
  networkSlug?: string;
};

export function modePathSegment(mode: SurfaceMode) {
  return mode;
}

export function normalizeModeSegment(segment?: string | null): SurfaceMode | null {
  if (!segment) return null;
  if (segment === "anonymous" || segment === "strict" || segment === "registered" || segment === "key-bound" || segment === "open") return segment;
  return null;
}

export function modePrefix(defaultMode: SurfaceMode, mode: SurfaceMode) {
  return mode === defaultMode ? "" : `/modes/${modePathSegment(mode)}`;
}

export function buildFhirBasePath(defaultMode: SurfaceMode, context: SurfaceContext) {
  const prefix = modePrefix(defaultMode, context.mode);
  if (context.networkSlug) return `${prefix}/networks/${context.networkSlug}/fhir`;
  if (context.siteSlug) return `${prefix}/sites/${context.siteSlug}/fhir`;
  return `${prefix}/fhir`;
}

export function buildAuthBasePath(defaultMode: SurfaceMode, context: SurfaceContext) {
  const prefix = modePrefix(defaultMode, context.mode);
  if (context.networkSlug) return `${prefix}/networks/${context.networkSlug}`;
  if (context.siteSlug) return `${prefix}/sites/${context.siteSlug}`;
  return prefix;
}

export function buildSmartConfigPath(defaultMode: SurfaceMode, context: SurfaceContext) {
  return `${buildFhirBasePath(defaultMode, context)}/.well-known/smart-configuration`;
}

export function buildPreviewFhirBasePath(context: Pick<SurfaceContext, "siteSlug" | "networkSlug">) {
  return buildFhirBasePath("strict", { mode: "anonymous", ...context });
}

export function surfaceKind(context: SurfaceContext) {
  if (context.networkSlug) return "network";
  if (context.siteSlug) return "site";
  return "global";
}
