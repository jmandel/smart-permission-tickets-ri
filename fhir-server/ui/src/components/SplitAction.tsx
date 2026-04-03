import { useEffect, useRef, useState } from "react";

export type SplitActionItem = {
  label: string;
  href?: string;
  onSelect?: () => void | Promise<void>;
  disabled?: boolean;
  feedbackLabel?: string;
};

export function SplitAction({
  primary,
  secondary,
}: {
  primary: SplitActionItem;
  secondary: SplitActionItem[];
}) {
  const availableSecondary = secondary.filter((action) => !action.disabled);
  const [open, setOpen] = useState(false);
  const [flashLabel, setFlashLabel] = useState<string | null>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const timeoutRef = useRef<number | null>(null);

  useEffect(() => {
    if (!open) return;
    const handlePointerDown = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) {
        setOpen(false);
      }
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [open]);

  useEffect(() => {
    return () => {
      if (timeoutRef.current) window.clearTimeout(timeoutRef.current);
    };
  }, []);

  const runAction = async (action: SplitActionItem) => {
    if (action.disabled) return;
    setOpen(false);
    if (action.href) {
      window.open(action.href, "_blank", "noopener,noreferrer");
    } else {
      await action.onSelect?.();
    }
    if (action.feedbackLabel) {
      setFlashLabel(action.feedbackLabel);
      if (timeoutRef.current) window.clearTimeout(timeoutRef.current);
      timeoutRef.current = window.setTimeout(() => {
        setFlashLabel(null);
        timeoutRef.current = null;
      }, 1400);
    }
  };

  return (
    <div className="split-action" ref={rootRef}>
      <button
        type="button"
        className="button mini split-action-primary"
        disabled={primary.disabled}
        onClick={() => void runAction(primary)}
      >
        {flashLabel ?? primary.label}
      </button>
      {availableSecondary.length > 0 && (
        <>
          <button
            type="button"
            className="button mini split-action-toggle"
            aria-label={`More ${primary.label.toLowerCase()} actions`}
            aria-expanded={open}
            disabled={primary.disabled}
            onClick={() => setOpen((current) => !current)}
          >
            <span aria-hidden="true">▾</span>
          </button>
          {open && (
            <div className="split-action-menu">
              {availableSecondary.map((action) => (
                <button
                  key={`${primary.label}:${action.label}`}
                  type="button"
                  className="split-action-item"
                  onClick={() => void runAction(action)}
                >
                  {action.label}
                </button>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}
