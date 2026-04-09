import { useEffect, useState } from "react";
import { useStore } from "./store";
import { Hero } from "./components/Hero";
import { PersonCard } from "./components/PersonCard";
import { DataContract } from "./components/DataContract";
import { ProtocolTrace } from "./components/ProtocolTrace";
import { PermissionWorkbench } from "./components/PermissionWorkbench";
import { Viewer } from "./components/Viewer";
import { PatientSummaryBox } from "./components/PatientSummaryBox";
import { nextSelectedUseCaseKey } from "./use-case-filter";
import type { PersonInfo } from "./types";
import type { DemoTicketScenario } from "../../../shared/demo-ticket-scenarios.ts";

function cardScenarioPreview(person: PersonInfo): DemoTicketScenario | null {
  return person.ticketScenarios[0] ?? null;
}

function cardScenarioDescriptor(person: PersonInfo) {
  const scenario = cardScenarioPreview(person);
  return scenario ? { label: scenario.label, summary: scenario.summary } : null;
}

export function App() {
  if (window.location.pathname === "/viewer") {
    return <Viewer />;
  }
  if (window.location.pathname === "/trace") {
    return <ProtocolTrace />;
  }

  const { loading, error, init, persons, demoClientOptions, selectedPersonId, selectPerson, selectedMode, defaultTicketIssuer, defaultNetwork } = useStore();
  const [showAbout, setShowAbout] = useState(false);
  const [showPatientPicker, setShowPatientPicker] = useState(true);
  const [selectedUseCaseKey, setSelectedUseCaseKey] = useState<string | null>(null);

  useEffect(() => { init(); }, []);
  useEffect(() => {
    if (selectedPersonId) setShowPatientPicker(false);
    else setShowPatientPicker(true);
  }, [selectedPersonId]);

  if (loading) return <main className="shell"><p>Loading...</p></main>;
  if (error) return <main className="shell"><p style={{ color: "var(--warn)" }}>Error: {error}</p></main>;

  const selectedPerson = persons.find((person) => person.personId === selectedPersonId) ?? null;
  const useCaseOptions = Array.from(
    persons
      .flatMap((person) => person.useCases.map((useCase) => ({ ...useCase, key: `${useCase.system}|${useCase.code}` })))
      .reduce((map, useCase) => {
        const existing = map.get(useCase.key);
        map.set(useCase.key, {
          ...useCase,
          count: existing ? existing.count + 1 : 1,
        });
        return map;
      }, new Map<string, { system: string; code: string; display: string; key: string; count: number }>())
      .values(),
  ).sort((a, b) => a.display.localeCompare(b.display));
  const visiblePersons = selectedUseCaseKey
    ? persons.filter((person) => person.useCases.some((useCase) => `${useCase.system}|${useCase.code}` === selectedUseCaseKey))
    : persons;

  const handleSelectPerson = (personId: string) => {
    if (personId === selectedPersonId) {
      setShowPatientPicker(false);
      return;
    }
    selectPerson(personId);
    setShowPatientPicker(false);
  };

  return (
    <main className="shell">
      <Hero aboutOpen={showAbout} onToggleAbout={() => setShowAbout((current) => !current)} />
      {showAbout && <DataContract onClose={() => setShowAbout(false)} />}
      <section className="panel section">
        <div className="section-header">
          <div>
            <p className="eyebrow">Step 1 · Choose Patient</p>
            <h2>{selectedPerson ? "Patient selected" : "Choose a use case, then a patient"}</h2>
          </div>
          <span className="subtle">{persons.length} loaded</span>
        </div>
        {(!selectedPerson || showPatientPicker) && useCaseOptions.length > 0 && (
          <section className="scenario-picker">
            <div className="scenario-picker-header">
              <div>
                <h3>Use cases</h3>
                <p className="subtle">Start with the scenario you want to demonstrate, then choose a patient from the filtered list.</p>
              </div>
            </div>
            <div className="scenario-picker-grid">
              {useCaseOptions.map((useCase) => (
                <button
                  key={useCase.key}
                  type="button"
                  className={`scenario-card${selectedUseCaseKey === useCase.key ? " active" : ""}`}
                  onClick={() => setSelectedUseCaseKey((current) => nextSelectedUseCaseKey(current, useCase.key))}
                >
                  <span className="scenario-card-label">{useCase.display}</span>
                  <strong>{useCase.count} patient{useCase.count !== 1 && "s"}</strong>
                </button>
              ))}
            </div>
          </section>
        )}
        {selectedPerson && !showPatientPicker && (
          <section className="selected-person-banner">
            <div className="selected-person-header">
              <div>
                <div className="selected-person-title">
                  <h3>{selectedPerson.displayName}</h3>
                  {selectedPerson.useCases.length > 0 && (
                    <div className="patient-card-use-cases selected-person-use-cases">
                      {selectedPerson.useCases.slice(0, 3).map((useCase) => (
                        <span key={useCase.code} className="use-case-tag">{useCase.display}</span>
                      ))}
                      {selectedPerson.useCases.length > 3 && (
                        <span className="use-case-tag">… and {selectedPerson.useCases.length - 3} more</span>
                      )}
                    </div>
                  )}
                </div>
                <p className="subtle selected-person-meta">
                  {selectedPerson.birthDate ?? "unknown DOB"}
                  {selectedPerson.gender && <> · {selectedPerson.gender}</>}
                  {" · "}
                  {selectedPerson.sites.length} site{selectedPerson.sites.length !== 1 && "s"}
                  {" · "}
                  {selectedPerson.sites.reduce((sum, site) => sum + site.encounters.length, 0)} encounters
                </p>
              </div>
              {!showPatientPicker && (
                <button type="button" className="button selected-person-cta" onClick={() => setShowPatientPicker(true)}>
                  Choose different patient
                </button>
              )}
            </div>
            <PatientSummaryBox summary={selectedPerson.summary} />

            <div className="patient-card-tags selected-person-tags">
              {selectedPerson.sites.slice(0, 4).map((site) => (
                <span key={site.siteSlug} className="patient-card-tag">
                  {site.orgName}
                  {site.jurisdiction ? ` · ${site.jurisdiction}` : ""}
                </span>
              ))}
              {selectedPerson.sites.length > 4 && <span className="patient-card-tag">… and {selectedPerson.sites.length - 4} more</span>}
            </div>
          </section>
        )}
        {(!selectedPerson || showPatientPicker) && (
          <div className="patient-picker-grid">
            {visiblePersons.map((person) => (
              <PersonCard
                key={person.personId}
                person={person}
                selected={person.personId === selectedPersonId}
                onSelect={() => handleSelectPerson(person.personId)}
                scenarioPreview={cardScenarioDescriptor(person)}
              />
            ))}
          </div>
        )}
      </section>
      <PermissionWorkbench
        person={selectedPerson}
        mode={selectedMode}
        defaultTicketIssuer={defaultTicketIssuer}
        defaultNetwork={defaultNetwork}
        demoClientOptions={demoClientOptions}
      />
    </main>
  );
}
