import type {
  AuthenticatedClientIdentity,
  FrameworkType,
  RegisteredClient,
  ResolvedFrameworkEntity,
  ResolvedIssuerTrust,
} from "../../store/model.ts";
import type { DemoAuditStep } from "../../../shared/demo-events.ts";

export type SupportedTrustFramework = {
  framework: string;
  framework_type: FrameworkType;
};

export type FrameworkClientRegistration = {
  client?: RegisteredClient | null;
  resolvedEntity?: ResolvedFrameworkEntity | null;
  response: Record<string, any>;
  statusCode?: number;
  audit?: {
    authMode: string;
    outcome: "registered" | "cancelled";
    steps: DemoAuditStep[];
    frameworkUri?: string;
    entityUri?: string;
    algorithm?: string;
  };
};

export interface FrameworkResolver {
  readonly frameworkType: FrameworkType;

  getSupportedTrustFrameworks(): SupportedTrustFramework[];

  matchesClientId(clientId: string): boolean;

  authenticateClientAssertion(
    clientId: string,
    assertionJwt: string,
    tokenEndpointUrl: string,
  ): Promise<AuthenticatedClientIdentity | null>;

  resolveIssuerTrust?(
    issuerUrl: string,
  ): Promise<ResolvedIssuerTrust | null>;

  registerClient?(
    body: Record<string, any>,
    registrationEndpointUrl: string,
    authSurfaceUrl: string,
  ): Promise<FrameworkClientRegistration | null>;
}

export class ClientRegistrationError extends Error {
  constructor(
    readonly errorCode: string,
    readonly description: string,
    readonly status = 400,
    readonly audit?: {
      authMode?: string;
      steps?: DemoAuditStep[];
      frameworkUri?: string;
      entityUri?: string;
      algorithm?: string;
    },
  ) {
    super(description);
  }
}
