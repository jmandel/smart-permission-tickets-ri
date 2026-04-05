import { describe, expect, test } from "bun:test";

import { TicketRevocationRegistry } from "./ticket-revocation.ts";

describe("Permission Ticket revocation", () => {
  test("rejects an exact revoked rid", async () => {
    const revocations = new TicketRevocationRegistry(
      (async () => new Response(JSON.stringify({
        kid: "issuer-key-1",
        method: "rid",
        ctr: 1,
        rids: ["rid-revoked"],
      }), {
        headers: {
          "content-type": "application/json",
          "cache-control": "max-age=60",
        },
      })) as unknown as typeof fetch,
    );

    await expect(revocations.assertActive({
      jti: "ticket-1",
      iat: 1_700_000_000,
      revocation: {
        url: "https://issuer.example.org/crl.json",
        rid: "rid-revoked",
      },
    })).rejects.toThrow("Permission Ticket has been revoked");
  });

  test("applies timestamp-suffixed revocation entries using ticket iat", async () => {
    const revocations = new TicketRevocationRegistry(
      (async () => new Response(JSON.stringify({
        kid: "issuer-key-1",
        method: "rid",
        ctr: 1,
        rids: ["rid-123.1700000000"],
      }))) as unknown as typeof fetch,
    );

    await expect(revocations.assertActive({
      jti: "ticket-old",
      iat: 1_699_999_999,
      revocation: {
        url: "https://issuer.example.org/crl.json",
        rid: "rid-123",
      },
    })).rejects.toThrow("Permission Ticket has been revoked");

    await expect(revocations.assertActive({
      jti: "ticket-new",
      iat: 1_700_000_001,
      revocation: {
        url: "https://issuer.example.org/crl.json",
        rid: "rid-123",
      },
    })).resolves.toBeUndefined();
  });

  test("reuses cached revocation responses while cache is fresh", async () => {
    let shouldFail = false;
    let fetchCount = 0;
    let nowMs = 1_000;
    const revocations = new TicketRevocationRegistry(
      (async () => {
        fetchCount += 1;
        if (shouldFail) throw new Error("network down");
        return new Response(JSON.stringify({
          kid: "issuer-key-1",
          method: "rid",
          ctr: 1,
          rids: [],
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
        url: "https://issuer.example.org/crl.json",
        rid: "rid-ok",
      },
    })).resolves.toBeUndefined();
    expect(fetchCount).toBe(1);

    shouldFail = true;
    nowMs = 5_000;
    await expect(revocations.assertActive({
      jti: "ticket-2",
      revocation: {
        url: "https://issuer.example.org/crl.json",
        rid: "rid-ok",
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
        url: "https://issuer.example.org/crl.json",
        rid: "rid-unknown",
      },
    })).rejects.toThrow("Permission Ticket revocation status could not be determined");
  });

  test("requires jti for revocable tickets", async () => {
    const revocations = new TicketRevocationRegistry();

    await expect(revocations.assertActive({
      revocation: {
        url: "https://issuer.example.org/crl.json",
        rid: "rid-unknown",
      },
    })).rejects.toThrow("Revocable ticket missing jti");
  });
});
