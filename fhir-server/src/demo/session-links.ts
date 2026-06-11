type SessionLinkEntry = {
  sessionId: string;
  updatedAt: number;
};

// Where a ticket sat in its issuance batch. Proposal 003 can mint several
// tickets in one token response (one per chosen site); the protocol trace
// uses this to say which ticket index a client presented at each site.
export type TicketMintInfo = {
  ticketIndex: number;
  ticketCount: number;
};

export class DemoSessionLinks {
  private readonly tickets = new Map<string, SessionLinkEntry>();
  private readonly clients = new Map<string, SessionLinkEntry>();
  private readonly accessTokens = new Map<string, SessionLinkEntry>();
  private readonly ticketMints = new Map<string, TicketMintInfo>();

  constructor(private readonly ttlMs = 24 * 60 * 60 * 1000) {}

  bindTicket(sessionId: string, signedTicket: string, mint?: TicketMintInfo) {
    this.bind(this.tickets, signedTicket, sessionId);
    if (mint) this.ticketMints.set(signedTicket, mint);
  }

  sessionForTicket(signedTicket: string | null | undefined) {
    return this.lookup(this.tickets, signedTicket);
  }

  mintInfoForTicket(signedTicket: string | null | undefined): TicketMintInfo | null {
    if (!signedTicket || !this.lookup(this.tickets, signedTicket)) return null;
    return this.ticketMints.get(signedTicket) ?? null;
  }

  bindClient(sessionId: string, clientId: string) {
    this.bind(this.clients, clientId, sessionId);
  }

  sessionForClient(clientId: string | null | undefined) {
    return this.lookup(this.clients, clientId);
  }

  bindAccessToken(sessionId: string, accessToken: string) {
    this.bind(this.accessTokens, accessToken, sessionId);
  }

  sessionForAccessToken(accessToken: string | null | undefined) {
    return this.lookup(this.accessTokens, accessToken);
  }

  private bind(store: Map<string, SessionLinkEntry>, key: string, sessionId: string) {
    this.prune(store);
    store.set(key, { sessionId, updatedAt: Date.now() });
  }

  private lookup(store: Map<string, SessionLinkEntry>, key: string | null | undefined) {
    if (!key) return null;
    this.prune(store);
    const entry = store.get(key);
    if (!entry) return null;
    entry.updatedAt = Date.now();
    return entry.sessionId;
  }

  private prune(store: Map<string, SessionLinkEntry>) {
    const cutoff = Date.now() - this.ttlMs;
    for (const [key, entry] of store.entries()) {
      if (entry.updatedAt < cutoff) {
        store.delete(key);
        if (store === this.tickets) this.ticketMints.delete(key);
      }
    }
  }
}
