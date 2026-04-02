import { Database } from "bun:sqlite";

import { initializeSchema, loadAllResources } from "./permissioned-query-spike/ingest.ts";
import { printChainedCase, printTicketCase } from "./permissioned-query-spike/query.ts";
import { buildChainedTicket, buildTickets } from "./permissioned-query-spike/tickets.ts";

function main() {
  const db = new Database(":memory:");
  const loadStart = performance.now();
  initializeSchema(db);
  const loadResult = loadAllResources(db);
  const loadMs = performance.now() - loadStart;

  console.log(`# Permissioned Query Spike`);
  console.log();
  console.log(`Loaded ${scalar<number>(db, "SELECT COUNT(*) FROM resources")} canonical server resources`);
  console.log(`Across ${scalar<number>(db, "SELECT COUNT(DISTINCT representative_patient_slug) FROM resources")} filesystem patients and ${scalar<number>(db, "SELECT COUNT(DISTINCT site_slug) FROM resources")} sites`);
  console.log(`Hydrate time into in-memory SQLite: ${loadMs.toFixed(1)} ms`);
  console.log(`Source collisions on (resourceType, source_id): ${loadResult.sourceCollisionCount}`);
  console.log(`Server collisions on (resourceType, reminted_id): ${loadResult.serverCollisionCount}`);
  console.log();
  console.log(`Generated-window audit by resource type and source rule:`);
  printTable(
    db,
    `
      SELECT resource_type, generated_source_kind, COALESCE(generated_source_rule, '-') AS generated_source_rule, COUNT(*) AS n
      FROM resources
      GROUP BY resource_type, generated_source_kind, generated_source_rule
      ORDER BY resource_type, generated_source_kind, generated_source_rule
    `,
    [],
  );
  console.log(`Undated non-identity patient-scoped resources under generated semantics:`);
  printTable(
    db,
    `
      SELECT resource_type, COUNT(*) AS n
      FROM resources
      WHERE scope_class = 'patient'
        AND resource_type NOT IN ('Patient', 'Organization', 'Practitioner', 'Location', 'PractitionerRole')
        AND generated_start IS NULL
      GROUP BY resource_type
      ORDER BY resource_type
    `,
    [],
  );
  console.log(`Care-window audit by resource type and source rule:`);
  printTable(
    db,
    `
      SELECT resource_type, care_source_kind, COALESCE(care_source_rule, '-') AS care_source_rule, COUNT(*) AS n
      FROM resources
      GROUP BY resource_type, care_source_kind, care_source_rule
      ORDER BY resource_type, care_source_kind, care_source_rule
    `,
    [],
  );
  console.log(`This version remints deterministic server ids at load time.`);
  console.log(`- Patient-scoped resources are namespaced by site + source patient ref + resource type + source id.`);
  console.log(`- Site-scoped resources are namespaced by site + semantic site-level key.`);
  console.log(`- Shared site-level resources can be visible for multiple allowed site-local patients through a membership table.`);
  console.log();
  console.log(`Sample remints for the colliding source id \`Encounter/enc-000\`:`);
  printTable(
    db,
    `
      SELECT site_slug, representative_patient_slug, source_logical_id, server_logical_id
      FROM resources
      WHERE resource_type = 'Encounter'
        AND source_logical_id = 'enc-000'
      ORDER BY representative_patient_slug
    `,
    [],
  );

  for (const item of buildTickets(loadResult.patientAliases)) {
    printTicketCase(
      db,
      item.ticket,
      item.ticket.name.includes("reproductive sensitivity")
        ? [
            { resourceType: "Encounter", limit: 6 },
            { resourceType: "Observation", limit: 6 },
          ]
        : item.ticket.name.includes("HIV and mental-health")
          ? [
              { resourceType: "DiagnosticReport", limit: 6 },
              { resourceType: "Observation", limit: 6 },
            ]
        : item.ticket.name.includes("retina")
        ? [
            { resourceType: "Procedure", limit: 5 },
            { resourceType: "DiagnosticReport", limit: 5 },
          ]
        : item.ticket.name.includes("full chart")
          ? [
              {
                resourceType: "Observation",
                category: {
                  system: "http://terminology.hl7.org/CodeSystem/observation-category",
                  code: "laboratory",
                },
                limit: 6,
              },
            ]
          : item.ticket.name.includes("RA slice")
            ? [
                { resourceType: "Condition", limit: 8 },
                { resourceType: "MedicationRequest", limit: 8 },
              ]
            : [
                {
                  resourceType: "Observation",
                  category: {
                    system: "http://terminology.hl7.org/CodeSystem/observation-category",
                    code: "laboratory",
                  },
                  limit: 8,
                },
              ],
      item.hiddenRead,
    );
  }

  printChainedCase(db, buildChainedTicket(loadResult.patientAliases));

  console.log(`## Notes`);
  console.log(`- Tickets are evaluated against site-qualified source patient aliases, not a global person key.`);
  console.log(`- The corpus now carries real meta.security labels for sensitive domains like sexuality/reproductive health, mental health, and HIV; the spike also layers on a few derived demo labels like clinical-note and renal.`);
  console.log(`- Ticket date ranges now default to "generated during period" semantics, using generated_start/generated_end with encounter fallback where needed.`);
  console.log(`- Date filtering is interval overlap over the selected window model, not full containment.`);
  console.log(`- Clinical care windows are still stored separately so care-overlap can remain an explicit opt-in policy later.`);
  console.log(`- The rules file is ${"./scripts/permissioned-query-spike/care-date-rules.json"} and currently uses dotted-path selectors rather than a full FHIRPath engine.`);
  console.log(`- Generated-date rules live in ${"./scripts/permissioned-query-spike/generated-date-rules.json"}.`);
}

function scalar<T>(db: Database, sql: string) {
  const row = db.query<Record<string, T>, []>(sql).get() as Record<string, T> | null;
  if (!row) return undefined as T;
  return Object.values(row)[0] as T;
}

function printTable(db: Database, sql: string, params: Array<string>) {
  const rows = db.query<Record<string, string | number>, string[]>(sql).all(...params);
  for (const row of rows) {
    const parts = Object.entries(row).map(([key, value]) => `${key}=${value}`);
    console.log(`- ${parts.join(" ")}`);
  }
  console.log();
}

main();
