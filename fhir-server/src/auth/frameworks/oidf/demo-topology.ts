import { generateKeyPairSync } from "node:crypto";

import { computeEcJwkThumbprintSync, normalizePrivateJwk, normalizePublicJwk, signEs256Jwt } from "../../es256-jwt.ts";
import { DEFAULT_DEMO_OIDF_FRAMEWORK_URI } from "../../demo-frameworks.ts";
import { buildAuthBasePath, buildFhirBasePath, type SurfaceMode } from "../../../../shared/surfaces.ts";
import type { SiteSummary } from "../../../store/store.ts";

const ENTITY_STATEMENT_TYP = "entity-statement+jwt";
const TRUST_MARK_TYP = "trust-mark+jwt";
const ENTITY_STATEMENT_TTL_SECONDS = 3600;
const TRUST_MARK_TTL_SECONDS = 86400;

export type OidfDemoFixedEntityRole =
  | "anchor"
  | "app-network"
  | "provider-network"
  | "demo-app"
  | "ticket-issuer";

export type OidfDemoEntityRole = OidfDemoFixedEntityRole | "provider-site";

export type OidfDemoEntity = {
  role: OidfDemoEntityRole;
  entityId: string;
  name: string;
  siteSlug?: string;
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
  providerSiteEntityIds: Record<string, string>;
  ticketIssuerEntityId: string;
  entities: Record<OidfDemoFixedEntityRole, OidfDemoEntity>;
  providerSiteEntities: Record<string, OidfDemoEntity>;
  entityConfigurations: Map<string, string>;
  subordinateStatements: Map<string, Map<string, OidfDemoSubordinateStatement>>;
};

type OidfDemoKeyMaterial = {
  publicJwk: JsonWebKey & { kid?: string };
  privateJwk: JsonWebKey & { kid?: string };
};

type OidfDemoKeyMaterialByRole = Partial<Record<OidfDemoFixedEntityRole, OidfDemoKeyMaterial>>;
type OidfDemoProviderSiteKeyMaterialBySlug = Record<string, OidfDemoKeyMaterial | undefined>;
type OidfDemoSubordinateMetadataPolicy = Record<string, Record<string, Record<string, unknown>>>;
type OidfDemoSubordinateStatement = {
  metadataPolicy: OidfDemoSubordinateMetadataPolicy;
};

const DEFAULT_OIDF_DEMO_KEY_MATERIAL: Record<Exclude<OidfDemoFixedEntityRole, "ticket-issuer">, OidfDemoKeyMaterial> = {
  anchor: generateEcKeyPair(),
  "app-network": generateEcKeyPair(),
  "provider-network": generateEcKeyPair(),
  "demo-app": generateEcKeyPair(),
};

export function buildOidfDemoTopology(
  publicBaseUrl: string,
  defaultMode: SurfaceMode,
  sites: SiteSummary[],
  ticketIssuerSlug: string,
  ticketIssuerName = "Reference Demo Issuer",
  keyMaterialByRole: OidfDemoKeyMaterialByRole = {},
  providerSiteKeyMaterialBySlug: OidfDemoProviderSiteKeyMaterialBySlug = {},
): OidfDemoTopology {
  const trustAnchorEntityId = `${publicBaseUrl}/federation/anchor`;
  const appNetworkEntityId = `${publicBaseUrl}/federation/networks/app`;
  const providerNetworkEntityId = `${publicBaseUrl}/federation/networks/provider`;
  const demoAppEntityId = `${publicBaseUrl}/federation/leafs/demo-app`;
  const ticketIssuerEntityId = `${publicBaseUrl}/federation/leafs/ticket-issuer`;
  const ticketIssuerUrl = `${publicBaseUrl}/issuer/${ticketIssuerSlug}`;
  const trustMarkType = `${publicBaseUrl}/federation/trust-marks/permission-ticket-issuer`;
  const now = Math.floor(Date.now() / 1000);

  const anchor = createEntity("anchor", trustAnchorEntityId, "Demo Trust Anchor", {
    federation_entity: {
      organization_name: "Demo Trust Anchor",
      federation_fetch_endpoint: federationFetchEndpointPath(trustAnchorEntityId),
    },
  }, [], keyMaterialByRole.anchor ?? DEFAULT_OIDF_DEMO_KEY_MATERIAL.anchor);
  const appNetwork = createEntity("app-network", appNetworkEntityId, "Demo App Network", {
    federation_entity: {
      organization_name: "Demo App Network",
      federation_fetch_endpoint: federationFetchEndpointPath(appNetworkEntityId),
    },
  }, [trustAnchorEntityId], keyMaterialByRole["app-network"] ?? DEFAULT_OIDF_DEMO_KEY_MATERIAL["app-network"]);
  const providerNetwork = createEntity("provider-network", providerNetworkEntityId, "Provider Network", {
    federation_entity: {
      organization_name: "Provider Network",
      federation_fetch_endpoint: federationFetchEndpointPath(providerNetworkEntityId),
    },
  }, [trustAnchorEntityId], keyMaterialByRole["provider-network"] ?? DEFAULT_OIDF_DEMO_KEY_MATERIAL["provider-network"]);
  const demoApp = createEntity("demo-app", demoAppEntityId, "OpenID Federation Demo App", {
    oauth_client: {
      client_name: "Leaf Demo App",
      token_endpoint_auth_method: "private_key_jwt",
      redirect_uris: [],
      grant_types: ["client_credentials"],
      response_types: [],
    },
  }, [appNetworkEntityId], keyMaterialByRole["demo-app"] ?? DEFAULT_OIDF_DEMO_KEY_MATERIAL["demo-app"]);
  const ticketIssuer = createEntity("ticket-issuer", ticketIssuerEntityId, ticketIssuerName, {
    federation_entity: {
      organization_name: ticketIssuerName,
      issuer_url: ticketIssuerUrl,
    },
  }, [providerNetworkEntityId], keyMaterialByRole["ticket-issuer"]);
  const providerSiteEntities = Object.fromEntries(
    [...sites]
      .sort((a, b) => a.siteSlug.localeCompare(b.siteSlug))
      .map((site) => {
        const authBasePath = buildAuthBasePath(defaultMode, { mode: defaultMode, siteSlug: site.siteSlug });
        const fhirBasePath = buildFhirBasePath(defaultMode, { mode: defaultMode, siteSlug: site.siteSlug });
        const entity = createEntity(
          "provider-site",
          `${publicBaseUrl}/federation/leafs/provider-sites/${site.siteSlug}`,
          site.organizationName,
          {
            oauth_authorization_server: {
              token_endpoint: `${publicBaseUrl}${authBasePath}/token`,
            },
            oauth_resource: {
              resource: `${publicBaseUrl}${fhirBasePath}`,
            },
          },
          [providerNetworkEntityId],
          providerSiteKeyMaterialBySlug[site.siteSlug],
          site.siteSlug,
        );
        return [site.siteSlug, entity];
      }),
  );
  const providerSiteEntityIds = Object.fromEntries(
    Object.entries(providerSiteEntities).map(([siteSlug, entity]) => [siteSlug, entity.entityId]),
  );

  const ticketIssuerTrustMark = signTrustMark(providerNetwork, ticketIssuer.entityId, trustMarkType, now);
  ticketIssuer.trustMarks = [ticketIssuerTrustMark];

  const entities: Record<OidfDemoFixedEntityRole, OidfDemoEntity> = {
    anchor,
    "app-network": appNetwork,
    "provider-network": providerNetwork,
    "demo-app": demoApp,
    "ticket-issuer": ticketIssuer,
  };

  const entityConfigurations = new Map<string, string>();
  for (const entity of [...Object.values(entities), ...Object.values(providerSiteEntities)]) {
    entityConfigurations.set(entity.entityId, signEntityConfiguration(entity, now));
  }

  const subordinateStatements = new Map<string, Map<string, OidfDemoSubordinateStatement>>();
  addSubordinateStatement(subordinateStatements, appNetwork.entityId, demoApp.entityId, {
    metadataPolicy: {
      oauth_client: {
        client_name: {
          value: "OpenID Federation Demo App",
        },
      },
    },
  });
  addSubordinateStatement(subordinateStatements, anchor.entityId, appNetwork.entityId, {
    metadataPolicy: {
      oauth_client: {
        token_endpoint_auth_method: {
          one_of: ["private_key_jwt"],
        },
      },
    },
  });
  for (const siteEntity of Object.values(providerSiteEntities)) {
    addSubordinateStatement(subordinateStatements, providerNetwork.entityId, siteEntity.entityId, {
      metadataPolicy: {
        oauth_authorization_server: {
          token_endpoint: {
            value: siteEntity.metadata.oauth_authorization_server?.token_endpoint,
          },
        },
        oauth_resource: {
          resource: {
            value: siteEntity.metadata.oauth_resource?.resource,
          },
        },
      },
    });
  }
  addSubordinateStatement(subordinateStatements, providerNetwork.entityId, ticketIssuer.entityId, {
    metadataPolicy: {
      federation_entity: {
        issuer_url: {
          value: ticketIssuerUrl,
        },
      },
    },
  });
  addSubordinateStatement(subordinateStatements, anchor.entityId, providerNetwork.entityId, {
    metadataPolicy: {
      federation_entity: {
        organization_name: {
          default: "Provider Network",
        },
      },
    },
  });

  return {
    frameworkUri: DEFAULT_DEMO_OIDF_FRAMEWORK_URI,
    trustMarkType,
    ticketIssuerUrl,
    trustAnchorEntityId,
    appNetworkEntityId,
    providerNetworkEntityId,
    demoAppEntityId,
    providerSiteEntityIds,
    ticketIssuerEntityId,
    entities,
    providerSiteEntities,
    entityConfigurations,
    subordinateStatements,
  };
}

export function buildOidfTrustChain(topology: OidfDemoTopology, leafEntityId: string) {
  const chain: string[] = [];
  let currentEntityId: string | undefined = leafEntityId;
  let first = true;
  while (currentEntityId) {
    const entity = findEntity(topology, currentEntityId);
    if (!entity) {
      throw new Error(`No OIDF entity configuration published for ${currentEntityId}`);
    }
    if (first) {
      chain.push(signEntityConfiguration(entity, Math.floor(Date.now() / 1000)));
      first = false;
    }
    const parentEntityId: string | undefined = entityAuthorityHints(topology, currentEntityId)[0];
    if (!parentEntityId) {
      if (currentEntityId === topology.trustAnchorEntityId) break;
      throw new Error(`OIDF entity ${currentEntityId} is missing authority_hints for trust-chain construction`);
    }
    const subordinateStatement = topology.subordinateStatements.get(parentEntityId)?.get(currentEntityId);
    if (!subordinateStatement) {
      throw new Error(`No OIDF subordinate statement from ${parentEntityId} to ${currentEntityId}`);
    }
    chain.push(signCurrentSubordinateStatement(topology, parentEntityId, currentEntityId, Math.floor(Date.now() / 1000)));
    currentEntityId = parentEntityId;
    if (currentEntityId === topology.trustAnchorEntityId) {
      const anchorEntity = findEntity(topology, currentEntityId);
      if (!anchorEntity) {
        throw new Error(`No OIDF entity configuration published for ${currentEntityId}`);
      }
      chain.push(signEntityConfiguration(anchorEntity, Math.floor(Date.now() / 1000)));
      break;
    }
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
  siteSlug?: string,
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
    siteSlug,
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
  subject: OidfDemoEntity;
  metadataPolicy: OidfDemoSubordinateMetadataPolicy;
  now: number;
}) {
  return signEs256Jwt({
    iss: options.issuer.entityId,
    sub: options.subject.entityId,
    iat: options.now - 60,
    exp: options.now + ENTITY_STATEMENT_TTL_SECONDS,
    jwks: { keys: [options.subject.publicJwk] },
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
  statements: Map<string, Map<string, OidfDemoSubordinateStatement>>,
  issuerEntityId: string,
  subjectEntityId: string,
  statement: OidfDemoSubordinateStatement,
) {
  let children = statements.get(issuerEntityId);
  if (!children) {
    children = new Map<string, OidfDemoSubordinateStatement>();
    statements.set(issuerEntityId, children);
  }
  children.set(subjectEntityId, statement);
}

export function mintOidfEntityConfiguration(topology: OidfDemoTopology, entityId: string, now = Math.floor(Date.now() / 1000)) {
  const entity = findEntity(topology, entityId);
  if (!entity) return null;
  return signEntityConfiguration(entity, now);
}

export function mintOidfSubordinateStatement(
  topology: OidfDemoTopology,
  issuerEntityId: string,
  subjectEntityId: string,
  now = Math.floor(Date.now() / 1000),
) {
  const statement = topology.subordinateStatements.get(issuerEntityId)?.get(subjectEntityId);
  if (!statement) return null;
  return signCurrentSubordinateStatement(topology, issuerEntityId, subjectEntityId, now);
}

function signCurrentSubordinateStatement(
  topology: OidfDemoTopology,
  issuerEntityId: string,
  subjectEntityId: string,
  now: number,
) {
  const issuer = findEntity(topology, issuerEntityId);
  const subject = findEntity(topology, subjectEntityId);
  const statement = topology.subordinateStatements.get(issuerEntityId)?.get(subjectEntityId);
  if (!issuer || !subject || !statement) {
    throw new Error(`No OIDF subordinate statement from ${issuerEntityId} to ${subjectEntityId}`);
  }
  return signSubordinateStatement({
    issuer,
    subject,
    metadataPolicy: statement.metadataPolicy,
    now,
  });
}

function entityAuthorityHints(topology: OidfDemoTopology, entityId: string) {
  return findEntity(topology, entityId)?.authorityHints ?? [];
}

function findEntity(topology: OidfDemoTopology, entityId: string) {
  for (const entity of Object.values(topology.entities)) {
    if (entity.entityId === entityId) return entity;
  }
  for (const entity of Object.values(topology.providerSiteEntities)) {
    if (entity.entityId === entityId) return entity;
  }
  return null;
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
