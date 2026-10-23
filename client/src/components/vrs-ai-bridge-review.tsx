import React, { type ReactNode } from "react";
import type { VrsAiBridgeStatus } from "@/lib/vrsAiBridge";
import { VrsAiBridgePhotos } from "@/components/vrs-ai-bridge-photos";
import { useFeatureFlags, useVrsBridgePhotoProxyEnabled } from "@/hooks/use-feature-flags";
import { AhsTicketReview, type AhsReviewMedia } from "@/components/ahs-ticket-review";
import { AhsDetailsEditor } from "@/components/ahs-details-editor";
import { isAhsDetailsEditable, parseAhsDetailsForReview, techApplianceDetailsForTicket } from "@/lib/ahsReview";
import { parseTicketMediaMetadata } from "@/lib/ticket-media-metadata";
import { MAX_VIDEOS_PER_TICKET, parseVideoUrls } from "@/lib/videoUrls";

export const VRS_SOURCE_APP_LABEL = "Submitted by technician in VRS Express";
export const VRS_SOURCE_SASHA_LABEL = "SASHA";
export const AHS_NOT_ENROLLED_EDITABLE_TEXT =
  "This ticket is not enrolled in VRS AI yet. Complete the AHS details below and save them to send it to VRS AI.";
export const AHS_NOT_ENROLLED_TEXT =
  "This ticket is not enrolled in VRS AI. The VRS manager can complete the AHS details at Stage 1 to send it to VRS AI; otherwise use the manual authorization flow.";

// Blank values in the payload review (a field VRS AI will confirm with AHS).
const REVIEW_NOT_PROVIDED = "Not provided";

// The ticket columns the panel reads besides the bridge row. All of them are
// already on the agent's GET /api/submissions/:id response. The slim queue
// row lacks ahsDetails (undefined until the detail fetch lands).
export interface VrsAiBridgePanelSubmission {
  id?: number;
  ahsDetails?: string | null;
  // JSON (shared/tech-appliance-details.ts): grade, color and part function
  // the technician entered, so the AHS views can mark them "From technician".
  techApplianceDetails?: string | null;
  photos?: string | null;
  photoThumbnails?: string | null;
  videoUrl?: string | null;
  issueDescription?: string | null;
  requestType?: string | null;
  warrantyType?: string | null;
  ticketStatus?: string | null;
  stage1Status?: string | null;
  submissionApproved?: boolean | null;
}

function reviewMoney(value: unknown): string | undefined {
  return typeof value === "number" && Number.isFinite(value) ? `$${value.toFixed(2)}` : undefined;
}

function reviewSum(...values: unknown[]): number | undefined {
  let sum = 0;
  for (const value of values) {
    if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
    sum += value;
  }
  return sum;
}

function ahsReviewMedia(submission: VrsAiBridgePanelSubmission): AhsReviewMedia {
  const { parsed, thumbs } = parseTicketMediaMetadata(
    submission.photos,
    submission.photoThumbnails,
  );
  // The tech form files model/serial and estimate screenshots under
  // "estimate"; an old flat array has no categories, so show all of it.
  const raw = Array.isArray(parsed)
    ? parsed
    : parsed && typeof parsed === "object" && Array.isArray(parsed.estimate)
      ? parsed.estimate
      : [];
  return {
    estimatePhotos: raw.filter(
      (url: unknown): url is string => typeof url === "string" && url !== "",
    ),
    thumbnails: thumbs,
    videos: parseVideoUrls(submission.videoUrl).slice(0, MAX_VIDEOS_PER_TICKET),
  };
}

function ReviewField({
  label,
  dataField,
  children,
  mono = false,
}: {
  label: string;
  dataField: string;
  children: ReactNode;
  mono?: boolean;
}) {
  // Only a missing value reads "Not provided"; an empty string or 0 the
  // payload really carries is shown as is.
  const missing = children === undefined || children === null;
  return (
    <div>
      <span className="text-muted-foreground">{label}</span>
      <p
        data-field={dataField}
        className={
          missing
            ? "italic text-muted-foreground"
            : mono
              ? "font-mono font-medium"
              : "font-medium"
        }
      >
        {missing ? REVIEW_NOT_PROVIDED : children}
      </p>
    </div>
  );
}

export function VrsAiBridgeReview({
  bridge,
}: {
  bridge: VrsAiBridgeStatus;
}) {
  const context = bridge.reviewContext;
  const bridgePhotoProxyEnabled = useVrsBridgePhotoProxyEnabled();
  if (!context) return null;

  const total = reviewSum(context.labor_amount, context.tax_amount, context.part_price);
  const parts = Array.isArray(context.parts) ? context.parts : [];

  return (
    <details className="mt-3 border-t border-blue-200 pt-3 dark:border-blue-900">
      <summary className="cursor-pointer text-xs font-medium text-blue-800 dark:text-blue-300">
        {bridge.origin === "app"
          ? "Review the VRS AI request built from these details"
          : "Review SASHA / Tech Hub details"}
      </summary>
      <div className="mt-3 space-y-3 text-xs">
        <div className="grid gap-2 sm:grid-cols-2">
          <ReviewField label="Contract version" dataField="contract-version">
            {bridge.contractVersion}
          </ReviewField>
          <ReviewField label="Service order" dataField="service-order" mono>
            {context.service_order}
          </ReviewField>
          <ReviewField label="Reason for call" dataField="reason-for-call">
            {context.reason_for_call}
          </ReviewField>
          {context.partner_id !== undefined && (
            <ReviewField label="Partner" dataField="partner">
              {context.partner_id}
            </ReviewField>
          )}
          {bridge.contractVersion !== "v5" && (
            <>
              <ReviewField label="Contract number" dataField="contract-number" mono>
                {context.contract_number}
              </ReviewField>
              <ReviewField label="Symptom" dataField="symptom">
                {context.symptom}
              </ReviewField>
              <ReviewField label="Purchase year" dataField="purchase-year">
                {context.purchase_year}
              </ReviewField>
              <ReviewField label="Color" dataField="appliance-color">
                {context.appliance_color}
              </ReviewField>
              {bridge.contractVersion === "v9" && (
                <>
                  <ReviewField label="CTA number" dataField="cta-number" mono>
                    {context.cta_no}
                  </ReviewField>
                  <ReviewField
                    label="Order district"
                    dataField="district-number"
                    mono
                  >
                    {context.district_number}
                  </ReviewField>
                </>
              )}
            </>
          )}
          <ReviewField label="Technician ID" dataField="tech-id" mono>
            {context.tech_id}
          </ReviewField>
          <ReviewField label="Technician name" dataField="tech-name">
            {context.tech_name}
          </ReviewField>
          <ReviewField label="Technician phone" dataField="tech-phone">
            {context.tech_phone}
          </ReviewField>
          <ReviewField label="Customer name" dataField="customer-name">
            {context.customer_name}
          </ReviewField>
          <ReviewField label="Customer address" dataField="customer-address">
            {context.customer_address}
          </ReviewField>
          <ReviewField label="Service address" dataField="service-address">
            {context.service_address}
          </ReviewField>
          <ReviewField label="Appliance location" dataField="appliance-location">
            {context.appliance_location}
          </ReviewField>
          <ReviewField label="Failure cause" dataField="failure-cause">
            {context.failure_cause}
          </ReviewField>
          <ReviewField label="Recommendation" dataField="recommendation">
            {context.tech_recommendation}
          </ReviewField>
          <ReviewField label="Brand" dataField="brand">
            {context.brand}
          </ReviewField>
          <ReviewField label="Appliance type" dataField="appliance-type">
            {context.appliance_type}
          </ReviewField>
          <ReviewField label="Model" dataField="model" mono>
            {context.model_number}
          </ReviewField>
          <ReviewField label="Serial" dataField="serial" mono>
            {context.serial_number}
          </ReviewField>
          <ReviewField label="Appliance age" dataField="appliance-age">
            {context.appliance_age}
          </ReviewField>
          {context.appliance_grade !== undefined && (
            <ReviewField label="Appliance grade" dataField="appliance-grade">
              {context.appliance_grade}
            </ReviewField>
          )}
          <ReviewField label="Labor" dataField="labor">
            {reviewMoney(context.labor_amount)}
          </ReviewField>
          <ReviewField label="Tax" dataField="tax">
            {reviewMoney(context.tax_amount)}
          </ReviewField>
          <ReviewField label="Parts total" dataField="parts-total">
            {reviewMoney(context.part_price)}
          </ReviewField>
          <ReviewField label="Total" dataField="total">
            {reviewMoney(total)}
          </ReviewField>
        </div>

        <ReviewField
          label="Repair / replace rationale"
          dataField="repair-replace-rationale"
        >
          {context.repair_replace_rationale}
        </ReviewField>

        <div>
          <span className="text-muted-foreground">Parts</span>
          <div className="mt-1 space-y-2">
            {parts.length === 0 && (
              <p className="italic text-muted-foreground" data-field="parts">
                {REVIEW_NOT_PROVIDED}
              </p>
            )}
            {parts.map((part, index) => (
              <div
                key={`${part.part_id}-${index}`}
                className="grid gap-1 rounded border p-2 sm:grid-cols-2"
              >
                <ReviewField label="Part ID" dataField={`part-${index}-id`} mono>
                  {part.part_id}
                </ReviewField>
                <ReviewField
                  label="Part description"
                  dataField={`part-${index}-description`}
                >
                  {part.part_description}
                </ReviewField>
                <ReviewField label="Part price" dataField={`part-${index}-price`}>
                  {reviewMoney(part.sell_price)}
                </ReviewField>
                <ReviewField
                  label="Part function"
                  dataField={`part-${index}-function`}
                >
                  {part.part_function}
                </ReviewField>
              </div>
            ))}
          </div>
        </div>

        {context.comments?.length ? (
          <div>
            <span className="text-muted-foreground">Technician comments</span>
            <div className="mt-1 space-y-2">
              {context.comments.map((comment, index) => (
                <div
                  key={`${comment.timestamp}-${index}`}
                  className="grid gap-1 rounded border p-2 sm:grid-cols-2"
                >
                  <ReviewField
                    label="Comment technician ID"
                    dataField={`comment-${index}-tech-id`}
                    mono
                  >
                    {comment.tech_id}
                  </ReviewField>
                  <ReviewField
                    label="Work item"
                    dataField={`comment-${index}-work-item`}
                  >
                    {comment.work_item}
                  </ReviewField>
                  <ReviewField label="Text" dataField={`comment-${index}-text`}>
                    {comment.text}
                  </ReviewField>
                  <ReviewField
                    label="Timestamp"
                    dataField={`comment-${index}-timestamp`}
                  >
                    {comment.timestamp}
                  </ReviewField>
                </div>
              ))}
            </div>
          </div>
        ) : null}

        {context.appliance_photos?.length && !bridgePhotoProxyEnabled ? (
          <VrsAiBridgePhotos
            photos={context.appliance_photos}
            proxyEnabled={bridgePhotoProxyEnabled}
          />
        ) : null}
      </div>
    </details>
  );
}

export function VrsAiBridgePanel({
  bridge,
  submission,
  onOpenPhoto,
  allowAhsEdit = false,
}: {
  bridge: VrsAiBridgeStatus | null | undefined;
  // Optional so read-only callers (Pilot closed review) keep the bridge-only
  // view. When given, the ticket's AHS details are shown too, including when
  // the ticket has no bridge row yet (details not completed, enrollment
  // skipped or failed).
  submission?: VrsAiBridgePanelSubmission | null;
  onOpenPhoto?: (photos: string[], index: number) => void;
  // The Stage 1 card: show the AHS details editor while the ticket is still
  // editable (isAhsDetailsEditable) and vrsAiAppEnrollEnabled is on.
  allowAhsEdit?: boolean;
}) {
  const { vrsAiAppEnrollEnabled } = useFeatureFlags();
  const editable =
    allowAhsEdit &&
    vrsAiAppEnrollEnabled &&
    typeof submission?.id === "number" &&
    isAhsDetailsEditable(submission, bridge);
  const ahsDetails = parseAhsDetailsForReview(submission?.ahsDetails);
  const techDetails = techApplianceDetailsForTicket(submission);
  let ahsSection: ReactNode = null;
  if (editable && submission) {
    // Open the editor only once the detail fetch has the stored draft, so
    // it never starts from the slim queue row's missing value.
    ahsSection =
      submission.ahsDetails === undefined ? (
        <p className="mt-3 text-xs text-muted-foreground" data-testid="ahs-details-editor-loading">
          Loading AHS details…
        </p>
      ) : (
        <AhsDetailsEditor
          key={submission.id}
          submissionId={submission.id!}
          storedDetails={submission.ahsDetails}
          issueDescription={submission.issueDescription}
          media={ahsReviewMedia(submission)}
          onOpenPhoto={onOpenPhoto}
          hasBridge={!!bridge}
          techDetails={techDetails}
        />
      );
  } else if (ahsDetails && submission) {
    ahsSection = (
      <AhsTicketReview
        details={ahsDetails}
        media={ahsReviewMedia(submission)}
        onOpenPhoto={onOpenPhoto}
        techDetails={techDetails}
      />
    );
  }

  if (!bridge) {
    if (!ahsSection) return null;
    return (
      <div
        className="rounded-lg border border-blue-200 bg-blue-50/60 p-3 text-sm dark:border-blue-900 dark:bg-blue-950/20"
        data-testid="ahs-details-no-bridge"
      >
        <div className="flex items-center justify-between gap-3">
          <span className="font-medium">AHS ticket</span>
          <span className="whitespace-nowrap rounded-md bg-secondary px-2.5 py-0.5 text-xs font-semibold text-secondary-foreground">
            not sent to VRS AI
          </span>
        </div>
        <p className="mt-1 text-xs text-muted-foreground" data-testid="vrs-ai-bridge-source">
          Source: {VRS_SOURCE_APP_LABEL}
        </p>
        <p className="mt-2 text-xs text-muted-foreground" data-testid="text-ahs-not-enrolled">
          {editable ? AHS_NOT_ENROLLED_EDITABLE_TEXT : AHS_NOT_ENROLLED_TEXT}
        </p>
        {ahsSection}
      </div>
    );
  }

  return (
    <div
      className="rounded-lg border border-blue-200 bg-blue-50/60 p-3 text-sm dark:border-blue-900 dark:bg-blue-950/20"
      data-testid="vrs-ai-bridge-status"
    >
      <div className="flex items-center justify-between gap-3">
        <span className="font-medium">VRS AI bridge</span>
        <span className="whitespace-nowrap rounded-md bg-secondary px-2.5 py-0.5 text-xs font-semibold text-secondary-foreground">
          {bridge.state.replace(/_/g, " ")}
        </span>
      </div>
      <p className="mt-1 text-xs text-muted-foreground" data-testid="vrs-ai-bridge-source">
        Source: {bridge.origin === "app" ? VRS_SOURCE_APP_LABEL : VRS_SOURCE_SASHA_LABEL}
      </p>
      {bridge.dispatchError && (
        <p className="mt-2 text-xs text-destructive">
          Last send failed: {bridge.dispatchError}
        </p>
      )}
      {bridge.state === "failed" && (
        <p className="mt-2 text-xs text-destructive">
          VRS AI could not complete the call
          {bridge.failureReason ? ` (${bridge.failureReason})` : ""}. Use the
          existing manual authorization flow.
          {bridge.retryable
            ? " VRS AI marked this failure as retryable."
            : ""}
        </p>
      )}
      {ahsSection}
      <VrsAiBridgeReview bridge={bridge} />
    </div>
  );
}
