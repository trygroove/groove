/**
 * The commands of `bun run assistant:try` (GRV-108): parsing them, running
 * each against its session, and printing what it did. The script
 * (`scripts/assistant-try.ts`) hands in {@link TryIo}, the session files and
 * the provider; nothing here reads `process` or the disk, so every command is
 * tested with a scripted provider and an in-memory store.
 *
 * Every command is one call: it loads the session (the one named by
 * `--session`, or the one used last), runs one transition from
 * `trySession.ts`, and saves the session again. With no command the script
 * opens a prompt that takes the same commands, one per line.
 *
 * `ask` and `answer` call the live model, so they need `ANTHROPIC_API_KEY`;
 * without it they say so and call nothing, as `eval:assistant` does.
 */
import { ASSISTANT_MODEL_ID, ASSISTANT_MODELS, type AssistantModelId } from "../config";
import type { AssistantProvider } from "../provider";
import type { EvalExpectation } from "./caseChecks";
import { EvalUsageError, requireApiKey } from "./cli";
import type { ProjectOverview } from "./describe";
import {
  answer,
  apply,
  ask,
  cancel,
  newSession,
  type SessionSummary,
  saveCase,
  setScope,
  setSelection,
  show,
  type Transition,
  type TryResult,
  type TrySession,
  undo,
} from "./trySession";

/** What the commands need from outside: the session store and the provider. */
export interface TryIo {
  readonly env: Readonly<Record<string, string | undefined>>;
  /** The session saved under `id`, or null when there is none. */
  loadSession(id: string): TrySession | null;
  saveSession(session: TrySession): void;
  /** The session used last, if any. */
  currentSessionId(): string | null;
  setCurrentSession(id: string): void;
  /** A fresh session ID for a session on `fixture`. */
  newSessionId(fixture: string): string;
  writeFile(path: string, content: string): void;
  exists(path: string): boolean;
  /** Only called once the key is known to be there. */
  createProvider(apiKey: string): AssistantProvider;
  readonly casesDir: string;
  readonly fixturesDir: string;
  existingCaseIds(): readonly string[];
  readonly now?: () => number;
}

export const TRY_COMMANDS = [
  "new",
  "ask",
  "answer",
  "apply",
  "cancel",
  "undo",
  "scope",
  "select",
  "show",
  "save-case",
  "help",
] as const;
export type TryCommand = (typeof TRY_COMMANDS)[number];

export const TRY_USAGE = `Usage: bun run assistant:try -- <command> [--session ID] [--model ID] [--json]

  new <fixture> [--session ID]   start a session on an eval fixture
  ask "<message>"                one live turn (needs ANTHROPIC_API_KEY)
  answer <option>                answer the waiting question: option numbers (1,3), a label, or words
  apply | cancel | undo          what the proposal card's buttons do
  scope whole | <track> ...      what check 3 lets a proposal change
        [--create-tracks] [--song] [--master] [--returns]
  select none | tracks <name> ... | clips <name> ...
  show                           tracks, clips, levels, pans and devices
  save-case <case-id> --capability <c> [--expect proposal|ask|either] [--axis conventional|extreme]
                                 the last request, as an eval case

With no command it opens a prompt that takes the same commands.`;

export interface ParsedTryArgs {
  readonly command: TryCommand;
  readonly args: readonly string[];
  readonly session: string | null;
  readonly model: AssistantModelId | null;
  readonly json: boolean;
  readonly timeoutSeconds: number | null;
  readonly capability: string | null;
  readonly expect: EvalExpectation | null;
  readonly axis: "conventional" | "extreme" | null;
  readonly scopeFlags: {
    readonly createTracks: boolean;
    readonly song: boolean;
    readonly master: boolean;
    readonly returns: boolean;
  };
}

const EXPECTATIONS: readonly EvalExpectation[] = ["proposal", "ask", "either"];

export function parseTryArgs(argv: readonly string[]): ParsedTryArgs {
  const positional: string[] = [];
  let session: string | null = null;
  let model: string | null = null;
  let json = false;
  let timeoutSeconds: number | null = null;
  let capability: string | null = null;
  let expect: string | null = null;
  let axis: string | null = null;
  const scopeFlags = { createTracks: false, song: false, master: false, returns: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const value = (): string => {
      const next = argv[index + 1];
      if (next === undefined) throw new EvalUsageError(`${arg} needs a value`);
      index += 1;
      return next;
    };
    if (arg === "--session") session = value();
    else if (arg === "--model") model = value();
    else if (arg === "--json") json = true;
    else if (arg === "--timeout") timeoutSeconds = Number(value());
    else if (arg === "--capability") capability = value();
    else if (arg === "--expect") expect = value();
    else if (arg === "--axis") axis = value();
    else if (arg === "--create-tracks") scopeFlags.createTracks = true;
    else if (arg === "--song") scopeFlags.song = true;
    else if (arg === "--master") scopeFlags.master = true;
    else if (arg === "--returns") scopeFlags.returns = true;
    else if (arg === "--help" || arg === "-h") positional.unshift("help");
    else if (arg.startsWith("--")) throw new EvalUsageError(`Unknown option ${arg}`);
    else positional.push(arg);
  }
  const [command = "help", ...args] = positional;
  if (!(TRY_COMMANDS as readonly string[]).includes(command)) {
    throw new EvalUsageError(`Unknown command "${command}"\n\n${TRY_USAGE}`);
  }
  if (model !== null && !(model in ASSISTANT_MODELS)) {
    throw new EvalUsageError(
      `Unknown model "${model}". Configured: ${Object.keys(ASSISTANT_MODELS).join(", ")}`,
    );
  }
  if (
    timeoutSeconds !== null &&
    !(Number.isInteger(timeoutSeconds) && timeoutSeconds >= 1)
  ) {
    throw new EvalUsageError("--timeout must be a whole number of at least 1");
  }
  if (expect !== null && !(EXPECTATIONS as readonly string[]).includes(expect)) {
    throw new EvalUsageError("--expect is proposal, ask or either");
  }
  if (axis !== null && axis !== "conventional" && axis !== "extreme") {
    throw new EvalUsageError("--axis is conventional or extreme");
  }
  if (session !== null && !/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(session)) {
    throw new EvalUsageError("A session ID is letters, digits, - and _");
  }
  return {
    command: command as TryCommand,
    args,
    session,
    model: model as AssistantModelId | null,
    json,
    timeoutSeconds,
    capability,
    expect: expect as EvalExpectation | null,
    axis: axis as ParsedTryArgs["axis"],
    scopeFlags,
  };
}

/**
 * Splits one line typed at the prompt into arguments, as a shell would for
 * plain words and quoted strings: `ask "make it 'wider'"` is two arguments.
 */
export function splitCommandLine(line: string): string[] {
  const args: string[] = [];
  let current = "";
  let quote: '"' | "'" | null = null;
  let started = false;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (quote) {
      if (char === quote) quote = null;
      else if (char === "\\" && quote === '"' && index + 1 < line.length) {
        index += 1;
        current += line[index];
      } else current += char;
    } else if (char === '"' || char === "'") {
      quote = char;
      started = true;
    } else if (/\s/.test(char)) {
      if (started) args.push(current);
      current = "";
      started = false;
    } else {
      current += char;
      started = true;
    }
  }
  if (quote) throw new EvalUsageError("A quote is not closed");
  if (started) args.push(current);
  return args;
}

/** What one command printed, and the exit status it ends with. */
export interface TryOutcome {
  readonly exitCode: 0 | 1;
  readonly output: string;
  readonly result: TryResult | null;
}

function needsSession(io: TryIo, parsed: ParsedTryArgs): TrySession {
  const id = parsed.session ?? io.currentSessionId();
  if (!id) {
    throw new EvalUsageError("No session yet: start one with new <fixture>");
  }
  const session = io.loadSession(id);
  if (!session) throw new EvalUsageError(`No session "${id}"`);
  return parsed.model ? { ...session, model: parsed.model } : session;
}

async function transition(parsed: ParsedTryArgs, io: TryIo): Promise<Transition> {
  const { command, args } = parsed;
  if (command === "new") {
    const [fixture] = args;
    if (!fixture || args.length > 1)
      throw new EvalUsageError("new takes one fixture name");
    return newSession({
      id: parsed.session ?? io.newSessionId(fixture),
      fixture,
      model: parsed.model ?? ASSISTANT_MODEL_ID,
      fixturesDir: io.fixturesDir,
    });
  }
  if (command === "ask" || command === "answer") {
    // Before anything else, so a missing key costs nothing and changes nothing.
    const apiKey = requireApiKey(io.env, {
      name: "The assistant try-it CLI's turns",
      example: `bun run assistant:try -- ${command} ...`,
    });
    const session = needsSession(io, parsed);
    const said = args.join(" ");
    const deps = {
      provider: io.createProvider(apiKey),
      now: io.now,
      turnTimeoutMs:
        parsed.timeoutSeconds === null ? undefined : parsed.timeoutSeconds * 1000,
    };
    return command === "ask"
      ? ask(session, { text: said }, deps)
      : answer(session, said, deps);
  }
  const session = needsSession(io, parsed);
  switch (command) {
    case "apply":
      return apply(session);
    case "cancel":
      return cancel(session);
    case "undo":
      return undo(session);
    case "scope":
      return setScope(session, args, parsed.scopeFlags);
    case "select":
      return setSelection(session, args);
    case "show":
      return show(session);
    case "save-case": {
      const [caseId] = args;
      if (!caseId || args.length > 1)
        throw new EvalUsageError("save-case takes one case ID");
      if (!parsed.capability)
        throw new EvalUsageError("save-case needs --capability <c>");
      return saveCase(session, {
        caseId,
        capability: parsed.capability,
        expect: parsed.expect ?? undefined,
        axis: parsed.axis ?? undefined,
        existingCaseIds: io.existingCaseIds(),
        casesDir: io.casesDir,
        fixturesDir: io.fixturesDir,
        exists: (path) => io.exists(path),
      });
    }
    default:
      throw new EvalUsageError(TRY_USAGE);
  }
}

/** Runs one command: loads its session, runs it, saves the session, prints. */
export async function runTryCommand(
  argv: readonly string[],
  io: TryIo,
): Promise<TryOutcome> {
  let json = argv.includes("--json");
  try {
    const parsed = parseTryArgs(argv);
    json = parsed.json;
    if (parsed.command === "help")
      return { exitCode: 0, output: TRY_USAGE, result: null };
    const { session, result } = await transition(parsed, io);
    for (const file of result.kind === "save-case" ? result.files : []) {
      io.writeFile(file.path, file.content);
    }
    io.saveSession(session);
    io.setCurrentSession(session.id);
    return {
      exitCode: result.kind === "ask" && result.error ? 1 : 0,
      output: json ? JSON.stringify(result, null, 2) : formatResult(result),
      result,
    };
  } catch (error) {
    if (!(error instanceof EvalUsageError)) throw error;
    return {
      exitCode: 1,
      output: json ? JSON.stringify({ error: error.message }, null, 2) : error.message,
      result: null,
    };
  }
}

// ---------------------------------------------------------------------------
// Printing
// ---------------------------------------------------------------------------

function scopeLine(summary: SessionSummary): string {
  const { scope, selection } = summary;
  const tracks = scope.tracks === "all" ? "every track" : scope.tracks.join(", ");
  const also = (["createTracks", "song", "master", "returns"] as const)
    .filter((key) => scope[key])
    .map((key) => (key === "createTracks" ? "new tracks" : key));
  const selected =
    selection === null
      ? "nothing"
      : "tracks" in selection
        ? `tracks ${selection.tracks.join(", ")}`
        : `clips ${selection.clips.join(", ")}`;
  return `Scope: ${tracks}${also.length > 0 ? ` (+ ${also.join(", ")})` : ""}. Selected: ${selected}.`;
}

function projectLines(project: ProjectOverview): string[] {
  const lines = [
    `${project.name}: ${project.tempo} BPM, swing ${project.swing}, revision ${project.revision}`,
  ];
  for (const track of project.tracks) {
    const flags = [track.muted ? "muted" : "", track.soloed ? "soloed" : ""].filter(
      Boolean,
    );
    lines.push(
      `  ${track.name} (${track.instrument ?? track.type}) ${track.volume} dB, pan ${track.pan}${flags.length > 0 ? `, ${flags.join(", ")}` : ""}`,
    );
    for (const device of track.devices) lines.push(`    device: ${device}`);
    for (const clip of track.clips) {
      lines.push(
        `    clip "${clip.name}": ${clip.bars} bars, ${clip.notes === null ? "audio" : `${clip.notes} notes`}, placed ${clip.placements}x`,
      );
    }
  }
  for (const bus of project.returns) {
    lines.push(
      `  return ${bus.name}${bus.devices.length > 0 ? `: ${bus.devices.join("; ")}` : ""}`,
    );
  }
  lines.push(
    `  master ${project.master.volume} dB${project.master.devices.length > 0 ? `: ${project.master.devices.join("; ")}` : ""}`,
  );
  return lines;
}

function rowLines(
  rows: readonly {
    label: string;
    from: string | null;
    to: string | null;
    change: string;
  }[],
) {
  return rows.map((row) =>
    row.change === "added"
      ? `  + ${row.label}${row.to ? `: ${row.to}` : ""}`
      : row.change === "removed"
        ? `  - ${row.label}${row.from ? ` (was ${row.from})` : ""}`
        : `  ~ ${row.label}: ${row.from ?? "?"} -> ${row.to ?? "?"}`,
  );
}

function questionLines(
  question: NonNullable<Extract<TryResult, { kind: "ask" }>["question"]>,
) {
  return [
    `Question: ${question.question}${question.multiSelect ? " (pick any)" : ""}`,
    ...question.options.map(
      (option, index) =>
        `  ${index + 1}. ${option.label}${option.description ? `: ${option.description}` : ""}${question.suggested === index ? " (suggested)" : ""}`,
    ),
    'Answer with: answer <number>, or answer "<your words>"',
  ];
}

/** What the turn cost: the provider's token counts, the estimated price, the time. */
function tokenLine(result: Extract<TryResult, { kind: "ask" }>): string {
  const usage = result.usage;
  const seconds = `${(result.durationMs / 1000).toFixed(1)} s`;
  if (!usage) return `Tokens: not reported; ${seconds}`;
  return `Tokens: ${usage.inputTokens} in (${usage.cacheReadInputTokens} cache read, ${usage.cacheCreationInputTokens} cache write), ${usage.outputTokens} out; about $${(result.costUsd ?? 0).toFixed(4)}; ${seconds}`;
}

const STATUS_MARK = { pass: "pass", fail: "FAIL", skip: "skip" } as const;

/** The result as the console shows it. */
export function formatResult(result: TryResult): string {
  switch (result.kind) {
    case "new":
      return [
        `Session ${result.session.id} on ${result.session.fixture}, model ${result.session.model}.`,
        scopeLine(result.session),
        ...projectLines(result.project),
      ].join("\n");
    case "ask": {
      if (result.error) {
        return [
          `The turn errored: ${result.error}`,
          "The song is unchanged.",
          "",
          tokenLine(result),
        ].join("\n");
      }
      const lines = [result.reply.trim() || "(no text)"];
      if (result.proposal) {
        lines.push(
          "",
          `Proposal: ${result.proposal.summary}`,
          ...rowLines(result.proposal.rows),
        );
        lines.push("apply, or cancel?");
      }
      if (result.rejected) {
        lines.push(
          "",
          "The proposal was refused:",
          ...result.rejected.map((issue) => `  ${issue.code}: ${issue.message}`),
        );
      }
      if (result.recommendations > 0) {
        lines.push(`(${result.recommendations} sound recommendations, not shown here)`);
      }
      if (result.question) lines.push("", ...questionLines(result.question));
      if (result.checks) {
        lines.push(
          "",
          "Checks:",
          ...result.checks.map(
            (check) => `  ${STATUS_MARK[check.status]}  ${check.label}: ${check.detail}`,
          ),
        );
      } else if (result.noProposal) {
        lines.push("", `No proposal: ${result.noProposal}`);
      }
      lines.push("", tokenLine(result));
      return lines.join("\n");
    }
    case "apply":
    case "cancel":
    case "undo":
      return [
        result.message,
        ...result.issues.map((issue) => `  ${issue}`),
        ...(result.ok ? [`Revision ${result.revision}.`] : []),
      ].join("\n");
    case "scope":
    case "select":
      return scopeLine(result.session);
    case "show": {
      const lines = [
        `Session ${result.session.id} on ${result.session.fixture}, model ${result.session.model}; ${result.turns} turns, ${result.undoable} applied proposals to undo.`,
        scopeLine(result.session),
        ...projectLines(result.project),
      ];
      if (result.pending) {
        lines.push(
          "",
          `Waiting: ${result.pending.summary}`,
          ...rowLines(result.pending.rows),
        );
      }
      if (result.question) lines.push("", ...questionLines(result.question));
      return lines.join("\n");
    }
    case "save-case":
      return [
        `Saved the case "${result.caseId}" on the fixture "${result.fixture}":`,
        ...result.files.map((file) => `  ${file.path}`),
        "Add its expected scope and any case checks by hand, then run it with",
        `  bun run eval:assistant -- ${result.caseId}`,
      ].join("\n");
  }
}
