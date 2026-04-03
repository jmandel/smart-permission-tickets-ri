export type ArtifactViewerPayload = {
  title: string;
  subtitle?: string;
  content: unknown;
  copyText?: string;
  metadata?: Array<{ label: string; value: string }>;
  noteText?: string | null;
};

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
  if (typeof payload.content === "string") return payload.content;
  return JSON.stringify(payload.content, null, 2);
}
