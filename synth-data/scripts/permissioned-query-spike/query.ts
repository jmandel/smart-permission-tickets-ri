import { Database } from "bun:sqlite";

import { IDENTITY_TYPES, type DateSemantics, type HiddenRead, type ResourceRow, type Search, type Ticket } from "./model.ts";

export function materializeVisibleSet(db: Database, ticket: Ticket) {
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

  const insertAllowed = db.prepare(`INSERT INTO temp.allowed_patients (site_slug, source_patient_ref) VALUES (?, ?)`);
  for (const alias of ticket.allowedPatientAliases) {
    insertAllowed.run(alias.siteSlug, alias.sourcePatientRef);
  }

  const { sql, params } = buildVisibleSql(ticket);
  db.query(sql).run(...params);
}

export function printTicketCase(db: Database, ticket: Ticket, searches: Search[], hiddenRead?: HiddenRead) {
  const buildStart = performance.now();
  materializeVisibleSet(db, ticket);
  const buildMs = performance.now() - buildStart;
  const visibleCount = scalar<number>(db, "SELECT COUNT(*) FROM temp.visible_resources");

  console.log(`## ${ticket.name}`);
  console.log();
  console.log(`Allowed patient aliases: ${ticket.allowedPatientAliases.map((alias) => `${alias.siteSlug}:${alias.sourcePatientRef}`).join(", ")}`);
  if (ticket.allowedSites?.length) console.log(`Allowed sites: ${ticket.allowedSites.join(", ")}`);
  if (ticket.allowedResourceTypes?.length) console.log(`Allowed resource types: ${ticket.allowedResourceTypes.join(", ")}`);
  if (ticket.dateRange) {
    console.log(`Ticket date window: ${ticket.dateRange.start} to ${ticket.dateRange.end}`);
    console.log(`Date semantics: ${resolveDateSemantics(ticket)} with interval overlap`);
  }
  if (ticket.requiredLabelsAll?.length) console.log(`Required labels: ${formatLabels(ticket.requiredLabelsAll)}`);
  if (ticket.deniedLabelsAny?.length) console.log(`Denied labels: ${formatLabels(ticket.deniedLabelsAny)}`);
  if (ticket.granularCategoryRules?.length) {
    const rules = ticket.granularCategoryRules.map((rule) => `${rule.resourceType}.category=${rule.code}`).join(", ");
      console.log(`Granular category rules: ${rules}`);
  }
  console.log(`Visible-set build time: ${buildMs.toFixed(2)} ms`);
  console.log(`Visible resources: ${visibleCount}`);
  printTable(
    db,
    `
      SELECT r.site_slug, r.resource_type, COUNT(*) AS n
      FROM temp.visible_resources v
      JOIN resources r ON r.resource_pk = v.resource_pk
      GROUP BY r.site_slug, r.resource_type
      ORDER BY r.site_slug, r.resource_type
    `,
    [],
  );

  for (const search of searches) {
    const rows = searchVisibleResources(db, search);
    const semantics = resolveDateSemantics(ticket);
    console.log();
    console.log(`Search: ${search.resourceType}${search.category ? ` with category ${search.category.code}` : ""}`);
    for (const row of rows) {
      console.log(`- ${row.site_slug} ${row.resource_type}/${row.server_logical_id} source=${row.source_logical_id} ${formatWindowForSemantics(row, semantics)} via=${formatSourceForSemantics(row, semantics)}`);
    }
    if (!rows.length) console.log(`- no rows`);
  }

  if (hiddenRead) {
    const row = db
      .query<{ server_ref: string } | null, [string, string, string]>(`
        SELECT r.server_ref
        FROM resources r
        WHERE r.resource_type = ?
          AND r.source_logical_id = ?
          AND r.site_slug = ?
      `)
      .get(hiddenRead.resourceType, hiddenRead.sourceLogicalId, hiddenRead.siteSlug);

    console.log();
    console.log(`Guarded read check: ${hiddenRead.resourceType}/${hiddenRead.sourceLogicalId} at ${hiddenRead.siteSlug}`);
    if (!row) {
      console.log(`- source resource not found`);
    } else {
      const visible = scalar<number>(
        db,
        `
          SELECT COUNT(*)
          FROM temp.visible_resources v
          JOIN resources r ON r.resource_pk = v.resource_pk
          WHERE r.server_ref = ?
        `,
        [row.server_ref],
      );
      console.log(visible ? `- unexpectedly visible as ${row.server_ref}` : `- not visible, guarded read for ${row.server_ref} would 404`);
    }
  }

  console.log();
}

export function printChainedCase(db: Database, ticket: Ticket) {
  materializeVisibleSet(db, ticket);
  const semantics = resolveDateSemantics(ticket);
  console.log(`## ${ticket.name}`);
  console.log();
  console.log(`This simulates a chained-style query where Observation visibility is checked first, then the linked Encounter is joined only through the same visible set.`);
  const rows = db
    .query<ResourceRow, [string, string]>(`
      SELECT DISTINCT
        obs.resource_pk,
        obs.site_slug,
        obs.resource_type,
        obs.source_logical_id,
        obs.server_logical_id,
        obs.care_start,
        obs.care_end,
        obs.care_source_rule,
        obs.care_source_kind,
        obs.generated_start,
        obs.generated_end,
        obs.generated_source_rule,
        obs.generated_source_kind
      FROM temp.visible_resources vv
      JOIN resources obs
        ON obs.resource_pk = vv.resource_pk
      JOIN resource_tokens cat
        ON cat.resource_pk = obs.resource_pk
       AND cat.param_name = 'category'
       AND cat.system = ?
       AND cat.code = ?
      JOIN resource_refs rr
        ON rr.resource_pk = obs.resource_pk
       AND rr.param_name = 'encounter'
       AND rr.target_type = 'Encounter'
      JOIN resources enc
        ON enc.resource_type = 'Encounter'
       AND enc.server_logical_id = rr.target_server_id
      JOIN temp.visible_resources ve
        ON ve.resource_pk = enc.resource_pk
      JOIN resource_tokens enc_class
        ON enc_class.resource_pk = enc.resource_pk
       AND enc_class.param_name = 'class'
       AND enc_class.code = 'AMB'
      WHERE obs.resource_type = 'Observation'
      ORDER BY obs.site_slug, COALESCE(obs.generated_start, obs.care_start), obs.server_logical_id
      LIMIT 10
    `)
    .all("http://terminology.hl7.org/CodeSystem/observation-category", "laboratory");

  for (const row of rows) {
    console.log(`- ${row.site_slug} ${row.resource_type}/${row.server_logical_id} source=${row.source_logical_id} ${formatWindowForSemantics(row, semantics)} via=${formatSourceForSemantics(row, semantics)}`);
  }
  if (!rows.length) console.log(`- no rows`);
  console.log();
}

export function searchVisibleResources(db: Database, search: Search): ResourceRow[] {
  const params: Array<string | number> = [search.resourceType];
  let sql = `
    SELECT
      r.resource_pk,
      r.site_slug,
      r.resource_type,
      r.source_logical_id,
      r.server_logical_id,
      r.care_start,
      r.care_end,
      r.care_source_rule,
      r.care_source_kind,
      r.generated_start,
      r.generated_end,
      r.generated_source_rule,
      r.generated_source_kind
    FROM temp.visible_resources v
    JOIN resources r ON r.resource_pk = v.resource_pk
    WHERE r.resource_type = ?
  `;

  if (search.category) {
    sql += `
      AND EXISTS (
        SELECT 1
        FROM resource_tokens t
        WHERE t.resource_pk = r.resource_pk
          AND t.param_name = 'category'
          AND t.system = ?
          AND t.code = ?
      )
    `;
    params.push(search.category.system, search.category.code);
  }

  sql += ` ORDER BY r.site_slug, COALESCE(r.generated_start, r.care_start), r.server_logical_id`;
  if (search.limit) {
    sql += ` LIMIT ?`;
    params.push(search.limit);
  }
  return db.query<ResourceRow, Array<string | number>>(sql).all(...params);
}

function buildVisibleSql(ticket: Ticket): { sql: string; params: Array<string> } {
  const params: string[] = [];
  const clauses: string[] = [
    `
      EXISTS (
        SELECT 1
        FROM resource_patient_memberships rpm
        JOIN temp.allowed_patients ap
          ON ap.site_slug = rpm.site_slug
         AND ap.source_patient_ref = rpm.source_patient_ref
        WHERE rpm.resource_pk = r.resource_pk
      )
    `,
  ];

  if (ticket.allowedSites?.length) {
    clauses.push(`r.site_slug IN (${placeholders(ticket.allowedSites.length)})`);
    params.push(...ticket.allowedSites);
  }

  if (ticket.allowedResourceTypes?.length) {
    clauses.push(`r.resource_type IN (${placeholders(ticket.allowedResourceTypes.length)})`);
    params.push(...ticket.allowedResourceTypes);
  }

  if (ticket.dateRange) {
    const { startColumn, endColumn } = columnsForSemantics(resolveDateSemantics(ticket));
    clauses.push(`(
        r.resource_type IN (${placeholders(IDENTITY_TYPES.size)})
        OR (
          r.${startColumn} IS NOT NULL
          AND COALESCE(r.${endColumn}, r.${startColumn}) >= ?
          AND r.${startColumn} <= ?
      )
    )`);
    params.push(...IDENTITY_TYPES);
    params.push(ticket.dateRange.start, ticket.dateRange.end);
  }

  for (const label of ticket.requiredLabelsAll ?? []) {
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

  if (ticket.deniedLabelsAny?.length) {
    const denyClauses = ticket.deniedLabelsAny.map(() => `(rl.system = ? AND rl.code = ?)`).join(" OR ");
    clauses.push(`
      NOT EXISTS (
        SELECT 1
        FROM resource_labels rl
        WHERE rl.resource_pk = r.resource_pk
          AND (${denyClauses})
      )
    `);
    for (const label of ticket.deniedLabelsAny) {
      params.push(label.system, label.code);
    }
  }

  const groupedRules = new Map<string, NonNullable<Ticket["granularCategoryRules"]>>();
  for (const rule of ticket.granularCategoryRules ?? []) {
    const existing = groupedRules.get(rule.resourceType) ?? [];
    existing.push(rule);
    groupedRules.set(rule.resourceType, existing);
  }
  for (const [resourceType, rules] of groupedRules) {
    const ruleClauses = rules.map(() => `(rt.system = ? AND rt.code = ?)`).join(" OR ");
    clauses.push(`
      (
        r.resource_type <> ?
        OR EXISTS (
          SELECT 1
          FROM resource_tokens rt
          WHERE rt.resource_pk = r.resource_pk
            AND rt.param_name = 'category'
            AND (${ruleClauses})
        )
      )
    `);
    params.push(resourceType);
    for (const rule of rules) {
      params.push(rule.system, rule.code);
    }
  }

  return {
    sql: `
      INSERT INTO temp.visible_resources(resource_pk)
      SELECT r.resource_pk
      FROM resources r
      WHERE ${clauses.join("\n        AND ")}
    `,
    params,
  };
}

function placeholders(count: number) {
  return new Array(count).fill("?").join(", ");
}

function formatLabels(labels: Array<{ system: string; code: string }>) {
  return labels.map((label) => `${label.system}|${label.code}`).join(", ");
}

function scalar<T>(db: Database, sql: string, params: Array<string | number> = []): T {
  const row = db.query<Record<string, T>, Array<string | number>>(sql).get(...params) as Record<string, T> | null;
  if (!row) return undefined as T;
  return Object.values(row)[0] as T;
}

function printTable(db: Database, sql: string, params: Array<string>) {
  const rows = db.query<Record<string, string | number>, string[]>(sql).all(...params);
  for (const row of rows) {
    const parts = Object.entries(row).map(([key, value]) => `${key}=${value}`);
    console.log(`- ${parts.join(" ")}`);
  }
}

function formatCareWindow(row: Pick<ResourceRow, "care_start" | "care_end">) {
  if (!row.care_start && !row.care_end) return "-";
  if (row.care_start && row.care_end && row.care_start !== row.care_end) {
    return `${row.care_start}..${row.care_end}`;
  }
  return row.care_start ?? row.care_end ?? "-";
}

function formatGeneratedWindow(row: Pick<ResourceRow, "generated_start" | "generated_end">) {
  if (!row.generated_start && !row.generated_end) return "-";
  if (row.generated_start && row.generated_end && row.generated_start !== row.generated_end) {
    return `${row.generated_start}..${row.generated_end}`;
  }
  return row.generated_start ?? row.generated_end ?? "-";
}

function resolveDateSemantics(ticket: Ticket): DateSemantics {
  return ticket.dateSemantics ?? "generated-during-period";
}

function columnsForSemantics(semantics: DateSemantics) {
  return semantics === "care-overlap"
    ? { startColumn: "care_start", endColumn: "care_end" }
    : { startColumn: "generated_start", endColumn: "generated_end" };
}

function formatWindowForSemantics(row: ResourceRow, semantics: DateSemantics) {
  return semantics === "care-overlap" ? `care=${formatCareWindow(row)}` : `generated=${formatGeneratedWindow(row)}`;
}

function formatSourceForSemantics(row: ResourceRow, semantics: DateSemantics) {
  return semantics === "care-overlap"
    ? row.care_source_rule ?? row.care_source_kind
    : row.generated_source_rule ?? row.generated_source_kind;
}
