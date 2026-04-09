import { bestCodeableText, bestHumanName } from "../../../shared/resource-display.ts";
import type { DemoTicketScenario } from "../../../../shared/demo-ticket-scenarios.ts";

function ReadonlyField({
  label,
  value,
  mono = false,
  stack = false,
  scroll = false,
}: {
  label: string;
  value: string;
  mono?: boolean;
  stack?: boolean;
  scroll?: boolean;
}) {
  return (
    <div className={`readonly-ticket-field${stack ? " readonly-ticket-field-stack" : ""}`}>
      <span className="readonly-ticket-field-label">{label}</span>
      <div className={`readonly-ticket-field-value${mono ? " mono-value" : ""}${mono && !scroll ? " mono-wrap" : ""}${scroll ? " readonly-ticket-field-value-scroll" : ""}`}>{value}</div>
    </div>
  );
}

type BindingPreview = {
  method: string;
  detailLabel?: string;
  detailHeading?: string;
  value?: string;
};

function CompactMatrix({
  columns,
  rows,
}: {
  columns: string[];
  rows: string[][];
}) {
  if (rows.length === 0) return null;

  return (
    <div className={`readonly-ticket-matrix readonly-ticket-matrix-${columns.length}`}>
      {columns.map((column) => (
        <span key={`head:${column}`} className="readonly-ticket-matrix-head">{column}</span>
      ))}
      {rows.flatMap((row, rowIndex) => row.map((value, columnIndex) => (
        <span
          key={`row:${rowIndex}:${columnIndex}`}
          className={`readonly-ticket-matrix-cell${columnIndex < row.length - 1 ? " mono-value mono-wrap" : ""}`}
        >
          {value}
        </span>
      )))}
    </div>
  );
}

function CodeableConceptField({
  label,
  concept,
}: {
  label: string;
  concept: any;
}) {
  const text = bestCodeableText(concept);
  const codings = Array.isArray(concept?.coding) ? concept.coding.filter((coding: any) => coding && typeof coding === "object") : [];

  if (!text && codings.length === 0) return null;

  return (
    <div className="readonly-ticket-field readonly-ticket-field-complex">
      <span className="readonly-ticket-field-label">{label}</span>
      <div className="readonly-ticket-field-complex-body">
        {text && (
          <CompactMatrix
            columns={["text"]}
            rows={[[text]]}
          />
        )}
      {codings.length > 0 && (
        <CompactMatrix
          columns={["system", "code", "display"]}
          rows={codings.map((coding: any) => [
            coding.system ?? "none",
            coding.code ?? "none",
            coding.display ?? "none",
          ])}
        />
      )}
      </div>
    </div>
  );
}

function IdentifierFields({ identifiers }: { identifiers: any[] | undefined }) {
  if (!Array.isArray(identifiers) || identifiers.length === 0) return null;

  return (
    <div className="readonly-ticket-field readonly-ticket-field-complex">
      <span className="readonly-ticket-field-label">identifier</span>
      <CompactMatrix
        columns={["system", "value"]}
        rows={identifiers.map((identifier: any) => [
          identifier.system ?? "none",
          identifier.value ?? "none",
        ])}
      />
    </div>
  );
}

function requesterName(requester: any) {
  if (!requester || typeof requester !== "object") return null;
  if (requester.resourceType === "Organization" && typeof requester.name === "string") return requester.name;
  if ((requester.resourceType === "RelatedPerson" || requester.resourceType === "Practitioner") && Array.isArray(requester.name)) {
    return bestHumanName(requester.name);
  }
  if (requester.resourceType === "PractitionerRole") {
    return requester.practitioner?.display ?? requester.organization?.display ?? null;
  }
  return null;
}

function MinimalResourceFields({
  label,
  resource,
}: {
  label: string;
  resource: any;
}) {
  if (!resource || typeof resource !== "object") return null;

  return (
    <>
      <ReadonlyField label={`${label} resourceType`} value={resource.resourceType ?? "unknown"} />
      {typeof resource.title === "string" && <ReadonlyField label={`${label}.title`} value={resource.title} />}
      {typeof resource.status === "string" && <ReadonlyField label={`${label}.status`} value={resource.status} />}
      {typeof resource.intent === "string" && <ReadonlyField label={`${label}.intent`} value={resource.intent} />}
      {typeof resource.use === "string" && <ReadonlyField label={`${label}.use`} value={resource.use} />}
      <IdentifierFields identifiers={resource.identifier} />
    </>
  );
}

function RequesterSection({
  scenario,
  fullWidth = false,
}: {
  scenario: DemoTicketScenario;
  fullWidth?: boolean;
}) {
  const requester = "requester" in scenario.ticket ? scenario.ticket.requester : null;
  const practitionerDisplay = typeof (requester as any)?.practitioner?.display === "string"
    ? (requester as any).practitioner.display
    : null;
  const organizationDisplay = typeof (requester as any)?.organization?.display === "string"
    ? (requester as any).organization.display
    : null;
  if (!requester) return null;

  return (
    <section className={`readonly-ticket-section ${fullWidth ? "readonly-ticket-section-full" : "readonly-ticket-section-requester"}`}>
      <div className="readonly-ticket-section-header">
        <h4>Requester</h4>
        <p className="subtle">Read-only FHIR content included in the signed ticket.</p>
      </div>
      <ReadonlyField label="resourceType" value={requester.resourceType} />
      {requesterName(requester) && <ReadonlyField label="name" value={requesterName(requester)!} />}
      {requester.resourceType === "PractitionerRole" && practitionerDisplay && (
        <ReadonlyField label="practitioner.display" value={practitionerDisplay} />
      )}
      {requester.resourceType === "PractitionerRole" && organizationDisplay && (
        <ReadonlyField label="organization.display" value={organizationDisplay} />
      )}
      {requester.resourceType === "RelatedPerson" && Array.isArray(requester.relationship)
        ? requester.relationship.map((relationship: any, index: number) => (
            <CodeableConceptField key={`relationship:${index}`} label="relationship" concept={relationship} />
          ))
        : null}
      {requester.resourceType === "PractitionerRole" && Array.isArray(requester.code)
        ? requester.code.map((code: any, index: number) => (
            <CodeableConceptField key={`role:${index}`} label="code" concept={code} />
          ))
        : null}
      <IdentifierFields identifiers={requester.identifier} />
    </section>
  );
}

function ContextSection({
  scenario,
  fullWidth = false,
}: {
  scenario: DemoTicketScenario;
  fullWidth?: boolean;
}) {
  const context = scenario.ticket.context;
  const hasContext = context && typeof context === "object" && Object.keys(context).length > 0;
  if (!hasContext) return null;

  return (
    <section className={`readonly-ticket-section ${fullWidth ? "readonly-ticket-section-full" : "readonly-ticket-section-context"}`}>
      <div className="readonly-ticket-section-header">
        <h4>Context</h4>
        <p className="subtle">Read-only scenario claims that will be carried into the signed ticket.</p>
      </div>
      {"reportable_condition" in context && (
        <CodeableConceptField label="reportable_condition" concept={context.reportable_condition} />
      )}
      {"concern" in context && <CodeableConceptField label="concern" concept={context.concern} />}
      {"service" in context && <CodeableConceptField label="service" concept={context.service} />}
      {"reason" in context && <CodeableConceptField label="reason" concept={context.reason} />}
      {"referral" in context && <MinimalResourceFields label="referral" resource={context.referral} />}
      {"claim" in context && <MinimalResourceFields label="claim" resource={context.claim} />}
      {"study" in context && <MinimalResourceFields label="study" resource={context.study} />}
      {"consult_request" in context && <MinimalResourceFields label="consult_request" resource={context.consult_request} />}
    </section>
  );
}

function PresenterBindingSection({ bindingPreview }: { bindingPreview: BindingPreview | null | undefined }) {
  if (!bindingPreview) return null;

  return (
    <section className="readonly-ticket-section readonly-ticket-section-full">
      <div className="readonly-ticket-section-header">
        <h4>Presenter Binding</h4>
        <p className="subtle">Read-only client-binding claim that will be included in the signed ticket.</p>
      </div>
      <ReadonlyField label="presenter_binding.method" value={bindingPreview.method} stack />
      {bindingPreview.detailLabel && bindingPreview.value && (
        <ReadonlyField
          label={bindingPreview.detailLabel}
          value={bindingPreview.value}
          mono
          stack
          scroll
        />
      )}
    </section>
  );
}

export function TicketReadonlyPanel({
  scenario,
  bindingPreview,
}: {
  scenario: DemoTicketScenario;
  bindingPreview?: BindingPreview | null;
}) {
  const hasRequester = "requester" in scenario.ticket;
  const hasContext = Boolean(scenario.ticket.context && Object.keys(scenario.ticket.context).length > 0);
  const singleDetailSection = Number(hasRequester) + Number(hasContext) <= 1;

  return (
    <section className="readonly-ticket-panel">
      <div className="readonly-ticket-panel-header">
        <div>
          <p className="eyebrow">Included In Ticket</p>
          <h3>Read-only claims from the selected scenario</h3>
          <p className="subtle">These fields are fixed by the selected scenario and client path and are included in the signed Permission Ticket. Use the controls below only to adjust access constraints.</p>
        </div>
      </div>
      <div className="readonly-ticket-grid">
        <section className="readonly-ticket-section readonly-ticket-section-ticket-type">
          <div className="readonly-ticket-section-header">
            <h4>Ticket Type</h4>
          </div>
          <ReadonlyField label="ticket_type" value={scenario.ticket.ticket_type} mono stack />
        </section>
        <PresenterBindingSection bindingPreview={bindingPreview} />
        <RequesterSection scenario={scenario} fullWidth={singleDetailSection} />
        <ContextSection scenario={scenario} fullWidth={singleDetailSection} />
      </div>
    </section>
  );
}
