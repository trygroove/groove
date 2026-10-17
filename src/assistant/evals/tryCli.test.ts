import { describe, expect, it, vi } from "vitest";
import { setParameter } from "../../commands";
import {
  createScriptedAssistantProvider,
  type ScriptedAssistantProvider,
  toolUseEvents,
} from "../../testing/scriptedAssistantProvider";
import { CREATE_EXAMPLES, EXPLAIN_TOOL_NAME, toolNameFor } from "../tools";
import { createHouseLoopProject } from "./fixtures";
import { parseTryArgs, runTryCommand, splitCommandLine, type TryIo } from "./tryCli";
import type { TrySession } from "./trySession";
import { sessionFromJson, sessionToJson } from "./trySession";

/** Sessions, files and a provider, all in memory. */
function memoryIo(provider: ScriptedAssistantProvider, env: Record<string, string> = {}) {
  const sessions = new Map<string, string>();
  const files = new Map<string, string>();
  let current: string | null = null;
  const createProvider = vi.fn(() => provider);
  const io: TryIo = {
    env,
    loadSession: (id) => {
      const text = sessions.get(id);
      return text === undefined ? null : sessionFromJson(text);
    },
    saveSession: (session: TrySession) => {
      sessions.set(session.id, sessionToJson(session));
    },
    currentSessionId: () => current,
    setCurrentSession: (id) => {
      current = id;
    },
    newSessionId: (fixture) => `${fixture}-1`,
    writeFile: (path, content) => {
      files.set(path, content);
    },
    exists: (path) => files.has(path),
    createProvider,
    casesDir: "cases",
    fixturesDir: "fixtures",
    existingCaseIds: () => [],
    now: () => Date.parse("2026-10-12T12:00:00Z"),
  };
  return { io, sessions, files, createProvider };
}

function bassDown() {
  const project = createHouseLoopProject();
  const bass = project.song.tracks.find((track) => track.name === "Bass");
  if (!bass) throw new Error("no Bass");
  const command = setParameter(
    { scope: "track", trackId: bass.id, parameterId: "track.volume" },
    -6,
  );
  return { name: toolNameFor(command.type), input: command.payload };
}

const KEY = { ANTHROPIC_API_KEY: "sk-ant-test" };

describe("bun run assistant:try", () => {
  it("says the key is missing and calls nothing, leaving the session as it was", async () => {
    const provider = createScriptedAssistantProvider([]);
    const { io, sessions, createProvider } = memoryIo(provider);
    await runTryCommand(["new", "house-loop"], io);
    const before = sessions.get("house-loop-1");

    for (const argv of [
      ["ask", "Hello"],
      ["answer", "1"],
    ]) {
      const outcome = await runTryCommand(argv, io);
      expect(outcome.exitCode).toBe(1);
      expect(outcome.output).toContain("ANTHROPIC_API_KEY is not set");
      expect(outcome.output).toContain("No model was called.");
    }
    const json = await runTryCommand(["ask", "Hello", "--json"], io);
    expect(JSON.parse(json.output).error).toContain("ANTHROPIC_API_KEY is not set");
    expect(createProvider).not.toHaveBeenCalled();
    expect(provider.requests).toHaveLength(0);
    expect(sessions.get("house-loop-1")).toBe(before);
  });

  it("runs a session command by command, each reading and writing its file", async () => {
    const provider = createScriptedAssistantProvider([
      toolUseEvents("The Bass down to -6 dB.", [bassDown()]),
    ]);
    const { io, sessions, files } = memoryIo(provider, KEY);

    const started = await runTryCommand(["new", "house-loop", "--session", "s1"], io);
    expect(started.output).toContain("Session s1 on house-loop");
    expect(started.output).toContain('clip "House beat": 1 bars, 10 notes');

    expect((await runTryCommand(["scope", "Bass", "--master"], io)).output).toBe(
      "Scope: Bass (+ master). Selected: nothing.",
    );
    const asked = await runTryCommand(["ask", "Tuck", "the", "bass", "in"], io);
    expect(asked.exitCode).toBe(0);
    // The turn goes on after its change call, and ends in a step of its own.
    expect(asked.output).toContain("Response (call 1 of 2): stop tool_use");
    expect(asked.output).toContain("  [text]\n    The Bass down to -6 dB.");
    const call = bassDown();
    expect(asked.output).toContain(`  [tool call] ${call.name} (toolu_1)`);
    expect(asked.output).toContain(
      JSON.stringify(call.input, null, 2)
        .split("\n")
        .map((line) => `    ${line}`)
        .join("\n"),
    );
    expect(asked.output).toContain("Proposal: ");
    expect(asked.output).toContain("0.0 dB -> -6.0 dB");
    expect(asked.output).toContain("pass  3. In scope");
    expect(asked.output).toMatch(/Tokens: 100 in .* 20 out; about \$0\.\d{4}/);
    expect(provider.requests[0].messages).toEqual([
      { role: "user", content: "Tuck the bass in" },
    ]);

    const applied = await runTryCommand(["apply", "--json"], io);
    expect(JSON.parse(applied.output)).toMatchObject({
      kind: "apply",
      ok: true,
      revision: 1,
    });
    expect((await runTryCommand(["undo"], io)).output).toMatch(/^Undid: /);
    expect(sessionFromJson(sessions.get("s1") ?? "").applied).toEqual([]);

    const saved = await runTryCommand(
      ["save-case", "tuck-bass", "--capability", "balancing"],
      io,
    );
    expect(saved.exitCode).toBe(0);
    expect(saved.output).toContain("bun run assistant:eval -- tuck-bass");
    expect(JSON.parse(files.get("cases/tuck-bass.json") ?? "{}")).toMatchObject({
      id: "tuck-bass",
      fixture: "house-loop",
      request: "Tuck the bass in",
    });
    expect((await runTryCommand(["show"], io)).output).toContain(
      "1 turns, 0 applied proposals to undo",
    );
  });

  it("spells out a refused payload field by field, under the call it blames", async () => {
    // GRV-90's failure: the track wrapped in a `track` key.
    const nested = { name: "track_create", input: { track: CREATE_EXAMPLES.track } };
    // Explained in the same reply, so it is the turn's one step and its calls
    // reach the browser as they came.
    const explain = {
      name: EXPLAIN_TOOL_NAME,
      input: { goal: "A bass", technique: "A synth track" },
    };
    const provider = createScriptedAssistantProvider([
      toolUseEvents("A bass.", [bassDown(), nested, explain]),
    ]);
    const { io } = memoryIo(provider, KEY);
    await runTryCommand(["new", "house-loop"], io);
    const asked = await runTryCommand(["ask", "Add a bass"], io);
    const refusal = asked.output.slice(asked.output.indexOf("The proposal was refused"));
    expect(refusal).toContain("The proposal was refused (1 issue):");
    expect(refusal).toContain("  invalid_payload in call 2 of 2, track_create (toolu_2)");
    expect(refusal).toMatch(/^ {4}id +missing, expected string$/m);
    expect(refusal).toMatch(
      /^ {4}type +missing, expected one of "instrument" \| "audio"$/m,
    );
    expect(refusal).toContain(
      'Hint: "track" wraps the whole input: the model nested it one level too deep.',
    );
    expect(asked.output).toContain("FAIL  1. Valid: the proposal was refused, as above");
  });

  it("lists the fixtures without a session, and leaves the current one alone", async () => {
    const { io, sessions } = memoryIo(createScriptedAssistantProvider([]));
    const listed = await runTryCommand(["fixtures"], io);
    expect(listed.exitCode).toBe(0);
    expect(listed.output).toContain(
      "Fixtures (start a session on one with new <fixture>):",
    );
    expect(listed.output).toMatch(/^ {2}house-loop +fixtures\.ts$/m);
    expect(listed.output).toMatch(/^ {2}bd-sketch +fixtures\.ts$/m);
    expect(sessions.size).toBe(0);
    expect(io.currentSessionId()).toBeNull();

    const json = JSON.parse((await runTryCommand(["fixtures", "--json"], io)).output);
    expect(json.fixtures).toContainEqual({ name: "kit-sketch", source: "ts" });

    const extra = await runTryCommand(["fixtures", "more"], io);
    expect(extra.exitCode).toBe(1);
    expect(extra.output).toBe("fixtures takes no arguments");
  });

  it("knows quit, which only the prompt acts on", async () => {
    const { io, sessions } = memoryIo(createScriptedAssistantProvider([]));
    const quit = await runTryCommand(["quit"], io);
    expect(quit.exitCode).toBe(0);
    expect(quit.output).toBe("quit leaves the prompt; no prompt is open.");
    expect(sessions.size).toBe(0);
    expect((await runTryCommand(["help"], io)).output).toContain("quit ");
  });

  it("says what is wrong, without a session or with a bad command", async () => {
    const { io } = memoryIo(createScriptedAssistantProvider([]), KEY);
    expect((await runTryCommand(["show"], io)).output).toBe(
      "No session yet: start one with new <fixture>",
    );
    expect((await runTryCommand(["apply", "--session", "nope"], io)).output).toBe(
      'No session "nope"',
    );
    const unknown = await runTryCommand(["dance"], io);
    expect(unknown.exitCode).toBe(1);
    expect(unknown.output).toContain('Unknown command "dance"');
    expect((await runTryCommand([], io)).output).toContain(
      "Usage: bun run assistant:try",
    );
    await runTryCommand(["new", "house-loop"], io);
    expect((await runTryCommand(["apply"], io)).output).toBe(
      "No proposal is waiting to be applied",
    );
    expect((await runTryCommand(["save-case", "x"], io)).output).toBe(
      "save-case needs --capability <c>",
    );
  });
});

describe("parseTryArgs", () => {
  it("reads the command, its words and the options", () => {
    expect(
      parseTryArgs(["--session", "s1", "ask", "make", "it", "wider", "--json"]),
    ).toMatchObject({
      command: "ask",
      args: ["make", "it", "wider"],
      session: "s1",
      json: true,
      model: null,
    });
    expect(parseTryArgs(["new", "kit-sketch", "--model", "claude-haiku-4-5"]).model).toBe(
      "claude-haiku-4-5",
    );
    expect(() => parseTryArgs(["ask", "x", "--model", "gpt"])).toThrow(
      'Unknown model "gpt"',
    );
    expect(() => parseTryArgs(["save-case", "x", "--expect", "maybe"])).toThrow(
      "--expect",
    );
    expect(() => parseTryArgs(["show", "--session", "../etc"])).toThrow("A session ID");
  });
});

describe("splitCommandLine", () => {
  it("splits words and keeps quoted strings whole", () => {
    expect(splitCommandLine(`ask "make it 'wider'" --json`)).toEqual([
      "ask",
      "make it 'wider'",
      "--json",
    ]);
    expect(splitCommandLine(`select clips 'House beat' Hook`)).toEqual([
      "select",
      "clips",
      "House beat",
      "Hook",
    ]);
    expect(splitCommandLine(`ask "say \\"hi\\""`)).toEqual(["ask", 'say "hi"']);
    expect(splitCommandLine("   ")).toEqual([]);
    expect(() => splitCommandLine(`ask "open`)).toThrow("A quote is not closed");
  });
});
