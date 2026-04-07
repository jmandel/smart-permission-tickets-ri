import { gunzipSync } from "node:zlib";

import type { PermissionTicket } from "../store/model.ts";

type TicketStatusList = {
  kid?: string;
  bits: string;
};

type CachedTicketStatusList = {
  expiresAtMs: number;
  list: TicketStatusList;
};

export class TicketRevocationRegistry {
  private readonly cache = new Map<string, CachedTicketStatusList>();

  constructor(
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly nowMs: () => number = () => Date.now(),
  ) {}

  async assertActive(ticket: Pick<PermissionTicket, "revocation"> & { jti?: string }) {
    if (!ticket.revocation) return;
    if (typeof ticket.jti !== "string" || !ticket.jti) throw new Error("Revocable ticket missing jti");

    const revocationUrl = normalizeRevocationUrl(ticket.revocation.url);
    const statusList = await this.loadStatusList(revocationUrl);
    if (isRevoked(statusList.bits, ticket.revocation.index)) {
      throw new Error("Permission Ticket has been revoked");
    }
  }

  private async loadStatusList(revocationUrl: string) {
    const now = this.nowMs();
    this.evictExpired(now);

    const cached = this.cache.get(revocationUrl);
    if (cached && cached.expiresAtMs > now) return cached.list;

    try {
      const response = await this.fetchImpl(revocationUrl, { redirect: "follow" });
      if (!response.ok) {
        throw new Error(`Status list retrieval returned ${response.status}`);
      }
      const body = await response.json();
      const list = parseTicketStatusList(body);
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

function parseTicketStatusList(body: unknown): TicketStatusList {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new Error("Invalid status list");
  }
  const list = body as Record<string, unknown>;
  if (typeof list.bits !== "string" || !list.bits) throw new Error("Invalid status list");
  if (list.kid !== undefined && typeof list.kid !== "string") throw new Error("Invalid status list");
  return {
    ...(typeof list.kid === "string" ? { kid: list.kid } : {}),
    bits: list.bits,
  };
}

function isRevoked(encodedBits: string, index: number) {
  const bytes = decodeStatusBits(encodedBits);
  const byteIndex = Math.floor(index / 8);
  if (byteIndex >= bytes.length) return false;
  const bitMask = 1 << (index % 8);
  return (bytes[byteIndex] & bitMask) !== 0;
}

function decodeStatusBits(encodedBits: string) {
  try {
    const compressed = Buffer.from(encodedBits, "base64url");
    return new Uint8Array(gunzipSync(compressed));
  } catch {
    throw new Error("Invalid status list");
  }
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
