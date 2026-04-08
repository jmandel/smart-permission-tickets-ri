import { basename } from "path";
import { createHash } from "node:crypto";

import { loadEncounterTimeline, loadProviderMap, type EncounterRecord } from "./artifacts.ts";

export const CROSS_SITE_PATIENT_IDENTIFIER_SYSTEM = "urn:smart-permission-tickets:person-id";
export const PATIENT_SUMMARY_EXTENSION_URL =
  "https://smarthealthit.org/fhir/StructureDefinition/smart-permission-tickets-patient-summary";
export const ENCOUNTER_SUMMARY_EXTENSION_URL =
  "https://smarthealthit.org/fhir/StructureDefinition/smart-permission-tickets-encounter-summary";

export interface EnrichmentContext {
  patientSlug: string;
  patientSummary?: string;
  encounterSummaries: Map<string, string>;
}

export async function loadEnrichmentContext(patientDir: string): Promise<EnrichmentContext> {
  const patientSlug = basename(patientDir);
  const providerMapPath = `${patientDir}/provider-map.json`;
  const encountersPath = `${patientDir}/encounters.json`;
  const scenarioPath = `${patientDir}/scenario.md`;

  const providerMap = await loadProviderMap(providerMapPath);
  const timeline = await loadEncounterTimeline(encountersPath, providerMap);
  const scenarioText = await Bun.file(scenarioPath).text();

  return {
    patientSlug,
    patientSummary: buildPatientSummary(scenarioText),
    encounterSummaries: new Map(
      timeline.encounters.map((encounter) => [encounter.encounter_id, buildEncounterSummary(encounter)]),
    ),
  };
}

export function enrichResource(resource: any, context: EnrichmentContext, _siteSlug: string): any {
  if (!resource || typeof resource !== "object") return resource;
  stripProjectMetaTags(resource);

  if (resource.resourceType === "Patient") {
    addCrossSitePatientIdentifier(resource, context.patientSlug);
    if (context.patientSummary) {
      upsertMarkdownExtension(resource, PATIENT_SUMMARY_EXTENSION_URL, context.patientSummary);
    }
  }

  if (resource.resourceType === "Encounter") {
    const summary = context.encounterSummaries.get(String(resource.id ?? ""));
    if (summary) {
      upsertMarkdownExtension(resource, ENCOUNTER_SUMMARY_EXTENSION_URL, summary);
    }
  }

  return resource;
}

function addCrossSitePatientIdentifier(resource: any, patientSlug: string) {
  if (!Array.isArray(resource.identifier)) {
    resource.identifier = resource.identifier ? [resource.identifier] : [];
  }

  const value = stableCrossSitePatientId(patientSlug);
  const existing = resource.identifier.find(
    (identifier: any) => identifier?.system === CROSS_SITE_PATIENT_IDENTIFIER_SYSTEM,
  );
  if (existing) {
    existing.value = value;
    return;
  }

  resource.identifier.push({
    system: CROSS_SITE_PATIENT_IDENTIFIER_SYSTEM,
    value,
  });
}

function upsertMarkdownExtension(resource: any, url: string, value: string) {
  if (!Array.isArray(resource.extension)) {
    resource.extension = resource.extension ? [resource.extension] : [];
  }

  const existing = resource.extension.find((extension: any) => extension?.url === url);
  if (existing) {
    existing.valueMarkdown = value;
    delete existing.valueString;
    return;
  }

  resource.extension.push({
    url,
    valueMarkdown: value,
  });
}

function stableCrossSitePatientId(patientSlug: string) {
  return `person-${createHash("sha256").update(`patient:${patientSlug}`).digest("hex").slice(0, 24)}`;
}

const META_SECTION_HEADING_PREFIXES = [
  "key features",
  "encounter guidance",
  "demo relevance",
  "why this patient matters",
  "constraint exercise goals",
];

function buildPatientSummary(scenarioText: string): string | undefined {
  // Drop the top-level `# Title` line (viewer already shows the patient name).
  const withoutTopTitle = scenarioText.replace(/^\s*#\s[^\n]*\n?/, "");

  // Drop demo-meta sections ("## Key Features ...", etc.) by slicing out everything
  // from a meta heading through the next same-or-higher-level heading.
  const withoutMetaSections = stripMetaSections(withoutTopTitle);

  const trimmed = withoutMetaSections.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function stripMetaSections(markdown: string): string {
  const lines = markdown.split("\n");
  const output: string[] = [];
  let skipUntilHeadingLevel: number | null = null;

  for (const line of lines) {
    const headingMatch = line.match(/^(#{1,6})\s+(.*)$/);
    if (headingMatch) {
      const level = headingMatch[1].length;
      const headingText = headingMatch[2].toLowerCase().trim();

      if (skipUntilHeadingLevel !== null) {
        // We're currently in a skipped section. Stop skipping when we hit a heading
        // at the same level or shallower.
        if (level <= skipUntilHeadingLevel) {
          skipUntilHeadingLevel = null;
        } else {
          continue;
        }
      }

      if (META_SECTION_HEADING_PREFIXES.some((prefix) => headingText.startsWith(prefix))) {
        skipUntilHeadingLevel = level;
        continue;
      }
    }

    if (skipUntilHeadingLevel !== null) continue;
    output.push(line);
  }

  return output.join("\n");
}

function buildEncounterSummary(encounter: EncounterRecord): string {
  const firstParagraph = splitMarkdownParagraphs(encounter.body_markdown)
    .map(cleanMarkdownText)
    .find(Boolean);

  if (!firstParagraph) {
    return collapseWhitespace(`${encounter.encounter_type}: ${encounter.reason}`);
  }

  const sentences = splitSentences(firstParagraph);
  const summary = collapseWhitespace(sentences.slice(0, 2).join(" "));
  return summary || collapseWhitespace(firstParagraph);
}

function splitMarkdownParagraphs(markdown: string): string[] {
  return markdown
    .split(/\n\s*\n/g)
    .map((block) => block.trim())
    .filter(Boolean)
    .filter((block) => !/^#{1,6}\s/.test(block))
    .filter((block) => !/^\s*[-*]\s/.test(block));
}

function cleanMarkdownText(value: string): string {
  return collapseWhitespace(
    value
      .replace(/\*\*(.*?)\*\*/g, "$1")
      .replace(/\*(.*?)\*/g, "$1")
      .replace(/`([^`]+)`/g, "$1")
      .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
      .replace(/^#+\s+/gm, "")
      .replace(/\s+/g, " "),
  ).trim();
}

function collapseWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function splitSentences(value: string): string[] {
  return value
    .split(/(?<=[.!?])\s+/)
    .map((sentence) => sentence.trim())
    .filter(Boolean);
}

function stripProjectMetaTags(resource: any) {
  if (!resource.meta || typeof resource.meta !== "object" || Array.isArray(resource.meta)) {
    return;
  }
  if (!Array.isArray(resource.meta.tag)) return;

  resource.meta.tag = resource.meta.tag.filter((tag: any) => {
    const system = tag?.system;
    return system !== "urn:example:permissiontickets-demo:source-org-npi"
      && system !== "urn:example:permissiontickets-demo:jurisdiction-state";
  });

  if (resource.meta.tag.length === 0) {
    delete resource.meta.tag;
  }
  if (Object.keys(resource.meta).length === 0) {
    delete resource.meta;
  }
}
