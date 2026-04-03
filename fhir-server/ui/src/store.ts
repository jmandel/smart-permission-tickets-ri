import { create } from "zustand";
import type { DemoBootstrap, ModeName, NetworkInfo, PersonInfo, TicketIssuerInfo } from "./types";

type AppStore = {
  loading: boolean;
  error: string | null;
  selectedMode: ModeName;
  persons: PersonInfo[];
  searchableResourceTypes: string[];
  defaultTicketIssuer: TicketIssuerInfo | null;
  defaultNetwork: NetworkInfo | null;
  selectedPersonId: string | null;
  init: () => Promise<void>;
  selectPerson: (personId: string | null) => void;
};

function modeFromPath(): ModeName {
  const match = window.location.pathname.match(/^\/modes\/([a-z-]+)/);
  if (!match?.[1]) return "strict";
  return match[1] as ModeName;
}

async function fetchJson<T>(path: string): Promise<T> {
  const res = await window.fetch(path);
  if (!res.ok) throw new Error(`${res.status} ${path}`);
  return res.json() as Promise<T>;
}

function defaultPersonId(persons: PersonInfo[]) {
  return (
    persons.find((person) => person.displayName === "Elena Marisol Reyes")?.personId ??
    persons.find((person) => person.useCases.some((useCase) => /patient access/i.test(useCase.display)))?.personId ??
    persons[0]?.personId ??
    null
  );
}

export const useStore = create<AppStore>((set) => ({
  loading: true,
  error: null,
  selectedMode: modeFromPath(),
  persons: [],
  searchableResourceTypes: [],
  defaultTicketIssuer: null,
  defaultNetwork: null,
  selectedPersonId: null,

  init: async () => {
    set({ loading: true, error: null });
    try {
      const bootstrap = await fetchJson<DemoBootstrap>("/demo/bootstrap");
      const persons = bootstrap.persons.sort((a, b) => a.displayName.localeCompare(b.displayName));
      set({
        persons,
        searchableResourceTypes: bootstrap.searchableResourceTypes,
        defaultTicketIssuer: bootstrap.defaultTicketIssuer,
        defaultNetwork: bootstrap.defaultNetwork,
        selectedMode: modeFromPath(),
        selectedPersonId: defaultPersonId(persons),
        loading: false,
      });
    } catch (e) {
      set({ error: e instanceof Error ? e.message : "Failed to load", loading: false });
    }
  },

  selectPerson: (selectedPersonId) => set({ selectedPersonId }),
}));
