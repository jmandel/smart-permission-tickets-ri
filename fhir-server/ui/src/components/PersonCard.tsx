import { useEffect, useRef, useState } from "react";

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
  const [expanded, setExpanded] = useState(false);
  const [canExpand, setCanExpand] = useState(false);
  const summaryRef = useRef<HTMLParagraphElement | null>(null);
  const SUMMARY_COLLAPSED_MAX_HEIGHT = 11 * 1.55 * 16;

  useEffect(() => {
    setExpanded(false);
  }, [person.personId]);

  useEffect(() => {
    const element = summaryRef.current;
    if (!element || !person.summary) {
      setCanExpand(false);
      return;
    }

    const measure = () => {
      const overflow = element.scrollHeight > SUMMARY_COLLAPSED_MAX_HEIGHT + 1;
      setCanExpand(overflow);
      if (!overflow) setExpanded(false);
    };

    measure();

    const resizeObserver = typeof ResizeObserver !== "undefined" ? new ResizeObserver(measure) : null;
    resizeObserver?.observe(element);
    window.addEventListener("resize", measure);

    return () => {
      resizeObserver?.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, [person.summary, person.personId]);

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
      {person.summary && (
        <>
          <p ref={summaryRef} className={`patient-card-summary${!expanded ? " clamped" : ""}`}>
            {person.summary}
          </p>
          {canExpand && (
            <button
              type="button"
              className="patient-card-toggle"
              onClick={(event) => {
                event.stopPropagation();
                setExpanded((current) => !current);
              }}
            >
              {expanded ? "Show less" : "Show more"}
            </button>
          )}
        </>
      )}
      <div className="patient-card-tags">
        {person.sites.map((site) => (
          <span key={site.siteSlug} className="patient-card-tag">
            {site.orgName}
            {site.jurisdiction ? ` · ${site.jurisdiction}` : ""}
          </span>
        ))}
      </div>
    </article>
  );
}
