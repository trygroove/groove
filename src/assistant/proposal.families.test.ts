/**
 * Every Appendix A command family the assistant carries (GRV-4), five ways:
 * its tools' schema, its authorization, a proposal the kernel refuses for an
 * invariant, a malformed call, and a round trip (apply, then undo returns the
 * original project).
 */
import { describe, expect, it } from "vitest";
import {
  addClip,
  addDevice,
  addNotes,
  addPlacement,
  addReturn,
  addSend,
  addTrack,
  changeInstrument,
  createCommandHistory,
  duplicateDevice,
  insertChain,
  masterChain,
  type RawCommandInput,
  removeClip,
  removeDevice,
  removeNotes,
  removePlacement,
  removeReturn,
  removeSend,
  removeTrack,
  reorderDevice,
  reorderTrack,
  resetDevice,
  setDeviceBypass,
  setPadAsset,
  setPadParameter,
  setParameter,
  setSample,
  setTrackFlag,
  transposeNotes,
  updateClip,
  updateNotes,
  updatePlacement,
  updateReturn,
  updateTrack,
} from "../commands";
import {
  ABSENT_IDS,
  type CommandTestProject,
  contentSignature,
  createCommandTestProject,
  createTestFactoryContext,
} from "../commands/testProjects";
import {
  type AssetId,
  bareParameterId,
  bars,
  createDevice,
  createNoteClip,
  createNoteEvent,
  createPlacement,
  createReturnBus,
  createSend,
  createSynthInstrument,
  createTrack,
  type DeviceId,
  getParameterDefinition,
  MASTER_VOLUME,
  PAD_PITCH,
  RETURN_VOLUME,
  SONG_SWING,
  SONG_TEMPO,
  SYNTH_FILTER_CUTOFF,
  TICKS_PER_SIXTEENTH,
  TRACK_SEND_LEVEL,
  TRACK_VOLUME,
  toTicks,
} from "../domain";
import { createManualClock } from "../shared/clock";
import { historyProposalTarget } from "./historyProposalTarget";
import { type ProposalIssueCode, validateProposal } from "./proposal";
import { createProposalExecutor } from "./proposalExecutor";
import {
  type AssistantCapability,
  assistantTools,
  type ProposalCapability,
  toolNameFor,
} from "./tools";

interface ToolCall {
  readonly name: string;
  readonly input: unknown;
}

/** A command as the model would call it. */
function call(command: RawCommandInput): ToolCall {
  return { name: toolNameFor(command.type), input: command.payload };
}

function proposalOf(fx: CommandTestProject, calls: readonly ToolCall[]) {
  return { baseRevision: fx.project.metadata.revision, calls };
}

interface FamilyCase {
  readonly capability: AssistantCapability;
  /** A valid multi-command proposal in this family. */
  readonly valid: (fx: CommandTestProject) => readonly ToolCall[];
  /** A call that fails the command's own payload schema. */
  readonly badSchema: (fx: CommandTestProject) => ToolCall;
  /** A call the allowlist refuses, and how. */
  readonly unauthorized: (fx: CommandTestProject) => ToolCall;
  readonly unauthorizedCode: "unknown_tool" | "unauthorized";
  /**
   * A well-formed proposal that is refused before it changes anything: a
   * missing ID, a broken invariant or, for the song's tempo (which always
   * exists), a value outside its range.
   */
  readonly invariant: (fx: CommandTestProject) => readonly ToolCall[];
}

const context = createTestFactoryContext("assistant-families");
const newDeviceId = (): DeviceId => context.ids("device");
const absentAsset = context.ids("asset") as AssetId;

const FAMILIES: readonly FamilyCase[] = [
  {
    capability: "tempo",
    valid: () => [
      call(setParameter({ scope: "song", parameterId: SONG_TEMPO.id }, 96)),
      call(setParameter({ scope: "song", parameterId: SONG_TEMPO.id }, 128)),
      call(setParameter({ scope: "song", parameterId: SONG_SWING.id }, 58)),
    ],
    badSchema: () => ({
      name: "parameter_set",
      input: { target: { scope: "song", parameterId: SONG_TEMPO.id }, value: "fast" },
    }),
    // The song's tempo and swing are the assistant's; nothing else at song scope is.
    unauthorized: () => call(setParameter({ scope: "song", parameterId: "song.key" }, 1)),
    unauthorizedCode: "unauthorized",
    // The tempo always exists; its invariant is its range, refused, not clamped.
    invariant: () => [
      call(setParameter({ scope: "song", parameterId: SONG_TEMPO.id }, 1_000)),
    ],
  },
  {
    capability: "tracks",
    valid: (fx) => [
      call(addTrack(createTrack(context, { name: "Pad", order: 2 }))),
      call(updateTrack(fx.trackAId, { name: "Sub" })),
      call(reorderTrack(fx.trackBId, 0)),
      call(removeTrack(fx.trackAId)),
    ],
    badSchema: (fx) => call(updateTrack(fx.trackAId, {})),
    unauthorized: () => {
      const track = createTrack(context, { name: "Automated", order: 2 });
      return call(
        addTrack(track, {
          automation: [
            {
              id: context.ids("automation"),
              target: { scope: "track", trackId: track.id, parameterId: TRACK_VOLUME.id },
              interpolation: "linear",
              points: [],
            },
          ],
        }),
      );
    },
    unauthorizedCode: "unauthorized",
    // Two tracks with one ID.
    invariant: (fx) => {
      const original = fx.project.song.tracks[1];
      return [call(addTrack({ ...original, name: "Twin", order: 2 }))];
    },
  },
  {
    capability: "clips",
    valid: (fx) => [
      // An independent variation: a copy with new IDs throughout.
      call(
        addClip(
          createNoteClip(context, {
            trackId: fx.trackAId,
            name: "Bassline B",
            events: [
              createNoteEvent(context, {
                startTicks: 0,
                durationTicks: TICKS_PER_SIXTEENTH,
                pitch: 40,
              }),
            ],
          }),
        ),
      ),
      call(updateClip(fx.clipAId, { name: "Bassline A" })),
      call(removeClip(fx.clipBId)),
    ],
    badSchema: (fx) => call(updateClip(fx.clipAId, { lengthTicks: -1 as never })),
    unauthorized: (fx) => ({ name: "clip_duplicate", input: { clipId: fx.clipAId } }),
    unauthorizedCode: "unknown_tool",
    invariant: () => [
      call(addClip(createNoteClip(context, { trackId: ABSENT_IDS.track, name: "Lost" }))),
    ],
  },
  {
    capability: "notes",
    valid: (fx) => [
      call(
        addNotes(fx.clipAId, [
          createNoteEvent(context, {
            startTicks: 2 * TICKS_PER_SIXTEENTH,
            durationTicks: TICKS_PER_SIXTEENTH,
            pitch: 43,
          }),
        ]),
      ),
      call(
        updateNotes(fx.clipAId, [{ eventId: fx.eventIds[1], changes: { velocity: 1 } }]),
      ),
      call(transposeNotes(fx.clipAId, null, 12)),
      call(removeNotes(fx.clipAId, [fx.eventIds[0]])),
    ],
    badSchema: (fx) => ({
      name: "notes_transpose",
      input: { clipId: fx.clipAId, eventIds: null, semitones: "up" },
    }),
    unauthorized: (fx) => ({
      name: "note_transform",
      input: { clipId: fx.clipAId, semitones: 12 },
    }),
    unauthorizedCode: "unknown_tool",
    invariant: (fx) => [
      call(
        updateNotes(fx.clipAId, [
          { eventId: ABSENT_IDS.event, changes: { velocity: 1 } },
        ]),
      ),
    ],
  },
  {
    capability: "placements",
    valid: (fx) => [
      call(
        addPlacement(
          createPlacement(context, {
            clipId: fx.clipAId,
            trackId: fx.trackAId,
            startTicks: bars(1),
            durationTicks: bars(2),
            looped: true,
          }),
        ),
      ),
      call(updatePlacement(fx.placementAId, { durationTicks: toTicks(bars(1) / 2) })),
      call(removePlacement(fx.project.song.placements[1].id)),
    ],
    badSchema: (fx) =>
      call(updatePlacement(fx.placementAId, { startTicks: -96 as never })),
    unauthorized: (fx) => ({
      name: "placement_duplicate",
      input: { placementId: fx.placementAId },
    }),
    unauthorizedCode: "unknown_tool",
    // A combination the domain refuses: the bass clip placed on the drum track.
    invariant: (fx) => [
      call(
        addPlacement(
          createPlacement(context, {
            clipId: fx.clipAId,
            trackId: fx.trackBId,
            startTicks: bars(4),
            durationTicks: bars(1),
          }),
        ),
      ),
    ],
  },
  {
    capability: "instrument",
    valid: (fx) => [
      call(changeInstrument(fx.trackAId, createSynthInstrument())),
      // Depends on the change before it: the cutoff only exists on a synth.
      call(
        setParameter(
          {
            scope: "instrument",
            trackId: fx.trackAId,
            parameterId: bareParameterId(SYNTH_FILTER_CUTOFF.id),
          },
          800,
        ),
      ),
      call(setPadAsset(fx.trackBId, fx.padIds[1], fx.assetIds.unused)),
      call(setPadParameter(fx.trackBId, fx.padIds[0], PAD_PITCH.id, 3)),
    ],
    badSchema: (fx) => ({
      name: "instrument_setSample",
      input: { trackId: fx.trackAId, assetId: "a-sound" },
    }),
    unauthorized: (fx) => ({
      name: "asset_add",
      input: { asset: fx.project.song.assets[0] },
    }),
    unauthorizedCode: "unknown_tool",
    invariant: (fx) => [call(setSample(fx.trackAId, absentAsset))],
  },
  {
    capability: "devices",
    valid: (fx) => {
      const reverb = createDevice(newDeviceId(), "reverb", 2);
      const [reverbParameter] = Object.keys(reverb.parameters);
      return [
        call(addDevice(insertChain(fx.trackAId), reverb)),
        call(
          setParameter(
            {
              scope: "trackDevice",
              trackId: fx.trackAId,
              deviceId: reverb.id,
              parameterId: reverbParameter,
            },
            reverb.parameters[reverbParameter] / 2,
          ),
        ),
        call(setDeviceBypass(insertChain(fx.trackAId), fx.deviceId, true)),
        call(reorderDevice(insertChain(fx.trackAId), fx.device2Id, 0)),
        call(duplicateDevice(insertChain(fx.trackAId), reverb.id, newDeviceId())),
        call(resetDevice(insertChain(fx.trackAId), reverb.id)),
        call(addDevice(masterChain, createDevice(newDeviceId(), "reverb", 0))),
        call(removeDevice(insertChain(fx.trackAId), fx.deviceId)),
      ];
    },
    badSchema: (fx) => ({
      name: "device_reorder",
      input: { target: insertChain(fx.trackAId), deviceId: fx.deviceId, toIndex: -1 },
    }),
    unauthorized: (fx) => ({
      name: "device_restoreParameters",
      input: { target: insertChain(fx.trackAId), deviceId: fx.deviceId, parameters: {} },
    }),
    unauthorizedCode: "unknown_tool",
    invariant: (fx) => [
      call(setDeviceBypass(insertChain(fx.trackAId), ABSENT_IDS.device, true)),
    ],
  },
  {
    capability: "returns",
    valid: (fx) => {
      const delay = createReturnBus(context, { name: "Delay", order: 1 });
      return [
        call(addReturn(delay)),
        call(addSend(fx.trackBId, createSend(delay.id, 0.4))),
        call(
          setParameter(
            {
              scope: "send",
              trackId: fx.trackAId,
              returnId: fx.returnId,
              parameterId: TRACK_SEND_LEVEL.id,
            },
            0.5,
          ),
        ),
        call(
          setParameter(
            { scope: "return", returnId: delay.id, parameterId: RETURN_VOLUME.id },
            -9,
          ),
        ),
        call(updateReturn(fx.returnId, { name: "Hall" })),
        call(removeSend(fx.trackAId, fx.returnId)),
        call(removeReturn(fx.returnId)),
      ];
    },
    badSchema: (fx) => call(updateReturn(fx.returnId, { name: "" })),
    unauthorized: (fx) =>
      call(
        addSend(fx.trackBId, createSend(fx.returnId), {
          automation: [
            {
              id: context.ids("automation"),
              target: {
                scope: "send",
                trackId: fx.trackBId,
                returnId: fx.returnId,
                parameterId: TRACK_SEND_LEVEL.id,
              },
              interpolation: "linear",
              points: [],
            },
          ],
        }),
      ),
    unauthorizedCode: "unauthorized",
    invariant: (fx) => [call(addSend(fx.trackBId, createSend(ABSENT_IDS.return)))],
  },
  {
    capability: "mixer",
    valid: (fx) => [
      call(
        setParameter(
          { scope: "track", trackId: fx.trackAId, parameterId: TRACK_VOLUME.id },
          -6,
        ),
      ),
      call(setParameter({ scope: "master", parameterId: MASTER_VOLUME.id }, -3)),
      call(setTrackFlag(fx.trackBId, "muted", true)),
      call(setTrackFlag(fx.trackAId, "soloed", true)),
    ],
    badSchema: (fx) => ({
      name: "track_setFlag",
      input: { trackId: fx.trackAId, flag: "loud", value: true },
    }),
    unauthorized: (fx) => ({
      name: "drum_setPadFlag",
      input: { trackId: fx.trackBId, padId: fx.padIds[0], flag: "muted", value: true },
    }),
    unauthorizedCode: "unknown_tool",
    invariant: () => [
      call(
        setParameter(
          { scope: "track", trackId: ABSENT_IDS.track, parameterId: TRACK_VOLUME.id },
          -6,
        ),
      ),
    ],
  },
];

function expectRefused(
  fx: CommandTestProject,
  calls: readonly ToolCall[],
  codes: readonly ProposalIssueCode[],
): void {
  const before = contentSignature(fx.project);
  const history = createCommandHistory(fx.project);
  const executor = createProposalExecutor({
    target: historyProposalTarget(history),
    analytics: { log() {} },
  });
  const result = executor.propose(proposalOf(fx, calls));
  expect(result.ok).toBe(false);
  if (result.ok) return;
  expect(result.issues.length).toBeGreaterThan(0);
  for (const issue of result.issues) expect(codes).toContain(issue.code);
  // No change: the same project object, no history entry.
  expect(history.project).toBe(fx.project);
  expect(history.entries).toHaveLength(0);
  expect(contentSignature(history.project)).toBe(before);
}

it("covers every capability with a family case", () => {
  expect(FAMILIES.map((family) => family.capability).sort()).toEqual(
    [
      "clips",
      "devices",
      "instrument",
      "mixer",
      "notes",
      "placements",
      "returns",
      "tempo",
      "tracks",
    ].sort(),
  );
});

describe.each(FAMILIES)("the $capability family", (family) => {
  it("offers each of its tools with an object input schema from the command", () => {
    const fx = createCommandTestProject();
    const tools = assistantTools();
    for (const toolCall of family.valid(fx)) {
      const tool = tools.find((candidate) => candidate.name === toolCall.name);
      expect(tool, toolCall.name).toBeDefined();
      expect(tool?.capabilities).toContain(family.capability);
      expect(tool?.inputSchema.type).toBe("object");
    }
  });

  it("refuses a call that fails its payload schema", () => {
    const fx = createCommandTestProject();
    const valid = family.valid(fx);
    expectRefused(fx, [...valid, family.badSchema(fx)], ["invalid_payload"]);
    const result = validateProposal(fx.project, proposalOf(fx, [family.badSchema(fx)]));
    expect(result.ok ? null : result.issues[0]).toMatchObject({
      code: "invalid_payload",
      callIndex: 0,
    });
  });

  it("refuses a call outside the allowlist", () => {
    const fx = createCommandTestProject();
    expectRefused(fx, [family.unauthorized(fx)], [family.unauthorizedCode]);
    // One refused call refuses the whole proposal, however many are valid.
    expectRefused(
      fx,
      [...family.valid(fx), family.unauthorized(fx)],
      [family.unauthorizedCode],
    );
  });

  it("refuses a missing ID or a broken invariant before anything changes", () => {
    const fx = createCommandTestProject();
    const codes: ProposalIssueCode[] = ["rejected", "invalid_project", "out_of_range"];
    expectRefused(fx, family.invariant(fx), codes);
    // Atomic: valid commands ahead of the refused one do not land either.
    expectRefused(fx, [...family.valid(fx), ...family.invariant(fx)], codes);
  });

  it("refuses malformed calls", () => {
    const fx = createCommandTestProject();
    const [first] = family.valid(fx);
    for (const input of [undefined, null, "set it", 42, [], {}]) {
      expectRefused(fx, [{ name: first.name, input }], ["invalid_payload"]);
    }
    expectRefused(
      fx,
      [{ name: `${first.name}_v2`, input: first.input }],
      ["unknown_tool"],
    );
    // The command type itself is not a tool name.
    expectRefused(
      fx,
      [{ name: first.name.replace("_", "."), input: first.input }],
      ["unknown_tool"],
    );
  });

  it("applies as one history entry and undoes back to the original", () => {
    const fx = createCommandTestProject();
    const original = contentSignature(fx.project);
    const history = createCommandHistory(fx.project);
    const logged: { name: string; capability: ProposalCapability }[] = [];
    const executor = createProposalExecutor({
      target: historyProposalTarget(history),
      analytics: {
        log(name, ...args) {
          const [params] = args as unknown as [{ capability: ProposalCapability }];
          logged.push({ name, capability: params.capability });
        },
      },
      clock: createManualClock(0),
    });
    const proposed = executor.propose(proposalOf(fx, family.valid(fx)));
    if (!proposed.ok) throw new Error(JSON.stringify(proposed.issues));
    expect(proposed.handle.proposal.capability).toBe(family.capability);

    const applied = proposed.handle.apply();
    expect(applied.ok).toBe(true);
    expect(history.entries).toHaveLength(1);
    expect(history.entries[0].actor).toBe("assistant");
    expect(history.entries[0].commands).toHaveLength(family.valid(fx).length);
    expect(history.project.metadata.revision).toBe(fx.project.metadata.revision + 1);
    expect(contentSignature(history.project)).not.toBe(original);

    expect(proposed.handle.undo().ok).toBe(true);
    expect(contentSignature(history.project)).toBe(original);
    expect(history.entries).toHaveLength(0);
    expect(logged.map((entry) => entry.capability)).toEqual([
      family.capability,
      family.capability,
      family.capability,
    ]);
  });
});

describe("a value outside its parameter's range", () => {
  const above = (definition: { readonly max: number }) => definition.max + 1;

  it.each<[string, (fx: CommandTestProject) => readonly ToolCall[]]>([
    [
      "a tempo",
      () => [call(setParameter({ scope: "song", parameterId: SONG_TEMPO.id }, 1_000))],
    ],
    [
      "a tempo below the range",
      () => [call(setParameter({ scope: "song", parameterId: SONG_TEMPO.id }, 1))],
    ],
    [
      "a track volume",
      (fx) => [
        call(
          setParameter(
            { scope: "track", trackId: fx.trackAId, parameterId: TRACK_VOLUME.id },
            500,
          ),
        ),
      ],
    ],
    [
      "the master volume",
      () => [
        call(
          setParameter(
            { scope: "master", parameterId: MASTER_VOLUME.id },
            above(MASTER_VOLUME),
          ),
        ),
      ],
    ],
    [
      "a send level",
      (fx) => [
        call(
          setParameter(
            {
              scope: "send",
              trackId: fx.trackAId,
              returnId: fx.returnId,
              parameterId: TRACK_SEND_LEVEL.id,
            },
            above(TRACK_SEND_LEVEL),
          ),
        ),
      ],
    ],
    [
      "a return volume",
      (fx) => [
        call(
          setParameter(
            { scope: "return", returnId: fx.returnId, parameterId: RETURN_VOLUME.id },
            above(RETURN_VOLUME),
          ),
        ),
      ],
    ],
    [
      "a device parameter, on a device the same proposal adds",
      (fx) => {
        const reverb = createDevice(newDeviceId(), "reverb", 2);
        const [parameterId] = Object.keys(reverb.parameters);
        const definition = getParameterDefinition(`reverb.${parameterId}`);
        if (!definition) throw new Error("expected a reverb parameter");
        return [
          call(addDevice(insertChain(fx.trackAId), reverb)),
          call(
            setParameter(
              {
                scope: "trackDevice",
                trackId: fx.trackAId,
                deviceId: reverb.id,
                parameterId,
              },
              above(definition),
            ),
          ),
        ];
      },
    ],
    [
      "an instrument parameter",
      (fx) => [
        call(changeInstrument(fx.trackAId, createSynthInstrument())),
        call(
          setParameter(
            {
              scope: "instrument",
              trackId: fx.trackAId,
              parameterId: bareParameterId(SYNTH_FILTER_CUTOFF.id),
            },
            above(SYNTH_FILTER_CUTOFF),
          ),
        ),
      ],
    ],
    [
      "a drum pad's pitch",
      (fx) => [call(setPadParameter(fx.trackBId, fx.padIds[0], PAD_PITCH.id, 9_999))],
    ],
  ])("refuses %s, and changes nothing", (_label, calls) => {
    const fx = createCommandTestProject();
    expectRefused(fx, calls(fx), ["out_of_range"]);
    const result = validateProposal(fx.project, proposalOf(fx, calls(fx)));
    expect(result.ok ? null : result.issues).toEqual([
      expect.objectContaining({ code: "out_of_range", callIndex: calls(fx).length - 1 }),
    ]);
  });

  it("allows the range's own ends", () => {
    const fx = createCommandTestProject();
    const result = validateProposal(
      fx.project,
      proposalOf(fx, [
        call(setParameter({ scope: "song", parameterId: SONG_TEMPO.id }, SONG_TEMPO.max)),
        call(setPadParameter(fx.trackBId, fx.padIds[0], PAD_PITCH.id, PAD_PITCH.min)),
      ]),
    );
    expect(result.ok).toBe(true);
  });
});
