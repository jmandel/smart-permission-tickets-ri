export type ArtifactViewerMetadata = { label: string; value: string };

export type ArtifactViewerFocusNode = {
  ref: string;
  title: string;
  subtitle?: string | null;
  resourceType?: string | null;
  siteName?: string | null;
  siteJurisdiction?: string | null;
  noteText?: string | null;
  content: unknown;
  copyText?: string;
  metadata?: ArtifactViewerMetadata[];
};

export type ArtifactViewerGroup = {
  id: string;
  label: string;
  refs: string[];
};

export type ArtifactViewerSinglePayload = {
  kind?: "single";
  title: string;
  subtitle?: string;
  content: unknown;
  copyText?: string;
  metadata?: ArtifactViewerMetadata[];
  noteText?: string | null;
};

export type ArtifactViewerContextPayload = {
  kind: "context";
  title: string;
  subtitle?: string;
  summary?: string | null;
  focusRef: string;
  nodes: ArtifactViewerFocusNode[];
  groups: ArtifactViewerGroup[];
};

export type ArtifactViewerPayload = ArtifactViewerSinglePayload | ArtifactViewerContextPayload;

const STORAGE_PREFIX = "smart-permission-tickets:artifact:";

export function buildArtifactViewerHref(payload: ArtifactViewerPayload) {
  const key = crypto.randomUUID();
  localStorage.setItem(`${STORAGE_PREFIX}${key}`, JSON.stringify(payload));
  return `/viewer?artifact_key=${encodeURIComponent(key)}`;
}

export function loadArtifactViewerPayload(key: string) {
  const raw = localStorage.getItem(`${STORAGE_PREFIX}${key}`);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as ArtifactViewerPayload;
  } catch {
    return null;
  }
}

export function renderArtifactText(payload: ArtifactViewerPayload) {
  if (payload.kind === "context") {
    const focus = payload.nodes.find((node) => node.ref === payload.focusRef) ?? payload.nodes[0];
    if (!focus) return "";
    if (typeof focus.content === "string") return focus.content;
    return JSON.stringify(focus.content, null, 2);
  }
  if (typeof payload.content === "string") return payload.content;
  return JSON.stringify(payload.content, null, 2);
}
