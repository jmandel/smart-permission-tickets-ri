import { generateDemoCryptoBundle } from "../fhir-server/src/demo-crypto-bundle.ts";
import { FhirStore } from "../fhir-server/src/store/store.ts";

const store = FhirStore.load();
const siteSlugs = store.listSiteSummaries().map((site) => site.siteSlug).sort();
const bundle = generateDemoCryptoBundle(siteSlugs);

process.stdout.write(`${JSON.stringify(bundle, null, 2)}\n`);
