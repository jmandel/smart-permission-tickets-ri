import type { TicketIssuerInfo } from "../types";

export async function signPermissionTicket(
  origin: string,
  issuer: TicketIssuerInfo,
  ticketPayload: Record<string, any>,
  sessionId?: string | null,
) {
  const response = await fetch(`${origin}${issuer.signTicketPath}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(sessionId ? { "x-demo-session": sessionId } : {}),
    },
    body: JSON.stringify(ticketPayload),
  });
  const payload = await response.json();
  if (!response.ok) {
    throw new Error(extractErrorMessage(payload, "Failed to sign Permission Ticket"));
  }
  return {
    signedTicket: String(payload.signed_ticket),
    issuer: String(payload.issuer),
    jwksUri: String(payload.jwks_uri),
    kid: payload.kid ? String(payload.kid) : null,
  };
}

function extractErrorMessage(data: unknown, fallback: string) {
  if (!data) return fallback;
  if (typeof data === "string") return data;
  const diagnostics = (data as any)?.issue?.[0]?.diagnostics;
  return typeof diagnostics === "string" ? diagnostics : fallback;
}
