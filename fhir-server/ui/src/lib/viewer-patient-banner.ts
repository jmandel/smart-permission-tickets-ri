import { bestHumanName } from "../../../shared/resource-display.ts";
import type { PermissionTicket } from "../../../../shared/permission-ticket-schema.ts";
import type { ViewerResourceItem } from "./viewer-model";

export type ViewerPatientBanner = {
  displayName: string | null;
  birthDate: string | null;
  gender: string | null;
  mrIdentifier: string | null;
  hasLoadedPatient: boolean;
};

export function viewerPatientBannerTitle(banner: ViewerPatientBanner) {
  return banner.displayName ?? "Patient record";
}

export function buildViewerPatientBanner(
  ticketPayload: PermissionTicket | null,
  resources: ViewerResourceItem[],
): ViewerPatientBanner {
  const ticketPatient = ticketPayload?.subject?.patient ?? null;
  const loadedPatients = resources
    .filter((resource): resource is ViewerResourceItem & { resourceType: "Patient"; resource: Record<string, any> } => resource.resourceType === "Patient")
    .map((resource) => resource.resource);

  return {
    displayName: bestHumanName(ticketPatient?.name) ?? firstLoadedPatientName(loadedPatients),
    birthDate: ticketBirthDate(ticketPatient) ?? firstLoadedPatientString(loadedPatients, "birthDate"),
    gender: ticketGender(ticketPatient) ?? firstLoadedPatientString(loadedPatients, "gender"),
    mrIdentifier: firstMedicalRecordIdentifier(ticketPatient?.identifier),
    hasLoadedPatient: loadedPatients.length > 0,
  };
}

function ticketBirthDate(patient: PermissionTicket["subject"]["patient"] | null) {
  return typeof patient?.birthDate === "string" && patient.birthDate.trim() ? patient.birthDate.trim() : null;
}

function ticketGender(patient: PermissionTicket["subject"]["patient"] | null) {
  return typeof patient?.gender === "string" && patient.gender.trim() ? patient.gender.trim() : null;
}

function firstLoadedPatientName(patients: Record<string, any>[]) {
  for (const patient of patients) {
    const name = bestHumanName(patient?.name);
    if (name) return name;
  }
  return null;
}

function firstLoadedPatientString(patients: Record<string, any>[], key: "birthDate" | "gender") {
  for (const patient of patients) {
    const value = patient?.[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return null;
}

export function firstMedicalRecordIdentifier(identifiers: Array<Record<string, any>> | null | undefined) {
  if (!Array.isArray(identifiers)) return null;
  for (const identifier of identifiers) {
    const codings = Array.isArray(identifier?.type?.coding) ? identifier.type.coding : [];
    const isMedicalRecord = codings.some((coding: any) => typeof coding?.code === "string" && coding.code === "MR");
    if (!isMedicalRecord) continue;
    if (typeof identifier?.value === "string" && identifier.value.trim()) return identifier.value.trim();
  }
  return null;
}
