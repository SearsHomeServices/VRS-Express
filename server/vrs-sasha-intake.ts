import type { VrsExpressIntake } from "./vrs-sasha-api";
import {
  getVrsAuthorizeContractVersion,
  type VrsAuthorizeRequest,
} from "./vrs-sasha-contract";
import { projectVrsBridgeIntake } from "./vrs-sasha-queue";
import type { NewVrsBridgeIntake, VrsBridgeIntakeStore } from "./vrs-sasha-store";

export interface VrsIntakeTechnician {
  ldapId: string;
  name?: string | null;
  phone?: string | null;
  district?: string | null;
  isActive: boolean;
}

export interface VrsIntakeTechUser {
  id: number;
  email?: string | null;
  name: string;
  role: string;
  racId?: string | null;
  phone?: string | null;
}

function normalizeTechnicianDistrict(value: string | null | undefined) {
  if (value && /^\d{4}$/.test(value)) return value;
  return value?.match(/^000(\d{4})$/)?.[1];
}

export interface VrsIntakeTicketInput {
  body: ReturnType<typeof projectVrsBridgeIntake>["submissionBody"];
  user: VrsIntakeTechUser;
}

interface VrsSashaInternalTicketOptions {
  // Private route-to-handler escape hatch for the V8 §2.4 retry exception.
  // It never comes from the request body or public API.
  ignoreLegacyDuplicateSubmissionIds?: readonly number[];
}

export type VrsFreshSubmissionResult =
  | { kind: "created"; submissionId: number }
  | {
      kind: "rejected";
      status: 409 | 422;
      code: string;
      message: string;
    };

export interface VrsSashaIntakeDependencies {
  store: VrsBridgeIntakeStore;
  resolveTechnician(techId: string): Promise<VrsIntakeTechnician | undefined>;
  resolveTechUser(
    ldapId: string,
    name: string,
    phone: string,
  ): Promise<VrsIntakeTechUser>;
  encryptCallbackSecret(secret: string): {
    cipher: string;
    iv: string;
    authTag: string;
    salt: string;
  };
  generateCallId(): string;
  createTicket(
    input: VrsIntakeTicketInput,
    internalOptions?: VrsSashaInternalTicketOptions,
  ): Promise<VrsFreshSubmissionResult>;
}

function usablePhone(value: string | null | undefined): string {
  const trimmed = value?.trim() ?? "";
  return trimmed && trimmed.toUpperCase() !== "N/A" ? trimmed : "";
}

function normalizePartner(payload: VrsAuthorizeRequest): string {
  return (payload.partner_id ?? "ahs")
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, "_");
}

export function createVrsSashaIntake(
  deps: VrsSashaIntakeDependencies,
): VrsExpressIntake {
  return {
    async receive(payload) {
      const partnerId = normalizePartner(payload);
      if (!["ahs", "american_home_shield", "n/a"].includes(partnerId)) {
        return {
          kind: "unsupported_partner",
          partnerId: payload.partner_id ?? "unknown",
        };
      }

      const active = await deps.store.findActiveByServiceOrder(
        payload.service_order,
      );
      if (active) {
        return {
          kind: "duplicate",
          existingCallId: active.callId,
          state: active.state,
        };
      }

      const retryableFailedV8SubmissionIds =
        getVrsAuthorizeContractVersion(payload) === "v8"
          ? await deps.store.findLocallyAppliedRetryableFailedV8SubmissionsByServiceOrder(
            payload.service_order,
          )
          : [];

      const technician = await deps.resolveTechnician(payload.tech_id);
      if (!technician) {
        return {
          kind: "rejected",
          status: 422,
          code: "UNKNOWN_TECHNICIAN",
          message: `Unknown technician LDAP id: ${payload.tech_id}`,
        };
      }
      if (!technician.isActive) {
        return {
          kind: "rejected",
          status: 422,
          code: "INACTIVE_TECHNICIAN",
          message: `Technician ${payload.tech_id} is inactive`,
        };
      }
      const district = normalizeTechnicianDistrict(technician.district);
      if (!district) {
        return {
          kind: "rejected",
          status: 422,
          code: "INVALID_TECHNICIAN_DISTRICT",
          message:
            `Technician ${payload.tech_id} does not have a four-digit district`,
        };
      }

      const directoryPhone = usablePhone(technician.phone);
      const wirePhone = payload.tech_phone === "N/A"
        ? ""
        : usablePhone(payload.tech_phone);
      const techUser = await deps.resolveTechUser(
        technician.ldapId,
        technician.name || payload.tech_name,
        directoryPhone || wirePhone,
      );
      if (techUser.role !== "technician") {
        return {
          kind: "rejected",
          status: 409,
          code: "NOT_A_TECHNICIAN",
          message: "The resolved account is not a technician account",
        };
      }

      const encryptedSecret = deps.encryptCallbackSecret(
        payload.callback_secret,
      );
      const projection = projectVrsBridgeIntake(
        payload,
        district,
        {
          technicianPhone:
            directoryPhone || usablePhone(techUser.phone),
        },
      );
      const bridgeInput: Omit<NewVrsBridgeIntake, "submissionId"> = {
        callId: deps.generateCallId(),
        serviceOrder: payload.service_order,
        techId: payload.tech_id,
        techPhone: projection.operationalPhone,
        techName: techUser.name,
        requestPayload: projection.requestPayload,
        callbackUrl: payload.callback_url,
        callbackSecretCipher: encryptedSecret.cipher,
        callbackSecretIv: encryptedSecret.iv,
        callbackSecretAuthTag: encryptedSecret.authTag,
        callbackSecretSalt: encryptedSecret.salt,
      };

      const fresh = await deps.createTicket({
        body: projection.submissionBody,
        user: techUser,
      }, retryableFailedV8SubmissionIds.length > 0
        ? {
          ignoreLegacyDuplicateSubmissionIds: retryableFailedV8SubmissionIds
            .map((entry) => entry.submissionId),
        }
        : undefined);
      if (fresh.kind === "rejected") return fresh;

      const stored = await deps.store.createIntake({
        ...bridgeInput,
        submissionId: fresh.submissionId,
      });
      if (stored.kind === "duplicate") {
        return {
          kind: "duplicate",
          existingCallId: stored.record.callId,
          state: stored.record.state,
        };
      }
      return {
        kind: "accepted",
        callId: stored.record.callId,
        serviceOrder: payload.service_order,
        createdAt: stored.createdAt,
      };
    },
  };
}
