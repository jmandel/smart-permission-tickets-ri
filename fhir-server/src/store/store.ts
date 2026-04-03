import { Database } from "bun:sqlite";

import { DATA_ROOT, IDENTITY_TYPES, SENSITIVE_LABELS, type AllowedPatientAlias, type AuthorizationEnvelope, type DateSemantics, type Label, type LoadResult, type ResourceRow } from "./model.ts";
import { initializeSchema, loadAllResources } from "./ingest.ts";
import { normalizeText } from "./path-utils.ts";
import { resourcePrimaryDisplay } from "../../shared/resource-display.ts";

export type SiteSummary = {
  siteSlug: string;
  organizationName: string;
  organizationNpi: string | null;
  jurisdictions: string[];
  patientCount: number;
  resourceCount: number;
};

export type PatientSummary = {
  patientSlug: string;
  displayName: string;
  birthDate: string | null;
  aliases: Array<{
    siteSlug: string;
    sourcePatientRef: string;
    serverPatientRef: string;
  }>;
};

export type DemoEncounterSummary = {
  id: string;
  type: string;
  classCode: string;
  date: string;
  status: string;
  summary: string | null;
};

export type DemoSiteSummary = {
  siteSlug: string;
  orgName: string;
  organizationNpi: string | null;
  jurisdiction: string | null;
  patientId: string;
  resourceCounts: Record<string, number>;
  sensitiveResourceCount: number;
  startDate: string | null;
  endDate: string | null;
  encounters: DemoEncounterSummary[];
};

export type DemoPersonSummary = {
  personId: string;
  patientSlug: string;
  displayName: string;
  familyName: string | null;
  givenNames: string[];
  birthDate: string | null;
  gender: string | null;
  summary: string | null;
  useCases: Array<{ system: string; code: string; display: string }>;
  resourceCounts: Record<string, number>;
  sensitiveResourceCount: number;
  startDate: string | null;
  endDate: string | null;
  sites: DemoSiteSummary[];
};

const PATIENT_SUMMARY_EXT = "https://smarthealthit.org/fhir/StructureDefinition/smart-permission-tickets-patient-summary";
const ENCOUNTER_SUMMARY_EXT = "https://smarthealthit.org/fhir/StructureDefinition/smart-permission-tickets-encounter-summary";

export class FhirStore {
  readonly db: Database;
  readonly loadResult: LoadResult;

  constructor(db: Database, loadResult: LoadResult) {
    this.db = db;
    this.loadResult = loadResult;
  }

  static load(dataRoot = DATA_ROOT) {
    const db = new Database(":memory:");
    initializeSchema(db);
    const loadResult = loadAllResources(db, dataRoot);
    return new FhirStore(db, loadResult);
  }

  hasVisibleEncounter(envelope: AuthorizationEnvelope, siteSlug?: string) {
    return hasVisibleResourceType(this.db, envelope, "Encounter", siteSlug);
  }

  findPatientAliasesByReference(reference: string): AllowedPatientAlias[] {
    return this.db
      .query<AllowedPatientAlias, [string, string]>(`
        SELECT patient_slug as patientSlug, site_slug as siteSlug, source_patient_ref as sourcePatientRef, server_patient_ref as serverPatientRef
        FROM patient_aliases
        WHERE source_patient_ref = ? OR server_patient_ref = ?
        ORDER BY patient_slug, site_slug
      `)
      .all(reference, reference);
  }

  findPatientAliasesByIdentifiers(identifiers: Array<{ system?: string; value?: string }>): AllowedPatientAlias[] {
    const matches = new Set<string>();
    const query = this.db.prepare(`
      SELECT pa.patient_slug, pa.site_slug, pa.source_patient_ref, pa.server_patient_ref
      FROM patient_aliases pa
      JOIN resources r ON r.server_ref = pa.server_patient_ref
      JOIN resource_tokens t ON t.resource_pk = r.resource_pk
      WHERE r.resource_type = 'Patient'
        AND t.param_name = 'identifier'
        AND (? IS NULL OR t.system = ?)
        AND t.code = ?
    `);
    for (const identifier of identifiers) {
      if (!identifier.value) continue;
      const rows = query.all(identifier.system ?? null, identifier.system ?? null, identifier.value) as AllowedPatientAlias[];
      for (const row of rows) matches.add(JSON.stringify(row));
    }
    return [...matches].map((row) => JSON.parse(row) as AllowedPatientAlias).sort(compareAlias);
  }

  findPatientAliasesByTraits(traits: { name?: Array<{ family?: string; given?: string[]; text?: string }>; birthDate?: string; identifier?: Array<{ system?: string; value?: string }> }): AllowedPatientAlias[] {
    let candidatePatientSlugs: Set<string> | null = null;

    if (traits.identifier?.length) {
      candidatePatientSlugs = new Set(this.findPatientAliasesByIdentifiers(traits.identifier).map((alias) => alias.patientSlug));
    }

    const clauses = ["r.resource_type = 'Patient'"];
    const params: Array<string> = [];
    if (traits.birthDate) {
      clauses.push(`
        EXISTS (
          SELECT 1
          FROM resource_strings s
          WHERE s.resource_pk = r.resource_pk
            AND s.param_name = 'birthdate'
            AND s.norm_value = ?
        )
      `);
      params.push(normalizeText(traits.birthDate)!);
    }

    const names = traits.name ?? [];
    for (const name of names) {
      if (name.family) {
        clauses.push(`
          EXISTS (
            SELECT 1 FROM resource_strings s
            WHERE s.resource_pk = r.resource_pk
              AND s.param_name = 'family'
              AND s.norm_value = ?
          )
        `);
        params.push(normalizeText(name.family)!);
      }
      for (const given of name.given ?? []) {
        clauses.push(`
          EXISTS (
            SELECT 1 FROM resource_strings s
            WHERE s.resource_pk = r.resource_pk
              AND s.param_name = 'given'
              AND s.norm_value = ?
          )
        `);
        params.push(normalizeText(given)!);
      }
    }

    const rows = this.db
      .query<{ patient_slug: string }, string[]>(`
        SELECT DISTINCT r.representative_patient_slug AS patient_slug
        FROM resources r
        WHERE ${clauses.join(" AND ")}
      `)
      .all(...params);
    const traitMatches = new Set(rows.map((row) => row.patient_slug));
    candidatePatientSlugs = candidatePatientSlugs
      ? new Set([...candidatePatientSlugs].filter((slug) => traitMatches.has(slug)))
      : traitMatches;

    return this.expandAliasesForPatientSlugs([...(candidatePatientSlugs ?? new Set<string>())]);
  }

  expandAliasesForPatientSlugs(patientSlugs: string[]): AllowedPatientAlias[] {
    if (!patientSlugs.length) return [];
    return this.db
      .query<AllowedPatientAlias, string[]>(`
        SELECT patient_slug as patientSlug, site_slug as siteSlug, source_patient_ref as sourcePatientRef, server_patient_ref as serverPatientRef
        FROM patient_aliases
        WHERE patient_slug IN (${patientSlugs.map(() => "?").join(", ")})
        ORDER BY patient_slug, site_slug
      `)
      .all(...patientSlugs);
  }

  resolveAllowedSitesByOrganizations(organizations: Array<{ identifier?: Array<{ system?: string; value?: string }>; name?: string }>): string[] {
    const sites = new Set<string>();
    for (const org of organizations) {
      for (const identifier of org.identifier ?? []) {
        if (!identifier.value) continue;
        const rows = this.db
          .query<{ site_slug: string }, [string]>(`
            SELECT site_slug
            FROM site_metadata
            WHERE organization_npi = ?
          `)
          .all(identifier.value);
        for (const row of rows) sites.add(row.site_slug);
      }
      if (org.name) {
        const name = normalizeText(org.name);
        if (!name) continue;
        const rows = this.db
          .query<{ site_slug: string }, [string]>(`
            SELECT site_slug
            FROM site_metadata
            WHERE lower(trim(organization_name)) = ?
          `)
          .all(name);
        for (const row of rows) sites.add(row.site_slug);
      }
    }
    return [...sites].sort();
  }

  resolveAllowedSitesByJurisdictions(jurisdictions: Array<{ state?: string }>): string[] {
    const states = [
      ...new Set(
        jurisdictions
          .map((jurisdiction) => jurisdiction.state?.trim().toUpperCase())
          .filter((state): state is string => Boolean(state)),
      ),
    ];
    if (!states.length) return [];
    const rows = this.db
      .query<{ site_slug: string }, string[]>(`
        SELECT site_slug
        FROM site_metadata
        WHERE jurisdiction_state IN (${states.map(() => "?").join(", ")})
      `)
      .all(...states);
    return [...new Set(rows.map((row) => row.site_slug))].sort();
  }

  getResourceByServerId(resourceType: string, logicalId: string): ResourceRow | null {
    return this.db
      .query<ResourceRow, [string, string]>(`
        SELECT resource_pk, representative_patient_slug, site_slug, resource_type, source_logical_id, server_logical_id,
               server_ref, raw_json, care_start, care_end, care_source_rule, care_source_kind,
               generated_start, generated_end, generated_source_rule, generated_source_kind, last_updated
        FROM resources
        WHERE resource_type = ? AND server_logical_id = ?
      `)
      .get(resourceType, logicalId);
  }

  listAvailableSitesForAliases(aliases: AllowedPatientAlias[]) {
    const wanted = new Set(aliases.map((alias) => alias.siteSlug));
    return [...wanted].sort();
  }

  listSiteSummaries(): SiteSummary[] {
    const resourceCounts = new Map(
      this.db
        .query<{ site_slug: string; resource_count: number }, []>(`
          SELECT site_slug, COUNT(*) AS resource_count
          FROM resources
          GROUP BY site_slug
          ORDER BY site_slug
        `)
        .all()
        .map((row) => [row.site_slug, Number(row.resource_count)]),
    );
    const patientAliases = this.db
      .query<{ site_slug: string; patient_slug: string }, []>(`
        SELECT site_slug, patient_slug
        FROM patient_aliases
        ORDER BY site_slug, patient_slug
      `)
      .all();
    const sitePatients = new Map<string, Set<string>>();
    for (const row of patientAliases) {
      const set = sitePatients.get(row.site_slug) ?? new Set<string>();
      set.add(row.patient_slug);
      sitePatients.set(row.site_slug, set);
    }

    const siteMetadata = new Map(
      this.db
        .query<{ site_slug: string; organization_name: string | null; organization_npi: string | null; jurisdiction_state: string | null }, []>(`
          SELECT site_slug, organization_name, organization_npi, jurisdiction_state
          FROM site_metadata
          ORDER BY site_slug
        `)
        .all()
        .map((row) => [row.site_slug, row]),
    );

    return [...resourceCounts.keys()].sort().map((siteSlug) => ({
      siteSlug,
      organizationName: siteMetadata.get(siteSlug)?.organization_name ?? siteSlug,
      organizationNpi: siteMetadata.get(siteSlug)?.organization_npi ?? null,
      jurisdictions: siteMetadata.get(siteSlug)?.jurisdiction_state ? [siteMetadata.get(siteSlug)!.jurisdiction_state!] : [],
      patientCount: sitePatients.get(siteSlug)?.size ?? 0,
      resourceCount: resourceCounts.get(siteSlug) ?? 0,
    }));
  }

  listPatientSummaries(): PatientSummary[] {
    const rows = this.db
      .query<{
        patient_slug: string;
        site_slug: string;
        source_patient_ref: string;
        server_patient_ref: string;
        raw_json: string;
      }, []>(`
        SELECT pa.patient_slug, pa.site_slug, pa.source_patient_ref, pa.server_patient_ref, r.raw_json
        FROM patient_aliases pa
        JOIN resources r ON r.server_ref = pa.server_patient_ref
        ORDER BY pa.patient_slug, pa.site_slug
      `)
      .all();

    const grouped = new Map<string, PatientSummary>();
    for (const row of rows) {
      const existing = grouped.get(row.patient_slug);
      const parsed = JSON.parse(row.raw_json);
      if (!existing) {
        grouped.set(row.patient_slug, {
          patientSlug: row.patient_slug,
          displayName: describePatient(parsed, row.patient_slug),
          birthDate: typeof parsed.birthDate === "string" ? parsed.birthDate : null,
          aliases: [
            {
              siteSlug: row.site_slug,
              sourcePatientRef: row.source_patient_ref,
              serverPatientRef: row.server_patient_ref,
            },
          ],
        });
        continue;
      }
      existing.aliases.push({
        siteSlug: row.site_slug,
        sourcePatientRef: row.source_patient_ref,
        serverPatientRef: row.server_patient_ref,
      });
    }

    return [...grouped.values()].sort((a, b) => a.displayName.localeCompare(b.displayName));
  }

  listDemoPersons(): DemoPersonSummary[] {
    const siteMetadata = new Map(
      this.db
        .query<{ site_slug: string; organization_name: string | null; organization_npi: string | null; jurisdiction_state: string | null }, []>(`
          SELECT site_slug, organization_name, organization_npi, jurisdiction_state
          FROM site_metadata
          ORDER BY site_slug
        `)
        .all()
        .map((row) => [row.site_slug, row]),
    );

    const countRows = this.db
      .query<{ patient_slug: string; site_slug: string; resource_type: string; resource_count: number }, []>(`
        SELECT rpm.patient_slug, rpm.site_slug, r.resource_type, COUNT(DISTINCT r.resource_pk) AS resource_count
        FROM resource_patient_memberships rpm
        JOIN resources r ON r.resource_pk = rpm.resource_pk
        GROUP BY rpm.patient_slug, rpm.site_slug, r.resource_type
      `)
      .all();
    const siteCounts = new Map<string, Record<string, number>>();
    for (const row of countRows) {
      const key = `${row.patient_slug}|${row.site_slug}`;
      const counts = siteCounts.get(key) ?? {};
      counts[row.resource_type] = Number(row.resource_count);
      siteCounts.set(key, counts);
    }

    const sensitiveParams = SENSITIVE_LABELS.flatMap((label) => [label.system, label.code]);
    const sensitiveRows = this.db
      .query<{ patient_slug: string; site_slug: string; sensitive_count: number }, string[]>(`
        SELECT rpm.patient_slug, rpm.site_slug, COUNT(DISTINCT r.resource_pk) AS sensitive_count
        FROM resource_patient_memberships rpm
        JOIN resources r ON r.resource_pk = rpm.resource_pk
        JOIN resource_labels rl ON rl.resource_pk = r.resource_pk
        WHERE rl.kind = 'security'
          AND (${SENSITIVE_LABELS.map(() => "(rl.system = ? AND rl.code = ?)").join(" OR ")})
        GROUP BY rpm.patient_slug, rpm.site_slug
      `)
      .all(...sensitiveParams);
    const siteSensitiveCounts = new Map(
      sensitiveRows.map((row) => [`${row.patient_slug}|${row.site_slug}`, Number(row.sensitive_count)]),
    );

    const encounterRows = this.db
      .query<{ patient_slug: string; site_slug: string; raw_json: string }, []>(`
        SELECT rpm.patient_slug, rpm.site_slug, r.raw_json
        FROM resource_patient_memberships rpm
        JOIN resources r ON r.resource_pk = rpm.resource_pk
        WHERE r.resource_type = 'Encounter'
        ORDER BY rpm.patient_slug, rpm.site_slug, COALESCE(r.generated_start, r.care_start), r.server_logical_id
      `)
      .all();
    const encountersBySite = new Map<string, DemoEncounterSummary[]>();
    for (const row of encounterRows) {
      const key = `${row.patient_slug}|${row.site_slug}`;
      const encounters = encountersBySite.get(key) ?? [];
      const resource = JSON.parse(row.raw_json);
      encounters.push({
        id: String(resource.id ?? ""),
        type: resource.type?.[0]?.text ?? resource.type?.[0]?.coding?.[0]?.display ?? "Visit",
        classCode: resource.class?.code ?? "",
        date: typeof resource.period?.start === "string" ? resource.period.start.slice(0, 10) : "",
        status: resource.status ?? "",
        summary: findExtensionString(resource, ENCOUNTER_SUMMARY_EXT),
      });
      encountersBySite.set(key, encounters);
    }

    const patientRows = this.db
      .query<{
        patient_slug: string;
        site_slug: string;
        source_patient_ref: string;
        server_patient_ref: string;
        raw_json: string;
      }, []>(`
        SELECT pa.patient_slug, pa.site_slug, pa.source_patient_ref, pa.server_patient_ref, r.raw_json
        FROM patient_aliases pa
        JOIN resources r ON r.server_ref = pa.server_patient_ref
        ORDER BY pa.patient_slug, pa.site_slug
      `)
      .all();

    const persons = new Map<string, DemoPersonSummary>();
    for (const row of patientRows) {
      const resource = JSON.parse(row.raw_json);
      const person = persons.get(row.patient_slug) ?? buildDemoPerson(resource, row.patient_slug);
      if (!persons.has(row.patient_slug)) persons.set(row.patient_slug, person);

      const siteKey = `${row.patient_slug}|${row.site_slug}`;
      const encounters = encountersBySite.get(siteKey) ?? [];
      const counts = siteCounts.get(siteKey) ?? {};
      const site: DemoSiteSummary = {
        siteSlug: row.site_slug,
        orgName: siteMetadata.get(row.site_slug)?.organization_name ?? row.site_slug,
        organizationNpi: siteMetadata.get(row.site_slug)?.organization_npi ?? null,
        jurisdiction: siteMetadata.get(row.site_slug)?.jurisdiction_state ?? null,
        patientId: row.server_patient_ref.split("/", 2)[1] ?? row.server_patient_ref,
        resourceCounts: counts,
        sensitiveResourceCount: siteSensitiveCounts.get(siteKey) ?? 0,
        startDate: encounters[0]?.date ?? null,
        endDate: encounters.at(-1)?.date ?? null,
        encounters,
      };
      person.sites.push(site);
      mergeCounts(person.resourceCounts, counts);
      person.sensitiveResourceCount += site.sensitiveResourceCount;
      person.startDate = minDate(person.startDate, site.startDate);
      person.endDate = maxDate(person.endDate, site.endDate);
    }

    for (const person of persons.values()) {
      person.sites.sort((a, b) => `${a.startDate ?? ""}|${a.siteSlug}`.localeCompare(`${b.startDate ?? ""}|${b.siteSlug}`));
    }

    return [...persons.values()].sort((a, b) => a.displayName.localeCompare(b.displayName));
  }
}

export function materializeVisibleSet(db: Database, envelope: {
  allowedPatientAliases: AllowedPatientAlias[];
  allowedSites?: string[];
  allowedResourceTypes?: string[];
  dateRanges?: Array<{ start?: string; end?: string }>;
  dateSemantics: DateSemantics;
  sensitive: { mode: "deny" | "allow" };
  requiredLabelsAll?: Label[];
  deniedLabelsAny?: Label[];
  granularCategoryRules?: Array<{ resourceType: string; system: string; code: string }>;
}, siteSlug?: string) {
  db.exec(`
    DROP TABLE IF EXISTS temp.allowed_patients;
    CREATE TEMP TABLE allowed_patients (
      site_slug TEXT NOT NULL,
      source_patient_ref TEXT NOT NULL,
      PRIMARY KEY (site_slug, source_patient_ref)
    );
    DROP TABLE IF EXISTS temp.visible_resources;
    CREATE TEMP TABLE visible_resources(resource_pk INTEGER PRIMARY KEY);
  `);
  const insert = db.prepare(`INSERT INTO temp.allowed_patients (site_slug, source_patient_ref) VALUES (?, ?)`);
  for (const alias of envelope.allowedPatientAliases) insert.run(alias.siteSlug, alias.sourcePatientRef);

  const { sql, params } = buildVisibleSql(envelope, siteSlug);
  db.query(sql).run(...params);
}

export function hasVisibleResourceType(
  db: Database,
  envelope: AuthorizationEnvelope,
  resourceType: string,
  siteSlug?: string,
) {
  const { whereSql, params } = buildVisibleWhere(envelope, siteSlug, false);
  const row = db
    .query<{ resourceCount: number }, string[]>(`
      SELECT COUNT(*) as resourceCount
      FROM resources r
      WHERE ${whereSql}
        AND r.resource_type = ?
    `)
    .get(...params, resourceType);
  return (row?.resourceCount ?? 0) > 0;
}

function buildVisibleSql(
  envelope: {
    allowedPatientAliases: AllowedPatientAlias[];
    allowedSites?: string[];
    allowedResourceTypes?: string[];
    dateRanges?: Array<{ start?: string; end?: string }>;
    dateSemantics: DateSemantics;
    sensitive: { mode: "deny" | "allow" };
    requiredLabelsAll?: Label[];
    deniedLabelsAny?: Label[];
    granularCategoryRules?: Array<{ resourceType: string; system: string; code: string }>;
  },
  routeSiteSlug?: string,
) {
  const { whereSql, params } = buildVisibleWhere(envelope, routeSiteSlug);
  return {
    sql: `INSERT INTO temp.visible_resources(resource_pk) SELECT r.resource_pk FROM resources r WHERE ${whereSql}`,
    params,
  };
}

function buildVisibleWhere(
  envelope: {
    allowedPatientAliases: AllowedPatientAlias[];
    allowedSites?: string[];
    allowedResourceTypes?: string[];
    dateRanges?: Array<{ start?: string; end?: string }>;
    dateSemantics: DateSemantics;
    sensitive: { mode: "deny" | "allow" };
    requiredLabelsAll?: Label[];
    deniedLabelsAny?: Label[];
    granularCategoryRules?: Array<{ resourceType: string; system: string; code: string }>;
  },
  routeSiteSlug?: string,
  useTempAllowedPatients = true,
) {
  const params: string[] = [];
  const allowedPatientMembershipClause = useTempAllowedPatients
    ? `
      EXISTS (
        SELECT 1
        FROM resource_patient_memberships rpm
        JOIN temp.allowed_patients ap
          ON ap.site_slug = rpm.site_slug
         AND ap.source_patient_ref = rpm.source_patient_ref
        WHERE rpm.resource_pk = r.resource_pk
      )
    `
    : `
      EXISTS (
        SELECT 1
        FROM resource_patient_memberships rpm
        WHERE rpm.resource_pk = r.resource_pk
          AND (${envelope.allowedPatientAliases.map(() => "(rpm.site_slug = ? AND rpm.source_patient_ref = ?)").join(" OR ")})
      )
    `;
  const clauses: string[] = [
    allowedPatientMembershipClause,
  ];
  if (!useTempAllowedPatients) {
    for (const alias of envelope.allowedPatientAliases) {
      params.push(alias.siteSlug, alias.sourcePatientRef);
    }
  }

  const allowedSites = routeSiteSlug
    ? (envelope.allowedSites === undefined ? [routeSiteSlug] : envelope.allowedSites.filter((site) => site === routeSiteSlug))
    : envelope.allowedSites;
  if (routeSiteSlug && envelope.allowedSites !== undefined && (allowedSites?.length ?? 0) === 0) {
    clauses.push("1 = 0");
  } else if (allowedSites !== undefined) {
    if (allowedSites.length === 0) {
      clauses.push("1 = 0");
    } else {
      clauses.push(`r.site_slug IN (${allowedSites.map(() => "?").join(", ")})`);
      params.push(...allowedSites);
    }
  }

  if (envelope.allowedResourceTypes?.length) {
    clauses.push(`r.resource_type IN (${envelope.allowedResourceTypes.map(() => "?").join(", ")})`);
    params.push(...envelope.allowedResourceTypes);
  }

  if (envelope.dateRanges?.length) {
    const columns = envelope.dateSemantics === "care-overlap"
      ? { start: "care_start", end: "care_end" }
      : { start: "generated_start", end: "generated_end" };
    const rangeParams: string[] = [];
    const rangeClauses = envelope.dateRanges.map((range) => buildDateRangeClause(columns.start, columns.end, range, rangeParams));
    clauses.push(`(
      r.resource_type IN (${[...IDENTITY_TYPES].map(() => "?").join(", ")})
      OR (${rangeClauses.join(" OR ")})
    )`);
    params.push(...IDENTITY_TYPES);
    params.push(...rangeParams);
  }

  if (envelope.sensitive.mode === "deny") {
    clauses.push(`
      NOT EXISTS (
        SELECT 1
        FROM resource_labels rl
        WHERE rl.resource_pk = r.resource_pk
          AND rl.kind = 'security'
          AND (${SENSITIVE_LABELS.map(() => "(rl.system = ? AND rl.code = ?)").join(" OR ")})
      )
    `);
    for (const label of SENSITIVE_LABELS) params.push(label.system, label.code);
  }

  for (const label of envelope.requiredLabelsAll ?? []) {
    clauses.push(`
      EXISTS (
        SELECT 1
        FROM resource_labels rl
        WHERE rl.resource_pk = r.resource_pk
          AND rl.system = ?
          AND rl.code = ?
      )
    `);
    params.push(label.system, label.code);
  }

  if (envelope.deniedLabelsAny?.length) {
    clauses.push(`
      NOT EXISTS (
        SELECT 1
        FROM resource_labels rl
        WHERE rl.resource_pk = r.resource_pk
          AND (${envelope.deniedLabelsAny.map(() => "(rl.system = ? AND rl.code = ?)").join(" OR ")})
      )
    `);
    for (const label of envelope.deniedLabelsAny) params.push(label.system, label.code);
  }

  const groupedRules = new Map<string, Array<{ resourceType: string; system: string; code: string }>>();
  for (const rule of envelope.granularCategoryRules ?? []) {
    const existing = groupedRules.get(rule.resourceType) ?? [];
    existing.push(rule);
    groupedRules.set(rule.resourceType, existing);
  }
  for (const [resourceType, rules] of groupedRules) {
    clauses.push(`
      (
        r.resource_type <> ?
        OR EXISTS (
          SELECT 1
          FROM resource_tokens rt
          WHERE rt.resource_pk = r.resource_pk
            AND rt.param_name = 'category'
            AND (${rules.map(() => "(rt.system = ? AND rt.code = ?)").join(" OR ")})
        )
      )
    `);
    params.push(resourceType);
    for (const rule of rules) params.push(rule.system, rule.code);
  }

  return {
    whereSql: clauses.join(" AND "),
    params,
  };
}

function describePatient(resource: any, fallback: string) {
  return resourcePrimaryDisplay(resource, fallback);
}

function buildDateRangeClause(startColumn: string, endColumn: string, range: { start?: string; end?: string }, params: string[]) {
  if (range.start && range.end) {
    params.push(range.start, range.end);
    return `(r.${startColumn} IS NOT NULL AND COALESCE(r.${endColumn}, r.${startColumn}) >= ? AND r.${startColumn} <= ?)`;
  }
  if (range.start) {
    params.push(range.start);
    return `(r.${startColumn} IS NOT NULL AND COALESCE(r.${endColumn}, r.${startColumn}) >= ?)`;
  }
  if (range.end) {
    params.push(range.end);
    return `(r.${startColumn} IS NOT NULL AND r.${startColumn} <= ?)`;
  }
  return "1 = 1";
}

function compareAlias(a: AllowedPatientAlias, b: AllowedPatientAlias) {
  return `${a.patientSlug}/${a.siteSlug}/${a.sourcePatientRef}`.localeCompare(`${b.patientSlug}/${b.siteSlug}/${b.sourcePatientRef}`);
}

const USE_CASE_TAG_SYSTEM = "https://smarthealthit.org/fhir/CodeSystem/smart-permission-ticket-use-case";

function buildDemoPerson(resource: any, patientSlug: string): DemoPersonSummary {
  const name = resource.name?.[0] ?? {};
  const givenNames = Array.isArray(name.given) ? name.given.filter((value: unknown) => typeof value === "string") : [];
  const familyName = typeof name.family === "string" ? name.family : null;
  const personId = (resource.identifier ?? []).find((identifier: any) => identifier?.system === "urn:smart-permission-tickets:person-id")?.value ?? patientSlug;
  const useCases = (resource.meta?.tag ?? [])
    .filter((tag: any) => tag?.system === USE_CASE_TAG_SYSTEM && tag?.code)
    .map((tag: any) => ({ system: tag.system, code: tag.code, display: tag.display ?? tag.code }));
  return {
    personId,
    patientSlug,
    displayName: describePatient(resource, patientSlug),
    familyName,
    givenNames,
    birthDate: typeof resource.birthDate === "string" ? resource.birthDate : null,
    gender: typeof resource.gender === "string" ? resource.gender : null,
    summary: findExtensionString(resource, PATIENT_SUMMARY_EXT),
    useCases,
    resourceCounts: {},
    sensitiveResourceCount: 0,
    startDate: null,
    endDate: null,
    sites: [],
  };
}

function findExtensionString(resource: any, url: string): string | null {
  const extension = Array.isArray(resource.extension)
    ? resource.extension.find((entry: any) => entry?.url === url)
    : undefined;
  if (typeof extension?.valueMarkdown === "string") return extension.valueMarkdown;
  return null;
}

function mergeCounts(target: Record<string, number>, source: Record<string, number>) {
  for (const [resourceType, count] of Object.entries(source)) {
    target[resourceType] = (target[resourceType] ?? 0) + count;
  }
}

function minDate(current: string | null, next: string | null) {
  if (!current) return next;
  if (!next) return current;
  return current <= next ? current : next;
}

function maxDate(current: string | null, next: string | null) {
  if (!current) return next;
  if (!next) return current;
  return current >= next ? current : next;
}
