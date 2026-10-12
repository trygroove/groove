/**
 * `bun run assistant:try`: talk to the live assistant on an eval fixture, and
 * save a moment that went wrong as an eval case (GRV-108).
 *
 *   bun run assistant:try -- new house-loop          start a session (prints its ID)
 *   bun run assistant:try -- ask "Make the hats busier"
 *   bun run assistant:try -- apply | cancel | undo
 *   bun run assistant:try -- answer 2               answer the question it asked
 *   bun run assistant:try -- scope Drums --create-tracks
 *   bun run assistant:try -- select clips "House beat"
 *   bun run assistant:try -- show
 *   bun run assistant:try -- save-case busier-hats --capability density
 *   bun run assistant:try                           a prompt taking the same commands
 *
 * Each command reads and writes one session file,
 * `tmp/assistant-sessions/<id>.json`; `--session <id>` picks one, otherwise
 * the one used last. `--json` prints what a command did as JSON, and
 * `--model` picks a configured model as `eval:assistant` does. `ask` and
 * `answer` go through the gateway's own turn with the production prompt and
 * tools, against the live model: they need `ANTHROPIC_API_KEY` and say so,
 * calling nothing, without it. Nothing here touches Firestore, user data or
 * the deployed quota. The commands live in `src/assistant/evals/tryCli.ts`
 * and `trySession.ts`; this file is only the disk and the prompt.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { createInterface } from "node:readline";
import { createAnthropicProvider } from "../functions/src/anthropicProvider";
import { EVAL_CASES, jsonCasesDir } from "../src/assistant/evals/cases";
import { EvalUsageError } from "../src/assistant/evals/cli";
import { jsonFixturesDir } from "../src/assistant/evals/namedFixtures";
import {
  runTryCommand,
  splitCommandLine,
  TRY_USAGE,
  type TryIo,
} from "../src/assistant/evals/tryCli";
import {
  sessionFromJson,
  sessionToJson,
  type TrySession,
} from "../src/assistant/evals/trySession";

const SESSIONS = join("tmp", "assistant-sessions");
const CURRENT = join(SESSIONS, "current");

const sessionPath = (id: string) => join(SESSIONS, `${id}.json`);

/** Case IDs saved during this process, which `EVAL_CASES` loaded before. */
const savedNow = new Set<string>();

const io: TryIo = {
  env: process.env,
  loadSession(id) {
    const path = sessionPath(id);
    if (!existsSync(path)) return null;
    return sessionFromJson(readFileSync(path, "utf8"));
  },
  saveSession(session: TrySession) {
    mkdirSync(SESSIONS, { recursive: true });
    writeFileSync(sessionPath(session.id), sessionToJson(session));
  },
  currentSessionId() {
    return existsSync(CURRENT) ? readFileSync(CURRENT, "utf8").trim() || null : null;
  },
  setCurrentSession(id) {
    mkdirSync(SESSIONS, { recursive: true });
    writeFileSync(CURRENT, `${id}\n`);
  },
  newSessionId(fixture) {
    const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\..*$/, "");
    return `${fixture}-${stamp.replace("T", "-")}`;
  },
  writeFile(path, content) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content);
    // The repository's formatter has the last word on a file meant to be committed.
    spawnSync("bunx", ["biome", "format", "--write", path], { stdio: "ignore" });
  },
  exists: existsSync,
  createProvider: (apiKey) => createAnthropicProvider({ apiKey }),
  casesDir: relative(process.cwd(), jsonCasesDir()),
  fixturesDir: relative(process.cwd(), jsonFixturesDir()),
  existingCaseIds: () => [...EVAL_CASES.map((entry) => entry.id), ...savedNow],
};

async function once(argv: readonly string[]): Promise<number> {
  const outcome = await runTryCommand(argv, io);
  if (outcome.result?.kind === "save-case") savedNow.add(outcome.result.caseId);
  (outcome.exitCode === 0 ? console.log : console.error)(outcome.output);
  return outcome.exitCode;
}

/** The prompt: one command per line, with the flags the script was started with. */
async function prompt(flags: readonly string[]): Promise<number> {
  console.log(`${TRY_USAGE}\n\nType a command, or exit.`);
  const lines = createInterface({ input: process.stdin, output: process.stdout });
  lines.setPrompt("try> ");
  lines.prompt();
  try {
    // Lines typed (or piped) while a turn runs wait their turn here.
    for await (const line of lines) {
      let argv: string[] = [];
      try {
        argv = splitCommandLine(line);
      } catch (error) {
        console.error(error instanceof EvalUsageError ? error.message : String(error));
      }
      if (argv[0] === "exit" || argv[0] === "quit") return 0;
      if (argv.length > 0) await once([...argv, ...flags]);
      lines.prompt();
    }
    return 0;
  } finally {
    lines.close();
  }
}

/** Options that take a value, so the value is not read as the command. */
const VALUED = new Set([
  "--session",
  "--model",
  "--timeout",
  "--capability",
  "--expect",
  "--axis",
]);

const argv = process.argv.slice(2);
const hasCommand = argv.some(
  (arg, index) => !arg.startsWith("-") && !VALUED.has(argv[index - 1] ?? ""),
);
process.exitCode =
  hasCommand || argv.includes("--help") || argv.includes("-h")
    ? await once(argv)
    : await prompt(argv);
