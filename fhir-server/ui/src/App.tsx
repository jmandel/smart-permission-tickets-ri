import { useEffect, useState } from "react";
import { useStore } from "./store";
import { Hero } from "./components/Hero";
import { PersonCard } from "./components/PersonCard";
import { DataContract } from "./components/DataContract";
import { PermissionWorkbench } from "./components/PermissionWorkbench";
import { Viewer } from "./components/Viewer";

export function App() {
  if (window.location.pathname === "/viewer") {
    return <Viewer />;
  }

  const { loading, error, init, persons, selectedPersonId, selectPerson, selectedMode, defaultTicketIssuer, defaultNetwork } = useStore();
  const [showAbout, setShowAbout] = useState(false);

  useEffect(() => { init(); }, []);

  if (loading) return <main className="shell"><p>Loading...</p></main>;
  if (error) return <main className="shell"><p style={{ color: "var(--warn)" }}>Error: {error}</p></main>;

  const selectedPerson = persons.find((person) => person.personId === selectedPersonId) ?? null;

  return (
    <main className="shell">
      <Hero aboutOpen={showAbout} onToggleAbout={() => setShowAbout((current) => !current)} />
      {showAbout && <DataContract onClose={() => setShowAbout(false)} />}
      <section className="panel section">
        <div className="section-header">
          <div>
            <p className="eyebrow">Step 1 · Pick Patient</p>
            <h2>Loaded synthetic people</h2>
          </div>
          <span className="subtle">{persons.length} loaded</span>
        </div>
        <div className="patient-picker-grid">
          {persons.map((person) => (
            <PersonCard
              key={person.personId}
              person={person}
              selected={person.personId === selectedPersonId}
              onSelect={() => selectPerson(person.personId)}
            />
          ))}
        </div>
      </section>
      <PermissionWorkbench person={selectedPerson} mode={selectedMode} defaultTicketIssuer={defaultTicketIssuer} defaultNetwork={defaultNetwork} />
    </main>
  );
}
