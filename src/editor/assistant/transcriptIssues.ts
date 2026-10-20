/**
 * A refused proposal's issues as a kept transcript stores them (GRV-98), for
 * a whole proposal's card and for each part of a streamed one (GRV-144).
 */
import { issueCall, type ProposalIssue } from "../../assistant/proposal";
import type { AssistantProposal } from "../../assistant/protocol";
import { MAX_TRANSCRIPT_ISSUES, type TranscriptIssue } from "../../assistant/transcripts";

/**
 * The code, the call it blames by ID and tool name, and the validator's own
 * path and message, cut to what the transcript holds.
 */
export function transcriptIssues(
  proposal: AssistantProposal,
  issues: readonly ProposalIssue[],
): TranscriptIssue[] {
  return issues.slice(0, MAX_TRANSCRIPT_ISSUES).map((issue) => {
    const call = issueCall(proposal, issue);
    return {
      code: issue.code,
      callId: call?.id?.slice(0, 200) ?? null,
      callName: call?.name.slice(0, 200) ?? null,
      path: issue.path?.slice(0, 300) ?? null,
      message: issue.message.slice(0, 500) || null,
    };
  });
}
