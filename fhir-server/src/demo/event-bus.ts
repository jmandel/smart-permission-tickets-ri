import { deriveDemoEventPhase, type DemoEvent, type DemoEventDraft, type DemoObserver, type DemoSessionSummary } from "../../shared/demo-events.ts";

type DemoEventListener = (event: DemoEvent) => void;

type DemoSessionState = {
  events: DemoEvent[];
  listeners: Set<DemoEventListener>;
  cleanupTimer: ReturnType<typeof setTimeout> | null;
  createdAt: number;
  lastActivityAt: number;
  lastEventAt: number | null;
  patientName: string | null;
};

export class DemoEventBus {
  private readonly sessions = new Map<string, DemoSessionState>();

  constructor(private readonly inactivityMs = 24 * 60 * 60 * 1000) {}

  emit(sessionId: string, draft: DemoEventDraft): DemoEvent {
    const session = this.ensureSession(sessionId);
    const timestamp = Date.now();
    const event: DemoEvent = {
      ...draft,
      phase: draft.phase ?? deriveDemoEventPhase(draft),
      seq: session.events.at(-1)?.seq ? session.events.at(-1)!.seq + 1 : 1,
      timestamp,
    } as DemoEvent;
    session.events.push(event);
    session.lastEventAt = timestamp;
    if (!session.patientName && event.type === "ticket-created") {
      session.patientName = event.detail.patientName;
    }
    this.touch(sessionId);
    for (const listener of session.listeners) listener(event);
    return event;
  }

  observer(sessionId: string): DemoObserver {
    return {
      sessionId,
      emit: (event) => this.emit(sessionId, event),
    };
  }

  getEvents(sessionId: string, afterSeq = 0) {
    const session = this.sessions.get(sessionId);
    if (!session) return [];
    this.touch(sessionId);
    return session.events.filter((event) => event.seq > afterSeq);
  }

  subscribe(sessionId: string, listener: DemoEventListener, afterSeq = 0) {
    const session = this.ensureSession(sessionId);
    this.touch(sessionId);
    for (const event of session.events) {
      if (event.seq > afterSeq) listener(event);
    }
    session.listeners.add(listener);
    return () => {
      const current = this.sessions.get(sessionId);
      if (!current) return;
      current.listeners.delete(listener);
      this.touch(sessionId);
    };
  }

  hasSession(sessionId: string) {
    return this.sessions.has(sessionId);
  }

  clearSession(sessionId: string) {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    if (session.cleanupTimer) clearTimeout(session.cleanupTimer);
    this.sessions.delete(sessionId);
  }

  listSessions(maxAgeMs = 24 * 60 * 60 * 1000): DemoSessionSummary[] {
    const cutoff = Date.now() - maxAgeMs;
    return [...this.sessions.entries()]
      .map(([sessionId, session]) => ({
        sessionId,
        createdAt: session.createdAt,
        lastActivityAt: session.lastActivityAt,
        lastEventAt: session.lastEventAt,
        eventCount: session.events.length,
        patientName: session.patientName,
      }))
      .filter((session) => session.lastActivityAt >= cutoff)
      .sort((left, right) => right.lastActivityAt - left.lastActivityAt);
  }

  private ensureSession(sessionId: string) {
    const existing = this.sessions.get(sessionId);
    if (existing) return existing;
    const now = Date.now();
    const session: DemoSessionState = {
      events: [],
      listeners: new Set(),
      cleanupTimer: null,
      createdAt: now,
      lastActivityAt: now,
      lastEventAt: null,
      patientName: null,
    };
    this.sessions.set(sessionId, session);
    this.scheduleCleanup(sessionId, session);
    return session;
  }

  private touch(sessionId: string) {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    session.lastActivityAt = Date.now();
    this.scheduleCleanup(sessionId, session);
  }

  private scheduleCleanup(sessionId: string, session: DemoSessionState) {
    if (session.cleanupTimer) clearTimeout(session.cleanupTimer);
    session.cleanupTimer = setTimeout(() => {
      const current = this.sessions.get(sessionId);
      if (!current) return;
      if (Date.now() - current.lastActivityAt >= this.inactivityMs) {
        this.clearSession(sessionId);
        return;
      }
      this.scheduleCleanup(sessionId, current);
    }, this.inactivityMs);
  }
}
