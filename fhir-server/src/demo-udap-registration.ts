import {
  buildDemoUdapClients,
} from "./auth/demo-frameworks.ts";
import { pemToDerBase64, signEs256JwtWithPem, signRs256JwtWithPem } from "./auth/x509-jwt.ts";

const origin = Bun.env.DEMO_ORIGIN ?? "http://localhost:8091";
const requestedAlg = Bun.env.DEMO_UDAP_ALG === "RS256" ? "RS256" : "ES256";

const udapMetadata = await fetchJson<Record<string, any>>(`${origin}/.well-known/udap`);
const registrationEndpoint = String(udapMetadata.registration_endpoint ?? `${origin}/register`);
const softwareStatement = buildSoftwareStatement(registrationEndpoint);

const registrationResponse = await fetch(registrationEndpoint, {
  method: "POST",
  headers: {
    "content-type": "application/json",
  },
  body: JSON.stringify({
    udap: "1",
    software_statement: softwareStatement,
  }),
});

const registrationBody = await parseResponse(registrationResponse);
console.log(JSON.stringify({
  origin,
  discovery: udapMetadata,
  registration_status: registrationResponse.status,
  registration: registrationBody,
}, null, 2));

function buildSoftwareStatement(registrationEndpoint: string) {
  const isRs256 = requestedAlg === "RS256";
  const client = buildDemoUdapClients(origin).find((entry) => entry.algorithm === requestedAlg) ?? buildDemoUdapClients(origin)[0];
  const entityUri = client.entityUri;
  const privateKeyPem = client.privateKeyPem;
  const certificatePem = client.certificatePem;
  const payload = {
    iss: entityUri,
    sub: entityUri,
    aud: registrationEndpoint,
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + 300,
    jti: crypto.randomUUID(),
    client_name: client.clientName,
    grant_types: ["client_credentials"],
    token_endpoint_auth_method: "private_key_jwt",
    scope: client.scope,
    contacts: client.contacts,
  };
  const header = {
    x5c: [pemToDerBase64(certificatePem)],
  };
  return isRs256
    ? signRs256JwtWithPem(payload, privateKeyPem, header)
    : signEs256JwtWithPem(payload, privateKeyPem, header);
}

async function fetchJson<T>(url: string) {
  const response = await fetch(url);
  const body = await parseResponse(response);
  if (!response.ok) throw new Error(`Request failed (${response.status}): ${JSON.stringify(body)}`);
  return body as T;
}

async function parseResponse(response: Response) {
  const text = await response.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}
