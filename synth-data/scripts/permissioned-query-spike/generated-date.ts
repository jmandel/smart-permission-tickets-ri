import { readFileSync } from "node:fs";
import path from "node:path";

import type { WindowSourceKind } from "./model.ts";

type GeneratedRule = {
  label: string;
  kind: "instant" | "period";
  startPaths: string[];
  endPaths?: string[];
};

type ResourceRuleSet = {
  allowEncounterFallback: boolean;
  rules: GeneratedRule[];
};

type GeneratedRuleConfig = {
  default: ResourceRuleSet;
  resourceTypes: Record<string, ResourceRuleSet>;
};

export type GeneratedWindow = {
  generatedStart: string | null;
  generatedEnd: string | null;
  generatedSourceRule: string | null;
  generatedSourceKind: WindowSourceKind;
};

const CONFIG_PATH = path.resolve(import.meta.dir, "generated-date-rules.json");
const CONFIG = JSON.parse(readFileSync(CONFIG_PATH, "utf8")) as GeneratedRuleConfig;

export function extractConfiguredGeneratedWindow(resource: any): GeneratedWindow {
  const ruleSet = CONFIG.resourceTypes[resource.resourceType] ?? CONFIG.default;
  for (const rule of ruleSet.rules) {
    const start = firstDateFromPaths(resource, rule.startPaths);
    if (!start) continue;
    const end = rule.kind === "period" ? firstDateFromPaths(resource, rule.endPaths ?? []) ?? start : start;
    return {
      generatedStart: start,
      generatedEnd: end,
      generatedSourceRule: rule.label,
      generatedSourceKind: "direct",
    };
  }
  return {
    generatedStart: null,
    generatedEnd: null,
    generatedSourceRule: null,
    generatedSourceKind: "missing",
  };
}

export function allowsGeneratedEncounterFallback(resourceType: string): boolean {
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
          next.push(...child);
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
