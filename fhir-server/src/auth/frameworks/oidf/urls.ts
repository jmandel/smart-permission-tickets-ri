import type { ServerConfig } from "../../../config.ts";

export function oidfEntityConfigurationPath(entityId: string) {
  return `${new URL(entityId).pathname}/.well-known/openid-federation`;
}

export function federationFetchEndpointPath(entityId: string) {
  return `${new URL(entityId).pathname}/federation_fetch_endpoint`;
}

export function oidfEntityConfigurationUrl(entityId: string) {
  return appendPathToEntityId(entityId, "/.well-known/openid-federation");
}

export function federationFetchEndpointUrl(entityId: string) {
  return appendPathToEntityId(entityId, "/federation_fetch_endpoint");
}

export function resolvePublishedFederationFetchEndpointUrl(
  entityId: string,
  payload: { metadata?: Record<string, Record<string, unknown>> },
) {
  const endpoint = payload.metadata?.federation_entity?.federation_fetch_endpoint;
  if (typeof endpoint !== "string" || !endpoint.trim()) {
    throw new Error(`OIDF entity ${entityId} is missing metadata.federation_entity.federation_fetch_endpoint`);
  }
  return new URL(endpoint, entityId).toString();
}

export function rewriteSelfOriginFetchUrl(
  targetUrl: string,
  config: Pick<ServerConfig, "publicBaseUrl" | "internalBaseUrl">,
) {
  if (!config.internalBaseUrl) return targetUrl;
  const target = new URL(targetUrl);
  const publicBase = new URL(config.publicBaseUrl);
  if (target.origin !== publicBase.origin) return targetUrl;
  const internalBase = new URL(config.internalBaseUrl);
  return `${internalBase.origin}${target.pathname}${target.search}`;
}

export async function fetchOidfText(
  targetUrl: string,
  label: string,
  config: Pick<ServerConfig, "publicBaseUrl" | "internalBaseUrl">,
  fetchImpl: typeof fetch,
) {
  const requestUrl = rewriteSelfOriginFetchUrl(targetUrl, config);
  let response: Response;
  try {
    response = await fetchImpl(requestUrl, { redirect: "follow" });
  } catch (error) {
    throw new Error(`OIDF ${label} fetch failed for ${describeFetchRoute(targetUrl, requestUrl)}: ${formatError(error)}`);
  }
  if (!response.ok) {
    throw new Error(`OIDF ${label} fetch failed (${response.status}) for ${describeFetchRoute(targetUrl, requestUrl)}`);
  }
  const body = (await response.text()).trim();
  if (!body) {
    throw new Error(`OIDF ${label} fetch returned an empty body for ${describeFetchRoute(targetUrl, requestUrl)}`);
  }
  return body;
}

function appendPathToEntityId(entityId: string, suffix: string) {
  const url = new URL(entityId);
  const pathname = url.pathname.endsWith("/") ? url.pathname.slice(0, -1) : url.pathname;
  url.pathname = `${pathname}${suffix}`;
  url.search = "";
  url.hash = "";
  return url.toString();
}

function describeFetchRoute(targetUrl: string, requestUrl: string) {
  return targetUrl === requestUrl ? targetUrl : `${targetUrl} via ${requestUrl}`;
}

function formatError(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
