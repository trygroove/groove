/**
 * Why an assistant proposal can be refused (GRV-4), on its own so the
 * transcript (`transcripts.ts`) and the analytics catalog can name the codes
 * without pulling in the validator and the command kernel behind it.
 */
/**
 * Every reason a proposal can be refused. The list is a contract: a kept
 * transcript stores these codes for a rejected proposal, and
 * `assistant_proposal_rejected` carries them, pinned by `catalog.test.ts`
 * (GRV-98).
 *
 * - `malformed`: the response is not a proposal at all.
 * - `stale_revision`: the project moved on since the request was built.
 * - `toolset_mismatch`: the calls were made against another tool set version.
 * - `out_of_range`: a value is outside its parameter's range.
 * - `rejected`: the kernel refused a command (a missing ID, a wrong kind of track, …).
 * - `invalid_project`: the commands together would break a domain invariant.
 */
export const PROPOSAL_ISSUE_CODES = [
  "malformed",
  "too_many_commands",
  "stale_revision",
  "unknown_tool",
  "invalid_payload",
  "unauthorized",
  "toolset_mismatch",
  "out_of_range",
  "rejected",
  "invalid_project",
] as const;
export type ProposalIssueCode = (typeof PROPOSAL_ISSUE_CODES)[number];
