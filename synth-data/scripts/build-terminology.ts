#!/usr/bin/env bun
/**
 * Build terminology.sqlite from public sources.
 *
 * Downloads NDJSON vocabulary files (SNOMED, LOINC, RxNorm) from GitHub,
 * fetches FHIR R4 valuesets, UTG code systems, and CDC CVX codes,
 * then builds a SQLite database with FTS5 search index.
 *
 * No submodules, no symlinks — fully self-contained.
 */

import { Database } from "bun:sqlite";
import { existsSync, unlinkSync } from "fs";
import { XMLParser } from "fast-xml-parser";

const DB_PATH = "./terminology.sqlite";
const CACHE_DIR = "./.terminology-cache";

// NDJSON vocabulary files from https://github.com/jmandel/fhir-concept-publication-demo
const NDJSON_BASE =
  "https://github.com/jmandel/fhir-concept-publication-demo/raw/28f02f0e8788a92b095d503eade4e8cbd9219726";
const NDJSON_FILES = [
  "CodeSystem-snomed-20230901.ndjson.gz",
  "CodeSystem-loinc-2.77.ndjson.gz",
  "CodeSystem-rxnorm-03042024.ndjson.gz",
];

// Other public sources
const FHIR_R4_VALUESETS = "https://hl7.org/fhir/R4/valuesets.json";
const UTG_IG = "https://build.fhir.org/ig/HL7/UTG/full-ig.zip";
const CVX_URL =
  "https://www2a.cdc.gov/vaccines/iis/iisstandards/XML2.asp?rpt=cvx";
const CVX_SYSTEM = "http://hl7.org/fhir/sid/cvx";

const BIG_SYSTEMS = new Set([
  "http://snomed.info/sct",
  "http://loinc.org",
  "http://www.nlm.nih.gov/research/umls/rxnorm",
]);

interface Concept {
  code: string;
  display?: string;
  designation?: Array<{ value?: string; use?: { code?: string } }>;
}

// ── Download with caching ──────────────────────────────────────────────

async function cachedDownload(url: string, filename: string): Promise<string> {
  await Bun.spawn(["mkdir", "-p", CACHE_DIR]).exited;
  const path = `${CACHE_DIR}/${filename}`;
  if (existsSync(path)) {
    console.log(`  Using cached: ${filename}`);
    return path;
  }
  console.log(`  Downloading: ${filename}...`);
  const response = await fetch(url, { redirect: "follow" });
  if (!response.ok)
    throw new Error(`Failed to download ${url}: ${response.statusText}`);
  const buffer = await response.arrayBuffer();
  await Bun.write(path, buffer);
  console.log(
    `  Downloaded ${filename} (${(buffer.byteLength / 1024 / 1024).toFixed(1)} MB)`
  );
  return path;
}

// ── Database builder ───────────────────────────────────────────────────

class TerminologyBuilder {
  private db: Database;

  constructor() {
    if (existsSync(DB_PATH)) {
      console.log(`Removing existing ${DB_PATH}`);
      unlinkSync(DB_PATH);
    }
    this.db = new Database(DB_PATH);
    this.initSchema();
  }

  private initSchema() {
    this.db.exec(`
      PRAGMA journal_mode=WAL;
      PRAGMA synchronous=NORMAL;
      PRAGMA temp_store=MEMORY;
      PRAGMA cache_size=10000;

      CREATE TABLE code_systems (
        id INTEGER PRIMARY KEY,
        system TEXT NOT NULL UNIQUE,
        version TEXT, name TEXT, title TEXT, date TEXT,
        concept_count INTEGER DEFAULT 0,
        source TEXT,
        loaded_at TEXT DEFAULT (datetime('now'))
      );

      CREATE TABLE concepts (
        id INTEGER PRIMARY KEY,
        system TEXT NOT NULL,
        code TEXT NOT NULL,
        display TEXT,
        UNIQUE(system, code)
      );

      CREATE TABLE designations (
        id INTEGER PRIMARY KEY,
        concept_id INTEGER NOT NULL,
        label TEXT NOT NULL,
        use_code TEXT,
        FOREIGN KEY (concept_id) REFERENCES concepts(id)
      );

      CREATE INDEX idx_concepts_system ON concepts(system);
      CREATE INDEX idx_concepts_code ON concepts(code);
      CREATE INDEX idx_designations_concept ON designations(concept_id);
    `);
  }

  // ── Load NDJSON.gz vocabularies ──────────────────────────────────────

  async loadNDJSON(filePath: string) {
    console.log(`Loading: ${filePath}`);
    const compressed = await Bun.file(filePath).arrayBuffer();
    const decompressed = Bun.gunzipSync(new Uint8Array(compressed));
    const text = new TextDecoder().decode(decompressed);
    const lines = text.trim().split("\n");
    if (lines.length === 0) throw new Error(`Empty file: ${filePath}`);

    const header = JSON.parse(lines[0]);
    const system = header.url;
    if (!system) throw new Error(`No system URL in: ${filePath}`);
    console.log(
      `  System: ${system} (version: ${header.version || "unknown"})`
    );

    const insertConcept = this.db.prepare(
      `INSERT OR REPLACE INTO concepts (system, code, display) VALUES (?, ?, ?)`
    );
    const insertDesignation = this.db.prepare(
      `INSERT INTO designations (concept_id, label, use_code) VALUES (?, ?, ?)`
    );
    const getConceptId = this.db.prepare(
      `SELECT id FROM concepts WHERE system = ? AND code = ?`
    );

    let count = 0;
    const BATCH = 10000;
    const tx = this.db.transaction((batch: string[]) => {
      for (const line of batch) {
        if (!line.trim()) continue;
        try {
          const c = JSON.parse(line) as Concept;
          if (!c.code) continue;
          insertConcept.run(system, c.code, c.display || "");
          const row = getConceptId.get(system, c.code) as { id: number } | null;
          if (!row) continue;
          if (c.display) insertDesignation.run(row.id, c.display, null);
          for (const d of c.designation || []) {
            if (d.value && d.value !== c.display)
              insertDesignation.run(row.id, d.value, d.use?.code || null);
          }
          count++;
        } catch {}
      }
    });

    for (let i = 1; i < lines.length; i += BATCH) {
      tx(lines.slice(i, Math.min(i + BATCH, lines.length)));
      if (count > 0 && count % 100000 === 0)
        console.log(`  ${count.toLocaleString()} concepts...`);
    }

    this.db
      .prepare(
        `INSERT OR REPLACE INTO code_systems (system, version, name, title, date, concept_count, source) VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        system,
        header.version || null,
        header.name || null,
        header.title || null,
        header.date || null,
        count,
        filePath
      );

    console.log(`  Loaded ${count.toLocaleString()} concepts`);
    return count;
  }

  // ── Load FHIR R4 bundled CodeSystems ────────────────────────────────

  async loadFHIRValuesets() {
    console.log("Loading FHIR R4 valuesets...");
    const path = await cachedDownload(FHIR_R4_VALUESETS, "valuesets.json");
    const bundle = await Bun.file(path).json();
    if (bundle.resourceType !== "Bundle") throw new Error("Invalid bundle");

    const insertConcept = this.db.prepare(
      `INSERT OR REPLACE INTO concepts (system, code, display) VALUES (?, ?, ?)`
    );
    const insertDesignation = this.db.prepare(
      `INSERT INTO designations (concept_id, label, use_code) VALUES (?, ?, ?)`
    );
    const getConceptId = this.db.prepare(
      `SELECT id FROM concepts WHERE system = ? AND code = ?`
    );

    let systems = 0,
      concepts = 0;
    for (const entry of bundle.entry || []) {
      const r = entry.resource;
      if (r?.resourceType !== "CodeSystem" || !r.url) continue;
      if (BIG_SYSTEMS.has(r.url)) continue;
      const cs = r.concept || [];
      if (cs.length === 0) continue;

      const tx = this.db.transaction(() => {
        for (const c of cs) {
          if (!c.code) continue;
          insertConcept.run(r.url, c.code, c.display || "");
          const row = getConceptId.get(r.url, c.code) as { id: number } | null;
          if (row && c.display) insertDesignation.run(row.id, c.display, null);
          concepts++;
        }
      });
      tx();

      this.db
        .prepare(
          `INSERT OR REPLACE INTO code_systems (system, version, name, title, concept_count, source) VALUES (?, ?, ?, ?, ?, ?)`
        )
        .run(r.url, r.version || null, r.name || null, r.title || null, cs.length, "FHIR R4 Valuesets");
      systems++;
    }

    console.log(
      `  Loaded ${systems} code systems, ${concepts.toLocaleString()} concepts`
    );
    return concepts;
  }

  // ── Load UTG code systems ───────────────────────────────────────────

  async loadUTG() {
    console.log("Loading UTG code systems...");
    const path = await cachedDownload(UTG_IG, "utg-full-ig.zip");
    const tempDir = `/tmp/utg-${Date.now()}`;
    await Bun.spawn(["mkdir", "-p", tempDir]).exited;
    await Bun.spawn(["unzip", "-q", "-o", path, "-d", tempDir]).exited;

    const insertConcept = this.db.prepare(
      `INSERT OR REPLACE INTO concepts (system, code, display) VALUES (?, ?, ?)`
    );
    const insertDesignation = this.db.prepare(
      `INSERT INTO designations (concept_id, label, use_code) VALUES (?, ?, ?)`
    );
    const getConceptId = this.db.prepare(
      `SELECT id FROM concepts WHERE system = ? AND code = ?`
    );

    let systems = 0,
      concepts = 0;
    const glob = new Bun.Glob("**/CodeSystem-*.json");
    for await (const p of glob.scan({ cwd: tempDir })) {
      try {
        const cs = await Bun.file(`${tempDir}/${p}`).json();
        if (cs.resourceType !== "CodeSystem" || !cs.url) continue;
        if (BIG_SYSTEMS.has(cs.url)) continue;
        const csConcepts = cs.concept || [];
        if (csConcepts.length === 0) continue;

        const processHierarchy = (items: any[]) => {
          for (const c of items) {
            if (!c.code) continue;
            insertConcept.run(cs.url, c.code, c.display || "");
            const row = getConceptId.get(cs.url, c.code) as { id: number } | null;
            if (row && c.display)
              insertDesignation.run(row.id, c.display, null);
            concepts++;
            if (c.concept) processHierarchy(c.concept);
          }
        };

        this.db.transaction(() => processHierarchy(csConcepts))();
        this.db
          .prepare(
            `INSERT OR REPLACE INTO code_systems (system, version, name, title, concept_count, source) VALUES (?, ?, ?, ?, ?, ?)`
          )
          .run(cs.url, cs.version || null, cs.name || null, cs.title || null, csConcepts.length, "UTG");
        systems++;
      } catch {}
    }

    await Bun.spawn(["rm", "-rf", tempDir]).exited;
    console.log(
      `  Loaded ${systems} code systems, ${concepts.toLocaleString()} concepts`
    );
    return concepts;
  }

  // ── Load CVX vaccine codes ──────────────────────────────────────────

  async loadCVX() {
    console.log("Loading CVX vaccine codes from CDC...");
    try {
      const response = await fetch(CVX_URL);
      if (!response.ok) throw new Error(response.statusText);
      const xml = await response.text();
      const parsed = new XMLParser({
        ignoreAttributes: false,
        parseTagValue: true,
        trimValues: true,
      }).parse(xml);

      const entries = parsed?.CVXCodes?.CVXInfo;
      if (!entries) throw new Error("Invalid CVX XML");
      const items = Array.isArray(entries) ? entries : [entries];

      const insertConcept = this.db.prepare(
        `INSERT OR REPLACE INTO concepts (system, code, display) VALUES (?, ?, ?)`
      );
      const insertDesignation = this.db.prepare(
        `INSERT INTO designations (concept_id, label, use_code) VALUES (?, ?, ?)`
      );
      const getConceptId = this.db.prepare(
        `SELECT id FROM concepts WHERE system = ? AND code = ?`
      );

      let count = 0;
      this.db.transaction(() => {
        for (const item of items) {
          if (item.CVXCode == null) continue;
          const code = String(item.CVXCode).padStart(2, "0");
          const display = item.ShortDescription || "";
          const fullName = item.FullVaccinename || "";
          insertConcept.run(CVX_SYSTEM, code, display);
          const row = getConceptId.get(CVX_SYSTEM, code) as { id: number } | null;
          if (!row) continue;
          if (display) insertDesignation.run(row.id, display, "short");
          if (fullName && fullName !== display)
            insertDesignation.run(row.id, fullName, "full");
          count++;
        }
      })();

      this.db
        .prepare(
          `INSERT OR REPLACE INTO code_systems (system, version, name, title, concept_count, source) VALUES (?, ?, ?, ?, ?, ?)`
        )
        .run(CVX_SYSTEM, null, "CVX", "CDC Vaccine Administered (CVX) Codes", count, "CDC IIS Standards");

      console.log(`  Loaded ${count} CVX codes`);
      return count;
    } catch (e) {
      console.warn(`  Warning: CVX load failed (${e}), skipping`);
      return 0;
    }
  }

  // ── Build FTS index and finalize ────────────────────────────────────

  optimize() {
    console.log("Building FTS search index...");
    this.db.exec(`
      CREATE VIRTUAL TABLE designations_fts USING fts5(
        label, content='designations', content_rowid='id'
      );
      INSERT INTO designations_fts(rowid, label) SELECT id, label FROM designations;
      INSERT INTO designations_fts(designations_fts) VALUES('optimize');

      CREATE TRIGGER designations_ai AFTER INSERT ON designations BEGIN
        INSERT INTO designations_fts(rowid, label) VALUES (new.id, new.label);
      END;
      CREATE TRIGGER designations_au AFTER UPDATE ON designations BEGIN
        DELETE FROM designations_fts WHERE rowid = old.id;
        INSERT INTO designations_fts(rowid, label) VALUES (new.id, new.label);
      END;
      CREATE TRIGGER designations_ad AFTER DELETE ON designations BEGIN
        DELETE FROM designations_fts WHERE rowid = old.id;
      END;

      ANALYZE;
    `);
  }

  printSummary() {
    const s = this.db.prepare("SELECT COUNT(*) as n FROM code_systems").get() as { n: number };
    const c = this.db.prepare("SELECT COUNT(*) as n FROM concepts").get() as { n: number };
    const d = this.db.prepare("SELECT COUNT(*) as n FROM designations").get() as { n: number };
    console.log(`\nSummary:`);
    console.log(`  Code Systems: ${s.n}`);
    console.log(`  Concepts: ${c.n.toLocaleString()}`);
    console.log(`  Designations: ${d.n.toLocaleString()}`);
    console.log(`  Database: ${DB_PATH}`);

    const top = this.db
      .prepare(
        `SELECT system, concept_count FROM code_systems ORDER BY concept_count DESC LIMIT 5`
      )
      .all() as Array<{ system: string; concept_count: number }>;
    console.log(`\nTop systems:`);
    for (const t of top)
      console.log(`  ${t.system}: ${t.concept_count.toLocaleString()}`);
  }

  close() {
    this.db.close();
  }
}

// ── Main ───────────────────────────────────────────────────────────────

async function main() {
  console.log("Building terminology.sqlite\n");
  const builder = new TerminologyBuilder();

  try {
    // 1. Download and load NDJSON vocabularies
    console.log("Step 1: Large vocabularies (SNOMED, LOINC, RxNorm)");
    for (const file of NDJSON_FILES) {
      const path = await cachedDownload(`${NDJSON_BASE}/${file}`, file);
      await builder.loadNDJSON(path);
    }

    // 2. FHIR R4 valuesets
    console.log("\nStep 2: FHIR R4 valuesets");
    await builder.loadFHIRValuesets();

    // 3. UTG
    console.log("\nStep 3: UTG code systems");
    await builder.loadUTG();

    // 4. CVX
    console.log("\nStep 4: CVX vaccine codes");
    await builder.loadCVX();

    // 5. FTS index
    console.log("\nStep 5: FTS index");
    builder.optimize();

    builder.printSummary();
  } finally {
    builder.close();
  }

  console.log("\nDone.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
