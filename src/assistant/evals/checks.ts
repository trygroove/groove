/**
 * The assistant evals' checks (GRV-6): the whole list, deliberately short.
 *
 * Every check is a pure function of a fixture project, a proposal and the
 * reply's text, and none compares exact notes: we have no experience of the
 * model yet, and a tight rule now would constrain it before we know where it
 * is weak. Each returns `pass`, `fail` or `skip` (it cannot be judged, because
 * the proposal never got as far as applying) with a one-line reason.
 *
 * 1. {@link checkValid}: parses against the tool schema and applies through
 *    the GRV-4 executor with no rejected command or broken invariant.
 * 2. {@link checkBundled}: ordinary commands on ordinary entities, and every
 *    asset referenced resolves in the factory library.
 * 3. {@link checkInScope}: changes only what the case allows.
 * 4. {@link checkAtomicUndo}: one history entry, and one undo restores the
 *    canonical song state byte for byte.
 * 5. {@link checkGrounded}: every control the explanation names is one the
 *    proposal changes.
 * 6. {@link checkNotFlattened}: an extreme proposal is not identical to a
 *    conventional one.
 */
import {
  CONTROL_PARTS,
  type ControlAddress,
  MASTER_ENTITY,
  SONG_ENTITY,
} from "../../commands/controlAddress";
import { createCommandHistory } from "../../commands/history";
import type { RawCommandInput } from "../../commands/types";
import { readControl } from "../../controls/readControl";
import { deviceParameters, deviceTypeDefinition } from "../../domain/devices";
import type { Device, Project } from "../../domain/entities";
import { ID_PREFIXES, ID_SUFFIX_LENGTH } from "../../domain/ids";
import { bareParameterId, instrumentParameters } from "../../domain/parameters";
import { serializeClip, serializeSong } from "../../domain/serialize";
import { factoryLibrary } from "../../library/factoryLibrary";
import { historyProposalTarget } from "../historyProposalTarget";
import { type ValidProposal, validateProposal } from "../proposal";
import { createProposalExecutor, type ProposalTarget } from "../proposalExecutor";
import { ASSISTANT_COMMAND_TYPES } from "../tools";
import type { ResolvedScope } from "./cases";

export type CheckStatus = "pass" | "fail" | "skip";

export interface CheckResult {
  readonly status: CheckStatus;
  readonly detail: string;
  /**
   * What kind of failure it was, for a check that tells them apart (check 1:
   * {@link ValidFailureKind}). The detail starts with it too.
   */
  readonly kind?: string;
}

export const CHECK_IDS = [
  "valid",
  "bundled",
  "inScope",
  "atomicUndo",
  "grounded",
  "notFlattened",
] as const;
export type CheckId = (typeof CHECK_IDS)[number];

export const CHECK_LABELS: Record<CheckId, string> = {
  valid: "1. Valid",
  bundled: "2. Editable, bundled sources only",
  inScope: "3. In scope",
  atomicUndo: "4. Atomic undo",
  grounded: "5. Grounded explanation",
  notFlattened: "6. Extreme is not flattened",
};

const pass = (detail: string): CheckResult => ({ status: "pass", detail });
const fail = (detail: string): CheckResult => ({ status: "fail", detail });
export const skip = (detail: string): CheckResult => ({ status: "skip", detail });

/** Analytics the evals hand the executor: a developer tool logs nothing. */
const NO_ANALYTICS = { log() {} };

// ---------------------------------------------------------------------------
// 1. Valid
// ---------------------------------------------------------------------------

/**
 * Why a proposal failed check 1, so a run can show where its failures cluster:
 *
 * - `no proposal`: the reply changed nothing (it asked, was cut off, or only
 *   talked);
 * - `schema`: a call is not one the tool set takes as written (an unknown
 *   tool, a payload or ID in the wrong shape, input that did not parse);
 * - `range`: a value is outside its parameter's range;
 * - `executor`: well formed, but the kernel or the executor refused it (a
 *   missing ID, a broken invariant).
 */
export type ValidFailureKind = "no proposal" | "schema" | "range" | "executor";

const failValid = (kind: ValidFailureKind, detail: string): CheckResult => ({
  status: "fail",
  detail: `${kind}: ${detail}`,
  kind,
});

const EXECUTOR_ISSUES: ReadonlySet<string> = new Set(["rejected", "invalid_project"]);

export interface ValidOutcome {
  readonly result: CheckResult;
  /** The validated proposal and the project it leaves, when it applied. */
  readonly applied: { readonly proposal: ValidProposal; readonly after: Project } | null;
}

/**
 * Validates `proposal` against `project` and applies it through the executor
 * on a fresh history. `null` (a reply that proposed nothing) fails: every case
 * asks for a change. `noProposal` says why there was none, where the caller
 * knows.
 */
export function checkValid(
  project: Project,
  proposal: unknown,
  noProposal = "The reply proposed no change",
): ValidOutcome {
  if (proposal === null || proposal === undefined) {
    return { result: failValid("no proposal", noProposal), applied: null };
  }
  const validation = validateProposal(project, proposal);
  if (!validation.ok) {
    const issues = validation.issues
      .slice(0, 3)
      .map(
        (issue) =>
          `${issue.code}${issue.callIndex === null ? "" : ` (call ${issue.callIndex})`}: ${issue.message}`,
      );
    const more =
      validation.issues.length > 3 ? ` (+${validation.issues.length - 3} more)` : "";
    const [first] = validation.issues;
    const kind: ValidFailureKind = EXECUTOR_ISSUES.has(first.code)
      ? "executor"
      : first.code === "out_of_range"
        ? "range"
        : "schema";
    return { result: failValid(kind, `${issues.join("; ")}${more}`), applied: null };
  }
  const history = createCommandHistory(project);
  const executor = createProposalExecutor({
    target: historyProposalTarget(history),
    analytics: NO_ANALYTICS,
  });
  const proposed = executor.propose(proposal);
  if (!proposed.ok) {
    return {
      result: failValid("executor", proposed.issues[0]?.message ?? "Refused"),
      applied: null,
    };
  }
  const applied = proposed.handle.apply();
  if (!applied.ok) {
    return {
      result: failValid("executor", `The executor refused it: ${applied.reason}`),
      applied: null,
    };
  }
  return {
    result: pass(`${validation.proposal.commands.length} commands applied`),
    applied: { proposal: validation.proposal, after: history.project },
  };
}

// ---------------------------------------------------------------------------
// 2. Editable, bundled sources only
// ---------------------------------------------------------------------------

/** Every asset ID something in `project` plays. */
function referencedAssetIds(project: Project): Set<string> {
  const ids = new Set<string>();
  for (const track of project.song.tracks) {
    const instrument = track.instrument;
    if (instrument?.kind === "sampler" && instrument.assetId) ids.add(instrument.assetId);
    if (instrument?.kind === "drumMachine") {
      for (const pad of instrument.pads) if (pad.assetId) ids.add(pad.assetId);
    }
  }
  for (const clip of project.clips) {
    if (clip.content.kind === "audioLoop") ids.add(clip.content.assetId);
  }
  return ids;
}

const ALLOWED_COMMANDS: ReadonlySet<string> = new Set(ASSISTANT_COMMAND_TYPES);

/**
 * Every command is one of the assistant's ordinary commands (none adds an
 * asset), and every asset the resulting project plays is a factory library
 * sound: no audio generated, uploaded or pointed at from outside the library.
 */
export function checkBundled(
  commands: readonly RawCommandInput[],
  after: Project,
): CheckResult {
  const foreign = commands.filter((command) => !ALLOWED_COMMANDS.has(command.type));
  if (foreign.length > 0) {
    return fail(
      `Not an ordinary assistant command: ${[...new Set(foreign.map((command) => command.type))].join(", ")}`,
    );
  }
  const library = factoryLibrary();
  const assets = new Map<string, Project["song"]["assets"][number]>(
    after.song.assets.map((asset) => [asset.id, asset]),
  );
  const unresolved: string[] = [];
  for (const id of referencedAssetIds(after)) {
    const asset = assets.get(id);
    const bundled =
      asset &&
      library.some(
        (entry) =>
          entry.storageRef === asset.storageRef && entry.pack.id === asset.packId,
      );
    if (!bundled) unresolved.push(id);
  }
  if (unresolved.length > 0) {
    return fail(`Plays assets outside the factory library: ${unresolved.join(", ")}`);
  }
  return pass(
    `${commands.length} ordinary commands; every sound is from the factory library`,
  );
}

// ---------------------------------------------------------------------------
// 3. In scope
// ---------------------------------------------------------------------------

interface Identified {
  readonly id: string;
}

function changedIds<T extends Identified>(
  before: readonly T[],
  after: readonly T[],
): { added: T[]; removed: T[]; changed: T[] } {
  const beforeById = new Map(before.map((entity) => [entity.id, entity]));
  const afterIds = new Set(after.map((entity) => entity.id));
  const added: T[] = [];
  const changed: T[] = [];
  for (const entity of after) {
    const previous = beforeById.get(entity.id);
    if (!previous) added.push(entity);
    else if (JSON.stringify(previous) !== JSON.stringify(entity)) changed.push(previous);
  }
  return { added, removed: before.filter((entity) => !afterIds.has(entity.id)), changed };
}

function songSettings(project: Project): string {
  const { song } = project;
  return JSON.stringify([
    song.tempo,
    song.swing,
    song.key,
    song.loop,
    song.timeSignature,
  ]);
}

/**
 * The proposal changes only what the case's scope allows: the named tracks
 * (their settings, devices, clips and placements), new tracks if it may add
 * them, and the song, master, returns or sections only when allowed.
 */
export function checkInScope(
  before: Project,
  after: Project,
  scope: ResolvedScope,
): CheckResult {
  const problems: string[] = [];
  const trackName = (id: string) =>
    [...before.song.tracks, ...after.song.tracks].find((track) => track.id === id)
      ?.name ?? id;

  const tracks = changedIds(before.song.tracks, after.song.tracks);
  const newTracks = new Set<string>(tracks.added.map((track) => track.id));
  if (newTracks.size > 0 && !scope.createTracks) {
    problems.push(`adds tracks (${tracks.added.map((track) => track.name).join(", ")})`);
  }
  for (const track of [...tracks.changed, ...tracks.removed]) {
    if (!scope.tracks.has(track.id)) problems.push(`changes track "${track.name}"`);
  }
  const allowedTrack = (trackId: string) =>
    scope.tracks.has(trackId) || newTracks.has(trackId);

  const clips = changedIds(before.clips, after.clips);
  const clipTracks = new Set(
    [...clips.added, ...clips.changed, ...clips.removed].map((clip) => clip.trackId),
  );
  const placements = changedIds(before.song.placements, after.song.placements);
  for (const placement of [
    ...placements.added,
    ...placements.changed,
    ...placements.removed,
  ]) {
    clipTracks.add(placement.trackId);
  }
  for (const trackId of clipTracks) {
    if (!allowedTrack(trackId)) problems.push(`changes clips on "${trackName(trackId)}"`);
  }

  const sections = changedIds(before.song.sections, after.song.sections);
  if (
    !scope.sections &&
    sections.added.length + sections.changed.length + sections.removed.length > 0
  ) {
    problems.push("changes sections");
  }
  const returns = changedIds(before.song.returns, after.song.returns);
  if (
    !scope.returns &&
    returns.added.length + returns.changed.length + returns.removed.length > 0
  ) {
    problems.push("changes return buses");
  }
  if (!scope.song && songSettings(before) !== songSettings(after)) {
    problems.push("changes the song's settings");
  }
  if (
    !scope.master &&
    JSON.stringify(before.song.master) !== JSON.stringify(after.song.master)
  ) {
    problems.push("changes the master");
  }
  if (JSON.stringify(before.song.automation) !== JSON.stringify(after.song.automation)) {
    problems.push("changes automation");
  }
  const unique = [...new Set(problems)];
  return unique.length > 0
    ? fail(`Out of scope: ${unique.join("; ")}`)
    : pass("Within the case's scope");
}

// ---------------------------------------------------------------------------
// 4. Atomic undo
// ---------------------------------------------------------------------------

/**
 * The song as stored, in canonical order, without the revision bookkeeping an
 * undo moves on: what "byte-equivalent" compares.
 */
export function canonicalSongState(project: Project): string {
  const clips = [...project.clips]
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .map(serializeClip);
  return JSON.stringify({ song: serializeSong(project.song), clips });
}

/**
 * What check 4 applies a proposal to: a proposal target, and a count of the
 * undo entries it holds. The default is a fresh command history; a test can
 * hand in a broken one to prove the check notices.
 */
export interface UndoBench {
  readonly target: ProposalTarget;
  entryCount(): number;
}

export function historyBench(project: Project): UndoBench {
  const history = createCommandHistory(project);
  return {
    target: historyProposalTarget(history),
    entryCount: () => history.entries.length,
  };
}

/**
 * Applying the proposal through the executor makes exactly one history entry
 * and one revision, and one undo restores the canonical song state exactly.
 */
export function checkAtomicUndo(
  project: Project,
  proposal: unknown,
  bench: (project: Project) => UndoBench = historyBench,
): CheckResult {
  const { target, entryCount } = bench(project);
  const executor = createProposalExecutor({ target, analytics: NO_ANALYTICS });
  const proposed = executor.propose(proposal);
  if (!proposed.ok) return skip("The proposal does not apply");
  const applied = proposed.handle.apply();
  if (!applied.ok) return skip("The proposal does not apply");
  const entries = entryCount();
  const revisions = target.project.metadata.revision - project.metadata.revision;
  if (entries !== 1 || revisions !== 1) {
    return fail(`Applying made ${entries} history entries and ${revisions} revisions`);
  }
  const undone = proposed.handle.undo();
  if (!undone.ok) return fail(`One undo was refused: ${undone.reason}`);
  if (entryCount() !== 0) {
    return fail(`${entryCount()} history entries remain after one undo`);
  }
  if (canonicalSongState(target.project) !== canonicalSongState(project)) {
    return fail("One undo did not restore the song exactly");
  }
  return pass("One entry; one undo restores the song exactly");
}

// ---------------------------------------------------------------------------
// 5. Grounded explanation
// ---------------------------------------------------------------------------

/** A control a reply could name, and the words that name it. */
interface NameableControl {
  readonly address: ControlAddress;
  /** As the card would show it, e.g. "Bass volume", "Compressor threshold". */
  readonly label: string;
  readonly pattern: RegExp;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * The pattern that finds `label` in prose. The owner's name may take a
 * possessive ("Bass's volume"). A label of one word that is also ordinary
 * music talk (the song's tempo and swing) only counts when a number follows
 * it closely ("tempo to 128"), so "at this tempo" names nothing.
 */
function labelPattern(label: string, owner: string | null): RegExp {
  if (owner && label.toLowerCase().startsWith(`${owner.toLowerCase()} `)) {
    const rest = label.slice(owner.length + 1);
    return new RegExp(
      `(?<![\\w])${escapeRegExp(owner)}(?:'s|’s)?\\s+${escapeRegExp(rest)}(?![\\w])`,
      "i",
    );
  }
  if (!label.includes(" ")) {
    return new RegExp(
      `(?<![\\w])${escapeRegExp(label)}(?![\\w])[^.!?\\n\\d]{0,24}\\d`,
      "i",
    );
  }
  return new RegExp(`(?<![\\w])${escapeRegExp(label)}(?![\\w])`, "i");
}

function nameable(
  project: Project,
  address: ControlAddress,
  owner: string | null,
): NameableControl | null {
  const reading = readControl(project, address);
  if (!reading) return null;
  return { address, label: reading.label, pattern: labelPattern(reading.label, owner) };
}

function allDevices(project: Project): Device[] {
  const { song } = project;
  return [
    ...song.tracks.flatMap((track) => track.devices),
    ...song.returns.flatMap((bus) => bus.devices),
    ...song.master.devices,
  ];
}

/** Every value-bearing control in `project` a reply could name. */
export function nameableControls(project: Project): NameableControl[] {
  const { song } = project;
  const controls: (NameableControl | null)[] = [
    nameable(project, { entity: SONG_ENTITY, param: "tempo" }, null),
    nameable(project, { entity: SONG_ENTITY, param: "swing" }, null),
    nameable(project, { entity: MASTER_ENTITY, param: "volume" }, "Master"),
  ];
  const mixerParts = ["volume", "pan", CONTROL_PARTS.muted, CONTROL_PARTS.soloed];
  for (const track of song.tracks) {
    const params = [
      ...mixerParts,
      ...track.sendConfig.map((send) => `sendLevel.${send.returnId}`),
      ...(track.instrument
        ? instrumentParameters(track.instrument.kind).map((definition) =>
            bareParameterId(definition.id),
          )
        : []),
    ];
    for (const param of params) {
      controls.push(nameable(project, { entity: track.id, param }, track.name));
    }
    if (track.instrument?.kind === "drumMachine") {
      for (const pad of track.instrument.pads) {
        for (const param of [...mixerParts, "pitch", "attack", "decay"]) {
          controls.push(nameable(project, { entity: pad.id, param }, pad.name));
        }
      }
    }
  }
  for (const bus of song.returns) {
    for (const param of ["volume", "pan", CONTROL_PARTS.muted]) {
      controls.push(nameable(project, { entity: bus.id, param }, bus.name));
    }
  }
  for (const device of allDevices(project)) {
    const owner = deviceTypeDefinition(device.type)?.label ?? null;
    for (const definition of deviceParameters(device.type)) {
      controls.push(
        nameable(
          project,
          { entity: device.id, param: bareParameterId(definition.id) },
          owner,
        ),
      );
    }
    controls.push(
      nameable(project, { entity: device.id, param: CONTROL_PARTS.bypassed }, owner),
    );
  }
  return controls.filter((control): control is NameableControl => control !== null);
}

const sameAddress = (a: ControlAddress, b: ControlAddress) =>
  a.entity === b.entity && a.param === b.param;

/**
 * Every control the reply names is one the proposal changes: one its impact
 * lists, one whose value moved, or one on something it adds. A reply that
 * names no control passes; one that names a control it leaves alone fails,
 * naming it.
 */
export function checkGrounded(
  before: Project,
  after: Project,
  changed: readonly ControlAddress[],
  text: string,
): CheckResult {
  const beforeEntities = new Set<string>(
    [
      ...before.song.tracks,
      ...before.song.returns,
      ...allDevices(before),
      ...before.song.tracks.flatMap((track) =>
        track.instrument?.kind === "drumMachine" ? track.instrument.pads : [],
      ),
    ].map((entity) => entity.id),
  );
  const isChanged = (address: ControlAddress): boolean => {
    if (changed.some((candidate) => sameAddress(candidate, address))) return true;
    if (
      address.entity !== SONG_ENTITY &&
      address.entity !== MASTER_ENTITY &&
      !beforeEntities.has(address.entity)
    ) {
      return true;
    }
    const was = readControl(before, address);
    const is = readControl(after, address);
    return was?.value !== is?.value;
  };

  // One label can belong to several controls (two compressors): naming it is
  // grounded when the proposal changes any of them.
  const byLabel = new Map<string, { pattern: RegExp; addresses: ControlAddress[] }>();
  for (const control of [...nameableControls(before), ...nameableControls(after)]) {
    const key = control.label.toLowerCase();
    const entry = byLabel.get(key) ?? { pattern: control.pattern, addresses: [] };
    entry.addresses.push(control.address);
    byLabel.set(key, entry);
  }
  const named: string[] = [];
  const ungrounded: string[] = [];
  for (const [label, entry] of byLabel) {
    if (!entry.pattern.test(text)) continue;
    named.push(label);
    if (!entry.addresses.some(isChanged)) ungrounded.push(label);
  }
  if (ungrounded.length > 0) {
    return fail(`Names controls it does not change: ${ungrounded.join(", ")}`);
  }
  return pass(
    named.length === 0
      ? "Names no control"
      : `Every named control changes: ${named.join(", ")}`,
  );
}

// ---------------------------------------------------------------------------
// 6. Extreme is not flattened
// ---------------------------------------------------------------------------

/**
 * Any entity ID, by the domain's own prefixes. The suffix alphabet includes
 * `-` and `_`, which `\b` does not treat as word characters, so the bounds
 * are explicit: an ID that ends in `-` still matches, and a longer run of ID
 * characters never matches a 21-character slice of itself.
 */
const ENTITY_ID = new RegExp(
  `(?<![A-Za-z0-9_-])(?:${Object.values(ID_PREFIXES).join("|")})_[A-Za-z0-9_-]{${ID_SUFFIX_LENGTH}}(?![A-Za-z0-9_-])`,
  "g",
);

/**
 * The proposal's commands with every ID it made up replaced by its order of
 * first appearance, so two proposals that make the same change under
 * different fresh IDs compare equal. IDs that already existed in `before`
 * are kept: aiming the same edit at a different track is a different change.
 */
export function proposalFingerprint(
  before: Project,
  commands: readonly RawCommandInput[],
): string {
  const existing = new Set(JSON.stringify(before).match(ENTITY_ID) ?? []);
  const fresh = new Map<string, string>();
  return JSON.stringify(commands.map(({ type, payload }) => ({ type, payload }))).replace(
    ENTITY_ID,
    (id) => {
      if (existing.has(id)) return id;
      let placeholder = fresh.get(id);
      if (!placeholder) {
        placeholder = `${id.slice(0, 3)}#${fresh.size + 1}`;
        fresh.set(id, placeholder);
      }
      return placeholder;
    },
  );
}

/**
 * An extreme proposal is not identical to any of its pair's conventional
 * ones. It sets no threshold on density, register, timing or ranges: being
 * different at all is the whole check for now.
 */
export function checkNotFlattened(
  extreme: string | null,
  conventional: readonly (string | null)[],
): CheckResult {
  if (extreme === null) return skip("The extreme proposal does not apply");
  const comparable = conventional.filter((entry): entry is string => entry !== null);
  if (comparable.length === 0)
    return skip("No conventional proposal applied to compare with");
  const same = comparable.filter((entry) => entry === extreme).length;
  return same > 0
    ? fail(`Identical to ${same} of ${comparable.length} conventional proposals`)
    : pass(`Differs from all ${comparable.length} conventional proposals`);
}
