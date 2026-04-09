import { useEffect, useLayoutEffect, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";

export function PatientSummaryBox({ summary }: { summary: string | null | undefined }) {
  const trimmed = (summary ?? "").trim();
  const [expanded, setExpanded] = useState(false);
  const [hasOverflow, setHasOverflow] = useState(false);
  const bodyRef = useRef<HTMLDivElement | null>(null);

  // Measure whether the rendered content exceeds the collapsed max-height.
  // Re-measure on summary change and on window resize.
  useLayoutEffect(() => {
    const node = bodyRef.current;
    if (!node) {
      setHasOverflow(false);
      return;
    }
    const measure = () => {
      // Temporarily force uncapped measurement.
      const previousMaxHeight = node.style.maxHeight;
      node.style.maxHeight = "none";
      const fullHeight = node.scrollHeight;
      node.style.maxHeight = previousMaxHeight;
      // Compare against the collapsed cap declared in CSS (keep in sync with
      // .patient-summary-box.collapsed .patient-summary-box-body max-height).
      const collapsedCapPx = parseFloat(getComputedStyle(node).fontSize) * 12;
      setHasOverflow(fullHeight > collapsedCapPx + 1);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, [trimmed]);

  // Reset expansion when the summary text changes.
  useEffect(() => {
    setExpanded(false);
  }, [trimmed]);

  if (!trimmed) return null;

  const showToggle = hasOverflow;
  const collapsed = showToggle && !expanded;

  return (
    <aside
      className={`patient-summary-box${collapsed ? " collapsed" : ""}`}
      aria-label="Patient summary"
    >
      <div className="patient-summary-box-body" ref={bodyRef}>
        <ReactMarkdown>{trimmed}</ReactMarkdown>
      </div>
      {showToggle && (
        <button
          type="button"
          className="button mini patient-summary-box-toggle"
          onClick={() => setExpanded((prev) => !prev)}
          aria-expanded={expanded}
        >
          {expanded ? "Show less" : "Show more"}
        </button>
      )}
    </aside>
  );
}
