import type { DemoArtifactProvenanceStep, DemoHttpRequestArtifact, DemoHttpResponseArtifact } from "../../../shared/demo-events";
import type { SharedEventArtifactProvenanceGroup } from "../lib/demo-event-tabs";
import { decodeJwtArtifact } from "../lib/artifact-viewer";

export function HttpRequestArtifactPanel({ artifact }: { artifact: DemoHttpRequestArtifact }) {
  const body = renderHttpBody(artifact.body);
  const target = formatHttpTarget(artifact.url);
  return (
    <div className="http-artifact">
      <div className="http-start-line">
        <span className="http-method-badge">{artifact.method.toUpperCase()}</span>
        <code className="http-target">{target}</code>
      </div>
      {target !== artifact.url && <div className="http-full-url subtle mono-wrap">{artifact.url}</div>}
      <HttpHeadersTable headers={artifact.headers} />
      {body && <HttpBodyPanel title="Body" body={body} />}
    </div>
  );
}

export function HttpResponseArtifactPanel({ artifact }: { artifact: DemoHttpResponseArtifact }) {
  const body = renderHttpBody(artifact.body);
  const statusText = httpStatusText(artifact.status);
  const statusClass = artifact.status >= 400 ? "error" : artifact.status >= 300 ? "redirect" : "success";
  return (
    <div className="http-artifact">
      <div className="http-start-line">
        <span className={`http-status-badge ${statusClass}`}>{artifact.status}{statusText ? ` ${statusText}` : ""}</span>
      </div>
      <HttpHeadersTable headers={artifact.headers} />
      {body && <HttpBodyPanel title="Body" body={body} />}
    </div>
  );
}

export function JwtArtifactPanel({ jwt, titlePrefix = "JWT" }: { jwt: string; titlePrefix?: string }) {
  const artifact = decodeJwtArtifact(jwt);
  return (
    <div className="artifact-jwt-stack">
      <section className="artifact-json-panel">
        <div className="artifact-json-head">
          <h3>{titlePrefix} Header</h3>
        </div>
        <pre className="viewer-json" dangerouslySetInnerHTML={{ __html: renderHighlightedJson(JSON.stringify(artifact.header, null, 2)) }} />
      </section>
      <section className="artifact-json-panel">
        <div className="artifact-json-head">
          <h3>{titlePrefix} Payload</h3>
        </div>
        <pre className="viewer-json" dangerouslySetInnerHTML={{ __html: renderHighlightedJson(JSON.stringify(artifact.payload, null, 2)) }} />
      </section>
      <section className="artifact-json-panel">
        <div className="artifact-json-head">
          <h3>{titlePrefix} Signature</h3>
        </div>
        <pre className="viewer-json viewer-json-plain">{artifact.signature}</pre>
      </section>
      <section className="artifact-json-panel">
        <div className="artifact-json-head">
          <h3>{titlePrefix} Compact</h3>
        </div>
        <pre className="viewer-json viewer-json-plain">{artifact.compact}</pre>
      </section>
    </div>
  );
}

export function JsonArtifactPanel({ title, content, plainText = false }: { title: string; content: unknown; plainText?: boolean }) {
  const text = typeof content === "string" ? content : JSON.stringify(content, null, 2);
  return (
    <section className="artifact-json-panel">
      <div className="artifact-json-head">
        <h3>{title}</h3>
      </div>
      <pre
        className={`viewer-json${plainText ? " viewer-json-plain" : ""}`}
        dangerouslySetInnerHTML={plainText ? undefined : { __html: renderHighlightedJson(text) }}
      >
        {plainText ? text : undefined}
      </pre>
    </section>
  );
}

export function ArtifactProvenancePanel({
  provenance,
}: {
  provenance: {
    steps: DemoArtifactProvenanceStep[];
  };
}) {
  const steps = provenance.steps.filter((step) => step.summary || (step.requests?.length ?? 0) > 0);
  if (!steps.length) return null;
  return (
    <section className="artifact-provenance-panel">
      <div className="artifact-provenance-head">
        <h4>How this artifact was obtained</h4>
      </div>
      <div className="artifact-provenance-steps">
        {steps.map((step, stepIndex) => (
          <section key={`${step.role}:${step.title}:${stepIndex}`} className="artifact-provenance-step">
            <div className="artifact-provenance-step-head">
              <span className={`artifact-provenance-role artifact-provenance-role-${step.role}`}>{formatProvenanceRole(step.role)}</span>
              <h5>{step.title}</h5>
            </div>
            {step.summary ? <p className="artifact-provenance-summary subtle">{step.summary}</p> : null}
            {step.requests?.length ? (
              <div className="artifact-provenance-stack">
                {step.requests.map((request, requestIndex) => (
                  <div key={`${request.method}:${request.url}:${requestIndex}`} className="artifact-provenance-request">
                    <HttpRequestArtifactPanel artifact={request} />
                  </div>
                ))}
              </div>
            ) : null}
          </section>
        ))}
      </div>
    </section>
  );
}

export function SharedArtifactProvenancePanel({
  groups,
}: {
  groups: SharedEventArtifactProvenanceGroup[];
}) {
  if (!groups.length) return null;
  return (
    <section className="artifact-provenance-panel">
      <div className="artifact-provenance-head">
        <h4>Shared inputs behind these artifacts</h4>
      </div>
      <div className="artifact-provenance-steps">
        {groups.map((group, groupIndex) => (
          <section key={`${group.step.role}:${group.step.title}:${groupIndex}`} className="artifact-provenance-step">
            <div className="artifact-provenance-step-head">
              <span className={`artifact-provenance-role artifact-provenance-role-${group.step.role}`}>{formatProvenanceRole(group.step.role)}</span>
              <h5>{group.step.title}</h5>
            </div>
            {group.step.summary ? <p className="artifact-provenance-summary subtle">{group.step.summary}</p> : null}
            <p className="artifact-provenance-derived subtle">
              Used to derive: {group.artifactLabels.join(" · ")}
            </p>
            {group.step.requests?.length ? (
              <div className="artifact-provenance-stack">
                {group.step.requests.map((request, requestIndex) => (
                  <div key={`${request.method}:${request.url}:${requestIndex}`} className="artifact-provenance-request">
                    <HttpRequestArtifactPanel artifact={request} />
                  </div>
                ))}
              </div>
            ) : null}
          </section>
        ))}
      </div>
    </section>
  );
}

export function renderHighlightedJson(text: string) {
  const escaped = escapeHtml(text);
  return escaped.replace(
    /("(?:\\u[\da-fA-F]{4}|\\[^u]|[^\\"])*"\s*:?)|\b(true|false|null)\b|\b-?\d+(?:\.\d+)?(?:[eE][+\-]?\d+)?\b/g,
    (match) => {
      if (/^"/.test(match)) {
        const className = /:\s*$/.test(match) ? "json-key" : "json-string";
        return `<span class="${className}">${match}</span>`;
      }
      if (/true|false/.test(match)) return `<span class="json-boolean">${match}</span>`;
      if (/null/.test(match)) return `<span class="json-null">${match}</span>`;
      return `<span class="json-number">${match}</span>`;
    },
  );
}

export function formatHttpRequestForCopy(artifact: DemoHttpRequestArtifact) {
  return [
    `${artifact.method.toUpperCase()} ${artifact.url}`,
    ...Object.entries(artifact.headers).sort(([left], [right]) => left.localeCompare(right)).map(([key, value]) => `${key}: ${value}`),
    artifact.body === undefined ? null : "",
    artifact.body === undefined ? null : formatUnknownForCopy(artifact.body),
  ].filter((line): line is string => line !== null).join("\n");
}

export function formatHttpResponseForCopy(artifact: DemoHttpResponseArtifact) {
  const statusText = httpStatusText(artifact.status);
  return [
    `${artifact.status}${statusText ? ` ${statusText}` : ""}`,
    ...Object.entries(artifact.headers).sort(([left], [right]) => left.localeCompare(right)).map(([key, value]) => `${key}: ${value}`),
    artifact.body === undefined ? null : "",
    artifact.body === undefined ? null : formatUnknownForCopy(artifact.body),
  ].filter((line): line is string => line !== null).join("\n");
}

function HttpHeadersTable({ headers }: { headers: Record<string, string> }) {
  const entries = Object.entries(headers).sort(([left], [right]) => left.localeCompare(right));
  if (!entries.length) return null;
  return (
    <section className="http-section">
      <h4>Headers</h4>
      <table className="compact-table http-header-table">
        <tbody>
          {entries.map(([key, value]) => (
            <tr key={key}>
              <th scope="row">{key}</th>
              <td className="mono-wrap">{value}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}

function HttpBodyPanel({ title, body }: { title: string; body: { kind: "json" | "text"; text: string } }) {
  return (
    <section className="http-section">
      <h4>{title}</h4>
      {body.kind === "json" ? (
        <pre className="viewer-json" dangerouslySetInnerHTML={{ __html: renderHighlightedJson(body.text) }} />
      ) : (
        <pre className="viewer-json viewer-json-plain">{body.text}</pre>
      )}
    </section>
  );
}

function renderHttpBody(body: unknown): { kind: "json" | "text"; text: string } | null {
  if (body === undefined) return null;
  if (typeof body === "string") {
    const parsed = tryParseJson(body);
    return parsed ? { kind: "json", text: JSON.stringify(parsed, null, 2) } : { kind: "text", text: body };
  }
  return { kind: "json", text: JSON.stringify(body, null, 2) };
}

function tryParseJson(value: string) {
  const trimmed = value.trim();
  if (!trimmed || (!trimmed.startsWith("{") && !trimmed.startsWith("["))) return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    return null;
  }
}

function formatHttpTarget(url: string) {
  try {
    const parsed = new URL(url, window.location.origin);
    return parsed.origin === window.location.origin
      ? `${parsed.pathname}${parsed.search}${parsed.hash}`
      : parsed.toString();
  } catch {
    return url;
  }
}

function formatUnknownForCopy(value: unknown) {
  return typeof value === "string" ? value : JSON.stringify(value, null, 2);
}

function httpStatusText(status: number) {
  return HTTP_STATUS_TEXT[status] ?? "";
}

function formatProvenanceRole(role: DemoArtifactProvenanceStep["role"]) {
  switch (role) {
    case "inbound":
      return "Inbound";
    case "outbound":
      return "Outbound";
    case "in-process":
      return "In-process";
    default:
      return "Step";
  }
}

const HTTP_STATUS_TEXT: Record<number, string> = {
  200: "OK",
  201: "Created",
  202: "Accepted",
  204: "No Content",
  301: "Moved Permanently",
  302: "Found",
  303: "See Other",
  304: "Not Modified",
  307: "Temporary Redirect",
  308: "Permanent Redirect",
  400: "Bad Request",
  401: "Unauthorized",
  403: "Forbidden",
  404: "Not Found",
  409: "Conflict",
  422: "Unprocessable Content",
  429: "Too Many Requests",
  500: "Internal Server Error",
  502: "Bad Gateway",
  503: "Service Unavailable",
};

function escapeHtml(text: string) {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}
