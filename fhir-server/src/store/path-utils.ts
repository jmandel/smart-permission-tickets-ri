export function getPathValues(resource: any, pathSpec: string): unknown[] {
  const segments = pathSpec.split(".");
  let current: unknown[] = [resource];

  for (const rawSegment of segments) {
    const key = rawSegment.endsWith("[]") ? rawSegment.slice(0, -2) : rawSegment;
    const next: unknown[] = [];

    for (const value of current) {
      const items = Array.isArray(value) ? value : [value];
      for (const item of items) {
        if (!item || typeof item !== "object") continue;
        const child = (item as Record<string, unknown>)[key];
        if (child == null) continue;
        if (Array.isArray(child)) next.push(...child);
        else next.push(child);
      }
    }

    current = next;
    if (!current.length) break;
  }

  return current;
}

export function normalizeDate(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const match = value.match(/^(\d{4}-\d{2}-\d{2})/);
  return match ? match[1] : null;
}

export function normalizeInstant(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const match = value.match(/^(\d{4}-\d{2}-\d{2})(?:T.*)?$/);
  return match ? match[1] : null;
}

export function normalizeText(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim().toLowerCase().replace(/\s+/g, " ");
  return normalized || null;
}

export function asArray<T>(value: T | T[] | null | undefined): T[] {
  if (value == null) return [];
  return Array.isArray(value) ? value : [value];
}
