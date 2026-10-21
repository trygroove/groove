import { For, type JSX } from "@solidjs/web";
import { createEffect, createSignal, onCleanup } from "solid-js";
import { type Analytics, analytics as defaultAnalytics } from "../../analytics/analytics";
import type { FeatureKey } from "../../analytics/catalog";
import type { RawCommandInput, TransactionResult } from "../../commands";
import type { Clip } from "../../domain/entities";
import { createFactoryContext } from "../../domain/factories";
import type { IdFactory } from "../../domain/ids";
import { rowCommands } from "./generatedRow";
import { eventCountBucket, type StepLane, stepCount } from "./stepEditorModel";
import {
  clampEuclidean,
  type EuclideanSettings,
  euclideanHits,
  type Hit,
  MAX_EUCLIDEAN_STEPS,
  MIN_EUCLIDEAN_STEPS,
  newRoll,
  PRESETS,
  type PresetId,
  presetHits,
  randomHits,
} from "./stepGenerators";
import "./GeneratePanel.css";

/** Mints the ids of generated notes. Module singleton, as elsewhere. */
const factoryContext = createFactoryContext();

/** Which generator: a preset by id, or one of the other three. */
export type GeneratorKey = PresetId | "euclidean" | "random" | "clear";

const FEATURE: Readonly<Record<"pattern" | Exclude<GeneratorKey, PresetId>, FeatureKey>> =
  {
    pattern: "step_pattern",
    euclidean: "step_euclidean",
    random: "step_random",
    clear: "step_clear_row",
  };

export interface GeneratePanelProps {
  readonly clip: Clip;
  /** The selected row: what every generator replaces. */
  readonly row: StepLane | null;
  dispatch(
    commands: RawCommandInput | readonly RawCommandInput[],
  ): TransactionResult | undefined;
  /** What the hovered or focused generator would write, or null. */
  onPreview?(hits: readonly Hit[] | null): void;
  /** Defaults to the application's singleton; injectable for tests. */
  readonly analytics?: Analytics;
  /** Overrides the note-id factory and the dice, so tests are deterministic. */
  readonly ids?: IdFactory;
  readonly random?: () => number;
}

/**
 * The step grid's Generate panel (#643, study A "Panel beneath"): patterns,
 * Euclidean, Random and Clear row, each writing the selected row only.
 *
 * Every generator *replaces* the row, as one transaction built from the
 * existing note commands (`generatedRow.ts`), so one generate is one undo
 * entry. Hovering or focusing a generator hands what it would write to the
 * host, which draws it in the grid before anything changes.
 */
export default function GeneratePanel(props: GeneratePanelProps): JSX.Element {
  const analytics = () => props.analytics ?? defaultAnalytics;
  const [euclid, setEuclid] = createSignal<EuclideanSettings>({
    hits: 5,
    steps: 16,
    rotate: 0,
  });
  const [density, setDensity] = createSignal(35);
  const [roll, setRoll] = createSignal(newRoll(props.random));
  const [previewing, setPreviewing] = createSignal<GeneratorKey | null>(null);
  const settings = () => clampEuclidean(euclid());

  function hitsFor(key: GeneratorKey): Hit[] {
    const steps = stepCount(props.clip);
    if (key === "euclidean") return euclideanHits(settings(), steps);
    if (key === "random") return randomHits(roll(), density() / 100, steps);
    if (key === "clear") return [];
    const preset = PRESETS.find((candidate) => candidate.id === key);
    return preset ? presetHits(preset, steps) : [];
  }

  createEffect(
    () => {
      const key = previewing();
      return key && props.row ? hitsFor(key) : null;
    },
    // A block, not an expression: whatever the host's handler returns (a
    // signal setter returns its value) must not read as this effect's cleanup.
    (hits) => {
      props.onPreview?.(hits);
    },
  );
  onCleanup(() => props.onPreview?.(null));

  function write(key: GeneratorKey): void {
    const row = props.row;
    if (!row) return;
    const hits = hitsFor(key);
    const ids = props.ids ?? factoryContext.ids;
    const commands = rowCommands(props.clip, row.trigger, hits, ids);
    if (commands.length === 0) return;
    if (!props.dispatch(commands)?.ok) return;
    const kind =
      key === "euclidean" || key === "random" || key === "clear" ? key : "pattern";
    analytics().logFeatureFirstUse(FEATURE[kind]);
    analytics().log("clip_edited", {
      editor: "step",
      event_count_bucket: eventCountBucket(hits.length),
    });
  }

  /** Hover and focus both preview; leaving the panel lets go. */
  const previews = (key: GeneratorKey) => ({
    onPointerEnter: () => setPreviewing(key),
    onFocusIn: () => setPreviewing(key),
  });

  function setEuclidField(field: keyof EuclideanSettings, value: number): void {
    if (Number.isFinite(value)) setEuclid((current) => ({ ...current, [field]: value }));
  }

  const euclidField = (
    field: keyof EuclideanSettings,
    label: string,
    min: number,
    max: () => number,
  ) => (
    <label class="generate-field">
      <span class="generate-label">{label}</span>
      <input
        type="number"
        min={min}
        max={max()}
        step="1"
        value={euclid()[field]}
        onInput={(event) => setEuclidField(field, event.currentTarget.valueAsNumber)}
        // Leaving the field pulls it back into range.
        onChange={() => setEuclid(settings())}
      />
    </label>
  );

  return (
    <section
      class="generate-panel"
      aria-label="Generate"
      onPointerLeave={() => setPreviewing(null)}
      onFocusOut={(event) => {
        const next = event.relatedTarget as Node | null;
        if (!next || !event.currentTarget.contains(next)) setPreviewing(null);
      }}
    >
      <div class="generate-head">
        <span class="generate-title">Generate</span>
        <p class="generate-target">
          into <b>{props.row?.name ?? "no row"}</b>
        </p>
        <span class="generate-note">Replaces the row</span>
      </div>
      <fieldset class="generate-columns" disabled={!props.row}>
        <div class="generate-column">
          <span class="generate-label">Patterns</span>
          {/* Two columns of three, so the panel is three buttons tall. */}
          <div class="generate-patterns">
            <For each={PRESETS}>
              {(preset) => (
                <button
                  type="button"
                  class="generate-button"
                  onClick={() => write(preset.id)}
                  {...previews(preset.id)}
                >
                  <span class="generate-glyph" aria-hidden="true">
                    {/* Half a bar: every preset repeats within eight steps. */}
                    <For each={Array.from({ length: 8 }, (_, step) => step)}>
                      {(step) => <i class={{ on: preset.hits(step) }} />}
                    </For>
                  </span>
                  {preset.label}
                </button>
              )}
            </For>
            <button
              type="button"
              class="generate-button generate-clear"
              onClick={() => write("clear")}
              {...previews("clear")}
            >
              Clear row
            </button>
          </div>
        </div>
        <div class="generate-column" {...previews("euclidean")}>
          <span class="generate-label">Euclidean</span>
          {euclidField("hits", "Hits", 0, () => settings().steps)}
          {euclidField("steps", "Steps", MIN_EUCLIDEAN_STEPS, () => MAX_EUCLIDEAN_STEPS)}
          {euclidField("rotate", "Rotate", 0, () => settings().steps - 1)}
          <button type="button" class="generate-write" onClick={() => write("euclidean")}>
            Write Euclidean
          </button>
        </div>
        <div class="generate-column" {...previews("random")}>
          <span class="generate-label">Random</span>
          <label class="generate-field">
            <span class="generate-label">Density</span>
            <input
              type="range"
              min="0"
              max="100"
              step="5"
              value={density()}
              onInput={(event) => setDensity(event.currentTarget.valueAsNumber)}
            />
            <output>{density()}%</output>
          </label>
          <button
            type="button"
            class="generate-button"
            onClick={() => setRoll(newRoll(props.random))}
          >
            New roll
          </button>
          <button type="button" class="generate-write" onClick={() => write("random")}>
            Write random
          </button>
        </div>
      </fieldset>
    </section>
  );
}
