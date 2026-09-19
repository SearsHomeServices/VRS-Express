export interface SnowflakeBackfillResult {
  total: number;
  needingBackfill: number;
  updated: number;
  notFound: number;
  unavailable: number;
  failedUpdates: number;
  retryable: boolean;
}

export function SnowflakeBackfillStatus({ result }: { result: SnowflakeBackfillResult }) {
  return (
    <>
      <div>
        <span className="text-muted-foreground">Unavailable:</span>{" "}
        <span className="font-medium" data-testid="text-backfill-unavailable">{result.unavailable}</span>
      </div>
      <div>
        <span className="text-muted-foreground">Failed Updates:</span>{" "}
        <span className="font-medium" data-testid="text-backfill-failed-updates">{result.failedUpdates}</span>
      </div>
      {result.retryable && (
        <p className="col-span-2 text-muted-foreground" role="status">
          Some tickets could not be updated. Run backfill again to retry; unavailable lookups left existing classifications unchanged.
        </p>
      )}
    </>
  );
}