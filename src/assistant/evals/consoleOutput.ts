/**
 * What `bun run assistant:eval` prints while it runs and when it ends: one
 * line per run naming the calls it proposed, an indented line per check that
 * failed with that check's own reason, and a digest that groups every failure
 * by check and by reason, so a cause shared by many runs reads as one line.
 *
 * The Markdown report keeps the full detail; this is what a person reads in
 * the terminal to see where the failures are without opening it.
 */
import { CHECK_IDS, CHECK_LABELS, type CheckId } from "./checks";
import type { EvalRecord, EvalReport } from "./run";

/** The longest reason printed on one line before it is cut. */
const MAX_DETAIL = 220;
/** How many distinct reasons the digest lists per check. */
const MAX_REASONS = 6;
/** How many case names a digest line lists before it says "and N more". */
const MAX_CASES = 4;

/** Calls that take notes away. */
const CLEARING_TOOLS: ReadonlySet<string> = new Set(["notes_clear", "note_remove"]);
/** Calls that write notes. */
const WRITING_TOOLS: ReadonlySet<string> = new Set([
  "note_add",
  "clip_create",
  "track_create",
]);

function shorten(text: string, max = MAX_DETAIL): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 3)}...` : flat;
}

/** "notes_clear, note_add x3, explain_change": each tool once, in first-call order. */
export function callsSummary(record: EvalRecord): string {
  const calls = record.proposal?.calls ?? [];
  if (calls.length === 0) return "no calls";
  const counts = new Map<string, number>();
  for (const call of calls) counts.set(call.name, (counts.get(call.name) ?? 0) + 1);
  return [...counts]
    .map(([name, count]) => (count > 1 ? `${name} x${count}` : name))
    .join(", ");
}

/**
 * Whether the run clears notes and writes none back. Such a proposal applies
 * cleanly and passes check 1, but it is the model stopping after its first
 * step (no tool result ever comes back to it), so it is called out on its own.
 */
export function clearsWithoutWriting(record: EvalRecord): boolean {
  const names = (record.proposal?.calls ?? []).map((call) => call.name);
  return (
    names.some((name) => CLEARING_TOOLS.has(name)) &&
    !names.some((name) => WRITING_TOOLS.has(name))
  );
}

/**
 * Check 1's reason with the tool named: "(call 3)" alone says nothing in a
 * terminal, so it becomes "(call 3, track_create)".
 */
function withToolNames(record: EvalRecord, detail: string): string {
  const calls = record.proposal?.calls ?? [];
  return detail.replace(/\(call (\d+)\)/g, (match, index: string) => {
    const name = calls[Number(index)]?.name;
    return name ? `(call ${index}, ${name})` : match;
  });
}

/**
 * The top-level shape of a call's input, one level of nesting deep:
 * `{track: {track, clips, placements}}`, or "a JSON string". Check 1's
 * reasons say what was missing; this says what the model sent instead.
 */
export function inputShape(input: unknown): string {
  if (typeof input === "string") return "a JSON string, not an object";
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    return Array.isArray(input) ? "an array" : String(input);
  }
  const keys = Object.entries(input).map(([key, value]) =>
    value !== null && typeof value === "object" && !Array.isArray(value)
      ? `${key}: {${Object.keys(value).join(", ")}}`
      : key,
  );
  return `{${keys.join(", ")}}`;
}

/** The calls check 1's reason names, as "track_create got {...}", one per distinct pair. */
function badCallShapes(record: EvalRecord): string[] {
  const calls = record.proposal?.calls ?? [];
  const detail = record.checks.valid?.detail ?? "";
  const shapes = [...detail.matchAll(/\(call (\d+)\)/g)].flatMap(([, index]) => {
    const call = calls[Number(index)];
    return call ? [`${call.name} got ${inputShape(call.input)}`] : [];
  });
  return [...new Set(shapes)];
}

function failedChecks(record: EvalRecord): CheckId[] {
  return CHECK_IDS.filter((id) => record.checks[id]?.status === "fail");
}

function checkDetail(record: EvalRecord, id: CheckId): string {
  const detail = record.checks[id]?.detail ?? "";
  return id === "valid" ? withToolNames(record, detail) : detail;
}

/** The lines one run prints as it finishes. */
export function recordLines(record: EvalRecord): string[] {
  const head = `${record.caseId} run ${record.run}`;
  if (record.error) return [`  ! ${head}: errored: ${shorten(record.error)}`];
  const failed = failedChecks(record);
  const mark = failed.length === 0 ? "ok" : "FAIL";
  const asked = record.ask ? "; asked a question" : "";
  const hollow = clearsWithoutWriting(record) ? "; clears notes, writes none" : "";
  const calls =
    record.steps && record.steps.calls > 1 ? `; ${record.steps.calls} calls` : "";
  const lines = [
    `  ${mark.padEnd(4)} ${head} [${callsSummary(record)}${asked}${hollow}${calls}]`,
  ];
  for (const refused of record.steps?.refused ?? []) {
    lines.push(
      `         ~ refused back to the model: ${shorten(`${refused.name}: ${refused.reason}`)}`,
    );
  }
  for (const id of failed) {
    lines.push(`         x ${CHECK_LABELS[id]}: ${shorten(checkDetail(record, id))}`);
    if (id !== "valid") continue;
    for (const shape of badCallShapes(record))
      lines.push(`             ${shorten(shape)}`);
  }
  return lines;
}

/**
 * A reason with what differs run to run taken out (fresh IDs, call indices,
 * quoted names), so runs that failed the same way group together.
 */
function reasonKey(detail: string): string {
  return shorten(
    detail
      .replace(/\b[a-z]{3}_[A-Za-z0-9_-]{21}\b/g, "<id>")
      .replace(/\(call \d+(, )?/g, "(call ")
      .replace(/"[^"]*"/g, '"…"'),
    160,
  );
}

function casesList(caseIds: readonly string[]): string {
  const counts = new Map<string, number>();
  for (const id of caseIds) counts.set(id, (counts.get(id) ?? 0) + 1);
  const named = [...counts].map(([id, n]) => (n > 1 ? `${id} x${n}` : id));
  const shown = named.slice(0, MAX_CASES).join(", ");
  return named.length > MAX_CASES
    ? `${shown} and ${named.length - MAX_CASES} more`
    : shown;
}

/**
 * Every failure, grouped by check and then by reason, most common first; then
 * the runs that applied but only removed something. Empty when nothing failed.
 */
export function failureDigestLines(report: EvalReport): string[] {
  const judged = report.records.filter((record) => !record.error);
  const lines: string[] = [];
  for (const id of CHECK_IDS) {
    const failing = judged.filter((record) => record.checks[id]?.status === "fail");
    if (failing.length === 0) continue;
    const groups = new Map<string, string[]>();
    for (const record of failing) {
      const shapes = id === "valid" ? badCallShapes(record) : [];
      const key =
        shapes.length > 0
          ? `${record.checks.valid?.kind}: ${reasonKey(shapes.join("; "))}`
          : reasonKey(checkDetail(record, id));
      groups.set(key, [...(groups.get(key) ?? []), record.caseId]);
    }
    lines.push(`\n${CHECK_LABELS[id]}: ${failing.length} failed`);
    const sorted = [...groups].sort((a, b) => b[1].length - a[1].length);
    for (const [reason, cases] of sorted.slice(0, MAX_REASONS)) {
      lines.push(`  ${String(cases.length).padStart(3)}x ${reason}`);
      lines.push(`        in ${casesList(cases)}`);
    }
    if (sorted.length > MAX_REASONS) {
      lines.push(
        `        and ${sorted.length - MAX_REASONS} other reasons (see report.md)`,
      );
    }
  }
  const hollow = judged.filter(
    (record) => record.checks.valid?.status === "pass" && clearsWithoutWriting(record),
  );
  if (hollow.length > 0) {
    lines.push(
      `\nApplied, but clears notes and writes none back (passes check 1): ${hollow.length}`,
      `        in ${casesList(hollow.map((record) => record.caseId))}`,
    );
  }
  const refused = judged.flatMap((record) =>
    (record.steps?.refused ?? []).map((call) => ({ caseId: record.caseId, ...call })),
  );
  if (refused.length > 0) {
    const groups = new Map<string, string[]>();
    for (const call of refused) {
      const key = reasonKey(`${call.name}: ${call.reason}`);
      groups.set(key, [...(groups.get(key) ?? []), call.caseId]);
    }
    lines.push(
      `\nRefused back to the model mid-turn (it could resend): ${refused.length}`,
    );
    for (const [reason, cases] of [...groups].sort((a, b) => b[1].length - a[1].length)) {
      lines.push(`  ${String(cases.length).padStart(3)}x ${reason}`);
      lines.push(`        in ${casesList(cases)}`);
    }
  }
  return lines.length === 0 ? [] : ["\nFailures by check and reason:", ...lines];
}
