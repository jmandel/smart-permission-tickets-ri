import { readdirSync, readFileSync, statSync } from "node:fs";
import { extname, join, relative } from "node:path";

const root = process.cwd();
const publicShimPath = join(root, "shared", "permission-ticket-schema.ts");
const specShimPath = join(root, "shared", "spec-permission-ticket-schema.ts");
const vendorImportFragment = "vendor/smart-permission-tickets-spec/scripts/permission-ticket-schema.ts";
const allowedExtensions = new Set([".ts", ".tsx", ".js", ".jsx", ".mts", ".cts"]);
const ignoredDirs = new Set([".git", "node_modules", "vendor"]);
const errors: string[] = [];

function walk(dir: string): string[] {
  const entries = readdirSync(dir).sort();
  const files: string[] = [];
  for (const entry of entries) {
    const fullPath = join(dir, entry);
    const stats = statSync(fullPath);
    if (stats.isDirectory()) {
      if (!ignoredDirs.has(entry)) files.push(...walk(fullPath));
      continue;
    }
    if (allowedExtensions.has(extname(entry))) files.push(fullPath);
  }
  return files;
}

const selfPath = join(root, "scripts", "check-permission-ticket-schema.ts");

for (const filePath of walk(root)) {
  const text = readFileSync(filePath, "utf8");
  const rel = relative(root, filePath);
  if (filePath !== specShimPath && filePath !== selfPath && text.includes(vendorImportFragment)) {
    errors.push(`${rel}: direct imports from the vendored spec schema are only allowed in shared/spec-permission-ticket-schema.ts`);
  }
  if (filePath !== specShimPath && /(?:export\s+)?const\s+PermissionTicketSchema\b/.test(text)) {
    errors.push(`${rel}: local PermissionTicketSchema definitions are not allowed; import through shared/permission-ticket-schema.ts`);
  }
}

const publicShim = readFileSync(publicShimPath, "utf8").trim();
if (publicShim !== 'export * from "./spec-permission-ticket-schema.ts";') {
  errors.push('shared/permission-ticket-schema.ts must remain a pure re-export shim');
}

const specShim = readFileSync(specShimPath, "utf8");
if (!specShim.includes(vendorImportFragment)) {
  errors.push('shared/spec-permission-ticket-schema.ts must re-export the vendored canonical schema');
}

if (errors.length > 0) {
  console.error("Permission Ticket schema guardrail failed:\n");
  for (const error of errors) console.error(`- ${error}`);
  process.exit(1);
}

console.log("Permission Ticket schema guardrail passed.");
