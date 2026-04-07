export function DataContract({ onClose }: { onClose: () => void }) {
  const origin = typeof window !== "undefined" ? window.location.origin : "";
  const surfaces = [
    {
      label: "Strict",
      appPath: "/",
      tokenPath: "/token",
      fhirBase: "/sites/{siteSlug}/fhir",
      note: "Registered client plus private-key client assertion. Best fit for the full Permission Ticket flow.",
    },
    {
      label: "Registered",
      appPath: "/modes/registered",
      tokenPath: "/modes/registered/token",
      fhirBase: "/modes/registered/sites/{siteSlug}/fhir",
      note: "Still requires a registered client, but with looser policy than strict.",
    },
    {
      label: "Key-Bound",
      appPath: "/modes/key-bound",
      tokenPath: "/modes/key-bound/token",
      fhirBase: "/modes/key-bound/sites/{siteSlug}/fhir",
      note: "For sender-constrained tickets that carry presenter_binding.key.jkt and require the matching client key.",
    },
    {
      label: "Open",
      appPath: "/modes/open",
      tokenPath: "/modes/open/token",
      fhirBase: "/modes/open/sites/{siteSlug}/fhir",
      note: "Token exchange stays available without registration, but FHIR still requires an issued token.",
    },
    {
      label: "Preview",
      appPath: "/modes/anonymous",
      tokenPath: "none",
      fhirBase: "/modes/anonymous/sites/{siteSlug}/fhir",
      note: "Read-only local preview surface used for comparison and quick inspection.",
    },
  ];

  return (
    <section className="panel section">
      <div className="section-header">
        <div>
          <p className="eyebrow">About</p>
          <h2>About This App</h2>
        </div>
        <button type="button" className="button" onClick={onClose}>Close</button>
      </div>

      <p className="subtle" style={{ marginTop: 0 }}>
        This is a developer-facing SMART Permission Tickets demo. You pick a synthetic patient,
        choose ticket constraints, exchange a Permission Ticket for an access token, and compare
        the shared result set with the full preview chart for the same patient and sites.
      </p>

      <h3 style={{ fontSize: "1.05rem", marginTop: 20, marginBottom: 8 }}>Developer entry points</h3>
      <p className="subtle" style={{ marginTop: 0 }}>
        The landing page is the ticket builder. The health app lives at <code>/viewer</code> and
        receives a ticket handoff from here. If you want to point another local client at the
        server, these are the base paths to use.
      </p>
      <table style={{ fontSize: "0.92rem" }}>
        <thead>
          <tr><th>Surface</th><th>App path</th><th>Token endpoint</th><th>Site FHIR base</th><th>Use it when</th></tr>
        </thead>
        <tbody>
          {surfaces.map((surface) => (
            <tr key={surface.label}>
              <td>{surface.label}</td>
              <td><code>{origin}{surface.appPath}</code></td>
              <td><code>{surface.tokenPath === "none" ? "none" : `${origin}${surface.tokenPath}`}</code></td>
              <td><code>{origin}{surface.fhirBase}</code></td>
              <td>{surface.note}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <h3 style={{ fontSize: "1.05rem", marginTop: 16, marginBottom: 8 }}>Synthetic pipeline</h3>
      <table style={{ fontSize: "0.92rem" }}>
        <thead>
          <tr><th>Stage</th><th>Purpose</th></tr>
        </thead>
        <tbody>
          <tr>
            <td><code>01</code> to <code>05</code></td>
            <td>Agent-assisted generation of biography, encounters, notes, inventory, and site-partitioned FHIR resources.</td>
          </tr>
          <tr>
            <td><code>06-security-labels</code></td>
            <td>Applies <code>meta.security</code> labels for sensitive domains such as reproductive health, HIV, mental health, STI, ethnicity, and sexual/domestic violence.</td>
          </tr>
          <tr>
            <td><code>07-assemble</code></td>
            <td>Builds final bundles, adds patient and encounter summaries, and prepares the assembled corpus the server loads.</td>
          </tr>
        </tbody>
      </table>

      <h3 style={{ fontSize: "1.05rem", marginTop: 20, marginBottom: 8 }}>Load contract</h3>
      <p className="subtle" style={{ marginTop: 0 }}>
        The server loads FHIR resources from <code>synth-data/patients/*/sites/*/resources/</code>.
        Some conventions on the input resources enable specific features. All are optional, but the
        server loses capability when they are missing.
      </p>

      <h3 style={{ fontSize: "1.05rem", marginTop: 16, marginBottom: 8 }}>Required by directory structure</h3>
      <table style={{ fontSize: "0.92rem" }}>
        <thead>
          <tr><th>Convention</th><th>What it enables</th></tr>
        </thead>
        <tbody>
          <tr>
            <td><code>patients/&#123;slug&#125;/sites/&#123;site&#125;/resources/&#123;Type&#125;/*.json</code></td>
            <td>
              Cross-site patient identity. All Patient resources under the same <code>&#123;slug&#125;</code>
              directory are treated as the same person. The server builds a <code>patient_aliases</code>
              table from this, enabling ticket subject resolution to fan out across sites during token exchange.
            </td>
          </tr>
          <tr>
            <td>Exactly one <code>Patient/*.json</code> per site directory</td>
            <td>
              Establishes the site-local patient reference. All other resources at this site are
              linked to this patient for compartment membership.
            </td>
          </tr>
        </tbody>
      </table>

      <h3 style={{ fontSize: "1.05rem", marginTop: 20, marginBottom: 8 }}>Derived at ingest</h3>
      <p className="subtle" style={{ marginTop: 0 }}>
        The server derives site-level organization and jurisdiction metadata from the site&apos;s
        Organization and Location resources. These values are compiled into <code>allowedSites</code>
        during token exchange, so the FHIR query path can stay focused on allowed site slugs,
        patient aliases, dates, scopes, and sensitivity labels.
      </p>
      <table style={{ fontSize: "0.92rem" }}>
        <thead>
          <tr><th>System</th><th>Example</th><th>What it enables</th></tr>
        </thead>
        <tbody>
          <tr>
            <td>Organization or Location address state</td>
            <td><code>TX</code>, <code>CA</code>, <code>IL</code></td>
            <td>
              Jurisdiction-based ticket filtering. A ticket with{" "}
              <code>access.jurisdictions</code> is resolved to matching site slugs
              during token exchange.
            </td>
          </tr>
          <tr>
            <td>Organization identifier / NPI</td>
            <td><code>1437826095</code></td>
            <td>
              Organization-based ticket filtering. A ticket with{" "}
              <code>access.source_organizations</code> can identify sites by NPI.
            </td>
          </tr>
        </tbody>
      </table>

      <h3 style={{ fontSize: "1.05rem", marginTop: 20, marginBottom: 8 }}>Optional: <code>meta.security</code> labels</h3>
      <p className="subtle" style={{ marginTop: 0 }}>
        Stamped by the synth-data pipeline based on encounter-level sensitivity classification.
      </p>
      <table style={{ fontSize: "0.92rem" }}>
        <thead>
          <tr><th>System</th><th>Codes</th><th>What it enables</th></tr>
        </thead>
        <tbody>
          <tr>
            <td><code>http://terminology.hl7.org/CodeSystem/v3-ActCode</code></td>
            <td><code>SEX</code>, <code>MH</code>, <code>HIV</code>, <code>ETH</code>, <code>STD</code>, <code>SDV</code></td>
            <td>
              Sensitive-data filtering. When a ticket carries <code>access.sensitive_data = exclude</code>,
              resources with any of these labels are excluded from the visible set.
            </td>
          </tr>
        </tbody>
      </table>

      <h3 style={{ fontSize: "1.05rem", marginTop: 20, marginBottom: 8 }}>Optional: identifiers and extensions</h3>
      <table style={{ fontSize: "0.92rem" }}>
        <thead>
          <tr><th>Convention</th><th>What it enables</th></tr>
        </thead>
        <tbody>
          <tr>
            <td><code>Patient.identifier[system=&quot;urn:smart-permission-tickets:person-id&quot;]</code></td>
            <td>Cross-site person linkage visible in served FHIR responses.</td>
          </tr>
          <tr>
            <td><code>Organization.identifier[system=&quot;http://hl7.org/fhir/sid/us-npi&quot;]</code></td>
            <td>Organization matching by NPI in ticket claims.</td>
          </tr>
          <tr>
            <td><code>smart-permission-tickets-patient-summary</code> and <code>smart-permission-tickets-encounter-summary</code> extensions</td>
            <td>Human-readable summaries in the UI for patients and encounters.</td>
          </tr>
        </tbody>
      </table>
    </section>
  );
}
