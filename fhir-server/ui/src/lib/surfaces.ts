import type { AuthSurface, ModeName } from "../types";
import { buildAuthBasePath, buildFhirBasePath, buildPreviewFhirBasePath } from "../../../shared/surfaces";

export function buildAuthSurface(mode: ModeName, context: { siteSlug?: string; networkSlug?: string }): AuthSurface {
  const authBasePath = buildAuthBasePath("strict", { mode, ...context });
  const fhirBasePath = buildFhirBasePath("strict", { mode, ...context });
  return {
    kind: context.networkSlug ? "network" : context.siteSlug ? "site" : "global",
    siteSlug: context.siteSlug,
    networkSlug: context.networkSlug,
    smartConfigPath: `${fhirBasePath}/.well-known/smart-configuration`,
    registerPath: `${authBasePath}/register`,
    tokenPath: `${authBasePath}/token`,
    introspectPath: `${authBasePath}/introspect`,
    fhirBasePath,
    previewFhirBasePath: buildPreviewFhirBasePath(context),
  };
}
