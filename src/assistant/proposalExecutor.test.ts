import { beforeEach, describe, expect, it } from "vitest";
import { validateEventPayload } from "../analytics/catalog";
import {
  addNotes,
  type CommandHistory,
  createCommandHistory,
  type RawCommandInput,
  setParameter,
  setTrackFlag,
  transposeNotes,
  updateTrack,
} from "../commands";
import {
  type CommandTestProject,
  contentSignature,
  createCommandTestProject,
  createTestFactoryContext,
} from "../commands/testProjects";
import {
  createDrumPad,
  createNoteEvent,
  SONG_TEMPO,
  TICKS_PER_SIXTEENTH,
  TRACK_VOLUME,
} from "../domain";
import { createManualClock, type ManualClock } from "../shared/clock";
import { historyProposalTarget } from "./historyProposalTarget";
import {
  issueCall,
  MAX_PROPOSAL_COMMANDS,
  rejectedProposalShape,
  validateProposal,
} from "./proposal";
import { createProposalExecutor, type ProposalExecutor } from "./proposalExecutor";
import { ASSISTANT_TOOLSET_VERSION, EXPLAIN_TOOL_NAME, toolNameFor } from "./tools";

const INTENT = "Lift the bassline an octave so it clears the kick";

function call(command: RawCommandInput) {
  return { name: toolNameFor(command.type), input: command.payload };
}

interface Logged {
  readonly name: string;
  readonly params: Record<string, unknown>;
}

let fx: CommandTestProject;
let history: CommandHistory;
let clock: ManualClock;
let logged: Logged[];
let executor: ProposalExecutor;

beforeEach(() => {
  fx = createCommandTestProject();
  history = createCommandHistory(fx.project);
  clock = createManualClock(1_000_000);
  logged = [];
  executor = createProposalExecutor({
    target: historyProposalTarget(history),
    clock,
    analytics: {
      log(name, ...args) {
        logged.push({ name, params: { ...(args[0] as Record<string, unknown>) } });
      },
    },
  });
});

function notesProposal(baseRevision = fx.project.metadata.revision) {
  const context = createTestFactoryContext("executor");
  return {
    baseRevision,
    intent: INTENT,
    calls: [
      call(transposeNotes(fx.clipAId, null, 12)),
      call(
        addNotes(fx.clipAId, [
          createNoteEvent(context, {
            startTicks: 2 * TICKS_PER_SIXTEENTH,
            durationTicks: TICKS_PER_SIXTEENTH,
            pitch: 50,
          }),
        ]),
      ),
      { id: "toolu_1", type: "tool_use", ...call(transposeNotes(fx.clipAId, null, -1)) },
    ],
  };
}

function propose(input: unknown = notesProposal()) {
  const result = executor.propose(input);
  if (!result.ok) throw new Error(JSON.stringify(result.issues));
  return result.handle;
}

function expectNoChange(): void {
  expect(history.project).toBe(fx.project);
  expect(history.entries).toHaveLength(0);
}

describe("a malformed response", () => {
  it.each([
    ["nothing", undefined],
    ["text", "Sure, I made it punchier!"],
    ["an empty object", {}],
    ["no calls", { baseRevision: 0, calls: [] }],
    ["calls that are not a list", { baseRevision: 0, calls: "transpose" }],
    ["a call with no name", { baseRevision: 0, calls: [{ input: {} }] }],
    ["a negative revision", { baseRevision: -1, calls: [{ name: "x", input: {} }] }],
    ["an unexpected field", { baseRevision: 0, calls: [{ name: "x" }], sudo: true }],
    [
      "an over-long intent",
      { baseRevision: 0, intent: "x".repeat(5000), calls: [{ name: "x", input: {} }] },
    ],
  ])("is refused as malformed: %s", (_label, input) => {
    const result = executor.propose(input);
    expect(result.ok).toBe(false);
    expect(result.ok ? null : result.issues.map((issue) => issue.code)).toEqual([
      "malformed",
    ]);
    expectNoChange();
    expect(logged).toMatchObject([
      {
        name: "assistant_proposal_rejected",
        params: { kind: "invalid", capability: "unknown", issue_code: "malformed" },
      },
    ]);
  });

  it("is refused when it carries more commands than a proposal may", () => {
    const calls = Array.from({ length: MAX_PROPOSAL_COMMANDS + 1 }, () =>
      call(setTrackFlag(fx.trackAId, "muted", true)),
    );
    const result = executor.propose({ baseRevision: 0, calls });
    expect(result.ok ? null : result.issues[0].code).toBe("too_many_commands");
    expectNoChange();
  });

  it("names every bad call, not just the first", () => {
    const result = executor.propose({
      baseRevision: fx.project.metadata.revision,
      calls: [
        { name: "project_delete", input: {} },
        call(transposeNotes(fx.clipAId, null, 12)),
        { name: "notes_transpose", input: { clipId: fx.clipAId } },
      ],
    });
    expect(result.ok ? null : result.issues).toMatchObject([
      { code: "unknown_tool", callIndex: 0 },
      { code: "invalid_payload", callIndex: 2 },
    ]);
    expectNoChange();
  });
});

describe("a rejected proposal (GRV-98)", () => {
  it("logs assistant_proposal_rejected exactly once, with codes only", () => {
    const result = executor.propose({
      baseRevision: fx.project.metadata.revision,
      calls: [
        { name: EXPLAIN_TOOL_NAME, input: { goal: "Make room", technique: "Cut" } },
        { name: "project_delete", input: { name: "My secret song" } },
        call(transposeNotes(fx.clipAId, null, 12)),
        { name: "notes_transpose", input: { clipId: fx.clipAId } },
      ],
    });
    expect(result.ok).toBe(false);
    expect(logged).toEqual([
      {
        name: "assistant_proposal_rejected",
        params: {
          kind: "invalid",
          // The one call that resolved; the explanation changes nothing.
          capability: "notes",
          command_count_bucket: "2_5",
          issue_code: "unknown_tool",
          issue_code_count: 2,
        },
      },
    ]);
    const [event] = logged;
    expect(
      validateEventPayload("assistant_proposal_rejected", event?.params).issues,
    ).toEqual([]);
    expect(JSON.stringify(logged)).not.toMatch(/secret|project_delete|clp_|toolu/);
  });

  it("names the call an issue blames by its ID and tool, counting past explain_change", () => {
    const input = {
      baseRevision: fx.project.metadata.revision,
      calls: [
        { id: "toolu_0", name: EXPLAIN_TOOL_NAME, input: {} },
        { id: "toolu_1", ...call(transposeNotes(fx.clipAId, null, 12)) },
        { id: "toolu_2", name: "notes_transpose", input: { clipId: fx.clipAId } },
      ],
    };
    const result = validateProposal(fx.project, input);
    if (result.ok) throw new Error("expected issues");
    expect(result.issues.map((issue) => issueCall(input, issue))).toEqual([
      { id: "toolu_2", name: "notes_transpose" },
    ]);
    expect(rejectedProposalShape(input)).toEqual({
      capability: "notes",
      commandCount: 2,
    });
    expect(rejectedProposalShape("not a proposal")).toEqual({
      capability: null,
      commandCount: 0,
    });
  });

  it("logs nothing more when a valid proposal is shown", () => {
    propose();
    expect(logged.map((entry) => entry.name)).toEqual(["assistant_proposal_shown"]);
  });
});

describe("a stale proposal", () => {
  it("is refused when it was built against another revision", () => {
    const result = executor.propose(notesProposal(fx.project.metadata.revision + 1));
    expect(result.ok ? null : result.issues[0].code).toBe("stale_revision");
    expectNoChange();
    expect(logged).toEqual([
      {
        name: "assistant_proposal_rejected",
        params: {
          kind: "stale",
          capability: "notes",
          command_count_bucket: "2_5",
          issue_code: "stale_revision",
          issue_code_count: 1,
        },
      },
    ]);
  });

  it("goes stale, and cannot be applied, when the project moves under it", () => {
    const handle = propose();
    history.execute(updateTrack(fx.trackBId, { name: "Kit" }));
    const moved = history.project;

    expect(handle.isStale).toBe(true);
    expect(handle.status).toBe("pending");
    const applied = handle.apply();
    expect(applied).toMatchObject({ ok: false, reason: "stale" });
    expect(handle.isStale).toBe(true);
    expect(handle.status).toBe("stale");
    expect(history.project).toBe(moved);
    expect(history.entries).toHaveLength(1);
    expect(logged.map((entry) => entry.name)).toEqual(["assistant_proposal_shown"]);

    // Still a decision the producer can make: cancelling it.
    expect(handle.cancel().ok).toBe(true);
    expect(handle.status).toBe("cancelled");
    expect(handle.isStale).toBe(false);
    expect(handle.apply()).toMatchObject({ ok: false, reason: "not_pending" });
  });

  it("is not stale while the project stays where it was validated", () => {
    const handle = propose();
    expect(handle.isStale).toBe(false);
    handle.apply();
    // Its own commit moves the revision; that does not make it stale.
    expect(handle.isStale).toBe(false);
  });
});

describe("an explanation (explain_change)", () => {
  const explanation = {
    goal: "The bassline clears the kick.",
    technique: "An octave up moves its energy out of the kick's range.",
  };

  it("is carried beside the commands, never as one", () => {
    const input = notesProposal();
    const handle = propose({
      ...input,
      calls: [{ name: EXPLAIN_TOOL_NAME, input: explanation }, ...input.calls],
    });
    expect(handle.proposal.explanation).toEqual(explanation);
    expect(handle.proposal.commands).toHaveLength(3);
    expect(handle.proposal.commands.map((command) => command.type)).not.toContain(
      EXPLAIN_TOOL_NAME,
    );
  });

  it("is null when there is none, and when it does not parse, without costing the proposal", () => {
    expect(propose().proposal.explanation).toBeNull();
    const input = notesProposal();
    const handle = propose({
      ...input,
      calls: [...input.calls, { name: EXPLAIN_TOOL_NAME, input: { goal: "" } }],
    });
    expect(handle.proposal.explanation).toBeNull();
  });

  it("is not a proposal on its own", () => {
    const result = validateProposal(fx.project, {
      baseRevision: fx.project.metadata.revision,
      calls: [{ name: EXPLAIN_TOOL_NAME, input: explanation }],
    });
    expect(result.ok ? null : result.issues).toMatchObject([{ code: "malformed" }]);
  });
});

describe("the tool set version", () => {
  it("accepts a proposal made against this tool set", () => {
    const result = executor.propose({
      ...notesProposal(),
      toolsetVersion: ASSISTANT_TOOLSET_VERSION,
    });
    expect(result.ok).toBe(true);
  });

  it("refuses one made against another, and changes nothing", () => {
    const result = executor.propose({
      ...notesProposal(),
      toolsetVersion: ASSISTANT_TOOLSET_VERSION + 1,
    });
    expect(result.ok ? null : result.issues).toMatchObject([
      { code: "toolset_mismatch", callIndex: null },
    ]);
    expectNoChange();
    expect(logged.map((entry) => entry.params.issue_code)).toEqual(["toolset_mismatch"]);
  });
});

describe("the impact of a valid proposal", () => {
  it("summarizes each command and what it changes, without changing anything", () => {
    const result = validateProposal(fx.project, notesProposal());
    if (!result.ok) throw new Error(JSON.stringify(result.issues));
    const { proposal } = result;
    expect(proposal.intent).toBe(INTENT);
    expect(proposal.capability).toBe("notes");
    expect(proposal.commands.map((command) => command.version)).toEqual([1, 1, 1]);
    expect(proposal.impact.lines.map((line) => line.commandType)).toEqual([
      "notes.transpose",
      "note.add",
      "notes.transpose",
    ]);
    for (const line of proposal.impact.lines) {
      expect(line.summary.length).toBeGreaterThan(0);
      expect(line.controls).toContainEqual({ entity: fx.clipAId, param: "notes" });
    }
    expect(proposal.impact.controls).toEqual([{ entity: fx.clipAId, param: "notes" }]);
    expect(proposal.impact.clips).toEqual({
      added: [],
      removed: [],
      changed: [fx.clipAId],
    });
    expect(proposal.impact.tracks).toEqual({ added: [], removed: [], changed: [] });
    expect(proposal.impact.songSettingsChanged).toBe(false);
    expect(proposal.impact.summary).toMatch(/\(\+2 more changes\)$/);
    expectNoChange();
  });

  it("reports a mixed proposal and song-level changes", () => {
    const result = validateProposal(fx.project, {
      baseRevision: fx.project.metadata.revision,
      calls: [
        call(setParameter({ scope: "song", parameterId: SONG_TEMPO.id }, 100)),
        call(
          setParameter(
            { scope: "track", trackId: fx.trackAId, parameterId: TRACK_VOLUME.id },
            -3,
          ),
        ),
      ],
    });
    if (!result.ok) throw new Error(JSON.stringify(result.issues));
    expect(result.proposal.capability).toBe("mixed");
    expect(result.proposal.capabilities).toEqual(["tempo", "mixer"]);
    expect(result.proposal.impact.songSettingsChanged).toBe(true);
    expect(result.proposal.impact.tracks.changed).toEqual([fx.trackAId]);
  });
});

describe("applying, cancelling and undoing", () => {
  it("applies atomically as one history entry and one revision, as the assistant", () => {
    const handle = propose();
    const applied = handle.apply();
    expect(applied.ok).toBe(true);
    expect(handle.status).toBe("applied");
    expect(history.entries).toHaveLength(1);
    const [entry] = history.entries;
    expect(entry.actor).toBe("assistant");
    expect(entry.correlationId).toBe(handle.id);
    expect(entry.commands).toHaveLength(3);
    expect(history.project.metadata.revision).toBe(fx.project.metadata.revision + 1);
    expect(handle.apply()).toMatchObject({ ok: false, reason: "not_pending" });
    expect(history.entries).toHaveLength(1);
  });

  it("undoes exactly, back to the project it was applied to", () => {
    const original = contentSignature(fx.project);
    const handle = propose();
    handle.apply();
    expect(handle.undo().ok).toBe(true);
    expect(handle.status).toBe("undone");
    expect(contentSignature(history.project)).toBe(original);
    // Redo replays it as the same single entry.
    history.redo();
    expect(history.entries).toHaveLength(1);
    expect(handle.undo()).toMatchObject({ ok: false, reason: "not_applied" });
  });

  it("follows an undo and a redo of its entry made through the history", () => {
    const original = contentSignature(fx.project);
    const handle = propose();
    handle.apply();
    history.undo();
    handle.followHistory("undo");
    expect(handle.status).toBe("undone");
    expect(logged.map(({ name }) => name)).toEqual([
      "assistant_proposal_shown",
      "assistant_proposal_applied",
      "assistant_proposal_undone",
    ]);
    history.redo();
    handle.followHistory("redo");
    expect(handle.status).toBe("applied");
    expect(handle.undo().ok).toBe(true);
    expect(contentSignature(history.project)).toBe(original);
    // Its own undo already moved it, so hearing of it again changes nothing.
    handle.followHistory("undo");
    expect(
      logged.filter(({ name }) => name === "assistant_proposal_undone"),
    ).toHaveLength(2);
    // A redo of an entry it never applied is not its to follow.
    const pending = propose(notesProposal(history.project.metadata.revision));
    pending.followHistory("redo");
    expect(pending.status).toBe("pending");
  });

  it("refuses to undo once something else has been committed after it", () => {
    const handle = propose();
    handle.apply();
    history.execute(updateTrack(fx.trackBId, { name: "Kit" }));
    const latest = history.project;
    expect(handle.undo()).toMatchObject({ ok: false, reason: "not_latest" });
    expect(history.project).toBe(latest);
    expect(handle.status).toBe("applied");
  });

  it("waits for an open gesture rather than joining it", () => {
    const handle = propose();
    const gesture = history.beginGesture();
    gesture.apply(setTrackFlag(fx.trackBId, "muted", true));
    expect(handle.apply()).toMatchObject({ ok: false, reason: "busy" });
    expect(handle.status).toBe("pending");
    gesture.cancel();
    expect(handle.apply().ok).toBe(true);
    expect(history.entries).toHaveLength(1);

    const second = history.beginGesture();
    expect(handle.undo()).toMatchObject({ ok: false, reason: "busy" });
    second.cancel();
    expect(handle.undo().ok).toBe(true);
  });

  it("cancels without changing anything", () => {
    const handle = propose();
    expect(handle.cancel()).toEqual({ ok: true, result: null });
    expect(handle.status).toBe("cancelled");
    expectNoChange();
    expect(handle.cancel()).toMatchObject({ ok: false, reason: "not_pending" });
    expect(handle.apply()).toMatchObject({ ok: false, reason: "not_pending" });
    expectNoChange();
  });
});

describe("analytics", () => {
  it("logs shown, applied and undone once each, bucketed", () => {
    const handle = propose();
    clock.advance(40_000);
    handle.apply();
    handle.apply();
    clock.advance(3_000);
    handle.undo();
    handle.undo();
    expect(logged).toEqual([
      {
        name: "assistant_proposal_shown",
        params: { capability: "notes", command_count_bucket: "2_5" },
      },
      {
        name: "assistant_proposal_applied",
        params: {
          capability: "notes",
          command_count_bucket: "2_5",
          seconds_to_decision_bucket: "31_120s",
        },
      },
      {
        name: "assistant_proposal_undone",
        params: {
          capability: "notes",
          command_count_bucket: "2_5",
          seconds_to_undo_bucket: "0_5s",
        },
      },
    ]);
  });

  it("logs a cancel once, with the time to decide", () => {
    const handle = propose({
      baseRevision: fx.project.metadata.revision,
      calls: [call(setTrackFlag(fx.trackAId, "muted", true))],
    });
    clock.advance(15 * 60_000);
    handle.cancel();
    handle.cancel();
    expect(logged.slice(1)).toEqual([
      {
        name: "assistant_proposal_cancelled",
        params: {
          capability: "mixer",
          command_count_bucket: "1",
          seconds_to_decision_bucket: "10m_plus",
        },
      },
    ]);
  });

  it("logs only what the catalog declares, and never the proposal's content", () => {
    const handle = propose();
    handle.apply();
    handle.undo();
    const cancelled = propose(notesProposal(history.project.metadata.revision));
    cancelled.cancel();
    for (const { name, params } of logged) {
      const { issues } = validateEventPayload(
        name as Parameters<typeof validateEventPayload>[0],
        params,
      );
      expect(issues, name).toEqual([]);
      const text = JSON.stringify(params);
      expect(text).not.toContain(INTENT);
      expect(text).not.toContain("Bassline");
      expect(text).not.toContain(fx.clipAId);
      expect(text).not.toMatch(/transpose|Transpose/);
    }
  });
});

describe("an instrument change that adds pads (GRV-138)", () => {
  /** What a model sends: the drum machine's pads, the old ones with no sound. */
  function addPadsProposal() {
    const track = fx.project.song.tracks.find(
      (candidate) => candidate.id === fx.trackBId,
    );
    if (track?.instrument?.kind !== "drumMachine") throw new Error("fixture changed");
    const context = createTestFactoryContext("grv138");
    const newPad = createDrumPad(context, { name: "Rim" });
    const existing = track.instrument.pads.map((pad) => ({
      ...pad,
      assetId: null,
      mixer: { ...pad.mixer, volume: 0 },
    }));
    return {
      baseRevision: fx.project.metadata.revision,
      intent: "Add a rim pad",
      calls: [
        call({
          type: "instrument.change",
          version: 1,
          payload: {
            trackId: fx.trackBId,
            instrument: { ...track.instrument, pads: [...existing, newPad] },
          },
        }),
      ],
      newPadId: newPad.id,
    };
  }

  function drumPads(project: typeof fx.project) {
    const track = project.song.tracks.find((candidate) => candidate.id === fx.trackBId);
    return track?.instrument?.kind === "drumMachine" ? track.instrument.pads : [];
  }

  it("keeps the samples of the pads it already has, and undoes as one step", () => {
    const before = drumPads(fx.project);
    const { newPadId, ...input } = addPadsProposal();
    const handle = propose(input);
    expect(handle.apply().ok).toBe(true);
    const after = drumPads(history.project);
    expect(after.map((pad) => pad.id)).toEqual([
      ...before.map((pad) => pad.id),
      newPadId,
    ]);
    expect(after.slice(0, before.length)).toEqual(before);
    expect(after[before.length].assetId).toBeNull();
    expect(history.entries).toHaveLength(1);
    expect(handle.undo().ok).toBe(true);
    expect(drumPads(history.project)).toEqual(before);
  });

  it("takes a sound the proposal gives an existing pad", () => {
    const { newPadId: _, ...input } = addPadsProposal();
    const call0 = input.calls[0].input as {
      instrument: { pads: { id: string; assetId: string | null }[] };
    };
    call0.instrument.pads[1].assetId = fx.assetIds.pad;
    propose(input).apply();
    expect(drumPads(history.project)[1].assetId).toBe(fx.assetIds.pad);
  });
});
