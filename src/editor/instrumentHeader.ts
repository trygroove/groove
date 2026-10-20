import type { Asset, Project, Track } from "../domain/entities";
import type { PadId } from "../domain/ids";
import {
  readInstrumentParameter,
  SAMPLER_PITCH,
  SAMPLER_SAMPLE_END,
  SAMPLER_SAMPLE_START,
  SYNTH_FILTER_CUTOFF,
  SYNTH_WAVEFORM,
  synthWaveform,
} from "../domain/parameters";
import { formatReadout } from "../domain/valueFormat";
import { instrumentKindSpec } from "../instrument/instrumentKinds";

/** One key fact in the header: a small label over its value. */
export interface HeaderReadout {
  readonly label: string;
  readonly value: string;
  /** The value is a name the user chose or recorded, so replay masks it. */
  readonly masked?: boolean;
}

/** What an instrument's header row says about it (#447). */
export interface InstrumentHeaderFacts {
  /** "T01", the track's place in the song. */
  readonly slot: string;
  /** "Drum machine", "Sampler", "Synth", "Loop". */
  readonly kind: string;
  readonly readouts: readonly HeaderReadout[];
}

function assetName(project: Project, id: string | null): string {
  return project.song.assets.find((asset: Asset) => asset.id === id)?.name ?? "None";
}

function capitalize(word: string): string {
  return word.charAt(0).toUpperCase() + word.slice(1);
}

/**
 * The header row's facts for one track (#447, after the faceplate system's
 * `hd` row): its slot and kind above its name, then the three or so values
 * that say what this instrument is doing without reading its controls.
 */
export function instrumentHeaderFacts(
  project: Project,
  track: Track,
  selectedPadId: PadId | null = null,
): InstrumentHeaderFacts {
  const index = project.song.tracks.findIndex((t) => t.id === track.id);
  const slot = `T${String(index + 1).padStart(2, "0")}`;
  const instrument = track.instrument;

  if (track.type === "audio") {
    const clip = project.clips.find(
      (c) => c.trackId === track.id && c.content.kind === "audioLoop",
    );
    const content = clip?.content.kind === "audioLoop" ? clip.content : null;
    return {
      slot,
      kind: "Loop",
      readouts: [
        {
          label: "Loop",
          value: assetName(project, content?.assetId ?? null),
          masked: true,
        },
        { label: "Source tempo", value: content ? `${content.sourceTempo} BPM` : "–" },
      ],
    };
  }
  if (!instrument) return { slot, kind: "No instrument", readouts: [] };

  const kind = instrumentKindSpec(instrument.kind).label;
  const read = (definition: Parameters<typeof readInstrumentParameter>[0]) =>
    readInstrumentParameter(definition, instrument.parameters);
  const show = (definition: Parameters<typeof readInstrumentParameter>[0]) =>
    formatReadout(definition, read(definition));

  switch (instrument.kind) {
    case "sampler":
      return {
        slot,
        kind,
        readouts: [
          {
            label: "Sample",
            value: assetName(project, instrument.assetId),
            masked: true,
          },
          {
            label: "Window",
            value: `${show(SAMPLER_SAMPLE_START)} → ${show(SAMPLER_SAMPLE_END)}`,
          },
          { label: "Pitch", value: show(SAMPLER_PITCH) },
        ],
      };
    case "synth":
      return {
        slot,
        kind,
        readouts: [
          { label: "Voice", value: "Poly" },
          { label: "Wave", value: capitalize(synthWaveform(read(SYNTH_WAVEFORM))) },
          { label: "Filter", value: show(SYNTH_FILTER_CUTOFF) },
        ],
      };
    case "drumMachine": {
      const pad =
        instrument.pads.find((candidate) => candidate.id === selectedPadId) ??
        instrument.pads[0];
      return {
        slot,
        kind,
        readouts: [
          { label: "Pads", value: String(instrument.pads.length) },
          { label: "Selected", value: pad?.name ?? "None" },
          {
            label: "Sample",
            value: assetName(project, pad?.assetId ?? null),
            masked: true,
          },
        ],
      };
    }
  }
}
