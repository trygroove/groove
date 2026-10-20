import { describe, expect, it } from "vitest";
import { RENDER_CHANNELS } from "../../audio/offlineRenderer";
import { songEndSeconds } from "../../audio/renderLength";
import { wav24ByteLength } from "../../audio/wavEncoder";
import { createDevice } from "../../domain/devices";
import type { Project } from "../../domain/entities";
import type { DeviceId } from "../../domain/ids";
import { estimateStemExport } from "./exportStems";
import { stemArchiveBytes } from "./stemArchive";
import { planStemBatches } from "./stemBatches";
import { createStemFixtureProject } from "./stemFixture";
import { planStems } from "./stemPlan";

const RATE = 8_000;
const project = createStemFixtureProject();
const whole = estimateStemExport(project, { sampleRate: RATE });
const plan = planStems(project);
const todayPaths = plan.map((stem) => stem.path);
const trackStems = plan.filter((stem) => stem.kind === "track");
const trackIds = [...project.song.tracks]
  .sort((a, b) => a.order - b.order)
  .map((track) => track.id);

/** A budget that holds `n` of the five stems, and not one more. */
const budgetFor = (n: number) => Math.floor((whole.bytes / 5) * (n + 0.5));

describe("planStemBatches", () => {
  it("is one batch, with today's files, when everything fits", () => {
    const batches = planStemBatches(project, { sampleRate: RATE });
    expect(batches).toHaveLength(1);
    expect([...batches[0].paths].sort()).toEqual([...todayPaths].sort());
    expect(batches[0]).toMatchObject({ index: 0, hasMix: true, bytes: whole.bytes });
    expect(batches[0].trackIds).toEqual(trackIds);
  });

  // #836: the dialog shows this, so it is the song's length, not the budget's
  // bound with 30 s of possible tail on every stem.
  it("expects every stem to be the song's length, as a render with no tail past it is", () => {
    const [batch] = planStemBatches(project, { sampleRate: RATE });
    const frames = Math.round(songEndSeconds(plan[plan.length - 1].projection) * RATE);
    expect(batch.expectedBytes).toBe(
      stemArchiveBytes(batch.paths, wav24ByteLength(RENDER_CHANNELS, frames)),
    );
    expect(batch.expectedBytes).toBeLessThan(batch.bytes);
  });

  // GRV-162: a reverb on a return keeps ringing past the song, and every stem
  // is padded to that, so the size shown before exporting must count it.
  it("expects the tail a return's reverb rings for past the song", () => {
    const [verb] = project.song.returns.filter((bus) => bus.name === "Verb");
    const reverb = createDevice("dev_tail" as DeviceId, "reverb", 0);
    // The fixture's notes all end well before the song does, so the reverb has
    // to ring past the last placement to show: a long, fully wet hall does.
    reverb.parameters.decay = 20;
    reverb.parameters.wet = 1;
    const ringing: Project = {
      ...project,
      song: {
        ...project.song,
        returns: project.song.returns.map((bus) =>
          bus.id === verb.id ? { ...bus, devices: [reverb] } : bus,
        ),
      },
    };
    const [dry] = planStemBatches(project, { sampleRate: RATE });
    const [wet] = planStemBatches(ringing, { sampleRate: RATE });
    const songOnly = stemArchiveBytes(
      wet.paths,
      wav24ByteLength(
        RENDER_CHANNELS,
        Math.round(
          songEndSeconds(planStems(ringing)[planStems(ringing).length - 1].projection) *
            RATE,
        ),
      ),
    );
    expect(wet.expectedBytes).toBeGreaterThan(songOnly);
    expect(wet.expectedBytes).toBeLessThanOrEqual(wet.bytes);
    expect(dry.expectedBytes).toBeLessThan(wet.expectedBytes);
  });

  it("splits in order: mix first, tracks, then returns, each under budget", () => {
    const maxBytes = budgetFor(2);
    const batches = planStemBatches(project, { sampleRate: RATE, maxBytes });
    expect(batches.map((batch) => batch.index)).toEqual([0, 1, 2]);
    expect(batches.map((batch) => batch.hasMix)).toEqual([true, false, false]);
    expect(batches.every((batch) => batch.fits && batch.bytes <= maxBytes)).toBe(true);
    const packed = batches.flatMap((batch) => batch.paths);
    expect(packed).toEqual([
      "Reference mix.wav",
      ...trackStems.map((stem) => stem.path),
      ...plan.filter((stem) => stem.kind === "return").map((stem) => stem.path),
    ]);
    expect(batches.flatMap((batch) => batch.trackIds)).toEqual(trackIds);
    // The returns ride in the last ZIPs, after every track.
    const rows = batches.flatMap((batch) => batch.rowIds);
    expect(rows.slice(0, trackIds.length)).toEqual(trackIds);
    expect(rows.length).toBe(trackIds.length + project.song.returns.length);
  });

  it("keeps each track's whole-song number when only some are selected", () => {
    const batches = planStemBatches(project, {
      sampleRate: RATE,
      trackIds: [trackIds[1]],
      maxBytes: budgetFor(2),
    });
    const paths = batches.flatMap((batch) => batch.paths);
    expect(paths).toContain(trackStems[1].path);
    expect(paths).not.toContain(trackStems[0].path);
    expect(batches.flatMap((batch) => batch.trackIds)).toEqual([trackIds[1]]);
  });

  it("plans the mix and returns alone when no track is selected", () => {
    const batches = planStemBatches(project, { sampleRate: RATE, trackIds: [] });
    expect(batches).toHaveLength(1);
    expect(batches[0].trackIds).toEqual([]);
    expect(batches[0].paths).toHaveLength(3);
  });

  it("gives a stem over the budget by itself a batch of its own that does not fit", () => {
    const batches = planStemBatches(project, { sampleRate: RATE, maxBytes: 1 });
    expect(batches).toHaveLength(5);
    expect(batches.every((batch) => batch.paths.length === 1 && !batch.fits)).toBe(true);
  });
});
