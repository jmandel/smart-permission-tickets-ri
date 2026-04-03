import type { PersonInfo } from "../types";

export function PersonCard({
  person,
  selected,
  onSelect,
}: {
  person: PersonInfo;
  selected: boolean;
  onSelect: () => void;
}) {
  const visibleSites = person.sites.slice(0, 3);
  const hiddenSiteCount = Math.max(person.sites.length - visibleSites.length, 0);

  return (
    <article
      className={`patient-card${selected ? " selected" : ""}`}
      onClick={onSelect}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          onSelect();
        }
      }}
      aria-pressed={selected}
      role="button"
      tabIndex={0}
    >
      <div className="patient-card-header">
        <h3>{person.displayName}</h3>
        <span className="patient-card-arrow">{selected ? "Selected" : "Choose"}</span>
      </div>
      <p className="patient-card-meta">
        {person.birthDate ?? "unknown DOB"}
        {person.gender && <> · {person.gender}</>}
        {" · "}
        {person.sites.length} site{person.sites.length !== 1 && "s"}
        {" · "}
        {person.sites.reduce((total, site) => total + site.encounters.length, 0)} encounters
      </p>
      {person.useCases?.length > 0 && (
        <div className="patient-card-use-cases">
          {person.useCases.map((uc) => (
            <span key={uc.code} className="use-case-tag">{uc.display}</span>
          ))}
        </div>
      )}
      {person.summary && <p className="patient-card-summary clamped">{person.summary}</p>}
      <div className="patient-card-tags">
        {visibleSites.map((site) => (
          <span key={site.siteSlug} className="patient-card-tag">
            {site.orgName}
            {site.jurisdiction ? ` · ${site.jurisdiction}` : ""}
          </span>
        ))}
        {hiddenSiteCount > 0 && <span className="patient-card-tag">+{hiddenSiteCount} more</span>}
      </div>
    </article>
  );
}
