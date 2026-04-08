import type { PersonInfo } from "../types";

function firstProseLine(markdown: string | null | undefined): string | null {
  if (!markdown) return null;
  for (const block of markdown.split(/\n\s*\n/g)) {
    const stripped = block
      .split("\n")
      .filter((line) => !/^\s*#{1,6}\s/.test(line))
      .join(" ")
      .replace(/\*\*([^*]+)\*\*/g, "$1")
      .replace(/\*([^*]+)\*/g, "$1")
      .replace(/`([^`]+)`/g, "$1")
      .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
      .replace(/^\s*[-*]\s+/gm, "")
      .replace(/\s+/g, " ")
      .trim();
    if (stripped) return stripped;
  }
  return null;
}

export function PersonCard({
  person,
  selected,
  onSelect,
}: {
  person: PersonInfo;
  selected: boolean;
  onSelect: () => void;
}) {
  const visibleSites = person.sites.slice(0, 2);
  const hiddenSiteCount = Math.max(person.sites.length - visibleSites.length, 0);
  const visibleUseCases = person.useCases.slice(0, 2);
  const hiddenUseCaseCount = Math.max(person.useCases.length - visibleUseCases.length, 0);
  const summaryPreview = firstProseLine(person.summary);

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
        {selected && <span className="patient-card-arrow">Selected</span>}
      </div>
      <p className="patient-card-meta">
        {person.birthDate ?? "unknown DOB"}
        {person.gender && <> · {person.gender}</>}
        {" · "}
        {person.sites.length} site{person.sites.length !== 1 && "s"}
        {" · "}
        {person.sites.reduce((total, site) => total + site.encounters.length, 0)} encounters
      </p>
      {visibleUseCases.length > 0 && (
        <div className="patient-card-use-cases">
          {visibleUseCases.map((useCase) => (
            <span key={useCase.code} className="use-case-tag">{useCase.display}</span>
          ))}
          {hiddenUseCaseCount > 0 && <span className="use-case-tag">… and {hiddenUseCaseCount} more</span>}
        </div>
      )}
      {summaryPreview && <p className="patient-card-summary clamped">{summaryPreview}</p>}
      <div className="patient-card-tags">
        {visibleSites.map((site) => (
          <span key={site.siteSlug} className="patient-card-tag">
            {site.orgName}
            {site.jurisdiction ? ` · ${site.jurisdiction}` : ""}
          </span>
        ))}
        {hiddenSiteCount > 0 && <span className="patient-card-tag">… and {hiddenSiteCount} more</span>}
      </div>
    </article>
  );
}
