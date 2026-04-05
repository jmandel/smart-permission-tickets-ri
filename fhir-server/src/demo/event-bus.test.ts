import { describe, expect, test } from "bun:test";

import { DemoEventBus } from "./event-bus.ts";

describe("DemoEventBus", () => {
  test("emits sequenced events and replays them after a given seq", () => {
    const bus = new DemoEventBus();

    const first = bus.emit("session-a", {
      source: "viewer",
      phase: "ticket",
      type: "ticket-created",
      label: "Ticket created",
      detail: {
        patientName: "Elena Reyes",
        patientDob: "1989-09-14",
        scopes: ["patient/*.rs"],
        dateSummary: "All dates",
        sensitiveSummary: "Sensitive excluded",
        expirySummary: "1 hour",
        bindingSummary: "Proof key",
      },
    });
    const second = bus.emit("session-a", {
      source: "server",
      phase: "complete",
      type: "session-complete",
      label: "Complete",
      detail: {
        totalSites: 2,
        totalResources: 7,
        queryCount: 3,
      },
    });

    expect(first.seq).toBe(1);
    expect(second.seq).toBe(2);
    expect(bus.getEvents("session-a", 1).map((event) => event.seq)).toEqual([2]);
  });

  test("keeps sessions isolated", () => {
    const bus = new DemoEventBus();
    bus.emit("session-a", {
      source: "viewer",
      phase: "ticket",
      type: "ticket-created",
      label: "A",
      detail: {
        patientName: "A",
        scopes: ["patient/*.rs"],
        dateSummary: "All dates",
        sensitiveSummary: "Sensitive excluded",
        expirySummary: "1 hour",
        bindingSummary: "Proof key",
      },
    });
    bus.emit("session-b", {
      source: "viewer",
      phase: "ticket",
      type: "ticket-created",
      label: "B",
      detail: {
        patientName: "B",
        scopes: ["patient/*.rs"],
        dateSummary: "All dates",
        sensitiveSummary: "Sensitive excluded",
        expirySummary: "1 hour",
        bindingSummary: "Proof key",
      },
    });

    expect(bus.getEvents("session-a").map((event) => event.label)).toEqual(["A"]);
    expect(bus.getEvents("session-b").map((event) => event.label)).toEqual(["B"]);
  });

  test("replay plus live subscription has no gaps or duplicates", () => {
    const bus = new DemoEventBus();
    bus.emit("session-a", {
      source: "viewer",
      phase: "ticket",
      type: "ticket-created",
      label: "A1",
      detail: {
        patientName: "A",
        scopes: ["patient/*.rs"],
        dateSummary: "All dates",
        sensitiveSummary: "Sensitive excluded",
        expirySummary: "1 hour",
        bindingSummary: "Proof key",
      },
    });
    bus.emit("session-a", {
      source: "viewer",
      phase: "registration",
      type: "udap-discovery",
      label: "A2",
      detail: { endpoint: "http://example.test/.well-known/udap" },
    });

    const delivered: number[] = [];
    const unsubscribe = bus.subscribe("session-a", (event) => {
      delivered.push(event.seq);
    }, 1);

    bus.emit("session-a", {
      source: "server",
      phase: "complete",
      type: "session-complete",
      label: "A3",
      detail: {
        totalSites: 1,
        totalResources: 3,
        queryCount: 1,
      },
    });
    bus.emit("session-b", {
      source: "viewer",
      phase: "complete",
      type: "session-complete",
      label: "B1",
      detail: {
        totalSites: 9,
        totalResources: 9,
        queryCount: 9,
      },
    });
    unsubscribe();

    expect(delivered).toEqual([2, 3]);
  });

  test("cleans up inactive sessions", async () => {
    const bus = new DemoEventBus(25);
    bus.emit("session-a", {
      source: "viewer",
      phase: "ticket",
      type: "ticket-created",
      label: "A",
      detail: {
        patientName: "A",
        scopes: ["patient/*.rs"],
        dateSummary: "All dates",
        sensitiveSummary: "Sensitive excluded",
        expirySummary: "1 hour",
        bindingSummary: "Proof key",
      },
    });

    expect(bus.hasSession("session-a")).toBe(true);
    await Bun.sleep(70);
    expect(bus.hasSession("session-a")).toBe(false);
  });

  test("lists session metadata sorted by most recent activity and captures patient name", async () => {
    const bus = new DemoEventBus();
    const first = bus.emit("session-a", {
      source: "viewer",
      phase: "ticket",
      type: "ticket-created",
      label: "A",
      detail: {
        patientName: "Elena Reyes",
        scopes: ["patient/*.rs"],
        dateSummary: "All dates",
        sensitiveSummary: "Sensitive excluded",
        expirySummary: "1 hour",
        bindingSummary: "Proof key",
      },
    });
    await Bun.sleep(2);
    const second = bus.emit("session-b", {
      source: "viewer",
      phase: "ticket",
      type: "ticket-created",
      label: "B",
      detail: {
        patientName: "Milo Brooks",
        scopes: ["patient/*.rs"],
        dateSummary: "All dates",
        sensitiveSummary: "Sensitive excluded",
        expirySummary: "1 hour",
        bindingSummary: "Proof key",
      },
    });

    const sessions = bus.listSessions();
    expect(sessions.map((session) => session.sessionId)).toEqual(["session-b", "session-a"]);
    expect(sessions[0]?.patientName).toBe("Milo Brooks");
    expect(sessions[1]?.patientName).toBe("Elena Reyes");
    expect(sessions[0]?.eventCount).toBe(1);
    expect(sessions[0]?.createdAt).toBeLessThanOrEqual(second.timestamp);
    expect(sessions[1]?.lastEventAt).toBe(first.timestamp);
  });
});
