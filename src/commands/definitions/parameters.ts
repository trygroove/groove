import { z } from "zod";
import type { Device, Project } from "../../domain/entities";
import { deviceIdSchema, returnIdSchema, trackIdSchema } from "../../domain/ids";
import {
  coerceParameterValue,
  getParameterDefinition,
  MASTER_VOLUME,
  type ParameterDefinition,
  RETURN_PAN,
  RETURN_VOLUME,
  SONG_SWING,
  SONG_TEMPO,
  TRACK_PAN,
  TRACK_SEND_LEVEL,
  TRACK_VOLUME,
} from "../../domain/parameters";
import { formatSummary } from "../../domain/valueFormat";
import {
  type ControlAddress,
  MASTER_ENTITY,
  parameterControl,
  SONG_ENTITY,
  sendControl,
} from "../controlAddress";
import { summarizeParameterChoice } from "../parameterChoices";
import { findTrack, replaceTrack, withSong } from "../projectEdits";
import {
  applied,
  type CommandInput,
  defineCommand,
  eraseCommand,
  type RegisteredCommand,
  rejected,
} from "../types";

/**
 * One generic parameter command for every user-controlled numeric value
 * (PRD invariants 4 and 10).
 *
 * The command never repeats a range, a default, or a clamping rule: it looks
 * the target's definition up in `src/domain/parameters.ts` and applies that
 * definition's policy. Adding a device parameter in Alpha Milestone 1 therefore makes it
 * settable by the UI, the keyboard, and the assistant without a new command.
 */

export const parameterTargetSchema = z.discriminatedUnion("scope", [
  z.strictObject({
    scope: z.literal("song"),
    parameterId: z.string().min(1),
  }),
  z.strictObject({
    scope: z.literal("track"),
    trackId: trackIdSchema,
    parameterId: z.string().min(1),
  }),
  z.strictObject({
    scope: z.literal("instrument"),
    trackId: trackIdSchema,
    parameterId: z.string().min(1),
  }),
  z.strictObject({
    scope: z.literal("trackDevice"),
    trackId: trackIdSchema,
    deviceId: deviceIdSchema,
    parameterId: z.string().min(1),
  }),
  z.strictObject({
    scope: z.literal("send"),
    trackId: trackIdSchema,
    returnId: returnIdSchema,
    parameterId: z.string().min(1),
  }),
  z.strictObject({
    scope: z.literal("return"),
    returnId: returnIdSchema,
    parameterId: z.string().min(1),
  }),
  z.strictObject({
    scope: z.literal("master"),
    parameterId: z.string().min(1),
  }),
  // A device in the master's own insert chain (LOOP-020). `master` above is
  // the bus itself — its volume — and `trackDevice` is the same idea one
  // chain over; this is the third chain kind the `device.*` commands already
  // write to, made writable at the parameter level too.
  z.strictObject({
    scope: z.literal("masterDevice"),
    deviceId: deviceIdSchema,
    parameterId: z.string().min(1),
  }),
  // A device in one return bus's insert chain (#386): `return` is the bus's
  // own strip, this is a device on its chain.
  z.strictObject({
    scope: z.literal("returnDevice"),
    returnId: returnIdSchema,
    deviceId: deviceIdSchema,
    parameterId: z.string().min(1),
  }),
]);
export type ParameterTarget = z.infer<typeof parameterTargetSchema>;

export const parameterSetPayloadSchema = z.strictObject({
  target: parameterTargetSchema,
  value: z.number(),
});
export type ParameterSetPayload = z.infer<typeof parameterSetPayloadSchema>;

/**
 * The control a parameter target is shown on (`UI-004`): the entity that owns
 * the value plus its bare parameter key. A song or master parameter belongs to
 * the song or the master bus; an instrument parameter to its track; a device
 * parameter to the device, whichever chain it sits in.
 */
export function parameterTargetControl(target: ParameterTarget): ControlAddress {
  switch (target.scope) {
    case "song":
      return parameterControl(SONG_ENTITY, target.parameterId);
    case "master":
      return parameterControl(MASTER_ENTITY, target.parameterId);
    case "track":
    case "instrument":
      return parameterControl(target.trackId, target.parameterId);
    case "send":
      return sendControl(target.trackId, target.returnId);
    case "return":
      return parameterControl(target.returnId, target.parameterId);
    case "trackDevice":
    case "returnDevice":
    case "masterDevice":
      return parameterControl(target.deviceId, target.parameterId);
  }
}

/**
 * Resolves one parameter on a device in any insert chain.
 *
 * A device's parameters are namespaced by its `type` — exactly how the domain
 * validates a stored device parameter value and how `src/domain/devices.ts`
 * registers them — so which chain the device sits in changes only *where the
 * new parameter map is written back*, never how the definition is found. That
 * is the entire difference between the `trackDevice`, `masterDevice` and
 * `returnDevice` cases below, which is why they share this and differ only in
 * their `write`.
 */
function resolveDeviceParameter(
  device: Device | undefined,
  parameterId: string,
  missing: string,
  write: (parameters: Record<string, number>) => Project,
): Resolution {
  if (!device) return { error: missing };
  const definition = getParameterDefinition(`${device.type}.${parameterId}`);
  if (!definition) {
    return {
      error: `Device ${device.type} has no registered parameter "${parameterId}"`,
    };
  }
  return {
    definition,
    current: device.parameters[parameterId] ?? definition.defaultValue,
    write: (value) => write({ ...device.parameters, [parameterId]: value }),
  };
}

interface ResolvedParameter {
  readonly definition: ParameterDefinition;
  readonly current: number;
  write(value: number): Project;
}

type Resolution = ResolvedParameter | { readonly error: string };

function isUnresolved(resolution: Resolution): resolution is { readonly error: string } {
  return "error" in resolution;
}

/**
 * Maps a target onto its parameter definition and the single place in the
 * project that stores its value.
 */
function resolveParameter(project: Project, target: ParameterTarget): Resolution {
  switch (target.scope) {
    case "song":
      return expectParameter(
        target.parameterId,
        [SONG_TEMPO, SONG_SWING],
        (definition) => {
          const key = definition === SONG_SWING ? "swing" : "tempo";
          return {
            definition,
            current: project.song[key],
            write: (value) => withSong(project, { ...project.song, [key]: value }),
          };
        },
      );
    case "master":
      return expectParameter(target.parameterId, [MASTER_VOLUME], (definition) => ({
        definition,
        current: project.song.master.volume,
        write: (value) =>
          withSong(project, {
            ...project.song,
            master: { ...project.song.master, volume: value },
          }),
      }));
    case "track": {
      const track = findTrack(project, target.trackId);
      if (!track) {
        return { error: `Track ${target.trackId} does not exist` };
      }
      return expectParameter(
        target.parameterId,
        [TRACK_VOLUME, TRACK_PAN],
        (definition) => ({
          definition,
          current: definition === TRACK_VOLUME ? track.mixer.volume : track.mixer.pan,
          write: (value) =>
            replaceTrack(project, {
              ...track,
              mixer: {
                ...track.mixer,
                [definition === TRACK_VOLUME ? "volume" : "pan"]: value,
              },
            }),
        }),
      );
    }
    case "instrument": {
      const track = findTrack(project, target.trackId);
      if (!track) {
        return { error: `Track ${target.trackId} does not exist` };
      }
      const instrument = track.instrument;
      if (!instrument) {
        return { error: `Track ${track.id} has no instrument` };
      }
      // Instrument parameters are namespaced by instrument kind, matching how
      // the domain validates a stored instrument parameter value.
      const definition = getParameterDefinition(
        `${instrument.kind}.${target.parameterId}`,
      );
      if (!definition) {
        return {
          error: `Instrument ${instrument.kind} has no registered parameter "${target.parameterId}"`,
        };
      }
      return {
        definition,
        current: instrument.parameters[target.parameterId] ?? definition.defaultValue,
        write: (value) =>
          replaceTrack(project, {
            ...track,
            instrument: {
              ...instrument,
              parameters: {
                ...instrument.parameters,
                [target.parameterId]: value,
              },
            },
          }),
      };
    }
    case "send": {
      const track = findTrack(project, target.trackId);
      if (!track) {
        return { error: `Track ${target.trackId} does not exist` };
      }
      const send = track.sendConfig.find(
        (candidate) => candidate.returnId === target.returnId,
      );
      if (!send) {
        return {
          error: `Track ${track.id} has no send to return bus ${target.returnId}`,
        };
      }
      return expectParameter(target.parameterId, [TRACK_SEND_LEVEL], (definition) => ({
        definition,
        current: send.level,
        write: (value) =>
          replaceTrack(project, {
            ...track,
            sendConfig: track.sendConfig.map((candidate) =>
              candidate.returnId === send.returnId
                ? { ...candidate, level: value }
                : candidate,
            ),
          }),
      }));
    }
    case "return": {
      const bus = project.song.returns.find(
        (candidate) => candidate.id === target.returnId,
      );
      if (!bus) {
        return { error: `Return bus ${target.returnId} does not exist` };
      }
      return expectParameter(
        target.parameterId,
        [RETURN_VOLUME, RETURN_PAN],
        (definition) => ({
          definition,
          current: definition === RETURN_VOLUME ? bus.mixer.volume : bus.mixer.pan,
          write: (value) =>
            withSong(project, {
              ...project.song,
              returns: project.song.returns.map((candidate) =>
                candidate.id === bus.id
                  ? {
                      ...candidate,
                      mixer: {
                        ...candidate.mixer,
                        [definition === RETURN_VOLUME ? "volume" : "pan"]: value,
                      },
                    }
                  : candidate,
              ),
            }),
        }),
      );
    }
    case "trackDevice": {
      const track = findTrack(project, target.trackId);
      if (!track) {
        return { error: `Track ${target.trackId} does not exist` };
      }
      return resolveDeviceParameter(
        track.devices.find((candidate) => candidate.id === target.deviceId),
        target.parameterId,
        `Track ${track.id} has no device ${target.deviceId}`,
        (parameters) =>
          replaceTrack(project, {
            ...track,
            devices: track.devices.map((candidate) =>
              candidate.id === target.deviceId ? { ...candidate, parameters } : candidate,
            ),
          }),
      );
    }
    case "masterDevice": {
      const master = project.song.master;
      return resolveDeviceParameter(
        master.devices.find((candidate) => candidate.id === target.deviceId),
        target.parameterId,
        `The master chain has no device ${target.deviceId}`,
        (parameters) =>
          withSong(project, {
            ...project.song,
            master: {
              ...master,
              devices: master.devices.map((candidate) =>
                candidate.id === target.deviceId
                  ? { ...candidate, parameters }
                  : candidate,
              ),
            },
          }),
      );
    }
    case "returnDevice": {
      const bus = project.song.returns.find(
        (candidate) => candidate.id === target.returnId,
      );
      if (!bus) {
        return { error: `Return bus ${target.returnId} does not exist` };
      }
      return resolveDeviceParameter(
        bus.devices.find((candidate) => candidate.id === target.deviceId),
        target.parameterId,
        `Return bus ${bus.id} has no device ${target.deviceId}`,
        (parameters) =>
          withSong(project, {
            ...project.song,
            returns: project.song.returns.map((candidate) =>
              candidate.id === bus.id
                ? {
                    ...candidate,
                    devices: candidate.devices.map((device) =>
                      device.id === target.deviceId ? { ...device, parameters } : device,
                    ),
                  }
                : candidate,
            ),
          }),
      );
    }
  }
}

/** Accepts only the parameters that this scope actually owns. */
function expectParameter(
  parameterId: string,
  allowed: readonly ParameterDefinition[],
  build: (definition: ParameterDefinition) => ResolvedParameter,
): Resolution {
  const definition = allowed.find((candidate) => candidate.id === parameterId);
  if (!definition) {
    return {
      error: `"${parameterId}" is not a parameter of this target (expected ${allowed
        .map((candidate) => `"${candidate.id}"`)
        .join(" or ")})`,
    };
  }
  return build(definition);
}

/**
 * The definition `target` resolves to in `project`, or undefined when it does
 * not resolve (a missing entity, a parameter the target does not have). For a
 * caller that must check a value against the range before the command clamps
 * it — the assistant refuses an out-of-range value rather than have it clamped
 * (GRV-4, PRD AI-03).
 */
export function parameterDefinitionAt(
  project: Project,
  target: ParameterTarget,
): ParameterDefinition | undefined {
  const resolution = resolveParameter(project, target);
  return isUnresolved(resolution) ? undefined : resolution.definition;
}

export const parameterSetCommand = defineCommand<ParameterSetPayload>({
  type: "parameter.set",
  version: 1,
  schema: parameterSetPayloadSchema,
  touches: (payload) => [parameterTargetControl(payload.target)],
  summarize(payload, project) {
    const resolution = resolveParameter(project, payload.target);
    if (isUnresolved(resolution)) {
      return `Set ${payload.target.parameterId}`;
    }
    const { definition } = resolution;
    return (
      summarizeParameterChoice(definition, payload.value) ??
      `Set ${definition.label} to ${formatSummary(definition, payload.value)}`
    );
  },
  apply(project, payload) {
    const resolution = resolveParameter(project, payload.target);
    if (isUnresolved(resolution)) {
      return rejected(resolution.error);
    }
    const coerced = coerceParameterValue(resolution.definition, payload.value);
    if (!coerced.ok) {
      return rejected(coerced.reason);
    }
    return applied(resolution.write(coerced.value));
  },
  invert(payload, before) {
    const resolution = resolveParameter(before, payload.target);
    return isUnresolved(resolution)
      ? []
      : [setParameter(payload.target, resolution.current)];
  },
});

// --- Typed builders -------------------------------------------------------

export function setParameter(
  target: ParameterTarget,
  value: number,
): CommandInput<ParameterSetPayload> {
  return { type: parameterSetCommand.type, payload: { target, value } };
}

/** Registered, payload-erased commands from this module. */
export const parameterCommands: readonly RegisteredCommand[] = [
  eraseCommand(parameterSetCommand),
];
