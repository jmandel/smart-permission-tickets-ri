import { readFileSync } from "node:fs";
import path from "node:path";

type CareRule = {
  label: string;
  kind: "instant" | "period";
  startPaths: string[];
  endPaths?: string[];
};

type ResourceRuleSet = {
  allowEncounterFallback: boolean;
  rules: CareRule[];
};

type CareRuleConfig = {
  default: ResourceRuleSet;
  resourceTypes: Record<string, ResourceRuleSet>;
};

export type CareWindow = {
  careStart: string | null;
  careEnd: string | null;
  careSourceRule: string | null;
  careSourceKind: "direct" | "encounter-fallback" | "identity-exempt" | "missing";
};

const CONFIG_PATH = path.resolve(import.meta.dir, "care-date-rules.json");
const CONFIG = JSON.parse(readFileSync(CONFIG_PATH, "utf8")) as CareRuleConfig;

export function extractConfiguredCareWindow(resource: any): CareWindow {
  const ruleSet = CONFIG.resourceTypes[resource.resourceType] ?? CONFIG.default;
  for (const rule of ruleSet.rules) {
    const start = firstDateFromPaths(resource, rule.startPaths);
    if (!start) continue;
    const end = rule.kind === "period" ? firstDateFromPaths(resource, rule.endPaths ?? []) ?? start : start;
    return {
      careStart: start,
      careEnd: end,
      careSourceRule: rule.label,
      careSourceKind: "direct",
    };
  }
  return {
    careStart: null,
    careEnd: null,
    careSourceRule: null,
    careSourceKind: "missing",
  };
}

export function allowsEncounterFallback(resourceType: string): boolean {
  return (CONFIG.resourceTypes[resourceType] ?? CONFIG.default).allowEncounterFallback;
}

function firstDateFromPaths(resource: any, paths: string[]): string | null {
  for (const pathSpec of paths) {
    for (const value of getPathValues(resource, pathSpec)) {
      const normalized = normalizeDate(value);
      if (normalized) return normalized;
    }
  }
  return null;
}

function getPathValues(resource: any, pathSpec: string): unknown[] {
  const segments = pathSpec.split(".");
  let current: unknown[] = [resource];

  for (const rawSegment of segments) {
    const isArraySegment = rawSegment.endsWith("[]");
    const key = isArraySegment ? rawSegment.slice(0, -2) : rawSegment;
    const next: unknown[] = [];

    for (const value of current) {
      const expanded = Array.isArray(value) ? value : [value];
      for (const item of expanded) {
        if (!item || typeof item !== "object") continue;
        const child = (item as Record<string, unknown>)[key];
        if (child == null) continue;
        if (Array.isArray(child)) {
          if (isArraySegment) next.push(...child);
          else next.push(...child);
        } else {
          next.push(child);
        }
      }
    }

    current = next;
    if (!current.length) break;
  }

  return current;
}

function normalizeDate(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const match = value.match(/^(\d{4}-\d{2}-\d{2})/);
  return match ? match[1] : null;
}
