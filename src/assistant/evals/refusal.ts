/**
 * A refused proposal, spelled out for `bun run assistant:try` (GRV-108):
 * which call each issue blames, and for a payload that does not parse, one
 * line per field saying what was wrong there and what the model sent.
 *
 * The gateway's {@link ProposalIssue} joins a payload's schema issues into
 * one message; this parses the blamed call's input against its command's
 * schema again to get them back field by field.
 */
import type { z } from "zod";
import { issueCall, type ProposalIssue } from "../proposal";
import type { AssistantProposal } from "../protocol";
import { EXPLAIN_TOOL_NAME, toolPayloadSchema } from "../tools";

/** One field of a payload that did not parse. */
export interface FieldIssue {
  /** Where in the tool's input: `track.id`, or `(input)` for the whole of it. */
  readonly path: string;
  readonly problem: string;
}

export interface RefusalDetail extends ProposalIssue {
  /** The call the issue blames, when it blames one. */
  readonly call: {
    /** 1-based, among the calls that change something. */
    readonly position: number;
    readonly of: number;
    readonly name: string;
    readonly id: string | null;
  } | null;
  /** An `invalid_payload` issue's fields; null for any other issue. */
  readonly fields: readonly FieldIssue[] | null;
  /** What the fields suggest went wrong, when something recognisable did. */
  readonly hints: readonly string[];
}

const MAX_SHOWN = 80;

function shown(value: unknown): string {
  const text = JSON.stringify(value) ?? String(value);
  return text.length > MAX_SHOWN ? `${text.slice(0, MAX_SHOWN - 1)}…` : text;
}

function valueAt(input: unknown, path: readonly PropertyKey[]): unknown {
  let value = input;
  for (const key of path) {
    if (value === null || typeof value !== "object") return undefined;
    value = (value as Record<PropertyKey, unknown>)[key];
  }
  return value;
}

function problemOf(issue: z.core.$ZodIssue, value: unknown): string {
  if (issue.code === "unrecognized_keys") {
    return `unexpected ${issue.keys.length === 1 ? "key" : "keys"} ${issue.keys.map((key) => `"${key}"`).join(", ")}`;
  }
  if (value === undefined) {
    if (issue.code === "invalid_type") return `missing, expected ${issue.expected}`;
    if (issue.code === "invalid_value") {
      return `missing, expected one of ${issue.values.map((option) => shown(option)).join(" | ")}`;
    }
    return `missing: ${issue.message}`;
  }
  return `${issue.message}; got ${shown(value)}`;
}

/** What the fields suggest went wrong, in words. */
function hintsFor(issues: readonly z.core.$ZodIssue[]): string[] {
  const hints: string[] = [];
  for (const issue of issues) {
    if (issue.code !== "unrecognized_keys" || issue.path.length === 0) continue;
    const at = issue.path.map(String).join(".");
    const last = String(issue.path[issue.path.length - 1]);
    if (issue.keys.includes(last)) {
      hints.push(
        `"${at}" holds another "${last}": the model nested the payload one level too deep. ${issue.keys.map((key) => `"${key}"`).join(", ")} belong where "${at}" is, not inside it.`,
      );
    }
  }
  return hints;
}

function fieldsOf(
  name: string,
  input: unknown,
): {
  fields: FieldIssue[];
  hints: string[];
} | null {
  const parsed = toolPayloadSchema(name)?.safeParse(input);
  if (!parsed || parsed.success) return null;
  const issues = parsed.error.issues;
  return {
    fields: issues.map((issue) => ({
      path: issue.path.map(String).join(".") || "(input)",
      problem: problemOf(issue, valueAt(input, issue.path)),
    })),
    hints: hintsFor(issues),
  };
}

/** Each issue of a refused `proposal`, with the call it blames and its fields. */
export function describeRefusal(
  proposal: AssistantProposal,
  issues: readonly ProposalIssue[],
): RefusalDetail[] {
  const changing = proposal.calls.filter((call) => call.name !== EXPLAIN_TOOL_NAME);
  return issues.map((issue) => {
    const blamed = issueCall(proposal, issue);
    const input =
      blamed && issue.callIndex !== null
        ? (
            changing.find((call) => blamed.id !== null && call.id === blamed.id) ??
            changing[issue.callIndex]
          )?.input
        : undefined;
    const detail =
      blamed && issue.code === "invalid_payload" ? fieldsOf(blamed.name, input) : null;
    return {
      ...issue,
      call:
        blamed && issue.callIndex !== null
          ? {
              position: issue.callIndex + 1,
              of: changing.length,
              name: blamed.name,
              id: blamed.id,
            }
          : null,
      fields: detail?.fields ?? null,
      hints: detail?.hints ?? [],
    };
  });
}
