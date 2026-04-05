import { type Database } from "bun:sqlite";

import type { AuthorizationEnvelope, ResourceRow } from "./model.ts";
import { materializeVisibleSet } from "./store.ts";
import { normalizeText } from "./path-utils.ts";

type SearchParamKind = "id" | "token" | "string" | "date" | "patient-ref" | "ref";

const SEARCH_MATRIX: Record<string, Record<string, SearchParamKind>> = {
  Patient: {
    _id: "id",
    identifier: "token",
    family: "string",
    given: "string",
    name: "string",
    birthdate: "date",
    gender: "string",
  },
  Observation: {
    patient: "patient-ref",
    category: "token",
    code: "token",
    date: "date",
    status: "token",
    _lastUpdated: "date",
  },
  Condition: {
    patient: "patient-ref",
    category: "token",
    code: "token",
    "clinical-status": "token",
    encounter: "ref",
  },
  DiagnosticReport: {
    patient: "patient-ref",
    category: "token",
    code: "token",
    date: "date",
    status: "token",
  },
  DocumentReference: {
    patient: "patient-ref",
    category: "token",
    type: "token",
    date: "date",
    period: "date",
    status: "token",
  },
  Encounter: {
    patient: "patient-ref",
    class: "token",
    type: "token",
    date: "date",
    location: "ref",
    status: "token",
  },
  MedicationRequest: {
    patient: "patient-ref",
    status: "token",
    intent: "token",
    authoredon: "date",
    encounter: "ref",
  },
  Procedure: {
    patient: "patient-ref",
    status: "token",
    code: "token",
    date: "date",
    encounter: "ref",
  },
  Immunization: {
    patient: "patient-ref",
    status: "token",
    date: "date",
  },
  ServiceRequest: {
    patient: "patient-ref",
    status: "token",
    intent: "token",
    authoredon: "date",
    encounter: "ref",
  },
  AllergyIntolerance: {
    patient: "patient-ref",
    "clinical-status": "token",
    "verification-status": "token",
    code: "token",
  },
  Organization: {
    _id: "id",
  },
  Practitioner: {
    _id: "id",
  },
  Location: {
    _id: "id",
  },
};

const DEFAULT_CATEGORY_SYSTEMS: Record<string, string> = {
  Observation: "http://terminology.hl7.org/CodeSystem/observation-category",
  DiagnosticReport: "http://terminology.hl7.org/CodeSystem/v2-0074",
  DocumentReference: "http://hl7.org/fhir/us/core/CodeSystem/us-core-documentreference-category",
  Condition: "http://terminology.hl7.org/CodeSystem/condition-category",
};

export function getSupportedSearchParams(resourceType: string) {
  return Object.keys(SEARCH_MATRIX[resourceType] ?? {});
}

export function executeRead(
  db: Database,
  envelope: AuthorizationEnvelope,
  routeSiteSlug: string | undefined,
  resourceType: string,
  logicalId: string,
): any | null {
  materializeVisibleSet(db, envelope, routeSiteSlug);
  const row = db
    .query<ResourceRow, [string, string]>(`
      SELECT r.resource_pk, r.representative_patient_slug, r.site_slug, r.resource_type, r.source_logical_id, r.server_logical_id,
             r.server_ref, r.raw_json, r.care_start, r.care_end, r.care_source_rule, r.care_source_kind,
             r.generated_start, r.generated_end, r.generated_source_rule, r.generated_source_kind, r.last_updated
      FROM temp.visible_resources v
      JOIN resources r ON r.resource_pk = v.resource_pk
      WHERE r.resource_type = ? AND r.server_logical_id = ?
    `)
    .get(resourceType, logicalId);
  return row ? JSON.parse(row.raw_json) : null;
}

export function executeSearch(
  db: Database,
  envelope: AuthorizationEnvelope,
  routeSiteSlug: string | undefined,
  resourceType: string,
  searchParams: URLSearchParams,
  baseUrl: string,
) {
  materializeVisibleSet(db, envelope, routeSiteSlug);
  const matrix = SEARCH_MATRIX[resourceType];
  if (!matrix) throw new Error(`Unsupported resource type: ${resourceType}`);

  const params: Array<string | number> = [resourceType];
  const clauses = ["r.resource_type = ?"];
  const summaryMode = searchParams.get("_summary");
  if (summaryMode && summaryMode !== "count") {
    throw new Error(`Unsupported _summary value: ${summaryMode}`);
  }

  for (const [name, values] of groupQueryParams(searchParams).entries()) {
    if (name === "_count" || name === "_summary" || name === "_offset") continue;
    const kind = matrix[name];
    if (!kind) throw new Error(`Unsupported search parameter for ${resourceType}: ${name}`);
    if (!values.length) continue;
    clauses.push(buildSearchClause(resourceType, name, kind, values, params));
  }

  const whereClause = clauses.join(" AND ");
  const total = Number(
    db
      .query<{ total_count: number }, Array<string | number>>(`
        SELECT COUNT(*) AS total_count
        FROM temp.visible_resources v
        JOIN resources r ON r.resource_pk = v.resource_pk
        WHERE ${whereClause}
      `)
      .get(...params)?.total_count ?? 0,
  );

  if (summaryMode === "count") {
    return {
      resourceType: "Bundle",
      type: "searchset",
      total,
      entry: [],
    };
  }

  let limit = Number(searchParams.get("_count") ?? 50);
  if (!Number.isFinite(limit) || limit < 0) limit = 50;
  limit = Math.min(limit, 200);
  let offset = Number(searchParams.get("_offset") ?? 0);
  if (!Number.isFinite(offset) || offset < 0) offset = 0;
  offset = Math.floor(offset);
  const rowParams = [...params, limit, offset];

  const rows = db
    .query<ResourceRow, Array<string | number>>(`
      SELECT r.resource_pk, r.representative_patient_slug, r.site_slug, r.resource_type, r.source_logical_id, r.server_logical_id,
             r.server_ref, r.raw_json, r.care_start, r.care_end, r.care_source_rule, r.care_source_kind,
             r.generated_start, r.generated_end, r.generated_source_rule, r.generated_source_kind, r.last_updated
      FROM temp.visible_resources v
      JOIN resources r ON r.resource_pk = v.resource_pk
      WHERE ${whereClause}
      ORDER BY r.site_slug, r.server_logical_id
      LIMIT ?
      OFFSET ?
    `)
    .all(...rowParams);

  const links: Array<{ relation: string; url: string }> = [];
  const selfParams = new URLSearchParams(searchParams);
  if (limit !== 50 || selfParams.has("_count")) selfParams.set("_count", String(limit));
  if (offset > 0 || selfParams.has("_offset")) selfParams.set("_offset", String(offset));
  else selfParams.delete("_offset");
  links.push({
    relation: "self",
    url: buildSearchUrl(baseUrl, selfParams),
  });
  if (offset + rows.length < total) {
    const nextParams = new URLSearchParams(selfParams);
    nextParams.set("_offset", String(offset + rows.length));
    links.push({
      relation: "next",
      url: buildSearchUrl(baseUrl, nextParams),
    });
  }

  return {
    resourceType: "Bundle",
    type: "searchset",
    total,
    link: links,
    entry: rows.map((row) => {
      const resource = JSON.parse(row.raw_json);
      return {
        fullUrl: `${baseUrl}/${resource.id}`,
        resource,
      };
    }),
  };
}

function buildSearchClause(resourceType: string, paramName: string, kind: SearchParamKind, values: string[], params: Array<string | number>) {
  switch (kind) {
    case "id":
      params.push(...values);
      return `r.server_logical_id IN (${values.map(() => "?").join(", ")})`;
    case "token":
      return buildTokenClause(resourceType, paramName, values, params);
    case "string":
      return buildStringClause(paramName, values, params);
    case "date":
      return buildDateClause(paramName, values, params);
    case "patient-ref":
      return buildPatientRefClause(values, params);
    case "ref":
      return buildReferenceClause(paramName, values, params);
  }
}

function buildTokenClause(resourceType: string, paramName: string, values: string[], params: Array<string | number>) {
  const valueClauses: string[] = [];
  for (const value of values) {
    const { system, code } = parseToken(value, paramName === "category" ? DEFAULT_CATEGORY_SYSTEMS[resourceType] : undefined);
    if (system) {
      valueClauses.push("(t.system = ? AND t.code = ?)");
      params.push(system, code ?? "");
    } else {
      valueClauses.push("(t.code = ? OR t.text_value = ?)");
      params.push(code ?? "", code ?? "");
    }
  }
  return `
    EXISTS (
      SELECT 1
      FROM resource_tokens t
      WHERE t.resource_pk = r.resource_pk
        AND t.param_name = '${paramName}'
        AND (${valueClauses.join(" OR ")})
    )
  `;
}

function buildStringClause(paramName: string, values: string[], params: Array<string | number>) {
  const clauses: string[] = [];
  for (const value of values) {
    const norm = normalizeText(value);
    if (!norm) continue;
    clauses.push("s.norm_value LIKE ?");
    params.push(`${norm}%`);
  }
  if (!clauses.length) return "1 = 0";
  return `
    EXISTS (
      SELECT 1
      FROM resource_strings s
      WHERE s.resource_pk = r.resource_pk
        AND s.param_name = '${paramName}'
        AND (${clauses.join(" OR ")})
    )
  `;
}

function buildDateClause(paramName: string, values: string[], params: Array<string | number>) {
  const clauses: string[] = [];
  for (const rawValue of values) {
    const parsed = parseDateQuery(rawValue);
    if (!parsed) continue;
    switch (parsed.prefix) {
      case "gt":
        clauses.push("d.start_date > ?");
        params.push(parsed.date);
        break;
      case "ge":
        clauses.push("d.start_date >= ?");
        params.push(parsed.date);
        break;
      case "lt":
        clauses.push("COALESCE(d.end_date, d.start_date) < ?");
        params.push(parsed.date);
        break;
      case "le":
        clauses.push("COALESCE(d.end_date, d.start_date) <= ?");
        params.push(parsed.date);
        break;
      default:
        clauses.push("(d.start_date <= ? AND COALESCE(d.end_date, d.start_date) >= ?)");
        params.push(parsed.date, parsed.date);
        break;
    }
  }
  if (!clauses.length) return "1 = 0";
  return `
    EXISTS (
      SELECT 1
      FROM resource_dates d
      WHERE d.resource_pk = r.resource_pk
        AND d.param_name = '${paramName}'
        AND (${clauses.join(" OR ")})
    )
  `;
}

function buildPatientRefClause(values: string[], params: Array<string | number>) {
  const refs = values.map((value) => normalizeReference("Patient", value));
  params.push(...refs);
  return `
    EXISTS (
      SELECT 1
      FROM resource_patient_memberships rpm
      WHERE rpm.resource_pk = r.resource_pk
        AND rpm.server_patient_ref IN (${refs.map(() => "?").join(", ")})
    )
  `;
}

function buildReferenceClause(paramName: string, values: string[], params: Array<string | number>) {
  const refs = values.map((value) => normalizeReference(undefined, value));
  const logicalIds = refs.map((value) => value.split("/", 2).at(1) ?? value);
  params.push(...logicalIds);
  return `
    EXISTS (
      SELECT 1
      FROM resource_refs rr
      WHERE rr.resource_pk = r.resource_pk
        AND rr.param_name = '${paramName}'
        AND rr.target_server_id IN (${logicalIds.map(() => "?").join(", ")})
    )
  `;
}

function groupQueryParams(searchParams: URLSearchParams) {
  const grouped = new Map<string, string[]>();
  for (const [name, value] of searchParams.entries()) {
    const values = value.split(",").map((entry) => entry.trim()).filter(Boolean);
    if (!values.length) continue;
    const existing = grouped.get(name) ?? [];
    existing.push(...values);
    grouped.set(name, existing);
  }
  return grouped;
}

function parseToken(value: string, defaultSystem?: string) {
  if (value.includes("|")) {
    const [system, code] = value.split("|", 2);
    return { system: system || defaultSystem || null, code: code || null };
  }
  return { system: defaultSystem ?? null, code: value };
}

function parseDateQuery(value: string) {
  const match = value.match(/^(eq|ge|gt|le|lt)?(\d{4}-\d{2}-\d{2})$/);
  if (!match) return null;
  return { prefix: match[1] ?? "eq", date: match[2] };
}

function normalizeReference(expectedType: string | undefined, value: string) {
  if (value.includes("/")) return value;
  return expectedType ? `${expectedType}/${value}` : value;
}

function buildSearchUrl(baseUrl: string, params: URLSearchParams) {
  const query = params.toString();
  return query ? `${baseUrl}?${query}` : baseUrl;
}
