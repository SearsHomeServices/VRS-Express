import type { VrsExpressIntake } from "./vrs-sasha-api";
import type { VrsAuthorizeRequest } from "./vrs-sasha-contract";
import {
  projectVrsBridgeIntake,
  type VrsExpressApplianceDivision,
} from "./vrs-sasha-queue";
import type {
  VrsBridgeIntakeDecisionStore,
  VrsFreshSubmissionResult,
} from "./vrs-sasha-store";

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

export interface VrsIntakeTicketInput {
  body: ReturnType<typeof projectVrsBridgeIntake>["submissionBody"];
  user: VrsIntakeTechUser;
}

export interface VrsRearmNotification {
  submissionId: number;
  previousAssignee: number | null;
  serviceOrder: string;
  applianceType: VrsExpressApplianceDivision;
  requestType: "authorization";
  warrantyType: "american_home_shield";
  warrantyProvider: "American Home Shield";
}

export interface VrsSashaIntakeDependencies {
  store: VrsBridgeIntakeDecisionStore;
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
  createTicket(input: VrsIntakeTicketInput): Promise<VrsFreshSubmissionResult>;
  bumpSubmissionsDataVersion(): void;
  notifyRearmed(notification: VrsRearmNotification): Promise<void>;
  logPostCommitError(error: unknown, notification: VrsRearmNotification): void;
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
      if (!technician.district || !/^\d{4}$/.test(technician.district)) {
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
        technician.district,
        {
          technicianPhone:
            directoryPhone || usablePhone(techUser.phone),
        },
      );
      const decisionInput = {
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
        submissionProjection: {
          applianceType: projection.submissionBody.applianceType,
          issueDescription: projection.submissionBody.issueDescription,
          estimateAmount: projection.submissionBody.estimateAmount,
          partNumbers: projection.submissionBody.partNumbers,
          phone: projection.submissionBody.phone,
        },
      };
      const decision = await deps.store.decideExistingOrRearm(decisionInput);

      if (decision.kind === "duplicate") {
        return {
          kind: "duplicate",
          existingCallId: decision.record.callId,
          state: decision.record.state,
        };
      }
      if (decision.kind === "rearmed") {
        const notification: VrsRearmNotification = {
          submissionId: decision.record.submissionId,
          previousAssignee: decision.previousAssignee,
          serviceOrder: projection.submissionBody.serviceOrder,
          applianceType: projection.submissionBody.applianceType,
          requestType: projection.submissionBody.requestType,
          warrantyType: projection.submissionBody.warrantyType,
          warrantyProvider: projection.submissionBody.warrantyProvider,
        };
        try {
          deps.bumpSubmissionsDataVersion();
          await deps.notifyRearmed(notification);
        } catch (error) {
          deps.logPostCommitError(error, notification);
        }
        return {
          kind: "accepted",
          callId: decision.record.callId,
          serviceOrder: payload.service_order,
          createdAt: decision.rearmedAt,
        };
      }

      const fresh = await deps.createTicket({
        body: projection.submissionBody,
        user: techUser,
      });
      if (fresh.kind === "rejected") return fresh;
      const {
        submissionProjection: _submissionProjection,
        ...bridgeInput
      } = decisionInput;
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
