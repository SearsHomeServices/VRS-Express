// Read-only Stage 1 view of a ticket's AHS details (submissions.ahs_details):
// shown once the details can no longer change (VRS AI request dispatched,
// Stage 1 decided, flag off) and on read-only screens. The editable version
// is ahs-details-editor.tsx. The stored JSON may be a partial draft; blank
// fields read "Not provided".
//
// Each field says where it came from: the server fills some from the service
// order (ahs_details.prefilledFields, see shared/ahs-prefill.ts: dispatch
// number and brand/model/serial from Snowflake, customer name and address
// from the HSSOM Order Lookup, possibly the parts), the rest was entered in
// VRS Express (by the VRS manager at Stage 1, or by the technician on older
// tickets). The model/serial and estimate screenshots and the videos sit
// next to the appliance fields so the reviewer can check them. Media goes
// through the existing MediaImage / MediaVideo components, so every
// /objects/ path still gets a scoped media token.
import React, { type ReactNode } from "react";
import { MediaImage, MediaVideo } from "@/components/media";
import {
  ahsApplianceKindLabel,
  ahsFailureCauseLabel,
  ahsGradeLabel,
  ahsRecommendationLabel,
  ahsReviewGrandTotal,
  ahsReviewPartLineTotal,
  ahsReviewPartsTotal,
  formatAhsMoney,
  type AhsReviewDetails,
  type AhsReviewProvenanceField,
} from "@/lib/ahsReview";

export const AHS_NOT_PROVIDED = "Not provided";
export const AHS_SOURCE_SERVICE_ORDER = "From service order";
export const AHS_SOURCE_TECH = "Entered in VRS Express";
export const AHS_CHECK_APPLIANCE = "Brand, model and serial against the model tag photo.";
export const AHS_CHECK_CUSTOMER =
  "Customer name and address against the service order. Confirm with the customer if unsure.";
export const AHS_CHECK_PARTS = "Parts and prices against the estimate screenshot.";

const AHS_APPLIANCE_PREFILL: readonly AhsReviewProvenanceField[] = ["brand", "modelNumber", "serialNumber"];
const AHS_CUSTOMER_PREFILL: readonly AhsReviewProvenanceField[] = ["customerName", "customerAddress"];

// What the reviewer should check before approving, for the fields the
// server filled on this ticket.
export function ahsPrefillChecks(prefilled: ReadonlySet<AhsReviewProvenanceField>): string[] {
  const checks: string[] = [];
  if (AHS_APPLIANCE_PREFILL.some((field) => prefilled.has(field))) checks.push(AHS_CHECK_APPLIANCE);
  if (AHS_CUSTOMER_PREFILL.some((field) => prefilled.has(field))) checks.push(AHS_CHECK_CUSTOMER);
  if (prefilled.has("parts")) checks.push(AHS_CHECK_PARTS);
  return checks;
}

export interface AhsReviewMedia {
  // Model, serial & estimate screenshots (photos.estimate).
  estimatePhotos: string[];
  // Optional { fullPath: thumbPath } map for faster grid paint.
  thumbnails?: Record<string, string>;
  // Up to MAX_VIDEOS_PER_TICKET (3) videos, 30 seconds each.
  videos: string[];
}

type FieldSource = "service_order" | "tech";

function SourceBadge({ source }: { source: FieldSource }) {
  return source === "service_order" ? (
    <span
      data-source="service_order"
      className="ml-1.5 inline-flex items-center whitespace-nowrap rounded border border-amber-300 bg-amber-50 px-1.5 py-px text-[10px] font-medium text-amber-800 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-300"
    >
      {AHS_SOURCE_SERVICE_ORDER}
    </span>
  ) : (
    <span
      data-source="tech"
      className="ml-1.5 inline-flex items-center whitespace-nowrap rounded border px-1.5 py-px text-[10px] font-medium text-muted-foreground"
    >
      {AHS_SOURCE_TECH}
    </span>
  );
}

function AhsField({
  label,
  dataField,
  value,
  source,
  mono = false,
}: {
  label: string;
  dataField: string;
  value: ReactNode | undefined;
  // Omitted for values VRS Express calculates (totals).
  source?: FieldSource;
  mono?: boolean;
}) {
  const blank = value === undefined || value === null || value === "";
  return (
    <div data-field-wrapper={dataField}>
      <span className="text-muted-foreground">
        {label}
        {source && <SourceBadge source={source} />}
      </span>
      <p
        data-field={dataField}
        className={
          blank
            ? "italic text-muted-foreground"
            : mono
              ? "font-mono font-medium"
              : "font-medium"
        }
      >
        {blank ? AHS_NOT_PROVIDED : value}
      </p>
    </div>
  );
}

// The tech's model/serial & estimate screenshots and videos. Also shown as
// evidence beside the Stage 1 editor.
export function AhsMedia({
  media,
  onOpenPhoto,
}: {
  media: AhsReviewMedia;
  onOpenPhoto?: (photos: string[], index: number) => void;
}) {
  const { estimatePhotos, videos } = media;
  const thumbs = media.thumbnails ?? {};
  return (
    <div className="space-y-2 rounded border bg-background/60 p-2" data-testid="ahs-review-media">
      <div>
        <span className="text-muted-foreground">
          Model, serial & estimate screenshots ({estimatePhotos.length})
        </span>
        {estimatePhotos.length > 0 ? (
          <div className="mt-1 grid grid-cols-3 gap-2" data-testid="ahs-review-estimate-photos">
            {estimatePhotos.map((url, index) => {
              const image = (
                <MediaImage
                  src={thumbs[url] ?? url}
                  alt={`AHS model, serial or estimate screenshot ${index + 1}`}
                  className="h-full w-full object-cover"
                />
              );
              return onOpenPhoto ? (
                <button
                  key={`${url}-${index}`}
                  type="button"
                  className="aspect-square overflow-hidden rounded-md bg-muted"
                  onClick={() => onOpenPhoto(estimatePhotos, index)}
                  data-testid={`ahs-review-estimate-photo-${index}`}
                >
                  {image}
                </button>
              ) : (
                <div
                  key={`${url}-${index}`}
                  className="aspect-square overflow-hidden rounded-md bg-muted"
                  data-testid={`ahs-review-estimate-photo-${index}`}
                >
                  {image}
                </div>
              );
            })}
          </div>
        ) : (
          <p className="italic text-muted-foreground" data-testid="ahs-review-no-estimate-photos">
            No screenshots attached
          </p>
        )}
      </div>
      <div>
        <span className="text-muted-foreground">Videos ({videos.length})</span>
        {videos.length > 0 ? (
          <div className="mt-1 grid gap-2 sm:grid-cols-2" data-testid="ahs-review-videos">
            {videos.map((url, index) => (
              <MediaVideo
                key={`${url}-${index}`}
                src={url}
                controls
                preload="metadata"
                className="max-h-[200px] w-full rounded-md bg-muted"
                data-testid={`ahs-review-video-${index}`}
              />
            ))}
          </div>
        ) : (
          <p className="italic text-muted-foreground" data-testid="ahs-review-no-videos">
            No video attached
          </p>
        )}
      </div>
    </div>
  );
}

export function AhsTicketReview({
  details,
  media,
  onOpenPhoto,
}: {
  details: AhsReviewDetails;
  media?: AhsReviewMedia;
  onOpenPhoto?: (photos: string[], index: number) => void;
}) {
  const prefilled = new Set<AhsReviewProvenanceField>(details.prefilledFields);
  const sourceOf = (field: AhsReviewProvenanceField | null): FieldSource =>
    field && prefilled.has(field) ? "service_order" : "tech";
  const partSource = sourceOf("parts");
  const checks = ahsPrefillChecks(prefilled);
  const age =
    details.applianceAge === undefined
      ? undefined
      : `${details.applianceAge} ${details.applianceAge === 1 ? "year" : "years"}`;

  return (
    <div className="mt-3 space-y-3 border-t border-blue-200 pt-3 text-xs dark:border-blue-900" data-testid="ahs-ticket-review">
      <p className="text-sm font-medium">AHS details</p>
      {prefilled.size > 0 && (
        <div
          className="rounded border border-amber-200 bg-amber-50 p-2 text-amber-900 dark:border-amber-900 dark:bg-amber-950/30 dark:text-amber-200"
          data-testid="ahs-prefill-hint"
        >
          <p>
            Fields marked “{AHS_SOURCE_SERVICE_ORDER}” were filled from the
            service order lookup, not typed in VRS Express.
            {checks.length > 0 && " Before approving, check:"}
          </p>
          {checks.length > 0 && (
            <ul className="mt-1 list-disc space-y-0.5 pl-4">
              {checks.map((check) => (
                <li key={check}>{check}</li>
              ))}
            </ul>
          )}
        </div>
      )}

      <div className="grid gap-2 sm:grid-cols-2">
        <AhsField
          label="Dispatch / contract number"
          dataField="ahs-contract-number"
          value={details.contractNumber}
          source={sourceOf("contractNumber")}
          mono
        />
        <AhsField
          label="Customer name"
          dataField="ahs-customer-name"
          value={details.customerName}
          source={sourceOf("customerName")}
        />
        <AhsField
          label="Customer address"
          dataField="ahs-customer-address"
          value={details.customerAddress}
          source={sourceOf("customerAddress")}
        />
        <AhsField
          label="Appliance type"
          dataField="ahs-appliance-type"
          value={ahsApplianceKindLabel(details.applianceKind)}
          source="tech"
        />
        <AhsField
          label="Brand"
          dataField="ahs-brand"
          value={details.brand}
          source={sourceOf("brand")}
        />
        <AhsField
          label="Model number"
          dataField="ahs-model"
          value={details.modelNumber}
          source={sourceOf("modelNumber")}
          mono
        />
        <AhsField
          label="Serial number"
          dataField="ahs-serial"
          value={details.serialNumber}
          source={sourceOf("serialNumber")}
          mono
        />
        <AhsField
          label="Appliance age"
          dataField="ahs-appliance-age"
          value={age}
          source="tech"
        />
      </div>

      {media && <AhsMedia media={media} onOpenPhoto={onOpenPhoto} />}

      <div className="grid gap-2 sm:grid-cols-2">
        <AhsField
          label="Appliance location"
          dataField="ahs-appliance-location"
          value={details.applianceLocation}
          source="tech"
        />
        <AhsField
          label="Appliance grade"
          dataField="ahs-appliance-grade"
          value={ahsGradeLabel(details.applianceGrade)}
          source="tech"
        />
        <AhsField
          label="Color"
          dataField="ahs-appliance-color"
          value={details.applianceColor}
          source="tech"
        />
        <AhsField
          label="Failure cause"
          dataField="ahs-failure-cause"
          value={ahsFailureCauseLabel(details.failureCause)}
          source="tech"
        />
        <AhsField
          label="Tech recommendation"
          dataField="ahs-tech-recommendation"
          value={ahsRecommendationLabel(details.techRecommendation)}
          source="tech"
        />
        <AhsField
          label="Labor"
          dataField="ahs-labor"
          value={formatAhsMoney(details.laborAmount)}
          source="tech"
        />
        <AhsField
          label="Tax"
          dataField="ahs-tax"
          value={formatAhsMoney(details.taxAmount)}
          source="tech"
        />
        <AhsField
          label="Parts total"
          dataField="ahs-parts-total"
          value={formatAhsMoney(ahsReviewPartsTotal(details))}
        />
        <AhsField
          label="Total"
          dataField="ahs-total"
          value={formatAhsMoney(ahsReviewGrandTotal(details))}
        />
      </div>

      <div>
        <span className="text-muted-foreground">Parts ({details.parts.length})</span>
        {details.parts.length === 0 ? (
          <p className="italic text-muted-foreground" data-field="ahs-parts">
            {AHS_NOT_PROVIDED}
          </p>
        ) : (
          <div className="mt-1 space-y-2">
            {details.parts.map((part, index) => (
              <div
                key={`${part.partNumber ?? "part"}-${index}`}
                className="grid gap-1 rounded border p-2 sm:grid-cols-2"
              >
                <AhsField
                  label="Part number"
                  dataField={`ahs-part-${index}-number`}
                  value={part.partNumber}
                  source={partSource}
                  mono
                />
                <AhsField
                  label="Quantity"
                  dataField={`ahs-part-${index}-quantity`}
                  value={part.quantity === undefined ? undefined : String(part.quantity)}
                  source={partSource}
                />
                <AhsField
                  label="Description"
                  dataField={`ahs-part-${index}-description`}
                  value={part.description}
                  source={partSource}
                />
                <AhsField
                  label="Unit price"
                  dataField={`ahs-part-${index}-price`}
                  value={formatAhsMoney(part.unitPrice)}
                  source={partSource}
                />
                <AhsField
                  label="Line total"
                  dataField={`ahs-part-${index}-line-total`}
                  value={formatAhsMoney(ahsReviewPartLineTotal(part))}
                />
                <AhsField
                  label="Part function"
                  dataField={`ahs-part-${index}-function`}
                  value={part.partFunction}
                  source={partSource}
                />
                <AhsField
                  label="Part failure reason"
                  dataField={`ahs-part-${index}-failure-reason`}
                  value={part.failureReason}
                  source={partSource}
                />
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
