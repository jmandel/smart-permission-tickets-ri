import { useStore } from "../store";

export function Hero({ onToggleAbout, aboutOpen }: { onToggleAbout: () => void; aboutOpen: boolean }) {
  const { persons } = useStore();
  const totalSites = new Set(persons.flatMap((p) => p.sites.map((s) => s.orgName))).size;
  const totalEncounters = persons.reduce((n, p) => n + p.sites.reduce((m, s) => m + s.encounters.length, 0), 0);

  return (
    <section className="hero">
      <div className="hero-header">
        <p className="eyebrow">Reference FHIR Server</p>
        <nav className="app-menu" aria-label="Application menu">
          <a
            className="menu-link"
            href="https://build.fhir.org/ig/jmandel/smart-permission-tickets-wip/"
          >
            IG
          </a>
          <button type="button" className={`menu-link${aboutOpen ? " active" : ""}`} onClick={onToggleAbout}>
            About
          </button>
        </nav>
      </div>
      <h1>SMART Permission Tickets</h1>
      <p className="lede">
        Reference FHIR server for the{" "}
        <a href="https://build.fhir.org/ig/jmandel/smart-permission-tickets-wip/">
          SMART Permission Tickets IG
        </a>
        . Synthetic patients across multiple sites, with ticket-based access constraints:
        scope filtering, date-range windowing, site partitioning, jurisdiction filtering,
        and sensitive-data exclusion.
      </p>
      <div className="pill-row">
        <span className="pill"><strong>Patients</strong> {persons.length}</span>
        <span className="pill"><strong>Sites</strong> {totalSites}</span>
        <span className="pill"><strong>Encounters</strong> {totalEncounters}</span>
      </div>
    </section>
  );
}
