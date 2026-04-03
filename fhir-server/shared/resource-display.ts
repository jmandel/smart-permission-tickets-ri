export function resourcePrimaryDisplay(resource: any, fallback?: string) {
  const resourceFallback = fallback ?? `${resource?.resourceType ?? "Resource"}/${resource?.id ?? ""}`.replace(/\/$/, "");
  switch (resource?.resourceType) {
    case "Patient":
    case "Practitioner":
    case "RelatedPerson":
      return bestHumanName(resource?.name) ?? resourceFallback;
    case "Organization":
    case "Location":
      return bestNamedValue(resource) ?? resourceFallback;
    case "Encounter":
      return (
        resource?.type?.[0]?.text ??
        resource?.type?.[0]?.coding?.[0]?.display ??
        resource?.serviceType?.text ??
        resource?.serviceType?.coding?.[0]?.display ??
        resource?.reasonCode?.[0]?.text ??
        resource?.reasonCode?.[0]?.coding?.[0]?.display ??
        resourceFallback ??
        "Encounter"
      );
    case "Observation":
    case "DiagnosticReport":
    case "Condition":
    case "Procedure":
    case "ServiceRequest":
    case "AllergyIntolerance":
      return bestCodeableText(resource?.code) ?? resourceFallback;
    case "DocumentReference":
      return bestCodeableText(resource?.type) ?? resourceFallback;
    case "MedicationRequest":
      return bestCodeableText(resource?.medicationCodeableConcept) ?? resourceFallback;
    case "Immunization":
      return bestCodeableText(resource?.vaccineCode) ?? resourceFallback;
    default:
      return bestNamedValue(resource) ?? resourceFallback;
  }
}

export function bestHumanName(names: any): string | null {
  if (!Array.isArray(names)) return null;
  for (const name of names) {
    if (typeof name?.text === "string" && name.text.trim()) return name.text.trim();
    const given = Array.isArray(name?.given)
      ? name.given.filter((value: unknown): value is string => typeof value === "string" && value.trim().length > 0)
      : [];
    const family = typeof name?.family === "string" && name.family.trim() ? name.family.trim() : "";
    const parts = [...given, family].filter(Boolean);
    if (parts.length) return parts.join(" ");
  }
  return null;
}

export function bestCodeableText(codeable: any): string | null {
  if (!codeable) return null;
  if (typeof codeable?.text === "string" && codeable.text.trim()) return codeable.text.trim();
  if (Array.isArray(codeable?.coding)) {
    for (const coding of codeable.coding) {
      if (typeof coding?.display === "string" && coding.display.trim()) return coding.display.trim();
      if (typeof coding?.code === "string" && coding.code.trim()) return coding.code.trim();
    }
  }
  return null;
}

function bestNamedValue(resource: any): string | null {
  if (typeof resource?.name === "string" && resource.name.trim()) return resource.name.trim();
  if (Array.isArray(resource?.name)) {
    const personName = bestHumanName(resource.name);
    if (personName) return personName;
  }
  if (Array.isArray(resource?.alias)) {
    const alias = resource.alias.find((value: unknown): value is string => typeof value === "string" && value.trim().length > 0);
    if (alias) return alias.trim();
  }
  if (typeof resource?.title === "string" && resource.title.trim()) return resource.title.trim();
  return null;
}
