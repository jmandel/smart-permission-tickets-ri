import { createAppContext, startServer } from "./app.ts";

const context = createAppContext();
const server = startServer(context);

console.log(`FHIR server listening on ${context.config.publicBaseUrl}`);
console.log(`Loaded ${context.store.loadResult.resourceCount} resources with ${context.store.loadResult.serverCollisionCount} server id collisions`);

void server;
