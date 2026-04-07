import type { DemoEvent } from "../../../shared/demo-events";

export type EventArtifactTab = {
  key: string;
  label: string;
  kind: "json" | "jwt" | "text" | "http-request" | "http-response";
  content: unknown;
};

export function buildDemoEventArtifactTabs(event: DemoEvent): EventArtifactTab[] {
  const tabs: EventArtifactTab[] = [];
  if (event.artifacts?.request) {
    tabs.push({
      key: "request",
      label: "Request",
      kind: "http-request",
      content: event.artifacts.request,
    });
  }
  if (event.artifacts?.response) {
    tabs.push({
      key: "response",
      label: "Response",
      kind: "http-response",
      content: event.artifacts.response,
    });
  }
  for (const [index, artifact] of (event.artifacts?.related ?? []).entries()) {
    if (artifactRepeatsHttpBody(artifact.content, artifact.kind, event.artifacts)) continue;
    tabs.push({
      key: `related:${index}`,
      label: artifact.label,
      kind: artifact.kind,
      content: artifact.content,
    });
  }
  return tabs;
}

function artifactRepeatsHttpBody(
  content: unknown,
  kind: EventArtifactTab["kind"],
  artifacts: DemoEvent["artifacts"] | undefined,
) {
  if (!artifacts) return false;
  if (kind !== "json" && kind !== "text") return false;
  return sameArtifactContent(content, artifacts.request?.body) || sameArtifactContent(content, artifacts.response?.body);
}

function sameArtifactContent(left: unknown, right: unknown) {
  if (left === undefined || right === undefined) return false;
  try {
    return JSON.stringify(left) === JSON.stringify(right);
  } catch {
    return false;
  }
}
