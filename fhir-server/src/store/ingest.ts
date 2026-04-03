import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import { extractCareWindow, extractGeneratedWindow, extractLabels, extractReferences, extractSearchDates, extractStrings, extractTokens, rewriteResourceJson } from "./extract.ts";
import { allowsEncounterFallback } from "./care-date.ts";
import { allowsGeneratedEncounterFallback } from "./generated-date.ts";
import { buildServerIdentity, scopeClassForResourceType, sourceLookupKeyForDescriptor } from "./ids.ts";
import {
  CROSS_SITE_PATIENT_IDENTIFIER_SYSTEM,
  DATA_ROOT,
  type LoadResult,
  type PatientAlias,
  type ResourceDescriptor,
} from "./model.ts";

export function initializeSchema(db: Database) {
  db.exec(`
    CREATE TABLE resources (
      resource_pk INTEGER PRIMARY KEY,
      representative_patient_slug TEXT NOT NULL,
      site_slug TEXT NOT NULL,
      scope_class TEXT NOT NULL,
      resource_type TEXT NOT NULL,
      source_logical_id TEXT NOT NULL,
      server_logical_id TEXT NOT NULL,
      source_ref TEXT NOT NULL,
      server_ref TEXT NOT NULL,
      care_start TEXT,
      care_end TEXT,
      care_source_rule TEXT,
      care_source_kind TEXT NOT NULL,
      generated_start TEXT,
      generated_end TEXT,
      generated_source_rule TEXT,
      generated_source_kind TEXT NOT NULL,
      last_updated TEXT,
      raw_json TEXT NOT NULL
    );
    CREATE UNIQUE INDEX resources_server_identity_idx ON resources(resource_type, server_logical_id);
    CREATE UNIQUE INDEX resources_source_identity_idx ON resources(site_slug, scope_class, source_ref);
    CREATE INDEX resources_site_type_idx ON resources(site_slug, resource_type);
    CREATE INDEX resources_generated_date_idx ON resources(generated_start, generated_end);
    CREATE INDEX resources_care_date_idx ON resources(care_start, care_end);

    CREATE TABLE resource_patient_memberships (
      resource_pk INTEGER NOT NULL,
      site_slug TEXT NOT NULL,
      patient_slug TEXT NOT NULL,
      source_patient_ref TEXT NOT NULL,
      server_patient_ref TEXT NOT NULL,
      PRIMARY KEY (resource_pk, site_slug, source_patient_ref)
    );
    CREATE INDEX resource_patient_memberships_lookup_idx
      ON resource_patient_memberships(site_slug, source_patient_ref, resource_pk);
    CREATE INDEX resource_patient_memberships_server_idx
      ON resource_patient_memberships(server_patient_ref, resource_pk);

    CREATE TABLE patient_aliases (
      site_slug TEXT NOT NULL,
      patient_slug TEXT NOT NULL,
      source_patient_ref TEXT NOT NULL,
      server_patient_ref TEXT NOT NULL,
      PRIMARY KEY (site_slug, source_patient_ref)
    );
    CREATE INDEX patient_aliases_patient_slug_idx ON patient_aliases(patient_slug);
    CREATE INDEX patient_aliases_server_idx ON patient_aliases(server_patient_ref);

    CREATE TABLE site_metadata (
      site_slug TEXT PRIMARY KEY,
      organization_name TEXT,
      organization_npi TEXT,
      jurisdiction_state TEXT
    );
    CREATE INDEX site_metadata_npi_idx ON site_metadata(organization_npi);
    CREATE INDEX site_metadata_state_idx ON site_metadata(jurisdiction_state);

    CREATE TABLE resource_tokens (
      resource_pk INTEGER NOT NULL,
      param_name TEXT NOT NULL,
      system TEXT,
      code TEXT,
      text_value TEXT
    );
    CREATE INDEX resource_tokens_lookup_idx ON resource_tokens(param_name, system, code, resource_pk);
    CREATE INDEX resource_tokens_text_idx ON resource_tokens(param_name, text_value, resource_pk);

    CREATE TABLE resource_strings (
      resource_pk INTEGER NOT NULL,
      param_name TEXT NOT NULL,
      raw_value TEXT NOT NULL,
      norm_value TEXT NOT NULL
    );
    CREATE INDEX resource_strings_lookup_idx ON resource_strings(param_name, norm_value, resource_pk);

    CREATE TABLE resource_dates (
      resource_pk INTEGER NOT NULL,
      param_name TEXT NOT NULL,
      start_date TEXT NOT NULL,
      end_date TEXT NOT NULL
    );
    CREATE INDEX resource_dates_lookup_idx ON resource_dates(param_name, start_date, end_date, resource_pk);

    CREATE TABLE resource_refs (
      resource_pk INTEGER NOT NULL,
      param_name TEXT NOT NULL,
      target_type TEXT,
      target_server_id TEXT,
      target_ref TEXT
    );
    CREATE INDEX resource_refs_lookup_idx ON resource_refs(param_name, target_type, target_server_id, resource_pk);

    CREATE TABLE resource_labels (
      resource_pk INTEGER NOT NULL,
      kind TEXT NOT NULL,
      system TEXT NOT NULL,
      code TEXT NOT NULL
    );
    CREATE INDEX resource_labels_lookup_idx ON resource_labels(kind, system, code, resource_pk);
  `);
}

export function loadAllResources(db: Database, dataRoot = DATA_ROOT): LoadResult {
  const sourcePatientRefs = discoverSourcePatientRefs(dataRoot);
  const descriptors = collectDescriptors(dataRoot, sourcePatientRefs);
  const siteMetadata = deriveSiteMetadata(descriptors);
  const sourceCollisionCount = countCollisions(descriptors.map((d) => `${d.resourceType}|${d.sourceLogicalId}`));
  const serverCollisionCount = countCollisions(descriptors.map((d) => `${d.resourceType}|${d.serverLogicalId}`));
  const sourceLookup = new Map<string, string>();
  const canonicalGroups = new Map<string, ResourceDescriptor[]>();

  for (const descriptor of descriptors) {
    sourceLookup.set(sourceLookupKeyForDescriptor(descriptor), descriptor.serverRef);
    const group = canonicalGroups.get(descriptor.serverKey) ?? [];
    group.push(descriptor);
    canonicalGroups.set(descriptor.serverKey, group);
  }

  const patientAliases = descriptors
    .filter((d) => d.resourceType === "Patient")
    .map((d) => ({
      patientSlug: d.patientSlug,
      siteSlug: d.siteSlug,
      sourcePatientRef: d.sourceRef,
      serverPatientRef: d.serverRef,
    }))
    .sort((a, b) => `${a.patientSlug}/${a.siteSlug}`.localeCompare(`${b.patientSlug}/${b.siteSlug}`));
  const patientAliasBySiteAndSource = new Map(patientAliases.map((alias) => [`${alias.siteSlug}|${alias.sourcePatientRef}`, alias.serverPatientRef]));

  const insertResource = db.prepare(`
    INSERT INTO resources (
      representative_patient_slug, site_slug, scope_class, resource_type, source_logical_id, server_logical_id,
      source_ref, server_ref, care_start, care_end, care_source_rule, care_source_kind,
      generated_start, generated_end, generated_source_rule, generated_source_kind, last_updated, raw_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const insertMembership = db.prepare(`
    INSERT INTO resource_patient_memberships (resource_pk, site_slug, patient_slug, source_patient_ref, server_patient_ref)
    VALUES (?, ?, ?, ?, ?)
  `);
  const insertAlias = db.prepare(`
    INSERT INTO patient_aliases (site_slug, patient_slug, source_patient_ref, server_patient_ref)
    VALUES (?, ?, ?, ?)
  `);
  const insertSiteMetadata = db.prepare(`
    INSERT INTO site_metadata (site_slug, organization_name, organization_npi, jurisdiction_state)
    VALUES (?, ?, ?, ?)
  `);
  const insertToken = db.prepare(`INSERT INTO resource_tokens (resource_pk, param_name, system, code, text_value) VALUES (?, ?, ?, ?, ?)`);
  const insertString = db.prepare(`INSERT INTO resource_strings (resource_pk, param_name, raw_value, norm_value) VALUES (?, ?, ?, ?)`);
  const insertDate = db.prepare(`INSERT INTO resource_dates (resource_pk, param_name, start_date, end_date) VALUES (?, ?, ?, ?)`);
  const insertRef = db.prepare(`INSERT INTO resource_refs (resource_pk, param_name, target_type, target_server_id, target_ref) VALUES (?, ?, ?, ?, ?)`);
  const insertLabel = db.prepare(`INSERT INTO resource_labels (resource_pk, kind, system, code) VALUES (?, ?, ?, ?)`);

  db.transaction(() => {
    for (const alias of patientAliases) {
      insertAlias.run(alias.siteSlug, alias.patientSlug, alias.sourcePatientRef, alias.serverPatientRef);
    }
    for (const [siteSlug, site] of siteMetadata.entries()) {
      insertSiteMetadata.run(siteSlug, site.organizationName, site.npi, site.state);
    }

    for (const group of canonicalGroups.values()) {
      const canonical = group[0];
      const rewritten = rewriteResourceJson(canonical.sourceJson, { siteSlug: canonical.siteSlug, localPatientSourceRef: canonical.localPatientSourceRef }, sourceLookup);
      rewritten.id = canonical.serverLogicalId;
      addCrossSitePatientIdentifier(rewritten, canonical.patientSlug);

      const care = extractCareWindow(rewritten);
      const generated = extractGeneratedWindow(rewritten);
      const lastUpdated = typeof rewritten.meta?.lastUpdated === "string" ? rewritten.meta.lastUpdated : null;

      const result = insertResource.run(
        canonical.patientSlug,
        canonical.siteSlug,
        canonical.scopeClass,
        canonical.resourceType,
        canonical.sourceLogicalId,
        canonical.serverLogicalId,
        canonical.sourceRef,
        canonical.serverRef,
        care.careStart,
        care.careEnd,
        care.careSourceRule,
        care.careSourceKind,
        generated.generatedStart,
        generated.generatedEnd,
        generated.generatedSourceRule,
        generated.generatedSourceKind,
        lastUpdated,
        JSON.stringify(rewritten),
      );
      const resourcePk = Number(result.lastInsertRowid);

      const memberships = new Map<string, { patientSlug: string; sourcePatientRef: string; serverPatientRef: string }>();
      for (const descriptor of group) {
        const membershipKey = `${descriptor.siteSlug}|${descriptor.localPatientSourceRef}`;
        const serverPatientRef = patientAliasBySiteAndSource.get(membershipKey);
        if (!serverPatientRef) continue;
        memberships.set(membershipKey, {
          patientSlug: descriptor.patientSlug,
          sourcePatientRef: descriptor.localPatientSourceRef,
          serverPatientRef,
        });
      }
      for (const membership of memberships.values()) {
        insertMembership.run(resourcePk, canonical.siteSlug, membership.patientSlug, membership.sourcePatientRef, membership.serverPatientRef);
      }

      for (const token of extractTokens(rewritten)) insertToken.run(resourcePk, token.paramName, token.system, token.code, token.textValue);
      for (const entry of extractStrings(rewritten)) insertString.run(resourcePk, entry.paramName, entry.value, entry.normValue);
      for (const entry of extractSearchDates(rewritten)) insertDate.run(resourcePk, entry.paramName, entry.start, entry.end);
      for (const ref of extractReferences(rewritten)) insertRef.run(resourcePk, ref.paramName, ref.targetType, ref.targetLogicalId, ref.targetRef);
      for (const label of extractLabels(rewritten, canonical.siteSlug)) insertLabel.run(resourcePk, label.kind, label.system, label.code);
    }

    applyEncounterFallbacks(db, {
      startColumn: "care_start",
      endColumn: "care_end",
      sourceRuleColumn: "care_source_rule",
      sourceKindColumn: "care_source_kind",
      encounterStartColumn: "care_start",
      encounterEndColumn: "care_end",
      fallbackTypes: listCareFallbackTypes(),
      ruleLabel: "Encounter.period",
    });
    applyEncounterFallbacks(db, {
      startColumn: "generated_start",
      endColumn: "generated_end",
      sourceRuleColumn: "generated_source_rule",
      sourceKindColumn: "generated_source_kind",
      encounterStartColumn: "generated_start",
      encounterEndColumn: "generated_end",
      fallbackTypes: listGeneratedFallbackTypes(),
      ruleLabel: "Encounter.period",
    });
  })();

  return { patientAliases, sourceCollisionCount, serverCollisionCount, resourceCount: descriptors.length };
}

function addCrossSitePatientIdentifier(resource: any, patientSlug: string) {
  if (resource?.resourceType !== "Patient") return;
  if (!Array.isArray(resource.identifier)) resource.identifier = resource.identifier ? [resource.identifier] : [];

  const existing = resource.identifier.some(
    (identifier: any) => identifier?.system === CROSS_SITE_PATIENT_IDENTIFIER_SYSTEM,
  );
  if (existing) return;

  resource.identifier.push({
    system: CROSS_SITE_PATIENT_IDENTIFIER_SYSTEM,
    value: stableCrossSitePatientId(patientSlug),
  });
}

function stableCrossSitePatientId(patientSlug: string) {
  return `person-${createHash("sha256").update(`patient:${patientSlug}`).digest("hex").slice(0, 24)}`;
}

function applyEncounterFallbacks(
  db: Database,
  opts: {
    startColumn: string;
    endColumn: string;
    sourceRuleColumn: string;
    sourceKindColumn: string;
    encounterStartColumn: string;
    encounterEndColumn: string;
    fallbackTypes: string[];
    ruleLabel: string;
  },
) {
  if (!opts.fallbackTypes.length) return;
  db.query(`
    UPDATE resources
       SET ${opts.startColumn} = (
             SELECT enc.${opts.encounterStartColumn}
             FROM resource_refs rr
             JOIN resources enc
               ON enc.resource_type = 'Encounter'
              AND enc.server_logical_id = rr.target_server_id
            WHERE rr.resource_pk = resources.resource_pk
              AND rr.param_name = 'encounter'
            LIMIT 1
           ),
           ${opts.endColumn} = (
             SELECT enc.${opts.encounterEndColumn}
             FROM resource_refs rr
             JOIN resources enc
               ON enc.resource_type = 'Encounter'
              AND enc.server_logical_id = rr.target_server_id
            WHERE rr.resource_pk = resources.resource_pk
              AND rr.param_name = 'encounter'
            LIMIT 1
           ),
           ${opts.sourceRuleColumn} = '${opts.ruleLabel}',
           ${opts.sourceKindColumn} = 'encounter-fallback'
     WHERE ${opts.startColumn} IS NULL
       AND resource_type IN (${opts.fallbackTypes.map(() => "?").join(", ")})
       AND EXISTS (
             SELECT 1
             FROM resource_refs rr
             JOIN resources enc
               ON enc.resource_type = 'Encounter'
              AND enc.server_logical_id = rr.target_server_id
            WHERE rr.resource_pk = resources.resource_pk
              AND rr.param_name = 'encounter'
              AND enc.${opts.encounterStartColumn} IS NOT NULL
       )
  `).run(...opts.fallbackTypes);
}

function listCareFallbackTypes() {
  return ["Observation", "DiagnosticReport", "DocumentReference", "Procedure", "MedicationRequest", "Condition", "Immunization", "ServiceRequest", "AllergyIntolerance"].filter(allowsEncounterFallback);
}

function listGeneratedFallbackTypes() {
  return ["Observation", "DiagnosticReport", "DocumentReference", "Procedure", "MedicationRequest", "Condition", "Immunization", "ServiceRequest", "AllergyIntolerance"].filter(allowsGeneratedEncounterFallback);
}

function collectDescriptors(dataRoot: string, sourcePatientRefs: Map<string, string>): ResourceDescriptor[] {
  const descriptors: ResourceDescriptor[] = [];
  for (const patientSlug of listDirs(dataRoot)) {
    const patientDir = path.join(dataRoot, patientSlug);
    const sitesDir = path.join(patientDir, "sites");
    if (!existsSync(sitesDir)) continue;
    for (const siteSlug of listDirs(sitesDir)) {
      const siteKey = `${patientSlug}/${siteSlug}`;
      const localPatientSourceRef = sourcePatientRefs.get(siteKey);
      if (!localPatientSourceRef) continue;
      const resourcesDir = path.join(sitesDir, siteSlug, "resources");
      if (!existsSync(resourcesDir)) continue;
      for (const resourceType of listDirs(resourcesDir)) {
        const typeDir = path.join(resourcesDir, resourceType);
        for (const fileName of readdirSync(typeDir)) {
          if (!fileName.endsWith(".json")) continue;
          const filePath = path.join(typeDir, fileName);
          const sourceJson = JSON.parse(readFileSync(filePath, "utf8"));
          const sourceLogicalId = String(sourceJson.id);
          const sourceRef = `${resourceType}/${sourceLogicalId}`;
          const scopeClass = scopeClassForResourceType(resourceType);
          const base = {
            filePath,
            patientSlug,
            siteSlug,
            resourceType,
            sourceLogicalId,
            sourceRef,
            localPatientSourceRef,
            scopeClass,
            sourceJson,
          };
          descriptors.push({ ...base, ...buildServerIdentity(base) });
        }
      }
    }
  }
  return descriptors;
}

function discoverSourcePatientRefs(dataRoot: string) {
  const map = new Map<string, string>();
  for (const patientSlug of listDirs(dataRoot)) {
    const patientDir = path.join(dataRoot, patientSlug);
    const sitesDir = path.join(patientDir, "sites");
    if (!existsSync(sitesDir)) continue;
    for (const siteSlug of listDirs(sitesDir)) {
      const patientDirForSite = path.join(sitesDir, siteSlug, "resources", "Patient");
      if (!existsSync(patientDirForSite)) continue;
      const files = readdirSync(patientDirForSite).filter((name) => name.endsWith(".json"));
      if (files.length !== 1) continue;
      const sourceJson = JSON.parse(readFileSync(path.join(patientDirForSite, files[0]), "utf8"));
      map.set(`${patientSlug}/${siteSlug}`, `Patient/${sourceJson.id}`);
    }
  }
  return map;
}

function countCollisions(keys: string[]) {
  const counts = new Map<string, number>();
  for (const key of keys) counts.set(key, (counts.get(key) ?? 0) + 1);
  return [...counts.values()].filter((count) => count > 1).length;
}

function deriveSiteMetadata(descriptors: ResourceDescriptor[]) {
  const metadata = new Map<string, { organizationName: string | null; npi: string | null; state: string | null }>();
  const bySite = new Map<string, ResourceDescriptor[]>();
  for (const descriptor of descriptors) {
    const list = bySite.get(descriptor.siteSlug) ?? [];
    list.push(descriptor);
    bySite.set(descriptor.siteSlug, list);
  }

  for (const [siteSlug, siteDescriptors] of bySite.entries()) {
    const organization = siteDescriptors.find((descriptor) => descriptor.resourceType === "Organization")?.sourceJson;
    const location = siteDescriptors.find((descriptor) => descriptor.resourceType === "Location")?.sourceJson;
    metadata.set(siteSlug, {
      organizationName: findOrganizationName(organization),
      npi: findNpi(organization),
      state: findState(organization) ?? findState(location),
    });
  }

  return metadata;
}

function findNpi(resource: any): string | null {
  for (const identifier of resource?.identifier ?? []) {
    const system = typeof identifier?.system === "string" ? identifier.system.toLowerCase() : "";
    const value = typeof identifier?.value === "string" ? identifier.value.trim() : "";
    if (!value) continue;
    if (system.includes("npi")) return value;
    for (const coding of identifier?.type?.coding ?? []) {
      if (coding?.code === "NPI") return value;
    }
  }
  return null;
}

function findOrganizationName(resource: any): string | null {
  return typeof resource?.name === "string" && resource.name.trim() ? resource.name.trim() : null;
}

function findState(resource: any): string | null {
  for (const address of resource?.address ?? []) {
    if (typeof address?.state === "string" && address.state.trim()) return address.state.trim().toUpperCase();
  }
  if (typeof resource?.address?.state === "string" && resource.address.state.trim()) {
    return resource.address.state.trim().toUpperCase();
  }
  return null;
}

function listDirs(dir: string) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
}
