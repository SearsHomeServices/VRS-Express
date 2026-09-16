import React, { type ReactNode } from "react";
import type { VrsAiBridgeStatus } from "@/lib/vrsAiBridge";
import { VrsAiBridgePhotos } from "@/components/vrs-ai-bridge-photos";
import { useVrsBridgePhotoProxyEnabled } from "@/hooks/use-feature-flags";

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
  return (
    <div>
      <span className="text-muted-foreground">{label}</span>
      <p
        data-field={dataField}
        className={mono ? "font-mono font-medium" : "font-medium"}
      >
        {children}
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

  const total = context.labor_amount + context.tax_amount + context.part_price;

  return (
    <details className="mt-3 border-t border-blue-200 pt-3 dark:border-blue-900">
      <summary className="cursor-pointer text-xs font-medium text-blue-800 dark:text-blue-300">
        Review SASHA / Tech Hub details
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
            ${context.labor_amount.toFixed(2)}
          </ReviewField>
          <ReviewField label="Tax" dataField="tax">
            ${context.tax_amount.toFixed(2)}
          </ReviewField>
          <ReviewField label="Parts total" dataField="parts-total">
            ${context.part_price.toFixed(2)}
          </ReviewField>
          <ReviewField label="Total" dataField="total">
            ${total.toFixed(2)}
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
            {context.parts.map((part, index) => (
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
                  ${part.sell_price.toFixed(2)}
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

        {context.appliance_photos?.length ? (
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
}: {
  bridge: VrsAiBridgeStatus | null | undefined;
}) {
  if (!bridge) return null;

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
      <VrsAiBridgeReview bridge={bridge} />
    </div>
  );
}

// The Pilot table deliberately keeps terminal rows read-only. Keep the
// bridge-only sender gallery available there in DEV proxy mode without
// mounting the workflow/status controls used for active reviews.
export function VrsAiPilotReadOnlySenderPhotos({
  bridge,
}: {
  bridge: VrsAiBridgeStatus | null | undefined;
}) {
  const bridgePhotoProxyEnabled = useVrsBridgePhotoProxyEnabled();
  const photos = bridge?.reviewContext?.appliance_photos;
  if (!bridgePhotoProxyEnabled || !photos?.length) return null;

  return (
    <div
      className="rounded-lg border border-blue-200 bg-blue-50/60 p-3 text-sm dark:border-blue-900 dark:bg-blue-950/20"
      data-testid="vrs-ai-pilot-read-only-sender-photos"
    >
      <VrsAiBridgePhotos photos={photos} proxyEnabled />
    </div>
  );
}
