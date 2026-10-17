import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { setParameter } from "../../commands";
import { stringifyProject } from "../../domain/serialize";
import {
  createScriptedAssistantProvider,
  replyEvents,
  toolUseEvents,
} from "../../testing/scriptedAssistantProvider";
import { askTranscript } from "../ask";
import type { AssistantProvider } from "../provider";
import { continuesTurn, type ProviderMessagesRequest } from "../providerRequest";
import { toolNameFor } from "../tools";
import { EVAL_CASES, loadJsonCases } from "./cases";
import { canonicalSongState } from "./checks";
import { createHouseLoopProject } from "./fixtures";
import { evaluateRecords } from "./run";
import {
  answer,
  apply,
  ask,
  cancel,
  newSession,
  parseAnswer,
  saveCase,
  sessionFromJson,
  sessionToJson,
  setScope,
  setSelection,
  show,
  type TrySession,
  undo,
} from "./trySession";

const fixedNow = () => Date.parse("2026-10-12T12:00:00Z");

function trackId(session: TrySession, name: string) {
  const track = session.project.song.tracks.find((candidate) => candidate.name === name);
  if (!track) throw new Error(`no track ${name}`);
  return track.id;
}

/** A tool call that sets `name`'s volume to `db`. */
function volumeCall(session: TrySession, name: string, db: number) {
  const command = setParameter(
    { scope: "track", trackId: trackId(session, name), parameterId: "track.volume" },
    db,
  );
  return { name: toolNameFor(command.type), input: command.payload };
}

const askCall = {
  name: "ask_producer",
  input: {
    question: "How busy should the hats get?",
    options: [{ label: "A little" }, { label: "Twice as busy" }],
  },
};

function started(): TrySession {
  return newSession({ id: "test", fixture: "house-loop", model: "claude-sonnet-5" })
    .session;
}

function deps(provider: AssistantProvider) {
  return { provider, now: fixedNow };
}

/** The requests that open a turn: each continued step is left out. */
function opened(provider: { readonly requests: readonly ProviderMessagesRequest[] }) {
  return provider.requests.filter((request) => !continuesTurn(request));
}

describe("an assistant:try session", () => {
  it("starts on a named fixture with the whole song in scope", () => {
    const { session, result } = newSession({
      id: "s1",
      fixture: "house-loop",
      model: "claude-sonnet-5",
    });
    expect(stringifyProject(session.project)).toBe(
      stringifyProject(createHouseLoopProject()),
    );
    expect(session.scope.tracks).toBe("all");
    expect(
      result.kind === "new" && result.project.tracks.map((track) => track.name),
    ).toEqual(["Drums", "Bass", "Chords", "Lead"]);
    expect(() =>
      newSession({ id: "s2", fixture: "no-such-thing", model: "claude-sonnet-5" }),
    ).toThrow(/No eval fixture "no-such-thing"\. Fixtures: kit-sketch, house-loop/);
  });

  it("asks, shows the card and checks 1 to 5, applies, and undoes to the song it started from", async () => {
    const session = started();
    const provider = createScriptedAssistantProvider([
      toolUseEvents("The Bass down to -6 dB.", [volumeCall(session, "Bass", -6)]),
    ]);
    const asked = await ask(session, { text: "Tuck the bass in" }, deps(provider));
    const result = asked.result;
    if (result.kind !== "ask") throw new Error("not an ask");
    expect(result.error).toBeNull();
    expect(result.reply).toBe("The Bass down to -6 dB.");
    expect(result.proposal?.rows).toEqual([
      expect.objectContaining({ from: "0.0 dB", to: "-6.0 dB", change: "changed" }),
    ]);
    expect(result.checks?.map((check) => [check.id, check.status])).toEqual([
      ["valid", "pass"],
      ["bundled", "pass"],
      ["inScope", "pass"],
      ["atomicUndo", "pass"],
      ["grounded", "pass"],
    ]);
    expect(result.usage?.inputTokens).toBe(100);
    expect(result.costUsd).toBeGreaterThan(0);
    expect(asked.session.pending).not.toBeNull();
    expect(asked.session.project).toBe(session.project);

    const applied = apply(asked.session);
    expect(applied.result).toMatchObject({ kind: "apply", ok: true, revision: 1 });
    expect(applied.session.pending).toBeNull();
    expect(
      applied.session.project.song.tracks.find((track) => track.name === "Bass")?.mixer
        .volume,
    ).toBe(-6);
    expect(show(applied.session).result).toMatchObject({ undoable: 1, turns: 1 });

    const undone = undo(applied.session);
    expect(undone.result).toMatchObject({ kind: "undo", ok: true });
    expect(canonicalSongState(undone.session.project)).toBe(
      canonicalSongState(session.project),
    );
    expect(undone.session.applied).toEqual([]);
    expect(() => undo(undone.session)).toThrow("No applied proposal to undo");
  });

  it("cancels without changing the song, and resends cancelled and undone replies", async () => {
    const session = started();
    const provider = createScriptedAssistantProvider([
      toolUseEvents("The Bass down to -6 dB.", [volumeCall(session, "Bass", -6)]),
      toolUseEvents("The Lead down to -3 dB.", [volumeCall(session, "Lead", -3)]),
      replyEvents(["Noted."]),
    ]);
    const first = await ask(session, { text: "Bass down" }, deps(provider));
    const cancelled = cancel(first.session);
    expect(cancelled.result).toMatchObject({ kind: "cancel", ok: true });
    expect(cancelled.session.pending).toBeNull();
    expect(cancelled.session.project).toBe(session.project);
    expect(() => cancel(cancelled.session)).toThrow("No proposal is waiting");

    const second = await ask(cancelled.session, { text: "Lead down" }, deps(provider));
    const undone = undo(apply(second.session).session).session;
    await ask(undone, { text: "Thanks" }, deps(provider));
    expect(opened(provider)[2].messages).toEqual([
      { role: "user", content: "Bass down" },
      { role: "assistant", content: "The Bass down to -6 dB." },
      { role: "user", content: "Lead down" },
      { role: "assistant", content: "The Lead down to -3 dB." },
      { role: "user", content: "Thanks" },
    ]);
  });

  it("leaves a reply that only proposed out of what it resends, as the panel does", async () => {
    const session = started();
    const provider = createScriptedAssistantProvider([
      toolUseEvents("", [volumeCall(session, "Bass", -6)]),
      replyEvents(["OK."]),
    ]);
    const first = await ask(session, { text: "Bass down" }, deps(provider));
    await ask(first.session, { text: "And now?" }, deps(provider));
    expect(opened(provider)[1].messages).toEqual([{ role: "user", content: "And now?" }]);
  });

  it("refuses to apply a proposal the song moved under, which can still be cancelled", async () => {
    const session = started();
    const provider = createScriptedAssistantProvider([
      toolUseEvents("Bass down.", [volumeCall(session, "Bass", -6)]),
      toolUseEvents("Lead down.", [volumeCall(session, "Lead", -3)]),
    ]);
    const first = await ask(session, { text: "Bass down" }, deps(provider));
    const applied = apply(first.session).session;
    const second = await ask(applied, { text: "Lead down" }, deps(provider));
    const moved = undo(second.session).session;
    const refused = apply(moved);
    expect(refused.result).toMatchObject({ kind: "apply", ok: false });
    expect(refused.session.project).toBe(moved.project);
    expect(cancel(moved).session.pending).toBeNull();
  });

  it("answers a question as the next turn, the question resent beside it", async () => {
    const session = started();
    const provider = createScriptedAssistantProvider([
      toolUseEvents("One thing first.", [askCall]),
      replyEvents(["Twice as busy it is."]),
    ]);
    const asked = await ask(session, { text: "Busier hats" }, deps(provider));
    const result = asked.result;
    if (result.kind !== "ask") throw new Error("not an ask");
    expect(result.question?.question).toBe("How busy should the hats get?");
    expect(result.checks).toBeNull();
    expect(result.noProposal).toMatch(/asked the producer/);
    const question = asked.session.pendingAsk;
    if (!question) throw new Error("no question");

    const answered = await answer(asked.session, "2", deps(provider));
    expect(answered.session.pendingAsk).toBeNull();
    expect(opened(provider)[1].messages).toEqual([
      { role: "user", content: "Busier hats" },
      {
        role: "assistant",
        content: `One thing first.\n\n${askTranscript(question)}`,
      },
      {
        role: "user",
        content: '[Answer to "How busy should the hats get?"] Picked: Twice as busy.',
      },
    ]);
    expect(answered.session.entries.at(-2)).toEqual({
      kind: "message",
      text: "Twice as busy",
      wire: '[Answer to "How busy should the hats get?"] Picked: Twice as busy.',
    });
    await expect(answer(answered.session, "1", deps(provider))).rejects.toThrow(
      "No question is waiting",
    );
  });

  it("reads an answer as option numbers, a label, or words", () => {
    const question = {
      id: "toolu_1",
      question: "Which?",
      options: [{ label: "One" }, { label: "Two" }],
      multiSelect: false,
    };
    expect(parseAnswer(question, "2")).toEqual({ picked: [1], text: "" });
    expect(parseAnswer(question, "two")).toEqual({ picked: [1], text: "" });
    expect(parseAnswer(question, "neither, thanks")).toEqual({
      picked: [],
      text: "neither, thanks",
    });
    expect(() => parseAnswer(question, "3")).toThrow("there is no 3");
    expect(() => parseAnswer(question, "1,2")).toThrow("takes one option");
  });

  it("judges check 3 against the scope, and sends the selection", async () => {
    const session = setSelection(setScope(started(), ["Drums"]).session, [
      "clips",
      "House beat",
    ]).session;
    expect(session.scope).toMatchObject({ tracks: ["Drums"], createTracks: false });
    const provider = createScriptedAssistantProvider([
      toolUseEvents("Bass down.", [volumeCall(session, "Bass", -6)]),
    ]);
    const { result } = await ask(session, { text: "Bass down" }, deps(provider));
    if (result.kind !== "ask") throw new Error("not an ask");
    expect(result.checks?.find((check) => check.id === "inScope")?.status).toBe("fail");
    const beat = session.project.clips.find((clip) => clip.name === "House beat");
    const sent = JSON.stringify(provider.requests[0]);
    expect(sent).toMatch(new RegExp(`selectedNotes\\W+clips\\W+clipId\\W+${beat?.id}`));
  });

  it("refuses names the project does not have, and calls nothing", async () => {
    const session = started();
    expect(() => setScope(session, ["Nope"])).toThrow('No track named "Nope"');
    expect(() => setSelection(session, ["clips", "Nope"])).toThrow(
      'The fixture has no clip named "Nope"',
    );
    expect(() => setSelection(session, ["everything"])).toThrow("select takes");
    const provider = createScriptedAssistantProvider([]);
    const stale = { ...session, selection: { tracks: ["Gone"] } };
    await expect(ask(stale, { text: "Hi" }, deps(provider))).rejects.toThrow(
      /no model was called/,
    );
    expect(provider.requests).toHaveLength(0);
  });

  it("keeps an errored turn out of the history and the song", async () => {
    const session = started();
    const provider = createScriptedAssistantProvider([
      [{ fail: "rejected", status: 400 }],
      replyEvents(["Hello."]),
    ]);
    const failed = await ask(session, { text: "Hi" }, deps(provider));
    const result = failed.result;
    if (result.kind !== "ask") throw new Error("not an ask");
    expect(result.error).toMatch(/provider_error/);
    await ask(failed.session, { text: "Hi again" }, deps(provider));
    expect(opened(provider)[1].messages).toEqual([{ role: "user", content: "Hi again" }]);
  });

  it("survives its file: what is written reads back the same", async () => {
    const session = started();
    const provider = createScriptedAssistantProvider([
      toolUseEvents("Bass down.", [volumeCall(session, "Bass", -6)]),
    ]);
    const asked = await ask(session, { text: "Bass down" }, deps(provider));
    const applied = apply(asked.session).session;
    const read = sessionFromJson(sessionToJson(applied));
    expect(stringifyProject(read.project)).toBe(stringifyProject(applied.project));
    expect(stringifyProject(read.applied[0].before)).toBe(
      stringifyProject(session.project),
    );
    expect(read.last?.request).toBe("Bass down");
    expect(canonicalSongState(undo(read).session.project)).toBe(
      canonicalSongState(session.project),
    );
    expect(() => sessionFromJson("{}")).toThrow("not an assistant:try session");
  });
});

describe("save-case", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  function scratch() {
    const root = mkdtempSync(join(tmpdir(), "assistant-try-"));
    dirs.push(root);
    return { casesDir: join(root, "cases"), fixturesDir: join(root, "fixtures") };
  }

  it("round-trips the last request into a case cases.ts loads and the replay judges", async () => {
    const { casesDir, fixturesDir } = scratch();
    const session = setScope(started(), ["Bass"]).session;
    const provider = createScriptedAssistantProvider([
      toolUseEvents("The Bass down to -6 dB.", [volumeCall(session, "Bass", -6)]),
    ]);
    const asked = await ask(session, { text: "Tuck the bass in" }, deps(provider));
    const saved = saveCase(asked.session, {
      caseId: "tuck-bass",
      capability: "balancing",
      existingCaseIds: EVAL_CASES.map((entry) => entry.id),
      casesDir,
      fixturesDir,
      exists: () => false,
    });
    const result = saved.result;
    if (result.kind !== "save-case") throw new Error("not saved");
    // The project is the fixture unchanged, so the case names it.
    expect(result.fixture).toBe("house-loop");
    expect(result.files.map((file) => file.path)).toEqual([`${casesDir}/tuck-bass.json`]);
    expect(JSON.parse(result.files[0].content)).toEqual({
      id: "tuck-bass",
      capability: "balancing",
      axis: "conventional",
      request: "Tuck the bass in",
      expect: "proposal",
      fixture: "house-loop",
      selection: null,
      scope: {
        tracks: ["Bass"],
        createTracks: false,
        song: false,
        master: false,
        returns: false,
        sections: false,
      },
    });

    mkdirSync(casesDir, { recursive: true });
    writeFileSync(result.files[0].path, result.files[0].content);
    const [loaded] = loadJsonCases(casesDir, fixturesDir);
    expect(loaded.id).toBe("tuck-bass");
    expect(stringifyProject(loaded.fixture())).toBe(
      stringifyProject(createHouseLoopProject()),
    );
    const last = asked.session.last;
    if (!last) throw new Error("no last turn");
    const [record] = evaluateRecords(
      [{ ...last.turn, caseId: "tuck-bass", run: 1 }],
      [loaded],
    );
    expect(record.checks.valid?.status).toBe("pass");
    expect(record.checks.inScope?.status).toBe("pass");
  });

  it("freezes a project that moved, with the history before the request, as a fixture of its own", async () => {
    const { casesDir, fixturesDir } = scratch();
    const session = started();
    const provider = createScriptedAssistantProvider([
      toolUseEvents("The Bass down to -6 dB.", [volumeCall(session, "Bass", -6)]),
      toolUseEvents("One thing first.", [askCall]),
    ]);
    const first = await ask(session, { text: "Bass down" }, deps(provider));
    const applied = apply(first.session).session;
    const second = await ask(applied, { text: "Busier hats" }, deps(provider));
    const saved = saveCase(second.session, {
      caseId: "hats-after-bass",
      capability: "density",
      expect: "ask",
      existingCaseIds: [],
      casesDir,
      fixturesDir,
      exists: () => false,
    });
    const result = saved.result;
    if (result.kind !== "save-case") throw new Error("not saved");
    expect(result.fixture).toBe("hats-after-bass");
    mkdirSync(casesDir, { recursive: true });
    mkdirSync(fixturesDir, { recursive: true });
    for (const file of result.files) writeFileSync(file.path, file.content);
    const [loaded] = loadJsonCases(casesDir, fixturesDir);
    expect(loaded.expect).toBe("ask");
    expect(loaded.history).toEqual([
      { role: "user", text: "Bass down" },
      { role: "assistant", text: "The Bass down to -6 dB." },
    ]);
    expect(stringifyProject(loaded.fixture())).toBe(stringifyProject(applied.project));
  });

  it("names the fixture when an applied proposal was undone before the request", async () => {
    const { casesDir, fixturesDir } = scratch();
    const session = started();
    const provider = createScriptedAssistantProvider([
      toolUseEvents("The Bass down to -6 dB.", [volumeCall(session, "Bass", -6)]),
      toolUseEvents("One thing first.", [askCall]),
    ]);
    const first = await ask(session, { text: "Bass down" }, deps(provider));
    const undone = undo(apply(first.session).session).session;
    // The revision moved on; the song did not.
    expect(undone.project.metadata.revision).not.toBe(
      createHouseLoopProject().metadata.revision,
    );
    const second = await ask(undone, { text: "Busier hats" }, deps(provider));
    const result = saveCase(second.session, {
      caseId: "hats-after-undo",
      capability: "density",
      existingCaseIds: [],
      casesDir,
      fixturesDir,
      exists: () => false,
    }).result;
    if (result.kind !== "save-case") throw new Error("not saved");
    expect(result.fixture).toBe("house-loop");
    expect(result.files.map((file) => file.path)).toEqual([
      `${casesDir}/hats-after-undo.json`,
    ]);
  });

  it("refuses a taken ID, an unknown capability, and a session with no turn", () => {
    const { casesDir, fixturesDir } = scratch();
    const base = {
      casesDir,
      fixturesDir,
      exists: () => false,
      existingCaseIds: ["db-lower"],
    };
    expect(() =>
      saveCase(started(), { ...base, caseId: "x", capability: "balancing" }),
    ).toThrow("ask something first");
    const withTurn = {
      ...started(),
      last: {
        text: "Hi",
        request: "Hi",
        history: [],
        project: createHouseLoopProject(),
        selection: null,
        scope: started().scope,
        turn: { durationMs: 1, error: null, stopReason: null, text: "", proposal: null },
      },
    } satisfies TrySession;
    expect(() =>
      saveCase(withTurn, { ...base, caseId: "db-lower", capability: "balancing" }),
    ).toThrow('There is already a case "db-lower"');
    expect(() =>
      saveCase(withTurn, { ...base, caseId: "Bad ID", capability: "balancing" }),
    ).toThrow("lower-case words");
    expect(() =>
      saveCase(withTurn, { ...base, caseId: "fine", capability: "vibes" }),
    ).toThrow('Unknown capability "vibes"');
  });
});
