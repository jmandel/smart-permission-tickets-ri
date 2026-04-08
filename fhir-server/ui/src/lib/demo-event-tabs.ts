import type { DemoArtifactProvenanceStep, DemoEvent } from "../../../shared/demo-events";

export type EventArtifactTab = {
  key: string;
  label: string;
  kind: "json" | "jwt" | "text" | "http-request" | "http-response";
  content: unknown;
  provenance?: {
    steps: DemoArtifactProvenanceStep[];
  };
};

export type SharedEventArtifactProvenanceGroup = {
  step: DemoArtifactProvenanceStep;
  artifactLabels: string[];
};

export function buildDemoEventArtifactTabs(event: DemoEvent): EventArtifactTab[] {
  const tabs: EventArtifactTab[] = [];
  if (event.artifacts?.request) {
    tabs.push({
      key: "request",
      label: "App -> data holder request",
      kind: "http-request",
      content: event.artifacts.request,
    });
  }
  if (event.artifacts?.response) {
    tabs.push({
      key: "response",
      label: "Data holder -> app response",
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
      provenance: artifact.provenance,
    });
  }
  return tabs;
}

export function splitSharedEventArtifactProvenance(tabs: EventArtifactTab[]) {
  const groups = new Map<string, { step: DemoArtifactProvenanceStep; artifactLabels: string[] }>();
  for (const tab of tabs) {
    if (!tab.provenance?.steps?.length) continue;
    for (const step of tab.provenance.steps) {
      const key = provenanceStepSignature(step);
      const existing = groups.get(key);
      if (existing) {
        if (!existing.artifactLabels.includes(tab.label)) existing.artifactLabels.push(tab.label);
      } else {
        groups.set(key, { step, artifactLabels: [tab.label] });
      }
    }
  }

  const sharedGroups = [...groups.values()]
    .filter((group) => group.artifactLabels.length > 1)
    .map((group) => ({ step: group.step, artifactLabels: group.artifactLabels }));
  const sharedKeys = new Set(sharedGroups.map((group) => provenanceStepSignature(group.step)));

  const tabsWithoutSharedProvenance = tabs.map((tab) => {
    if (!tab.provenance?.steps?.length) return tab;
    const remainingSteps = tab.provenance.steps.filter((step) => !sharedKeys.has(provenanceStepSignature(step)));
    return remainingSteps.length
      ? { ...tab, provenance: { steps: remainingSteps } }
      : { ...tab, provenance: undefined };
  });

  return {
    sharedGroups,
    tabsWithoutSharedProvenance,
  };
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

function provenanceStepSignature(step: DemoArtifactProvenanceStep) {
  return JSON.stringify({
    role: step.role,
    title: step.title,
    requests: (step.requests ?? []).map((request) => ({
      method: request.method,
      url: request.url,
      headers: request.headers,
      body: request.body,
    })),
  });
}
