import type { DirectResultReceipts } from "../../server/vrs-direct-result-store";
// Route-test dependency. Durable restart/concurrency behavior is tested on isolated PostgreSQL.
export const testReceipts = (boundSubmissionId: number | null = null): DirectResultReceipts => ({execute:async(_result,work)=>{
 const binding={submissionId:boundSubmissionId,bind:async(id:number)=>{binding.submissionId=id}};
 return work(binding);
}});
