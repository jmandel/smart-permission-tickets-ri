import { Database } from "bun:sqlite";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import { extractCareWindow, extractGeneratedWindow, extractLabels, extractReferences, extractTokens, rewriteResourceJson } from "./extract.ts";
import { allowsEncounterFallback } from "./care-date.ts";
import { allowsGeneratedEncounterFallback } from "./generated-date.ts";
import { buildServerIdentity, scopeClassForResourceType, sourceLookupKeyForDescriptor } from "./ids.ts";
import {
  DATA_ROOT,
  JURISDICTION_STATE_SYSTEM,
  SOURCE_ORG_NPI_SYSTEM,
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

    CREATE UNIQUE INDEX resources_server_identity_idx
      ON resources(resource_type, server_logical_id);
    CREATE UNIQUE INDEX resources_source_identity_idx
      ON resources(site_slug, scope_class, source_ref);
    CREATE INDEX resources_site_type_idx
      ON resources(site_slug, resource_type);
    CREATE INDEX resources_date_idx
      ON resources(care_start, care_end);
    CREATE INDEX resources_generated_date_idx
      ON resources(generated_start, generated_end);

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

    CREATE TABLE patient_aliases (
      site_slug TEXT NOT NULL,
      patient_slug TEXT NOT NULL,
      source_patient_ref TEXT NOT NULL,
      server_patient_ref TEXT NOT NULL,
      PRIMARY KEY (site_slug, source_patient_ref)
    );

    CREATE TABLE resource_tokens (
      resource_pk INTEGER NOT NULL,
      param_name TEXT NOT NULL,
      system TEXT,
      code TEXT,
      text_value TEXT
    );
    CREATE INDEX resource_tokens_lookup_idx
      ON resource_tokens(param_name, system, code, resource_pk);

    CREATE TABLE resource_refs (
      resource_pk INTEGER NOT NULL,
      param_name TEXT NOT NULL,
      target_type TEXT,
      target_server_id TEXT,
      target_ref TEXT
    );
    CREATE INDEX resource_refs_lookup_idx
      ON resource_refs(param_name, target_type, target_server_id, resource_pk);

    CREATE TABLE resource_labels (
      resource_pk INTEGER NOT NULL,
      kind TEXT NOT NULL,
      system TEXT NOT NULL,
      code TEXT NOT NULL
    );
    CREATE INDEX resource_labels_lookup_idx
      ON resource_labels(kind, system, code, resource_pk);
  `);
}

export function loadAllResources(db: Database): LoadResult {
  const sourcePatientRefs = discoverSourcePatientRefs();
  const descriptors = collectDescriptors(sourcePatientRefs);
  const siteMetadata = deriveSiteMetadata(descriptors);
  const sourceCollisionCount = countCollisions(descriptors.map((descriptor) => `${descriptor.resourceType}|${descriptor.sourceLogicalId}`));
  const serverCollisionCount = countCollisions(descriptors.map((descriptor) => `${descriptor.resourceType}|${descriptor.serverLogicalId}`));

  const sourceLookup = new Map<string, string>();
  const canonicalGroups = new Map<string, ResourceDescriptor[]>();
  for (const descriptor of descriptors) {
    sourceLookup.set(sourceLookupKeyForDescriptor(descriptor), descriptor.serverRef);
    const group = canonicalGroups.get(descriptor.serverKey) ?? [];
    group.push(descriptor);
    canonicalGroups.set(descriptor.serverKey, group);
  }

  const patientAliases = descriptors
    .filter((descriptor) => descriptor.resourceType === "Patient")
    .map((descriptor) => ({
      patientSlug: descriptor.patientSlug,
      siteSlug: descriptor.siteSlug,
      sourcePatientRef: descriptor.sourceRef,
      serverPatientRef: descriptor.serverRef,
    }))
    .sort((a, b) => `${a.patientSlug}/${a.siteSlug}`.localeCompare(`${b.patientSlug}/${b.siteSlug}`));
  const patientAliasBySiteAndSource = new Map(patientAliases.map((alias) => [`${alias.siteSlug}|${alias.sourcePatientRef}`, alias.serverPatientRef]));

  const insertResource = db.prepare(`
    INSERT INTO resources (
      representative_patient_slug,
      site_slug,
      scope_class,
      resource_type,
      source_logical_id,
      server_logical_id,
      source_ref,
      server_ref,
      care_start,
      care_end,
      care_source_rule,
      care_source_kind,
      generated_start,
      generated_end,
      generated_source_rule,
      generated_source_kind,
      last_updated,
      raw_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const insertMembership = db.prepare(`
    INSERT INTO resource_patient_memberships (
      resource_pk,
      site_slug,
      patient_slug,
      source_patient_ref,
      server_patient_ref
    ) VALUES (?, ?, ?, ?, ?)
  `);
  const insertAlias = db.prepare(`
    INSERT INTO patient_aliases (
      site_slug,
      patient_slug,
      source_patient_ref,
      server_patient_ref
    ) VALUES (?, ?, ?, ?)
  `);
  const insertToken = db.prepare(`
    INSERT INTO resource_tokens (resource_pk, param_name, system, code, text_value)
    VALUES (?, ?, ?, ?, ?)
  `);
  const insertRef = db.prepare(`
    INSERT INTO resource_refs (resource_pk, param_name, target_type, target_server_id, target_ref)
    VALUES (?, ?, ?, ?, ?)
  `);
  const insertLabel = db.prepare(`
    INSERT INTO resource_labels (resource_pk, kind, system, code)
    VALUES (?, ?, ?, ?)
  `);

  db.transaction(() => {
    for (const alias of patientAliases) {
      insertAlias.run(alias.siteSlug, alias.patientSlug, alias.sourcePatientRef, alias.serverPatientRef);
    }

    for (const group of canonicalGroups.values()) {
      const canonical = group[0];
      const rewritten = rewriteResourceJson(
        canonical.sourceJson,
        { siteSlug: canonical.siteSlug, localPatientSourceRef: canonical.localPatientSourceRef },
        sourceLookup,
      );
      rewritten.id = canonical.serverLogicalId;
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

      for (const token of extractTokens(rewritten)) {
        insertToken.run(resourcePk, token.paramName, token.system, token.code, token.textValue);
      }
      for (const ref of extractReferences(rewritten)) {
        insertRef.run(resourcePk, ref.paramName, ref.targetType, ref.targetLogicalId, ref.targetRef);
      }
      for (const label of extractLabels(rewritten, canonical.siteSlug)) {
        insertLabel.run(resourcePk, label.kind, label.system, label.code);
      }
      for (const label of deriveSiteLabels(siteMetadata.get(canonical.siteSlug))) {
        insertLabel.run(resourcePk, label.kind, label.system, label.code);
      }
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

  return { patientAliases, sourceCollisionCount, serverCollisionCount };
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
  db.query(
    `
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
    `,
  ).run(...opts.fallbackTypes);
}

function listCareFallbackTypes(): string[] {
  const types = [
    "Observation",
    "DiagnosticReport",
    "DocumentReference",
    "Procedure",
    "MedicationRequest",
    "Condition",
    "Immunization",
    "ServiceRequest",
    "AllergyIntolerance",
  ];
  return types.filter((resourceType) => allowsEncounterFallback(resourceType));
}

function listGeneratedFallbackTypes(): string[] {
  const types = [
    "Observation",
    "DiagnosticReport",
    "DocumentReference",
    "Procedure",
    "MedicationRequest",
    "Condition",
    "Immunization",
    "ServiceRequest",
    "AllergyIntolerance",
  ];
  return types.filter((resourceType) => allowsGeneratedEncounterFallback(resourceType));
}

function collectDescriptors(sourcePatientRefs: Map<string, string>): ResourceDescriptor[] {
  const descriptors: ResourceDescriptor[] = [];
  for (const patientSlug of listDirs(DATA_ROOT)) {
    const patientDir = path.join(DATA_ROOT, patientSlug);
    const sitesDir = path.join(patientDir, "sites");
    if (!existsSync(sitesDir)) continue;

    for (const siteSlug of listDirs(sitesDir)) {
      const siteKey = `${patientSlug}/${siteSlug}`;
      const localPatientSourceRef = sourcePatientRefs.get(siteKey);
      if (!localPatientSourceRef) continue;

      const resourcesDir = path.join(sitesDir, siteSlug, "resources");
      if (!existsSync(resourcesDir)) continue;
      for (const resourceType of listDirs(resourcesDir)) {
        const resourceTypeDir = path.join(resourcesDir, resourceType);
        for (const fileName of readdirSync(resourceTypeDir)) {
          if (!fileName.endsWith(".json")) continue;
          const filePath = path.join(resourceTypeDir, fileName);
          const sourceJson = JSON.parse(readFileSync(filePath, "utf8"));
          const sourceLogicalId = String(sourceJson.id);
          const sourceRef = `${resourceType}/${sourceLogicalId}`;
          const scopeClass = scopeClassForResourceType(resourceType);
          const descriptorBase = {
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
          const identity = buildServerIdentity(descriptorBase);
          descriptors.push({ ...descriptorBase, ...identity });
        }
      }
    }
  }
  return descriptors;
}

function discoverSourcePatientRefs(): Map<string, string> {
  const map = new Map<string, string>();
  for (const patientSlug of listDirs(DATA_ROOT)) {
    const patientDir = path.join(DATA_ROOT, patientSlug);
    const sitesDir = path.join(patientDir, "sites");
    if (!existsSync(sitesDir)) continue;
    for (const siteSlug of listDirs(sitesDir)) {
      const patientResourcesDir = path.join(sitesDir, siteSlug, "resources", "Patient");
      if (!existsSync(patientResourcesDir)) continue;
      const files = readdirSync(patientResourcesDir).filter((name) => name.endsWith(".json"));
      if (files.length !== 1) continue;
      const sourceJson = JSON.parse(readFileSync(path.join(patientResourcesDir, files[0]), "utf8"));
      map.set(`${patientSlug}/${siteSlug}`, `Patient/${sourceJson.id}`);
    }
  }
  return map;
}

function countCollisions(keys: string[]): number {
  const counts = new Map<string, number>();
  for (const key of keys) counts.set(key, (counts.get(key) ?? 0) + 1);
  return [...counts.values()].filter((count) => count > 1).length;
}

function deriveSiteMetadata(descriptors: ResourceDescriptor[]) {
  const metadata = new Map<string, { npi: string | null; state: string | null }>();
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
      npi: findNpi(organization),
      state: findState(organization) ?? findState(location),
    });
  }

  return metadata;
}

function deriveSiteLabels(site: { npi: string | null; state: string | null } | undefined) {
  const labels: Array<{ kind: string; system: string; code: string }> = [];
  if (!site) return labels;
  if (site.npi) labels.push({ kind: "tag", system: SOURCE_ORG_NPI_SYSTEM, code: site.npi });
  if (site.state) labels.push({ kind: "tag", system: JURISDICTION_STATE_SYSTEM, code: site.state });
  return labels;
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

function findState(resource: any): string | null {
  for (const address of resource?.address ?? []) {
    if (typeof address?.state === "string" && address.state.trim()) return address.state.trim().toUpperCase();
  }
  if (typeof resource?.address?.state === "string" && resource.address.state.trim()) {
    return resource.address.state.trim().toUpperCase();
  }
  return null;
}

function listDirs(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}
