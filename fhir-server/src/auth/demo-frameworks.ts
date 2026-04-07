import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { computeEcJwkThumbprintSync, normalizePrivateJwk, normalizePublicJwk } from "./es256-jwt.ts";
import { buildUdapCrlUrl } from "./udap-crl.ts";
import type { FrameworkDefinition } from "../store/model.ts";

export const DEFAULT_DEMO_WELL_KNOWN_FRAMEWORK_URI = "https://smarthealthit.org/trust-frameworks/reference-demo-well-known";
export const DEFAULT_DEMO_UDAP_FRAMEWORK_URI = "https://smarthealthit.org/trust-frameworks/reference-demo-udap";
export const DEFAULT_DEMO_OIDF_FRAMEWORK_URI = "https://smarthealthit.org/trust-frameworks/reference-demo-oidf";
export const DEFAULT_DEMO_WELL_KNOWN_FRAMEWORK_PATH = "/demo/frameworks/well-known-reference.json";
export const DEFAULT_DEMO_UDAP_CLIENT_PATH = "/demo/clients/udap/es256-client";
export const DEFAULT_DEMO_UDAP_RSA_CLIENT_PATH = "/demo/clients/udap/sample-client";
export const DEFAULT_DEMO_UDAP_EC_CA_ID = "ec-root";
export const DEFAULT_DEMO_UDAP_RSA_CA_ID = "rsa-root";

export type DemoWellKnownClientDefinition = {
  slug: string;
  label: string;
  description: string;
  entityPath: string;
  entityUri: string;
  jwksPath: string;
  jwksUrl: string;
  framework: string;
};

export type DemoWellKnownFrameworkDocument = {
  framework: string;
  framework_type: "well-known";
  display_name: string;
  clients: DemoWellKnownClientDefinition[];
};

export type DemoUdapClientDefinition = {
  slug: string;
  label: string;
  description: string;
  entityPath: string;
  entityUri: string;
  framework: string;
  algorithm: "ES256" | "RS256";
  clientName: string;
  scope: string;
  contacts: string[];
  certificatePem: string;
  certificateChainPems: string[];
  privateKeyPem: string;
  certificateSanUri: string;
  caId: string;
};

type DemoUdapClientTemplate = Omit<DemoUdapClientDefinition, "entityUri" | "certificatePem" | "certificateChainPems" | "certificateSanUri"> & {
  issuerCertificatePem: string;
  issuerPrivateKeyPem: string;
};

export const DEFAULT_DEMO_WELL_KNOWN_CLIENT_PRIVATE_JWK: JsonWebKey = normalizePrivateJwk({
  kty: "EC",
  crv: "P-256",
  x: "gwA5e-J9PsxXXZ8arlndCk8-tqiJ3Ye0_BdBTVfvahQ",
  y: "mkjjr7GMPWB26IpuJJKsq7TkhszYr4WQID2SH8CPDbQ",
  d: "DaNuMMgobU757Zs4zr8PJFl6QnrBozHRFqT917WP0QE",
});

export const DEFAULT_DEMO_WELL_KNOWN_CLIENT_PUBLIC_JWK: JsonWebKey & { kid: string } = (() => {
  const publicJwk = normalizePublicJwk({
    kty: "EC",
    crv: "P-256",
    x: DEFAULT_DEMO_WELL_KNOWN_CLIENT_PRIVATE_JWK.x!,
    y: DEFAULT_DEMO_WELL_KNOWN_CLIENT_PRIVATE_JWK.y!,
  });
  const kid = computeEcJwkThumbprintSync(publicJwk);
  return { ...publicJwk, kid };
})();

export function buildDemoWellKnownClients(publicBaseUrl: string): DemoWellKnownClientDefinition[] {
  return [
    {
      slug: "well-known-alpha",
      label: "Northwind Care Viewer",
      description: "Framework-affiliated app that uses an implicit well-known client id and current JWKS resolution.",
      entityPath: "/demo/clients/well-known-alpha",
      entityUri: `${publicBaseUrl}/demo/clients/well-known-alpha`,
      jwksPath: "/demo/clients/well-known-alpha/.well-known/jwks.json",
      jwksUrl: `${publicBaseUrl}/demo/clients/well-known-alpha/.well-known/jwks.json`,
      framework: DEFAULT_DEMO_WELL_KNOWN_FRAMEWORK_URI,
    },
    {
      slug: "well-known-beta",
      label: "Lattice Research Portal",
      description: "Alternate framework-listed client entity published from the same demo server for comparison.",
      entityPath: "/demo/clients/well-known-beta",
      entityUri: `${publicBaseUrl}/demo/clients/well-known-beta`,
      jwksPath: "/demo/clients/well-known-beta/.well-known/jwks.json",
      jwksUrl: `${publicBaseUrl}/demo/clients/well-known-beta/.well-known/jwks.json`,
      framework: DEFAULT_DEMO_WELL_KNOWN_FRAMEWORK_URI,
    },
  ];
}

export function buildDemoWellKnownFrameworkDocument(publicBaseUrl: string): DemoWellKnownFrameworkDocument {
  return {
    framework: DEFAULT_DEMO_WELL_KNOWN_FRAMEWORK_URI,
    framework_type: "well-known",
    display_name: "Reference Demo Well-Known Clients",
    clients: buildDemoWellKnownClients(publicBaseUrl),
  };
}

export const DEFAULT_DEMO_UDAP_TRUST_ANCHOR_PEM = `-----BEGIN CERTIFICATE-----
MIIBkTCCATegAwIBAgIUI4lNDekVA4xIu9azZ/5JCQWdxL0wCgYIKoZIzj0EAwIw
FjEUMBIGA1UEAwwLVURBUCBSb290IEEwHhcNMjYwNDA0MTI0MjQ1WhcNMzYwNDAx
MTI0MjQ1WjAWMRQwEgYDVQQDDAtVREFQIFJvb3QgQTBZMBMGByqGSM49AgEGCCqG
SM49AwEHA0IABDuHcEf5miZBkG/BZxbYG/+5YeAIYwunpP3DJWF8yhzXQrZR9zBJ
wa+15+g8TWuUuNTI1j8wqH4RiJbtyQMSYx2jYzBhMB0GA1UdDgQWBBT1z0xzbT2i
LCaI+PxRgeRkx02zNDAfBgNVHSMEGDAWgBT1z0xzbT2iLCaI+PxRgeRkx02zNDAP
BgNVHRMBAf8EBTADAQH/MA4GA1UdDwEB/wQEAwIBBjAKBggqhkjOPQQDAgNIADBF
AiBtiw6uoPGW17kkVs+roYFzFaPR2mP2/5QktKEnhav02QIhAIwxlL/TtEl7wYpO
mjF5Bbz7YujcucxcC30nTE0Hl3JJ
-----END CERTIFICATE-----`;

export const DEFAULT_DEMO_UDAP_TRUST_ANCHOR_PRIVATE_KEY_PEM = `-----BEGIN PRIVATE KEY-----
MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQgVDbB1vcdRhv2vE6n
//LgZEr0GS3niPMPo6ib9BQv1IahRANCAAQ7h3BH+ZomQZBvwWcW2Bv/uWHgCGML
p6T9wyVhfMoc10K2UfcwScGvtefoPE1rlLjUyNY/MKh+EYiW7ckDEmMd
-----END PRIVATE KEY-----`;

export const DEFAULT_DEMO_UDAP_CLIENT_KEY_PEM = `-----BEGIN EC PRIVATE KEY-----
MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQg2CinBtHsau5XJwSx
fkfZy0lMuyVYAHzpTcw1sGHL5hOhRANCAATtWZb6e+j0elobJ887C+shIaVhuBFL
q78l+Dcf4PrsKrDs/awnPh03822MQMi8WNBUnVlKoQr1R3F7pyNdYPo0
-----END EC PRIVATE KEY-----`;

export const DEFAULT_DEMO_UDAP_RSA_TRUST_ANCHOR_PEM = `-----BEGIN CERTIFICATE-----
MIIDITCCAgmgAwIBAgIUWqq8Icv0WgFIPSTzWI+lqbp/SGIwDQYJKoZIhvcNAQEL
BQAwGDEWMBQGA1UEAwwNVURBUCBSU0EgUm9vdDAeFw0yNjA0MDQxMzEyMzJaFw0z
NjA0MDExMzEyMzJaMBgxFjAUBgNVBAMMDVVEQVAgUlNBIFJvb3QwggEiMA0GCSqG
SIb3DQEBAQUAA4IBDwAwggEKAoIBAQCK1x/ibvr4XgSG9NM76+84Y3Uy+SmJq5xg
ddZjGtjVQr0xzh7gIqnSy1Eb9WtW2QHgVz03Yt+znZR5IqaDVXRM4KVxC3cJQwUz
AL2V70tBmOyakrYCwChRALYDRsmrGep1atOyjues/SlDHZ+xI827y1sfhp8iROcr
odG3fzr9VSIQYFJ4cDjUtPjzD/AB8xVPzzjwJwyacGaebn6SnZ5to+DF/rrX/YjV
uqAelTKqRXwnPOd79TE7icelw2To/sbhrkTdRPRLR2UT67x7sx9K0a4LfGGWKmaL
SLBou97RYIK/zXyqUTffuXpqZ+uETVw9j1JjmDshhXGTWacqHfB/AgMBAAGjYzBh
MB8GA1UdIwQYMBaAFPfzD3SyXn0MtJA4I1pEysIjDXOnMA8GA1UdEwEB/wQFMAMB
Af8wDgYDVR0PAQH/BAQDAgEGMB0GA1UdDgQWBBT38w90sl59DLSQOCNaRMrCIw1z
pzANBgkqhkiG9w0BAQsFAAOCAQEADQyn7XJKhUrV67ix6hEc5L/P+Lx30D/q8a7T
27CQ/SCSAKWnnAveh0kd+PPoBEcK1kD3hc7Q8C367IZidALSHyYV6a+S9eBYqZtj
oMpD+V4lzFwXTDdvepWgCjETkwu9c6wUoy3BAtu6VI6s+xcC8Aln12XZ1AwBZrbG
CS3OWHtnr/byOJVNhFcUgeScpN+nyRE//JknzZuf9rAuI7iRlYW3MJ+HYUD2BO3P
Gqa9UPKG+V2zOuIi9joWeaME9z7b9ufHxJWc9HhJxW3ra2WMgpuZRwVy/I6fBhuw
6uAYJeZ2IiyHeksdbpV8Cb3dcrNqJRvKw0nLB7f9zv3AjSJD1g==
-----END CERTIFICATE-----`;

export const DEFAULT_DEMO_UDAP_RSA_TRUST_ANCHOR_PRIVATE_KEY_PEM = `-----BEGIN PRIVATE KEY-----
MIIEvAIBADANBgkqhkiG9w0BAQEFAASCBKYwggSiAgEAAoIBAQCK1x/ibvr4XgSG
9NM76+84Y3Uy+SmJq5xgddZjGtjVQr0xzh7gIqnSy1Eb9WtW2QHgVz03Yt+znZR5
IqaDVXRM4KVxC3cJQwUzAL2V70tBmOyakrYCwChRALYDRsmrGep1atOyjues/SlD
HZ+xI827y1sfhp8iROcrodG3fzr9VSIQYFJ4cDjUtPjzD/AB8xVPzzjwJwyacGae
bn6SnZ5to+DF/rrX/YjVuqAelTKqRXwnPOd79TE7icelw2To/sbhrkTdRPRLR2UT
67x7sx9K0a4LfGGWKmaLSLBou97RYIK/zXyqUTffuXpqZ+uETVw9j1JjmDshhXGT
WacqHfB/AgMBAAECggEABSjixoypHnyJcCubbDlMgw+v5IJsWKuFAn+briEwSekB
TsgTlR+JBcaIXk9aezg6oM3OoWoIcDsIgcqAgSHlDHpaOi3mcTp9wZwdKcHuB/Sw
TlMBpMxX55WnFreJv0lEF23oc5rHbSrRjUn6F8NHr5VqelWLnhEM67mNWB3IPm+B
Z0hed2seTzKLGwHyC5IGtFf8GWf271EYkYPRF+pFhDC0XBTS9gO9I3xZoAbbozz6
UY0fSsnWPYC8Nxg3vvpGWYybc4aXCaNpfLQriJIL30Fa5ou64gxZkhhX5AFCQ8wq
aRcwMlmo9BkxOIo4mOzLVa+iPDWbIY99svif98bPuQKBgQC+BpAjLjtwXuymNUjq
fLNMl+qkxwyAq5EroLgK3Ahzz7crqJsPMF+CrYO/q4wpYHJOFK7d1hHK4q/J66dN
9wtEDkQFETgC0t7GcOcU2U2a1nCyDKz72cLU8T65Ws9G2BjYonS3C7r+EJj3f6U4
G1i8WmuFuAUiwIyGMPPKUCshawKBgQC7CzkBdKNFy1uDHEQRcuUrZZOiwif5cnnX
EBhZu0FR4SSikjHmu+MkQJPA7K7Fx1Gd0MuyQ2VySMqZJ5krB3ysejgtuSonAS+U
XyJUBdYjoE9d6S/QiCZnBg2d4nNHKr3Qmw/rcM/rGPwejj770Lv9pIHXykYZkLZ9
ysko5jFuPQKBgH4Fjju2onbAjUMhHW1dK+/E5DlJRLJklc8QNF4HVJexjrGmjMcC
9qSMfE5172tVahj8QIggOwaJVbmczgS3rMICj/uoUrQUsud54taB0qS4SF7cZzBT
V5GvOEDmx4YdNEUfYDYw0l9CFKA3CBRwlmW7tYkl5EoK1mb8OgHXLvNnAoGAPrvz
4b4aKQWc6uunFOchYB3Ql61hNPQlU3GtiSMaNHk8DV7VZ9sqwvT52aJIuEMy56ip
OWALfXpWoWm7oMgBE+RmRUeukKiAKdaCsAXJHefd1tSoWdvgbXuFQ6g5G+yE/5uS
ilgrFGIr5Z+2FkWbV+Y+On84Zci4vJYwRAx5Fc0CgYBW0PctkTaakFtxIjZHF2bP
JWBu0ywMkG2w/+V0VFRr8sIYFSmfGs0yQag8AnOrT0F7R9wRrLmGMmZ+CnSrNoKT
afdQG4yzB8KKpeQzPqB2Ma3TazUzRxWKnzY4ddK5I6ZaxtcD12ukCCVsUusn4/s8
7O15INV1pyvw03lJATQrhQ==
-----END PRIVATE KEY-----`;

export const DEFAULT_DEMO_UDAP_RSA_CLIENT_KEY_PEM = `-----BEGIN PRIVATE KEY-----
MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQDUIb4moP6JgQPW
1H79N4q7zFoNXHON2OYflzowCSrTwSudFPBbmvttwY8UZ9DaessIA+nBMlQgE6my
Yk86fiPdKqGYfXuhulZtjeBI+HkbkzJw+AY+8aynBsG7Uzrjge5cQj2mh1EgnyTk
jRxl1Difh1MOOgjk7ITHH3omJtYEImnALBW21SMXL2zsOXAUaWlpTlGfmQSSnlYF
M3Qbzl3oTXdCaUyHj7Qvotg9A490j9+MD9yDT+LGsA/ibdvdiAundrX2CVQvLvaD
vw+DYpJdW9XQjtex42qBI7mrR7ysthVvfWpxazAkv19CNNKS9JjtnXrxJAB+0hT+
IAdKRLQTAgMBAAECggEAAfe49U/FL9shmq9u6OqU38GsZipUEhFC4f3u0FcNbb7O
QkJy9k6QnXrppYu1YFY6P7FIzLERHn9zZNAZO9aQS5ljiImr1c5OLFPGeR00HMeq
2wLNJm4eDV1ex6q+eMsrcSSi8/WWXY7/i+hfk1w6e23vnP0R0kAu/RymiLSpUIsW
CEgTEs4WOFLp/iaKYbbealDg2LXHWhcmkasGefmLNk1GM2CXnOfC0YZ/VmNJSt3N
/UzEEPQl43Pjv7AeFMy1u7dpvj8EJuUe4/TmZ8CQPqXYnUdSSV9H3YQTw64vbTlS
Y/mw5lmYpdYqMY2nBJ9dPx8P+96+SvB9m+B2KYodcQKBgQD/zLEgqQRd5g/P3Rru
u3nTBvBJYNaQt+/NoQQPV75ObzhCCWyGqkGcKh5c0xlXbudE/QcYY5810sI5oLMR
otAsVurCS03TuABa/hSEU91LlDtmPNCiXIOkCS4TWZ3n/5HFGF+fQniUpk+Kji10
66505rXO42qv9r3pamOl4KU30QKBgQDUTErB+wISt0dRe4tEeOC1mIa6eAWC2/Gt
O0vtSyZtcrrKvcUlliV82AeXzbX3RgHbqYqnhXgkrXFEuflhsx7oMHAMZ2mCm8oB
8tMyr5jRX0KwYJqN0FsANLBB0Kch8sZlxs5BFIuEh2bDmRmHOow6epVXLxC2iNgD
f/9oG6QKowKBgH0qZ7GXgm9/11Ta2Abg7Wd5CbKeE9+UYV643wey44f1nA2UFup9
/MSxR1IcaVYDCl8TgJlKhekMS8VvALAsfrhzf0O7HUXvzxy3HsrxTmNhEP+h2mTX
6AIoC8ekHkQbJfTPTFrdZ6s1Bc7CazO+7wp8qZGmbdnUXnEMgd304mNBAoGAHCCb
iwXhqW8lANO4iPLm+shhmVULjeHsLEJ99cuOJNQdkX0BINC62Maagu9bW46n8l2N
JFLXryxXpH5rXxlnT+YTAmG1JfvUENwGRWHkgmD3qfyynXVsiSNx8tZdPm83AAcO
DqtVLNLvt5ySOEt2hsz0+l8e/MA2tof/4+A9pLcCgYEArnwEgi6dxFCOd3FbqRR5
LQnChoQymA/gPyOqiNclxAH5E2a4eUssZGbKBLSdtxtNaQaELOCay3vr0mmzKewY
C6NYpMQG6QJDJTfQM8BosUm3ARVFc7hZTG2HZsZk4quV8zy0CjqsPQ6dTsFq74Fx
e2fZyAxI5h4X/TEzR+EQdB4=
-----END PRIVATE KEY-----`;

const demoUdapClientCache = new Map<string, DemoUdapClientDefinition[]>();

export function buildDemoUdapClients(publicBaseUrl: string): DemoUdapClientDefinition[] {
  const cached = demoUdapClientCache.get(publicBaseUrl);
  if (cached) return cached;

  const clients = [
    materializeDemoUdapClient(publicBaseUrl, {
      slug: "es256-client",
      label: "Reference Demo EC UDAP Client",
      description: "Alternate EC demo client. Its entity URI is asserted through the certificate Subject Alternative Name (SAN).",
      entityPath: DEFAULT_DEMO_UDAP_CLIENT_PATH,
      framework: DEFAULT_DEMO_UDAP_FRAMEWORK_URI,
      algorithm: "ES256",
      clientName: "Reference Demo UDAP Client",
      scope: "system/Patient.rs",
      contacts: ["mailto:ops@example.org"],
      privateKeyPem: DEFAULT_DEMO_UDAP_CLIENT_KEY_PEM,
      issuerCertificatePem: DEFAULT_DEMO_UDAP_TRUST_ANCHOR_PEM,
      issuerPrivateKeyPem: DEFAULT_DEMO_UDAP_TRUST_ANCHOR_PRIVATE_KEY_PEM,
      caId: DEFAULT_DEMO_UDAP_EC_CA_ID,
    }),
    materializeDemoUdapClient(publicBaseUrl, {
      slug: "sample-client",
      label: "Reference Demo RSA UDAP Client",
      description: "Default UDAP demo path. Its entity URI is a resolvable page on this server and comes directly from the certificate Subject Alternative Name (SAN).",
      entityPath: DEFAULT_DEMO_UDAP_RSA_CLIENT_PATH,
      framework: DEFAULT_DEMO_UDAP_FRAMEWORK_URI,
      algorithm: "RS256",
      clientName: "Reference Demo RSA UDAP Client",
      scope: "system/Patient.rs",
      contacts: ["mailto:ops@example.org"],
      privateKeyPem: DEFAULT_DEMO_UDAP_RSA_CLIENT_KEY_PEM,
      issuerCertificatePem: DEFAULT_DEMO_UDAP_RSA_TRUST_ANCHOR_PEM,
      issuerPrivateKeyPem: DEFAULT_DEMO_UDAP_RSA_TRUST_ANCHOR_PRIVATE_KEY_PEM,
      caId: DEFAULT_DEMO_UDAP_RSA_CA_ID,
    }),
  ];

  demoUdapClientCache.set(publicBaseUrl, clients);
  return clients;
}

export function buildDefaultFrameworks(publicBaseUrl: string, issuerSlug: string): FrameworkDefinition[] {
  const issuerUrl = `${publicBaseUrl}/issuer/${issuerSlug}`;
  const oidfAnchorEntityId = `${publicBaseUrl}/federation/anchor`;
  const oidfAppNetworkEntityId = `${publicBaseUrl}/federation/networks/app`;
  const oidfProviderNetworkEntityId = `${publicBaseUrl}/federation/networks/provider`;
  const oidfDemoAppEntityId = `${publicBaseUrl}/federation/leafs/demo-app`;
  const oidfFhirServerEntityId = `${publicBaseUrl}/federation/leafs/fhir-server`;
  const oidfTicketIssuerEntityId = `${publicBaseUrl}/federation/leafs/ticket-issuer`;
  const oidfTrustMarkType = `${publicBaseUrl}/federation/trust-marks/permission-ticket-issuer`;
  const demoWellKnownClients = buildDemoWellKnownClients(publicBaseUrl);
  return [
    {
      framework: DEFAULT_DEMO_WELL_KNOWN_FRAMEWORK_URI,
      frameworkType: "well-known",
      supportsClientAuth: true,
      supportsIssuerTrust: true,
      cacheTtlSeconds: 3600,
      localAudienceMembership: {
        entityUri: publicBaseUrl,
      },
      wellKnown: {
        allowlist: [publicBaseUrl, issuerUrl, ...demoWellKnownClients.map((client) => client.entityUri)],
        jwksRelativePath: "/.well-known/jwks.json",
      },
    },
    {
      framework: DEFAULT_DEMO_UDAP_FRAMEWORK_URI,
      frameworkType: "udap",
      supportsClientAuth: true,
      supportsIssuerTrust: false,
      cacheTtlSeconds: 3600,
      localAudienceMembership: {
        entityUri: publicBaseUrl,
      },
      udap: {
        trustAnchors: [
          DEFAULT_DEMO_UDAP_TRUST_ANCHOR_PEM,
          DEFAULT_DEMO_UDAP_RSA_TRUST_ANCHOR_PEM,
        ],
        certificateAuthorities: [
          {
            caId: DEFAULT_DEMO_UDAP_EC_CA_ID,
            certificatePem: DEFAULT_DEMO_UDAP_TRUST_ANCHOR_PEM,
            privateKeyPem: DEFAULT_DEMO_UDAP_TRUST_ANCHOR_PRIVATE_KEY_PEM,
          },
          {
            caId: DEFAULT_DEMO_UDAP_RSA_CA_ID,
            certificatePem: DEFAULT_DEMO_UDAP_RSA_TRUST_ANCHOR_PEM,
            privateKeyPem: DEFAULT_DEMO_UDAP_RSA_TRUST_ANCHOR_PRIVATE_KEY_PEM,
          },
        ],
        metadataSigningIssuerCaId: DEFAULT_DEMO_UDAP_RSA_CA_ID,
        metadataSigningIssuerCertificatePem: DEFAULT_DEMO_UDAP_RSA_TRUST_ANCHOR_PEM,
        metadataSigningIssuerPrivateKeyPem: DEFAULT_DEMO_UDAP_RSA_TRUST_ANCHOR_PRIVATE_KEY_PEM,
      },
    },
    {
      framework: DEFAULT_DEMO_OIDF_FRAMEWORK_URI,
      frameworkType: "oidf",
      supportsClientAuth: true,
      supportsIssuerTrust: false,
      cacheTtlSeconds: 300,
      localAudienceMembership: {
        entityUri: oidfFhirServerEntityId,
      },
      oidf: {
        trustAnchorEntityId: oidfAnchorEntityId,
        appNetworkEntityId: oidfAppNetworkEntityId,
        providerNetworkEntityId: oidfProviderNetworkEntityId,
        demoAppEntityId: oidfDemoAppEntityId,
        fhirServerEntityId: oidfFhirServerEntityId,
        ticketIssuerEntityId: oidfTicketIssuerEntityId,
        ticketIssuerUrl: issuerUrl,
        trustMarkType: oidfTrustMarkType,
      },
    },
  ];
}

function materializeDemoUdapClient(publicBaseUrl: string, definition: DemoUdapClientTemplate): DemoUdapClientDefinition {
  const entityUri = `${publicBaseUrl}${definition.entityPath}`;
  const certificate = generateIssuerSignedClientCertificate({
    subjectCommonName: definition.clientName,
    subjectAltNameUri: entityUri,
    subjectPrivateKeyPem: definition.privateKeyPem,
    issuerCertificatePem: definition.issuerCertificatePem,
    issuerPrivateKeyPem: definition.issuerPrivateKeyPem,
    crlDistributionUrl: buildUdapCrlUrl(publicBaseUrl, DEFAULT_DEMO_UDAP_FRAMEWORK_URI, definition.caId),
  });
  return {
    slug: definition.slug,
    label: definition.label,
    description: definition.description,
    entityPath: definition.entityPath,
    entityUri,
    framework: definition.framework,
    algorithm: definition.algorithm,
    clientName: definition.clientName,
    scope: definition.scope,
    contacts: definition.contacts,
    certificatePem: certificate.certificatePem,
    certificateChainPems: certificate.certificateChainPems,
    privateKeyPem: definition.privateKeyPem,
    certificateSanUri: entityUri,
    caId: definition.caId,
  };
}

function generateIssuerSignedClientCertificate(options: {
  subjectCommonName: string;
  subjectAltNameUri: string;
  subjectPrivateKeyPem: string;
  issuerCertificatePem: string;
  issuerPrivateKeyPem: string;
  crlDistributionUrl?: string;
}) {
  const workspace = mkdtempSync(join(tmpdir(), "smart-permission-tickets-demo-udap-"));
  const requestConfigPath = join(workspace, "request.cnf");
  const signConfigPath = join(workspace, "sign.cnf");
  const keyPath = join(workspace, "subject.key");
  const csrPath = join(workspace, "subject.csr");
  const certPath = join(workspace, "subject.crt");
  const issuerCertPath = join(workspace, "issuer.crt");
  const issuerKeyPath = join(workspace, "issuer.key");
  try {
    writeFileSync(keyPath, options.subjectPrivateKeyPem, "utf8");
    writeFileSync(issuerCertPath, options.issuerCertificatePem, "utf8");
    writeFileSync(issuerKeyPath, options.issuerPrivateKeyPem, "utf8");
    writeFileSync(
      requestConfigPath,
      [
        "[ req ]",
        "prompt = no",
        "distinguished_name = dn",
        "req_extensions = v3_req",
        "[ dn ]",
        `CN = ${escapeDnValue(options.subjectCommonName)}`,
        "[ v3_req ]",
        "basicConstraints = critical, CA:FALSE",
        "subjectKeyIdentifier = hash",
        "keyUsage = critical, digitalSignature",
        "extendedKeyUsage = clientAuth",
        `subjectAltName = URI:${options.subjectAltNameUri}`,
        ...(options.crlDistributionUrl ? [`crlDistributionPoints = URI:${options.crlDistributionUrl}`] : []),
      ].join("\n"),
      "utf8",
    );
    writeFileSync(
      signConfigPath,
      [
        "[ v3_req ]",
        "basicConstraints = critical, CA:FALSE",
        "subjectKeyIdentifier = hash",
        "authorityKeyIdentifier = keyid,issuer",
        "keyUsage = critical, digitalSignature",
        "extendedKeyUsage = clientAuth",
        `subjectAltName = URI:${options.subjectAltNameUri}`,
        ...(options.crlDistributionUrl ? [`crlDistributionPoints = URI:${options.crlDistributionUrl}`] : []),
      ].join("\n"),
      "utf8",
    );
    execFileSync(
      "openssl",
      [
        "req",
        "-new",
        "-sha256",
        "-key",
        keyPath,
        "-out",
        csrPath,
        "-config",
        requestConfigPath,
      ],
      { stdio: ["ignore", "ignore", "pipe"] },
    );
    execFileSync(
      "openssl",
      [
        "x509",
        "-req",
        "-in",
        csrPath,
        "-CA",
        issuerCertPath,
        "-CAkey",
        issuerKeyPath,
        "-CAcreateserial",
        "-out",
        certPath,
        "-days",
        "365",
        "-sha256",
        "-extfile",
        signConfigPath,
        "-extensions",
        "v3_req",
      ],
      { stdio: ["ignore", "ignore", "pipe"] },
    );
    const certificatePem = readFileSync(certPath, "utf8");
    return {
      certificatePem,
      certificateChainPems: [certificatePem, options.issuerCertificatePem],
    };
  } catch (error) {
    const detail = error instanceof Error ? error.message : "Unknown error";
    throw new Error(`Unable to generate demo UDAP client certificate: ${detail}`);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
}

function escapeDnValue(value: string) {
  return value.replace(/[\\,+<>;\"=]/g, "\\$&");
}
