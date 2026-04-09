import type { PersonInfo } from "../types";

function cleanMarkdownBlock(block: string): string {
  return block
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
}

// Preferred section headings for the one-line card preview, in priority order.
// We want clinical content (the diagnosis / scenario), not biographical demographics.
const PREFERRED_SECTION_PATTERNS: RegExp[] = [
  /clinical\s+scenario/i,
  /clinical\s+arc/i,
  /clinical\s+picture/i,
  /clinical\s+story/i,
  /scenario/i,
];

function extractSection(markdown: string, pattern: RegExp): string | null {
  const headingRegex = new RegExp(`^#{1,6}\\s+(${pattern.source})[^\\n]*\\n([\\s\\S]*?)(?=\\n#{1,6}\\s|$)`, "im");
  const match = markdown.match(headingRegex);
  return match ? match[2] : null;
}

function firstProseLine(markdown: string | null | undefined): string | null {
  if (!markdown) return null;

  // Prefer a clinical section if one is present — that's where the diagnosis lives.
  for (const pattern of PREFERRED_SECTION_PATTERNS) {
    const section = extractSection(markdown, pattern);
    if (!section) continue;
    for (const block of section.split(/\n\s*\n/g)) {
      const stripped = cleanMarkdownBlock(block);
      if (stripped) return stripped;
    }
  }

  // Fallback: first prose paragraph in the document.
  for (const block of markdown.split(/\n\s*\n/g)) {
    const stripped = cleanMarkdownBlock(block);
    if (stripped) return stripped;
  }
  return null;
}

export function PersonCard({
  person,
  selected,
  onSelect,
  scenarioPreview,
}: {
  person: PersonInfo;
  selected: boolean;
  onSelect: () => void;
  scenarioPreview?: {
    label: string;
    summary: string | null;
  } | null;
}) {
  const visibleSites = person.sites.slice(0, 2);
  const hiddenSiteCount = Math.max(person.sites.length - visibleSites.length, 0);
  const visibleUseCases = person.useCases.slice(0, 2);
  const hiddenUseCaseCount = Math.max(person.useCases.length - visibleUseCases.length, 0);
  const summaryPreview = scenarioPreview?.summary ?? firstProseLine(person.summary);

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
      {scenarioPreview?.label && <p className="patient-card-scenario-title">{scenarioPreview.label}</p>}
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
