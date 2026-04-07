import { gzipSync } from "node:zlib";

import { describe, expect, test } from "bun:test";

import { TicketRevocationRegistry } from "./ticket-revocation.ts";

function encodeStatusBits(revokedIndexes: number[]) {
  const maxIndex = revokedIndexes.length ? Math.max(...revokedIndexes) : -1;
  const bytes = new Uint8Array(Math.max(1, Math.floor(maxIndex / 8) + 1));
  for (const index of revokedIndexes) {
    bytes[Math.floor(index / 8)] |= 1 << (index % 8);
  }
  return Buffer.from(gzipSync(bytes)).toString("base64url");
}

describe("Permission Ticket revocation", () => {
  test("rejects a ticket whose status-list bit is set", async () => {
    const revocations = new TicketRevocationRegistry(
      (async () => new Response(JSON.stringify({
        kid: "issuer-key-1",
        bits: encodeStatusBits([7]),
      }), {
        headers: {
          "content-type": "application/json",
          "cache-control": "max-age=60",
        },
      })) as unknown as typeof fetch,
    );

    await expect(revocations.assertActive({
      jti: "ticket-1",
      revocation: {
        url: "https://issuer.example.org/status.json",
        index: 7,
      },
    })).rejects.toThrow("Permission Ticket has been revoked");
  });

  test("accepts a ticket when its status-list bit is clear", async () => {
    const revocations = new TicketRevocationRegistry(
      (async () => new Response(JSON.stringify({
        kid: "issuer-key-1",
        bits: encodeStatusBits([2, 9]),
      }))) as unknown as typeof fetch,
    );

    await expect(revocations.assertActive({
      jti: "ticket-ok",
      revocation: {
        url: "https://issuer.example.org/status.json",
        index: 3,
      },
    })).resolves.toBeUndefined();
  });

  test("reuses cached status-list responses while cache is fresh", async () => {
    let shouldFail = false;
    let fetchCount = 0;
    let nowMs = 1_000;
    const revocations = new TicketRevocationRegistry(
      (async () => {
        fetchCount += 1;
        if (shouldFail) throw new Error("network down");
        return new Response(JSON.stringify({
          kid: "issuer-key-1",
          bits: encodeStatusBits([]),
        }), {
          headers: {
            "cache-control": "max-age=60",
          },
        });
      }) as unknown as typeof fetch,
      () => nowMs,
    );

    await expect(revocations.assertActive({
      jti: "ticket-1",
      revocation: {
        url: "https://issuer.example.org/status.json",
        index: 1,
      },
    })).resolves.toBeUndefined();
    expect(fetchCount).toBe(1);

    shouldFail = true;
    nowMs = 5_000;
    await expect(revocations.assertActive({
      jti: "ticket-2",
      revocation: {
        url: "https://issuer.example.org/status.json",
        index: 1,
      },
    })).resolves.toBeUndefined();
    expect(fetchCount).toBe(1);
  });

  test("fails closed when revocation status cannot be determined", async () => {
    const revocations = new TicketRevocationRegistry(
      (async () => new Response("nope", { status: 503 })) as unknown as typeof fetch,
    );

    await expect(revocations.assertActive({
      jti: "ticket-1",
      revocation: {
        url: "https://issuer.example.org/status.json",
        index: 9,
      },
    })).rejects.toThrow("Permission Ticket revocation status could not be determined");
  });

  test("requires jti for revocable tickets", async () => {
    const revocations = new TicketRevocationRegistry();

    await expect(revocations.assertActive({
      revocation: {
        url: "https://issuer.example.org/status.json",
        index: 9,
      },
    })).rejects.toThrow("Revocable ticket missing jti");
  });
});
