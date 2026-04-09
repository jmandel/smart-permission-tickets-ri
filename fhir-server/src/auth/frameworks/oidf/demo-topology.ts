import { generateKeyPairSync } from "node:crypto";

import {
  computeEcJwkThumbprintSync,
  decodeEs256Jwt,
  normalizePrivateJwk,
  normalizePublicJwk,
  signEs256Jwt,
  verifyEs256Jwt,
} from "../../es256-jwt.ts";
import { DEFAULT_DEMO_OIDF_FRAMEWORK_URI } from "../../demo-frameworks.ts";
import { buildAuthBasePath, buildFhirBasePath, type SurfaceMode } from "../../../../shared/surfaces.ts";
import { extractOidfOauthClientPublicJwks } from "./oauth-client-keys.ts";
import type { SiteSummary } from "../../../store/store.ts";
import { SMART_PERMISSION_TICKET_ISSUER_ENTITY_TYPE } from "./smart-permission-ticket-issuer.ts";
import { federationFetchEndpointPath, federationFetchEndpointUrl, oidfEntityConfigurationPath } from "./urls.ts";

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
  browserInstanceEntityBaseId: string;
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

export type MintedOidfBrowserClientInstance = {
  entityId: string;
  leafEntityConfiguration: string;
  subordinateStatement: string;
  trustChain: string[];
};

const OIDF_BROWSER_CLIENT_METADATA_POLICY: OidfDemoSubordinateMetadataPolicy = {
  oauth_client: {
    client_name: {
      value: "OpenID Federation Browser Demo App",
    },
    token_endpoint_auth_method: {
      value: "private_key_jwt",
    },
    grant_types: {
      value: ["client_credentials"],
    },
    response_types: {
      value: [],
    },
    redirect_uris: {
      value: [],
    },
  },
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
  ticketIssuerSigningKeyMaterial?: OidfDemoKeyMaterial,
  keyMaterialByRole: OidfDemoKeyMaterialByRole = {},
  providerSiteKeyMaterialBySlug: OidfDemoProviderSiteKeyMaterialBySlug = {},
): OidfDemoTopology {
  const trustAnchorEntityId = `${publicBaseUrl}/federation/anchor`;
  const appNetworkEntityId = `${publicBaseUrl}/federation/networks/app`;
  const providerNetworkEntityId = `${publicBaseUrl}/federation/networks/provider`;
  const demoAppEntityId = `${publicBaseUrl}/demo/clients/oidf/worldwide-app`;
  const browserInstanceEntityBaseId = `${demoAppEntityId}/instances`;
  const ticketIssuerUrl = `${publicBaseUrl}/issuer/${ticketIssuerSlug}`;
  const ticketIssuerEntityId = ticketIssuerUrl;
  const trustMarkType = `${publicBaseUrl}/federation/trust-marks/permission-ticket-issuer`;
  const now = Math.floor(Date.now() / 1000);
  const ticketIssuerSigningKeys = ticketIssuerSigningKeyMaterial
    ? normalizeKeyMaterial(ticketIssuerSigningKeyMaterial)
    : generateEcKeyPair();

  const anchor = createEntity("anchor", trustAnchorEntityId, "Demo Trust Anchor", {
    federation_entity: {
      organization_name: "Demo Trust Anchor",
      federation_fetch_endpoint: federationFetchEndpointUrl(trustAnchorEntityId),
    },
  }, [], keyMaterialByRole.anchor ?? DEFAULT_OIDF_DEMO_KEY_MATERIAL.anchor);
  const appNetwork = createEntity("app-network", appNetworkEntityId, "Demo App Network", {
    federation_entity: {
      organization_name: "Demo App Network",
      federation_fetch_endpoint: federationFetchEndpointUrl(appNetworkEntityId),
    },
  }, [trustAnchorEntityId], keyMaterialByRole["app-network"] ?? DEFAULT_OIDF_DEMO_KEY_MATERIAL["app-network"]);
  const providerNetwork = createEntity("provider-network", providerNetworkEntityId, "Provider Network", {
    federation_entity: {
      organization_name: "Provider Network",
      federation_fetch_endpoint: federationFetchEndpointUrl(providerNetworkEntityId),
    },
  }, [trustAnchorEntityId], keyMaterialByRole["provider-network"] ?? DEFAULT_OIDF_DEMO_KEY_MATERIAL["provider-network"]);
  const demoApp = createEntity("demo-app", demoAppEntityId, "OIDF Worldwide Demo App", {
    federation_entity: {
      organization_name: "OIDF Worldwide Demo App",
      federation_fetch_endpoint: federationFetchEndpointUrl(demoAppEntityId),
    },
  }, [appNetworkEntityId], keyMaterialByRole["demo-app"] ?? DEFAULT_OIDF_DEMO_KEY_MATERIAL["demo-app"]);
  const ticketIssuer = createEntity("ticket-issuer", ticketIssuerEntityId, ticketIssuerName, {
    federation_entity: {
      organization_name: ticketIssuerName,
    },
    [SMART_PERMISSION_TICKET_ISSUER_ENTITY_TYPE]: {
      jwks: {
        keys: [ticketIssuerSigningKeys.publicJwk],
      },
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
    metadataPolicy: {},
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
    metadataPolicy: {},
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
    browserInstanceEntityBaseId,
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
  const keys = keyMaterial ? normalizeKeyMaterial(keyMaterial) : generateEcKeyPair();
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
    ...(entity.authorityHints.length ? { authority_hints: entity.authorityHints } : {}),
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

export function buildOidfBrowserInstanceEntityId(topology: OidfDemoTopology, instanceId: string) {
  const normalizedInstanceId = instanceId.trim();
  if (!normalizedInstanceId) {
    throw new Error("OIDF browser instance id must be non-empty");
  }
  return `${topology.browserInstanceEntityBaseId}/${normalizedInstanceId}`;
}

export function mintOidfBrowserClientInstance(
  topology: OidfDemoTopology,
  leafEntityConfigurationJwt: string,
  now = Math.floor(Date.now() / 1000),
): MintedOidfBrowserClientInstance {
  const validatedLeaf = validateBrowserLeafEntityConfiguration(topology, leafEntityConfigurationJwt);
  const parentEntity = topology.entities["demo-app"];
  const subordinateStatement = signDynamicSubordinateStatement({
    issuer: parentEntity,
    subjectEntityId: validatedLeaf.entityId,
    subjectJwks: validatedLeaf.federationJwks,
    metadataPolicy: OIDF_BROWSER_CLIENT_METADATA_POLICY,
    now,
  });
  const ancestorChain = buildOidfTrustChain(topology, topology.demoAppEntityId).slice(1);
  return {
    entityId: validatedLeaf.entityId,
    leafEntityConfiguration: leafEntityConfigurationJwt,
    subordinateStatement,
    trustChain: [leafEntityConfigurationJwt, subordinateStatement, ...ancestorChain],
  };
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

function signDynamicSubordinateStatement(options: {
  issuer: OidfDemoEntity;
  subjectEntityId: string;
  subjectJwks: Array<JsonWebKey & { kid: string }>;
  metadataPolicy: OidfDemoSubordinateMetadataPolicy;
  now: number;
}) {
  return signEs256Jwt({
    iss: options.issuer.entityId,
    sub: options.subjectEntityId,
    iat: options.now - 60,
    exp: options.now + ENTITY_STATEMENT_TTL_SECONDS,
    jwks: { keys: options.subjectJwks },
    metadata_policy: options.metadataPolicy,
  }, options.issuer.privateJwk, {
    typ: ENTITY_STATEMENT_TYP,
    kid: options.issuer.publicJwk.kid,
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

function validateBrowserLeafEntityConfiguration(topology: OidfDemoTopology, jwt: string) {
  const decoded = decodeEs256Jwt<Record<string, any>>(jwt) as { header: Record<string, any>; payload: Record<string, any> };
  if (decoded.header.typ !== ENTITY_STATEMENT_TYP) {
    throw new Error("OIDF oidf_browser_leaf_typ_invalid: browser leaf entity configuration must use typ=entity-statement+jwt");
  }
  if (decoded.header.alg !== "ES256") {
    throw new Error("OIDF oidf_browser_leaf_alg_invalid: browser leaf entity configuration must use alg=ES256");
  }
  if (typeof decoded.header.kid !== "string" || !decoded.header.kid.trim()) {
    throw new Error("OIDF oidf_browser_leaf_header_kid_missing: browser leaf entity configuration header is missing kid");
  }

  const payload = decoded.payload;
  if (typeof payload.iss !== "string" || !payload.iss || typeof payload.sub !== "string" || !payload.sub) {
    throw new Error("OIDF oidf_browser_leaf_iss_sub_missing: browser leaf entity configuration must include iss and sub");
  }
  if (payload.iss !== payload.sub) {
    throw new Error("OIDF oidf_browser_leaf_iss_sub_mismatch: browser leaf entity configuration must have iss equal to sub");
  }
  if (!payload.iss.startsWith(`${topology.browserInstanceEntityBaseId}/`)) {
    throw new Error(
      `OIDF oidf_browser_leaf_entity_id_invalid: browser leaf entity_id must be under ${topology.browserInstanceEntityBaseId}`,
    );
  }

  const federationJwks = normalizeFederationJwks(payload.jwks?.keys, "OIDF oidf_browser_leaf_federation_jwks");
  const signingKey = federationJwks.find((key) => key.kid === decoded.header.kid);
  if (!signingKey) {
    throw new Error(
      `OIDF oidf_browser_leaf_kid_mismatch: browser leaf entity configuration kid ${decoded.header.kid} does not match federation jwks`,
    );
  }
  verifyEs256Jwt(jwt, signingKey);

  const authorityHints = payload.authority_hints;
  if (!Array.isArray(authorityHints) || authorityHints.length !== 1 || authorityHints[0] !== topology.demoAppEntityId) {
    throw new Error(
      `OIDF oidf_browser_leaf_authority_hints_invalid: browser leaf authority_hints must equal [${topology.demoAppEntityId}]`,
    );
  }
  if (payload.metadata?.federation_entity) {
    throw new Error(
      "OIDF oidf_browser_leaf_federation_entity_forbidden: browser leaf entity configuration must not include federation_entity metadata",
    );
  }
  extractOidfOauthClientPublicJwks(payload.metadata ?? {});

  return {
    entityId: payload.iss,
    federationJwks,
  };
}

function normalizeFederationJwks(
  jwks: JsonWebKey[] | undefined,
  errorPrefix: string,
): Array<JsonWebKey & { kid: string }> {
  if (!Array.isArray(jwks) || jwks.length === 0) {
    throw new Error(`${errorPrefix}_missing: browser leaf entity configuration is missing top-level jwks.keys`);
  }

  const normalizedKeys = jwks.map((jwk, index) => {
    const keyKid = (jwk as JsonWebKey & { kid?: string }).kid;
    const kid = typeof keyKid === "string"
      ? keyKid.trim()
      : "";
    if (!kid) {
      throw new Error(`${errorPrefix}_kid_missing: browser leaf federation jwks key ${index} is missing kid`);
    }
    try {
      return {
        ...normalizePublicJwk(jwk),
        kid,
      };
    } catch (error) {
      throw new Error(`${errorPrefix}_invalid_key: browser leaf federation jwks key ${index} is invalid (${error instanceof Error ? error.message : String(error)})`);
    }
  });

  const kids = normalizedKeys.map((key) => key.kid);
  if (new Set(kids).size !== kids.length) {
    throw new Error(`${errorPrefix}_duplicate_kid: browser leaf federation jwks contains duplicate kid values`);
  }

  return normalizedKeys;
}

function normalizeKeyMaterial(keyMaterial: OidfDemoKeyMaterial) {
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
}
