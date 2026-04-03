import { readFileSync } from "node:fs";
import path from "node:path";

import { getPathValues, normalizeDate } from "./path-utils.ts";
import type { WindowSourceKind } from "./model.ts";

type Rule = {
  label: string;
  kind: "instant" | "period";
  startPaths: string[];
  endPaths?: string[];
};

type ResourceRuleSet = {
  allowEncounterFallback: boolean;
  rules: Rule[];
};

type Config = {
  default: ResourceRuleSet;
  resourceTypes: Record<string, ResourceRuleSet>;
};

export type CareWindow = {
  careStart: string | null;
  careEnd: string | null;
  careSourceRule: string | null;
  careSourceKind: WindowSourceKind;
};

const CONFIG_PATH = path.resolve(import.meta.dir, "care-date-rules.json");
const CONFIG = JSON.parse(readFileSync(CONFIG_PATH, "utf8")) as Config;

export function extractConfiguredCareWindow(resource: any): CareWindow {
  const ruleSet = CONFIG.resourceTypes[resource.resourceType] ?? CONFIG.default;
  for (const rule of ruleSet.rules) {
    const start = firstDateFromPaths(resource, rule.startPaths);
    if (!start) continue;
    const end = rule.kind === "period" ? firstDateFromPaths(resource, rule.endPaths ?? []) ?? start : start;
    return { careStart: start, careEnd: end, careSourceRule: rule.label, careSourceKind: "direct" };
  }
  return { careStart: null, careEnd: null, careSourceRule: null, careSourceKind: "missing" };
}

export function allowsEncounterFallback(resourceType: string) {
  return (CONFIG.resourceTypes[resourceType] ?? CONFIG.default).allowEncounterFallback;
}

function firstDateFromPaths(resource: any, paths: string[]) {
  for (const pathSpec of paths) {
    for (const value of getPathValues(resource, pathSpec)) {
      const normalized = normalizeDate(value);
      if (normalized) return normalized;
    }
  }
  return null;
}
