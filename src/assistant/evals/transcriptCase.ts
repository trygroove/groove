/**
 * A kept assistant turn as an eval case file (GRV-98): a real failure becomes
 * a regression case for `bun run eval:assistant -- --from-transcript <file>`
 * (`evalCaseFromTranscript` in `cases.ts` turns the file into the case).
 *
 * The admin transcript viewer downloads a turn as an
 * {@link ExportedTranscriptCase}: the producer's message, the tool calls the
 * model made and why the proposal was rejected. A transcript never holds the
 * song it was about (ADR 0007), so the case runs the message against one of
 * the eval fixtures, the house loop unless the file names another; edit its
 * `fixture` to pick the closest. The recorded calls and issues are kept
 * beside it in the report for comparison; nothing replays them.
 *
 * The file holds the producer's own words. It is for an admin's machine and
 * the eval's `tmp/` output, never the repository: to keep a case for good,
 * write it into `cases.ts` in words of your own.
 */
import { z } from "zod";
import {
  PROPOSAL_OUTCOMES,
  type TranscriptRecord,
  transcriptIssueSchema,
} from "../transcripts";

/**
 * The fixtures a transcript case can run against, by name. `cases.ts` maps
 * each to its project; the names stay here so the admin page, which writes
 * the file, never loads the fixtures.
 */
export const TRANSCRIPT_CASE_FIXTURES = [
  "house-loop",
  "kit-sketch",
  "arrangement",
] as const;
export type TranscriptCaseFixture = (typeof TRANSCRIPT_CASE_FIXTURES)[number];

export const exportedTranscriptCaseSchema = z.strictObject({
  kind: z.literal("groove-assistant-transcript-case"),
  version: z.literal(1),
  turnId: z.string().min(1).max(64),
  model: z.string().max(100),
  promptVersion: z.string().max(100),
  /** The producer's message: the eval's request. */
  request: z.string().min(1).max(64_000),
  fixture: z.enum(TRANSCRIPT_CASE_FIXTURES),
  /** What the model proposed when the turn was kept, for comparison. */
  recorded: z.strictObject({
    toolsetVersion: z.int().min(0).nullable(),
    calls: z.array(
      z.strictObject({ id: z.string(), name: z.string(), input: z.unknown() }),
    ),
    outcomes: z.array(
      z.strictObject({
        outcome: z.enum(PROPOSAL_OUTCOMES),
        at: z.int().min(0),
        issues: z.array(transcriptIssueSchema).optional(),
      }),
    ),
  }),
});
export type ExportedTranscriptCase = z.infer<typeof exportedTranscriptCaseSchema>;

/** A kept turn as a file the eval reads. */
export function exportTranscriptCase(
  record: TranscriptRecord,
  fixture: TranscriptCaseFixture = "house-loop",
): ExportedTranscriptCase {
  return {
    kind: "groove-assistant-transcript-case",
    version: 1,
    turnId: record.turnId,
    model: record.model,
    promptVersion: record.promptVersion,
    request: record.userMessage,
    fixture,
    recorded: {
      toolsetVersion: record.proposal?.toolsetVersion ?? null,
      calls: record.proposal?.calls.map((call) => ({ ...call })) ?? [],
      outcomes: record.outcomes.map((outcome) => ({ ...outcome })),
    },
  };
}

/** The file name the viewer downloads a turn as. */
export function transcriptCaseFileName(turnId: string): string {
  return `transcript-${turnId}.json`;
}

/** Parses a downloaded file, or says what is wrong with it. */
export function parseTranscriptCase(
  raw: unknown,
): { ok: true; value: ExportedTranscriptCase } | { ok: false; message: string } {
  const parsed = exportedTranscriptCaseSchema.safeParse(raw);
  if (parsed.success) return { ok: true, value: parsed.data };
  return {
    ok: false,
    message: parsed.error.issues
      .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
      .join("; "),
  };
}
