import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Project } from "../../domain/entities";
import { serializeProject, stringifyProject } from "../../domain/serialize";
import { TICKS_PER_BAR } from "../../domain/time";
import { buildAssistantPayload } from "../payload";
import { assistantContextPayloadSchema, assistantTurnRequestSchema } from "../protocol";
import { CASE_CHECK_IDS, caseChecksFor } from "./caseChecks";
import {
  caseMessages,
  casePairs,
  EVAL_CASES,
  EVAL_PARTS,
  type EvalCase,
  evalCaseFromJson,
  loadJsonCases,
  PAIRED_CAPABILITIES,
  parseJsonEvalCase,
  resolveScope,
  resolveSelection,
  TYPESCRIPT_CASES,
} from "./cases";
import { CHECK_IDS, CHECK_LABELS, checkBundled } from "./checks";
import { selectEvalCases } from "./cli";
import {
  createHouseLoopProject,
  createTechnoDrumsProject,
  createTechnoLoopProject,
  TECHNO_TEMPO,
} from "./fixtures";
import { namedFixture, TS_FIXTURES } from "./namedFixtures";

/**
 * What every case, written or saved, must hold: a fixture that builds the
 * same valid project every time with only factory sounds, and a selection and
 * scope that resolve against it.
 */
function expectRunnableFixture(entry: EvalCase) {
  const project = entry.fixture();
  expect(stringifyProject(entry.fixture())).toBe(stringifyProject(project));
  expect(checkBundled([], project).status).toBe("pass");
  // The selection and scope resolve against the fixture's names.
  const selection = resolveSelection(project, entry.selection);
  expect(resolveScope(project, entry.scope).tracks.size).toBeGreaterThanOrEqual(0);
  const context = assistantContextPayloadSchema.parse(
    buildAssistantPayload(project, selection),
  );
  if (!entry.selection) expect(context.selectedNotes).toBeNull();
  // A written case selects notes to work on; a saved one may select an
  // empty clip or a new track, as the producer did.
  else if (TYPESCRIPT_CASES.includes(entry)) {
    expect(context.selectedNotes?.noteCount).toBeGreaterThan(0);
  }
}

/** Every case's turn is a conversation the gateway takes, ending in its request. */
function expectGatewayConversation(entry: EvalCase) {
  const project = entry.fixture();
  const messages = caseMessages(entry);
  const request = assistantTurnRequestSchema.parse({
    projectRevision: project.metadata.revision,
    messages,
    context: buildAssistantPayload(project, resolveSelection(project, entry.selection)),
  });
  expect(request.messages.at(-1)).toEqual({ role: "user", text: entry.request });
  // The producer opens, and the two take turns.
  messages.forEach((message, index) => {
    expect(message.role).toBe(index % 2 === 0 ? "user" : "assistant");
  });
}

describe("the eval cases", () => {
  it("ask every capability once conventionally and once at an extreme, on one fixture", () => {
    const pairs = casePairs();
    expect(pairs.map((pair) => pair.conventional.capability)).toEqual([
      ...PAIRED_CAPABILITIES,
    ]);
    for (const { conventional, extreme } of pairs) {
      expect(extreme.fixture).toBe(conventional.fixture);
    }
  });

  it("have unique IDs", () => {
    const ids = EVAL_CASES.map((entry) => entry.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it.each(EVAL_CASES.map((entry) => [entry.id, entry] as const))(
    "%s: builds the same valid project every time, with only factory sounds",
    (_id, entry) => expectRunnableFixture(entry),
  );

  it("show a loop sketch every drum pad it can play", () => {
    const sketch = EVAL_CASES.find((entry) => entry.capability === "loopSketch");
    if (!sketch) throw new Error("no sketch case");
    const project = sketch.fixture();
    const context = buildAssistantPayload(
      project,
      resolveSelection(project, sketch.selection),
    );
    const seen = new Set(
      context.selectedNotes?.clips.flatMap((clip) =>
        clip.events.flatMap((event) =>
          event.trigger.kind === "pad" ? [event.trigger.padId] : [],
        ),
      ),
    );
    const drums = project.song.tracks[0].instrument;
    expect(drums?.kind).toBe("drumMachine");
    if (drums?.kind === "drumMachine") {
      expect(seen).toEqual(new Set(drums.pads.map((pad) => pad.id)));
    }
  });

  it("refuse a name the fixture does not have", () => {
    const project = EVAL_CASES[0].fixture();
    expect(() => resolveSelection(project, { tracks: ["Nope"] })).toThrow(
      /no track named/,
    );
  });

  it("name the five sketch parts on the written loop sketches and nothing elsewhere", () => {
    for (const evalCase of TYPESCRIPT_CASES) {
      expect(evalCase.parts ?? []).toEqual(
        evalCase.capability === "loopSketch" ? EVAL_PARTS : [],
      );
    }
  });

  it.each(EVAL_CASES.map((entry) => [entry.id, entry] as const))(
    "%s: sends a conversation the gateway takes, ending in its request",
    (_id, entry) => expectGatewayConversation(entry),
  );

  it("name only checks that exist, and give every check a label", () => {
    for (const evalCase of EVAL_CASES) {
      for (const id of evalCase.checks ?? []) expect(CASE_CHECK_IDS).toContain(id);
    }
    for (const id of CHECK_IDS) expect(CHECK_LABELS[id]).toBeTruthy();
  });

  // GRV-99: the sessions copied from testing.
  it("expect a question on the broad requests and a proposal on the rest", () => {
    const asking = TYPESCRIPT_CASES.filter((entry) => entry.expect === "ask").map(
      (entry) => entry.id,
    );
    expect(asking).toEqual(["develop-track-ask", "pad-genre-unknown"]);
    const byId = (id: string) => EVAL_CASES.find((entry) => entry.id === id);
    expect(byId("density-hats")?.checks).toEqual(["hatDensity", "pointsToGenerate"]);
    expect(byId("develop-track-arrange")?.checks).toEqual(["developsTrack"]);
    expect(byId("pad-genre-known")?.checks).toEqual(["padSound", "dissonant"]);
  });

  // GRV-145: the large, open requests run as sessions, judged on the song
  // they end with.
  it("run the large, open requests as sessions, and nothing else", () => {
    const sessions = TYPESCRIPT_CASES.filter((entry) => entry.session).map(
      (entry) => entry.id,
    );
    expect(sessions).toEqual([
      "develop-track-arrange",
      "full-track-empty",
      "full-tune-loop",
    ]);
    const byId = (id: string) => TYPESCRIPT_CASES.find((entry) => entry.id === id);
    expect(byId("full-track-empty")?.request).toBe("Make me a full track.");
    expect(byId("full-track-empty")?.fixture().song.tracks).toEqual([]);
    expect(byId("full-track-empty")?.checks).toEqual(["developsTrack", "addsTracks"]);
    expect(byId("full-tune-loop")?.request).toBe("Make this a full tune.");
    expect(byId("full-tune-loop")?.checks).toEqual(["developsTrack"]);
    const loop = byId("full-tune-loop")?.fixture();
    expect(loop?.song.tracks.length).toBeGreaterThan(1);
    for (const id of sessions) {
      expect(byId(id)?.expect).toBe("proposal");
      expect(byId(id)?.session).toEqual({});
    }
  });

  it("pick the develop-track conversation up after the question and the answers", () => {
    const arrange = EVAL_CASES.find((entry) => entry.id === "develop-track-arrange");
    const ask = EVAL_CASES.find((entry) => entry.id === "develop-track-ask");
    if (!arrange || !ask) throw new Error("no develop-track cases");
    const [first, question] = arrange.history ?? [];
    expect(first).toEqual({ role: "user", text: ask.request });
    expect(question.text).toContain("[I asked the producer (ask_producer");
    expect(arrange.request).toMatch(/^\[Answer to "/);
    expect(arrange.request).toContain("About 5 minutes at 140");
  });

  it("build the techno beat: 140 BPM, five pads, one looped 4-bar clip", () => {
    const project = createTechnoDrumsProject();
    expect(project.song.tempo).toBe(TECHNO_TEMPO);
    const [drums] = project.song.tracks;
    expect(project.song.tracks).toHaveLength(1);
    expect(drums.instrument?.kind).toBe("drumMachine");
    if (drums.instrument?.kind === "drumMachine") {
      expect(drums.instrument.pads.map((pad) => pad.name)).toEqual([
        "Kick",
        "Clap",
        "Closed Hat",
        "Open Hat",
        "Perc",
      ]);
    }
    expect(project.clips).toHaveLength(1);
    expect(project.clips[0].lengthTicks).toBe(4 * TICKS_PER_BAR);
    expect(project.song.placements).toEqual([
      expect.objectContaining({ looped: true, durationTicks: 4 * TICKS_PER_BAR }),
    ]);
  });

  it("build the techno loop: the beat plus a synth with a 4-bar clip", () => {
    const project = createTechnoLoopProject();
    expect(project.song.tempo).toBe(TECHNO_TEMPO);
    expect(
      project.song.tracks.map((track) => [track.name, track.instrument?.kind]),
    ).toEqual([
      ["Drums", "drumMachine"],
      ["Synth", "synth"],
    ]);
    const synthClip = project.clips.find(
      (clip) => clip.trackId === project.song.tracks[1].id,
    );
    expect(synthClip?.lengthTicks).toBe(4 * TICKS_PER_BAR);
  });
});

// GRV-107: cases from GRV-6's QA findings.
describe("the basic production actions (GRV-119)", () => {
  const basic = TYPESCRIPT_CASES.filter((entry) => entry.set === "basicActions");

  it("ask the issue's 30 cases as 32 requests, each judged by checks 18 and 19", () => {
    expect(basic).toHaveLength(32);
    for (const entry of basic) {
      expect(entry.capability).toBe("basicAction");
      expect(entry.checks).toEqual(["exactEdit", "nothingElse"]);
      expect(entry.action).toBeDefined();
    }
    // Only the missing track expects anything but a proposal.
    expect(
      basic.filter((entry) => entry.expect !== "proposal").map((entry) => entry.id),
    ).toEqual(["basic-missing-track"]);
  });

  it("are the only cases in their set, and every other case is a musical one", () => {
    expect(EVAL_CASES.filter((entry) => entry.set === "basicActions")).toEqual(basic);
    expect(
      EVAL_CASES.filter((entry) => !basic.includes(entry)).every((entry) => !entry.set),
    ).toBe(true);
  });
});

describe("the cases from GRV-6's QA findings", () => {
  const byId = (id: string) => {
    const found = EVAL_CASES.find((entry) => entry.id === id);
    if (!found) throw new Error(`no case ${id}`);
    return found;
  };
  const track = (project: Project) => project.song.tracks[0];

  it("sketch on a project with only BD, whole song and scoped to BD", () => {
    const whole = byId("sketch-whole-song");
    const scoped = byId("sketch-track-scope");
    expect(whole.fixture().song.tracks.map((entry) => entry.name)).toEqual(["BD"]);
    expect(whole.selection).toBeNull();
    expect(whole.expect).toBe("proposal");
    expect(scoped.request).toBe(whole.request);
    expect(scoped.selection).toEqual({ tracks: ["BD"] });
    expect(scoped.expect).toBe("either");
    expect(whole.checks).toEqual(["addsTracks"]);
    expect(scoped.checks).toEqual(["addsTracks"]);
  });

  it.each([
    ["db-nudge-down", "Nudge the BD down 1 dB", -3, -4],
    ["db-turn-down", "Turn the BD down by 1 dB", -3, -4],
    ["db-lower", "Lower the BD by 1 dB", -3, -4],
    ["db-turn-up", "Turn the BD up by 3 dB", -3, 0],
    ["db-stale-cancelled", "Turn the BD up by 3 dB", -3, 0],
    ["db-stale-undone", "Turn the BD down by 3 dB", 0, -3],
  ] as const)(
    "%s: starts BD at the real volume and expects the exact end",
    (id, request, from, to) => {
      const entry = byId(id);
      expect(entry.request).toBe(request);
      expect(track(entry.fixture()).mixer.volume).toBe(from);
      expect(entry.checks).toEqual(["endsAt"]);
      expect(entry.expectedValue).toMatchObject({
        track: "BD",
        value: to,
        tolerance: 0.05,
      });
    },
  );

  it("resend a stale proposal's words, which the real volume contradicts", () => {
    expect(byId("db-stale-cancelled").history?.[1].text).toContain("-5.0 dB");
    expect(byId("db-stale-undone").history?.[1].text).toContain("-2.0 dB");
  });

  it("re-sketch after an applied sketch, and on BD alone, checking notes and no-ops", () => {
    const resketch = byId("resketch-extreme");
    expect(resketch.fixture().song.tracks.map((entry) => entry.name)).toEqual([
      "BD",
      "Bass",
      "Chords",
      "Melody",
      "Texture",
    ]);
    // Check 16 judges every case now; the case names only its own.
    expect(resketch.checks).toEqual(["noNoOps"]);
    expect(caseChecksFor(resketch.checks)).toEqual([
      "noEmptyClips",
      "noNoOps",
      "clipsPlaced",
    ]);
    // "Clear the notes in this clip" asks for the empty clip check 16 fails.
    const clear = byId("basic-clear-clip");
    expect(caseChecksFor(clear.checks, clear.exempt)).toEqual([
      "exactEdit",
      "nothingElse",
      "clipsPlaced",
    ]);
    expect(byId("noop-bd-only").request).toBe(resketch.request);
    expect(byId("noop-bd-only").checks).toEqual(["noNoOps"]);
  });
});

describe("JSON eval cases (GRV-108)", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  function scratch(files: Record<string, unknown>) {
    const root = mkdtempSync(join(tmpdir(), "eval-cases-"));
    dirs.push(root);
    for (const [path, content] of Object.entries(files)) {
      mkdirSync(join(root, dirname(path)), { recursive: true });
      writeFileSync(
        join(root, path),
        typeof content === "string" ? content : JSON.stringify(content),
      );
    }
    return { casesDir: join(root, "cases"), fixturesDir: join(root, "fixtures") };
  }

  const json = {
    id: "saved-case",
    capability: "balancing",
    axis: "conventional",
    request: "Tuck the bass in",
    expect: "proposal",
    fixture: "house-loop",
    selection: { tracks: ["Bass"] },
    scope: {
      tracks: ["Bass"],
      createTracks: false,
      song: false,
      master: false,
      returns: false,
      sections: false,
    },
  };

  it("load beside the TypeScript ones, on a named or a JSON fixture", () => {
    const moved = {
      ...createHouseLoopProject(),
      metadata: { ...createHouseLoopProject().metadata, name: "Moved" },
    };
    const where = scratch({
      "cases/saved-case.json": json,
      "cases/on-json.json": { ...json, id: "on-json", fixture: "moved" },
      "fixtures/moved.json": serializeProject(moved),
    });
    const loaded = loadJsonCases(where.casesDir, where.fixturesDir);
    expect(loaded.map((entry) => entry.id)).toEqual(["on-json", "saved-case"]);
    const [onJson, saved] = loaded;
    expect(stringifyProject(saved.fixture())).toBe(
      stringifyProject(createHouseLoopProject()),
    );
    expect(stringifyProject(onJson.fixture())).toBe(stringifyProject(moved));
    expect(onJson.fixture()).not.toBe(onJson.fixture());
    expect(selectEvalCases(["saved-case"], [...EVAL_CASES, ...loaded])).toEqual([saved]);
    expect(evalCaseFromJson(parseJsonEvalCase(json, "it")).scope).toEqual(json.scope);
  });

  it("hold every suite-wide property when saved asking, on an empty selection, at an extreme", () => {
    // What `save-case` may legitimately write: a question expected, a track
    // with no notes selected, a paired capability's extreme, a loop sketch
    // with no parts named.
    const house = createHouseLoopProject();
    const bass = house.song.tracks.find((entry) => entry.name === "Bass");
    if (!bass) throw new Error("no Bass track");
    const emptied = new Set(
      house.clips.filter((clip) => clip.trackId === bass.id).map((clip) => clip.id),
    );
    const bassless: Project = {
      ...house,
      clips: house.clips.filter((clip) => !emptied.has(clip.id)),
      song: {
        ...house.song,
        placements: house.song.placements.filter(
          (placement) => !emptied.has(placement.clipId),
        ),
      },
    };
    const where = scratch({
      "cases/asks-first.json": {
        ...json,
        id: "asks-first",
        capability: "loopSketch",
        axis: "extreme",
        expect: "ask",
        history: [
          { role: "user", text: "Bass down" },
          { role: "assistant", text: "The Bass down to -6 dB." },
        ],
        fixture: "bassless",
      },
      "fixtures/bassless.json": serializeProject(bassless),
    });
    const loaded = loadJsonCases(where.casesDir, where.fixturesDir);
    expect(loaded.map((entry) => entry.expect)).toEqual(["ask"]);
    const all = [...TYPESCRIPT_CASES, ...loaded];
    for (const entry of all) {
      expectRunnableFixture(entry);
      expectGatewayConversation(entry);
    }
    // The pairs check 6 compares stay the written ones.
    expect(casePairs(all)).toEqual(casePairs(TYPESCRIPT_CASES));
    expect(new Set(all.map((entry) => entry.id)).size).toBe(all.length);
  });

  it("refuse a broken case rather than leave it out", () => {
    const misnamed = scratch({ "cases/other.json": json });
    expect(() => loadJsonCases(misnamed.casesDir, misnamed.fixturesDir)).toThrow(
      "name it saved-case.json",
    );
    const unknown = scratch({
      "cases/saved-case.json": { ...json, capability: "vibes" },
    });
    expect(() => loadJsonCases(unknown.casesDir, unknown.fixturesDir)).toThrow(
      /is not an eval case: capability/,
    );
    const noFixture = scratch({ "cases/saved-case.json": { ...json, fixture: "gone" } });
    expect(() => loadJsonCases(noFixture.casesDir, noFixture.fixturesDir)).toThrow(
      'No eval fixture "gone"',
    );
    const broken = scratch({
      "cases/saved-case.json": { ...json, fixture: "bad" },
      "fixtures/bad.json": { metadata: {} },
    });
    expect(() => loadJsonCases(broken.casesDir, broken.fixturesDir)).toThrow(
      "is not a valid project",
    );
    expect(loadJsonCases(join(tmpdir(), "no-such-dir-for-evals"))).toEqual([]);
  });

  it("name every fixture fixtures.ts builds", () => {
    expect(Object.keys(TS_FIXTURES)).toEqual([
      "kit-sketch",
      "house-loop",
      "arrangement",
      "techno-drums",
      "techno-loop",
      "bd-only",
      "bd-sketch",
    ]);
    expect(() => namedFixture("constructor")).toThrow('No eval fixture "constructor"');
  });
});
