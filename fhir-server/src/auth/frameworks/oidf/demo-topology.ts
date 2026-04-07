import { generateKeyPairSync } from "node:crypto";

import { computeEcJwkThumbprintSync, normalizePrivateJwk, normalizePublicJwk, signEs256Jwt } from "../../es256-jwt.ts";
import { DEFAULT_DEMO_OIDF_FRAMEWORK_URI } from "../../demo-frameworks.ts";

const ENTITY_STATEMENT_TYP = "entity-statement+jwt";
const TRUST_MARK_TYP = "trust-mark+jwt";
const ENTITY_STATEMENT_TTL_SECONDS = 3600;
const TRUST_MARK_TTL_SECONDS = 86400;

export type OidfDemoEntityRole =
  | "anchor"
  | "app-network"
  | "provider-network"
  | "demo-app"
  | "fhir-server"
  | "ticket-issuer";

export type OidfDemoEntity = {
  role: OidfDemoEntityRole;
  entityId: string;
  name: string;
  publicJwk: JsonWebKey & { kid: string };
  privateJwk: JsonWebKey & { kid: string };
  metadata: Record<string, Record<string, unknown>>;
  authorityHints: string[];
  trustMarks?: string[];
};

export type OidfDemoTopology = {
  frameworkUri: string;
  trustMarkType: string;
  ticketIssuerUrl: string;
  trustAnchorEntityId: string;
  appNetworkEntityId: string;
  providerNetworkEntityId: string;
  demoAppEntityId: string;
  fhirServerEntityId: string;
  ticketIssuerEntityId: string;
  entities: Record<OidfDemoEntityRole, OidfDemoEntity>;
  entityConfigurations: Map<string, string>;
  subordinateStatements: Map<string, Map<string, string>>;
};

export function buildOidfDemoTopology(
  publicBaseUrl: string,
  ticketIssuerSlug: string,
  ticketIssuerName = "Reference Demo Issuer",
  ticketIssuerKeys?: {
    publicJwk: JsonWebKey & { kid?: string };
    privateJwk: JsonWebKey & { kid?: string };
  },
): OidfDemoTopology {
  const trustAnchorEntityId = `${publicBaseUrl}/federation/anchor`;
  const appNetworkEntityId = `${publicBaseUrl}/federation/networks/app`;
  const providerNetworkEntityId = `${publicBaseUrl}/federation/networks/provider`;
  const demoAppEntityId = `${publicBaseUrl}/federation/leafs/demo-app`;
  const fhirServerEntityId = `${publicBaseUrl}/federation/leafs/fhir-server`;
  const ticketIssuerEntityId = `${publicBaseUrl}/federation/leafs/ticket-issuer`;
  const ticketIssuerUrl = `${publicBaseUrl}/issuer/${ticketIssuerSlug}`;
  const trustMarkType = `${publicBaseUrl}/federation/trust-marks/permission-ticket-issuer`;
  const now = Math.floor(Date.now() / 1000);

  const anchor = createEntity("anchor", trustAnchorEntityId, "Demo Trust Anchor", {
    federation_entity: {
      organization_name: "Demo Trust Anchor",
      federation_fetch_endpoint: federationFetchEndpointPath(trustAnchorEntityId),
    },
  });
  const appNetwork = createEntity("app-network", appNetworkEntityId, "Demo App Network", {
    federation_entity: {
      organization_name: "Demo App Network",
      federation_fetch_endpoint: federationFetchEndpointPath(appNetworkEntityId),
    },
  }, [trustAnchorEntityId]);
  const providerNetwork = createEntity("provider-network", providerNetworkEntityId, "Provider Network", {
    federation_entity: {
      organization_name: "Provider Network",
      federation_fetch_endpoint: federationFetchEndpointPath(providerNetworkEntityId),
    },
  }, [trustAnchorEntityId]);
  const demoApp = createEntity("demo-app", demoAppEntityId, "OpenID Federation Demo App", {
    oauth_client: {
      client_name: "Leaf Demo App",
      token_endpoint_auth_method: "private_key_jwt",
      redirect_uris: [],
      grant_types: ["client_credentials"],
      response_types: [],
    },
  }, [appNetworkEntityId]);
  const fhirServer = createEntity("fhir-server", fhirServerEntityId, "FHIR Server", {
    oauth_authorization_server: {
      token_endpoint: `${publicBaseUrl}/token`,
    },
  }, [providerNetworkEntityId]);
  const ticketIssuer = createEntity("ticket-issuer", ticketIssuerEntityId, ticketIssuerName, {
    federation_entity: {
      organization_name: ticketIssuerName,
      issuer_url: ticketIssuerUrl,
    },
  }, [providerNetworkEntityId], ticketIssuerKeys);

  const ticketIssuerTrustMark = signTrustMark(providerNetwork, ticketIssuer.entityId, trustMarkType, now);
  ticketIssuer.trustMarks = [ticketIssuerTrustMark];

  const entities: Record<OidfDemoEntityRole, OidfDemoEntity> = {
    anchor,
    "app-network": appNetwork,
    "provider-network": providerNetwork,
    "demo-app": demoApp,
    "fhir-server": fhirServer,
    "ticket-issuer": ticketIssuer,
  };

  const entityConfigurations = new Map<string, string>();
  for (const entity of Object.values(entities)) {
    entityConfigurations.set(entity.entityId, signEntityConfiguration(entity, now));
  }

  const subordinateStatements = new Map<string, Map<string, string>>();
  addSubordinateStatement(subordinateStatements, appNetwork.entityId, demoApp.entityId, signSubordinateStatement({
    issuer: appNetwork,
    subjectEntityId: demoApp.entityId,
    metadataPolicy: {
      oauth_client: {
        client_name: {
          value: "OpenID Federation Demo App",
        },
      },
    },
    now,
  }));
  addSubordinateStatement(subordinateStatements, anchor.entityId, appNetwork.entityId, signSubordinateStatement({
    issuer: anchor,
    subjectEntityId: appNetwork.entityId,
    metadataPolicy: {
      oauth_client: {
        token_endpoint_auth_method: {
          one_of: ["private_key_jwt"],
        },
      },
    },
    now,
  }));
  addSubordinateStatement(subordinateStatements, providerNetwork.entityId, fhirServer.entityId, signSubordinateStatement({
    issuer: providerNetwork,
    subjectEntityId: fhirServer.entityId,
    metadataPolicy: {
      oauth_authorization_server: {
        token_endpoint: {
          value: `${publicBaseUrl}/token`,
        },
      },
    },
    now,
  }));
  addSubordinateStatement(subordinateStatements, providerNetwork.entityId, ticketIssuer.entityId, signSubordinateStatement({
    issuer: providerNetwork,
    subjectEntityId: ticketIssuer.entityId,
    metadataPolicy: {
      federation_entity: {
        issuer_url: {
          value: ticketIssuerUrl,
        },
      },
    },
    now,
  }));
  addSubordinateStatement(subordinateStatements, anchor.entityId, providerNetwork.entityId, signSubordinateStatement({
    issuer: anchor,
    subjectEntityId: providerNetwork.entityId,
    metadataPolicy: {
      federation_entity: {
        organization_name: {
          default: "Provider Network",
        },
      },
    },
    now,
  }));

  return {
    frameworkUri: DEFAULT_DEMO_OIDF_FRAMEWORK_URI,
    trustMarkType,
    ticketIssuerUrl,
    trustAnchorEntityId,
    appNetworkEntityId,
    providerNetworkEntityId,
    demoAppEntityId,
    fhirServerEntityId,
    ticketIssuerEntityId,
    entities,
    entityConfigurations,
    subordinateStatements,
  };
}

export function buildOidfTrustChain(topology: OidfDemoTopology, leafEntityId: string) {
  const chain: string[] = [];
  let currentEntityId: string | undefined = leafEntityId;
  while (currentEntityId) {
    const entityConfiguration = topology.entityConfigurations.get(currentEntityId);
    if (!entityConfiguration) {
      throw new Error(`No OIDF entity configuration published for ${currentEntityId}`);
    }
    chain.push(entityConfiguration);
    const parentEntityId: string | undefined = entityAuthorityHints(topology, currentEntityId)[0];
    if (!parentEntityId) break;
    const subordinateStatement = topology.subordinateStatements.get(parentEntityId)?.get(currentEntityId);
    if (!subordinateStatement) {
      throw new Error(`No OIDF subordinate statement from ${parentEntityId} to ${currentEntityId}`);
    }
    chain.push(subordinateStatement);
    currentEntityId = parentEntityId;
  }
  return chain;
}

export function oidfEntityConfigurationPath(entityId: string) {
  return `${new URL(entityId).pathname}/.well-known/openid-federation`;
}

export function federationFetchEndpointPath(entityId: string) {
  return `${new URL(entityId).pathname}/federation_fetch_endpoint`;
}

export function findOidfEntityIdByConfigurationPath(topology: OidfDemoTopology, pathname: string) {
  for (const entityId of topology.entityConfigurations.keys()) {
    if (oidfEntityConfigurationPath(entityId) === pathname) return entityId;
  }
  return null;
}

export function findOidfIssuerEntityIdByFetchPath(topology: OidfDemoTopology, pathname: string) {
  for (const issuerEntityId of topology.subordinateStatements.keys()) {
    if (federationFetchEndpointPath(issuerEntityId) === pathname) return issuerEntityId;
  }
  return null;
}

function createEntity(
  role: OidfDemoEntityRole,
  entityId: string,
  name: string,
  metadata: Record<string, Record<string, unknown>>,
  authorityHints: string[] = [],
  keyMaterial?: {
    publicJwk: JsonWebKey & { kid?: string };
    privateJwk: JsonWebKey & { kid?: string };
  },
): OidfDemoEntity {
  const keys = keyMaterial
    ? (() => {
      const normalizedPublicJwk = normalizePublicJwk(keyMaterial.publicJwk);
      const publicJwk = {
        ...normalizedPublicJwk,
        kid: typeof keyMaterial.publicJwk.kid === "string"
          ? keyMaterial.publicJwk.kid
          : computeEcJwkThumbprintSync(normalizedPublicJwk),
      };
      return {
        publicJwk,
        privateJwk: {
          ...normalizePrivateJwk(keyMaterial.privateJwk),
          kid: typeof keyMaterial.privateJwk.kid === "string" ? keyMaterial.privateJwk.kid : publicJwk.kid,
        },
      };
    })()
    : generateEcKeyPair();
  return {
    role,
    entityId,
    name,
    publicJwk: keys.publicJwk,
    privateJwk: keys.privateJwk,
    metadata,
    authorityHints,
  };
}

function signEntityConfiguration(entity: OidfDemoEntity, now: number) {
  return signEs256Jwt({
    iss: entity.entityId,
    sub: entity.entityId,
    iat: now - 60,
    exp: now + ENTITY_STATEMENT_TTL_SECONDS,
    jwks: { keys: [entity.publicJwk] },
    metadata: entity.metadata,
    authority_hints: entity.authorityHints,
    ...(entity.trustMarks?.length ? { trust_marks: entity.trustMarks } : {}),
  }, entity.privateJwk, {
    typ: ENTITY_STATEMENT_TYP,
    kid: entity.publicJwk.kid,
  });
}

function signSubordinateStatement(options: {
  issuer: OidfDemoEntity;
  subjectEntityId: string;
  metadataPolicy: Record<string, Record<string, Record<string, unknown>>>;
  now: number;
}) {
  return signEs256Jwt({
    iss: options.issuer.entityId,
    sub: options.subjectEntityId,
    iat: options.now - 60,
    exp: options.now + ENTITY_STATEMENT_TTL_SECONDS,
    metadata_policy: options.metadataPolicy,
  }, options.issuer.privateJwk, {
    typ: ENTITY_STATEMENT_TYP,
    kid: options.issuer.publicJwk.kid,
  });
}

function signTrustMark(issuer: OidfDemoEntity, subjectEntityId: string, trustMarkType: string, now: number) {
  return signEs256Jwt({
    iss: issuer.entityId,
    sub: subjectEntityId,
    iat: now - 60,
    exp: now + TRUST_MARK_TTL_SECONDS,
    trust_mark_type: trustMarkType,
  }, issuer.privateJwk, {
    typ: TRUST_MARK_TYP,
    kid: issuer.publicJwk.kid,
  });
}

function addSubordinateStatement(
  statements: Map<string, Map<string, string>>,
  issuerEntityId: string,
  subjectEntityId: string,
  statement: string,
) {
  let children = statements.get(issuerEntityId);
  if (!children) {
    children = new Map<string, string>();
    statements.set(issuerEntityId, children);
  }
  children.set(subjectEntityId, statement);
}

function entityAuthorityHints(topology: OidfDemoTopology, entityId: string) {
  for (const entity of Object.values(topology.entities)) {
    if (entity.entityId === entityId) return entity.authorityHints;
  }
  return [];
}

function generateEcKeyPair() {
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const publicJwk = normalizePublicJwk(publicKey.export({ format: "jwk" }) as JsonWebKey);
  const kid = computeEcJwkThumbprintSync(publicJwk);
  return {
    publicJwk: { ...publicJwk, kid },
    privateJwk: {
      ...normalizePrivateJwk(privateKey.export({ format: "jwk" }) as JsonWebKey),
      kid,
    },
  };
}
