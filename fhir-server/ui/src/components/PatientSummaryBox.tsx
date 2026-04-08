import { useMemo, useState } from "react";
import ReactMarkdown from "react-markdown";

export function PatientSummaryBox({ summary }: { summary: string | null | undefined }) {
  const [expanded, setExpanded] = useState(false);

  const trimmed = useMemo(() => (summary ?? "").trim(), [summary]);
  const isLong = useMemo(() => {
    if (!trimmed) return false;
    const paragraphs = trimmed.split(/\n\s*\n/g).filter(Boolean);
    // "Long enough to collapse" = more than a single short paragraph.
    return paragraphs.length > 1 || trimmed.length > 280;
  }, [trimmed]);

  if (!trimmed) return null;

  return (
    <aside
      className={`patient-summary-box${expanded ? " expanded" : " collapsed"}${isLong ? " collapsible" : ""}`}
      aria-label="Patient summary"
    >
      <header className="patient-summary-box-header">
        <span className="patient-summary-box-label">Patient summary</span>
      </header>
      <div className="patient-summary-box-body">
        <ReactMarkdown>{trimmed}</ReactMarkdown>
      </div>
      {isLong && (
        <button
          type="button"
          className="patient-summary-box-toggle"
          onClick={() => setExpanded((prev) => !prev)}
          aria-expanded={expanded}
        >
          {expanded ? "Show less" : "… Show more"}
        </button>
      )}
    </aside>
  );
}
