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
  const [showPatientPicker, setShowPatientPicker] = useState(true);

  useEffect(() => { init(); }, []);
  useEffect(() => {
    if (selectedPersonId) setShowPatientPicker(false);
    else setShowPatientPicker(true);
  }, [selectedPersonId]);

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
            <h2>{selectedPerson ? "Selected synthetic patient" : "Choose a synthetic patient"}</h2>
          </div>
          <div className="button-row">
            {selectedPerson && (
              <button type="button" className="button" onClick={() => setShowPatientPicker((current) => !current)}>
                {showPatientPicker ? "Hide patient list" : "Change patient"}
              </button>
            )}
            <span className="subtle">{persons.length} loaded</span>
          </div>
        </div>
        {selectedPerson && (
          <section className="selected-person-banner">
            <div className="selected-person-header">
              <div>
                <h3>{selectedPerson.displayName}</h3>
                <p className="subtle selected-person-meta">
                  {selectedPerson.birthDate ?? "unknown DOB"}
                  {selectedPerson.gender && <> · {selectedPerson.gender}</>}
                  {" · "}
                  {selectedPerson.sites.length} site{selectedPerson.sites.length !== 1 && "s"}
                  {" · "}
                  {selectedPerson.sites.reduce((sum, site) => sum + site.encounters.length, 0)} encounters
                </p>
              </div>
            </div>
            {selectedPerson.summary && <div className="viewer-copy-block selected-person-summary">{selectedPerson.summary.split(/\n\s*\n/g).map((paragraph, index) => <p key={`${index}:${paragraph.slice(0, 24)}`}>{paragraph.trim()}</p>)}</div>}
            <div className="patient-card-tags selected-person-tags">
              {selectedPerson.sites.map((site) => (
                <span key={site.siteSlug} className="patient-card-tag">
                  {site.orgName}
                  {site.jurisdiction ? ` · ${site.jurisdiction}` : ""}
                </span>
              ))}
            </div>
          </section>
        )}
        {(!selectedPerson || showPatientPicker) && (
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
        )}
      </section>
      <PermissionWorkbench person={selectedPerson} mode={selectedMode} defaultTicketIssuer={defaultTicketIssuer} defaultNetwork={defaultNetwork} />
    </main>
  );
}
