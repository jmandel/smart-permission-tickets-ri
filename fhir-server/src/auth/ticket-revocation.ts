import type { PermissionTicket } from "../store/model.ts";

type TicketRevocationList = {
  kid?: string;
  method: "rid";
  ctr: number;
  rids: string[];
};

type CachedTicketRevocationList = {
  expiresAtMs: number;
  list: TicketRevocationList;
};

export class TicketRevocationRegistry {
  private readonly cache = new Map<string, CachedTicketRevocationList>();

  constructor(
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly nowMs: () => number = () => Date.now(),
  ) {}

  async assertActive(ticket: Pick<PermissionTicket, "iat" | "revocation"> & { jti?: string }) {
    if (!ticket.revocation) return;
    if (typeof ticket.jti !== "string" || !ticket.jti) throw new Error("Revocable ticket missing jti");
    if (typeof ticket.revocation.rid !== "string" || !ticket.revocation.rid) throw new Error("Permission Ticket revocation rid missing");

    const revocationUrl = normalizeRevocationUrl(ticket.revocation.url);
    const revocationList = await this.loadRevocationList(revocationUrl);
    const status = evaluateRevocationStatus(revocationList.rids, ticket.revocation.rid, ticket.iat);
    if (status === "revoked") throw new Error("Permission Ticket has been revoked");
    if (status === "indeterminate") throw new Error("Permission Ticket revocation status could not be determined");
  }

  private async loadRevocationList(revocationUrl: string) {
    const now = this.nowMs();
    this.evictExpired(now);

    const cached = this.cache.get(revocationUrl);
    if (cached && cached.expiresAtMs > now) return cached.list;

    try {
      const response = await this.fetchImpl(revocationUrl, { redirect: "follow" });
      if (!response.ok) {
        throw new Error(`CRL retrieval returned ${response.status}`);
      }
      const body = await response.json();
      const list = parseTicketRevocationList(body);
      const ttlMs = cacheTtlMs(response.headers);
      if (ttlMs > 0) {
        this.cache.set(revocationUrl, { list, expiresAtMs: now + ttlMs });
      } else {
        this.cache.delete(revocationUrl);
      }
      return list;
    } catch {
      throw new Error("Permission Ticket revocation status could not be determined");
    }
  }

  private evictExpired(nowMs: number) {
    for (const [url, cached] of this.cache.entries()) {
      if (cached.expiresAtMs <= nowMs) this.cache.delete(url);
    }
  }
}

function parseTicketRevocationList(body: unknown): TicketRevocationList {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new Error("Invalid revocation list");
  }
  const list = body as Record<string, unknown>;
  if (list.method !== "rid") throw new Error("Invalid revocation list");
  if (typeof list.ctr !== "number" || !Number.isFinite(list.ctr)) throw new Error("Invalid revocation list");
  if (!Array.isArray(list.rids) || !list.rids.every((value) => typeof value === "string")) throw new Error("Invalid revocation list");
  if (list.kid !== undefined && typeof list.kid !== "string") throw new Error("Invalid revocation list");
  return {
    ...(typeof list.kid === "string" ? { kid: list.kid } : {}),
    method: "rid",
    ctr: list.ctr,
    rids: list.rids,
  };
}

function evaluateRevocationStatus(rids: string[], targetRid: string, issuedAt: number | undefined) {
  let indeterminate = false;
  for (const entry of rids) {
    if (entry === targetRid) return "revoked";
    if (!entry.startsWith(`${targetRid}.`)) continue;
    const cutoffRaw = entry.slice(targetRid.length + 1);
    if (!/^\d+$/.test(cutoffRaw)) {
      indeterminate = true;
      continue;
    }
    const cutoff = Number(cutoffRaw);
    if (!Number.isFinite(cutoff)) {
      indeterminate = true;
      continue;
    }
    if (typeof issuedAt !== "number") {
      indeterminate = true;
      continue;
    }
    if (issuedAt < cutoff) return "revoked";
  }
  return indeterminate ? "indeterminate" : "active";
}

function cacheTtlMs(headers: Headers) {
  const cacheControl = headers.get("cache-control") ?? "";
  const match = cacheControl.match(/max-age=(\d+)/i);
  if (!match) return 0;
  const seconds = Number(match[1]);
  if (!Number.isFinite(seconds) || seconds < 0) return 0;
  return seconds * 1000;
}

function normalizeRevocationUrl(raw: unknown) {
  if (typeof raw !== "string" || !raw) throw new Error("Permission Ticket revocation url must be an absolute URL");
  const parsed = new URL(raw);
  if (parsed.protocol !== "https:" && !isSecureLocalOrigin(parsed)) {
    throw new Error("Permission Ticket revocation url must use HTTPS or a secure local origin");
  }
  parsed.hash = "";
  return parsed.toString();
}

function isSecureLocalOrigin(url: URL) {
  return url.protocol === "http:" && (url.hostname === "localhost" || url.hostname === "127.0.0.1");
}
