import { createRoot, flush } from "solid-js";
import { describe, expect, it, vi } from "vitest";
import type { AskSound } from "../../assistant/ask";
import { setParameter } from "../../commands";
import { createReferenceProject } from "../../domain/fixtures";
import { SONG_TEMPO } from "../../domain/parameters";
import { TICKS_PER_QUARTER } from "../../domain/time";
import { auditionTrigger } from "./askReferences";
import { useAskEditorLink } from "./useAskEditorLink";

const project = createReferenceProject();
const slower = setParameter({ scope: "song", parameterId: SONG_TEMPO.id }, 100);
const PREVIEW: AskSound = {
  kind: "preview",
  calls: [{ name: "parameter_set", input: { ...slower.payload } }],
};

function harness(
  options: { playing?: boolean; mayStartSound?: boolean; previewOpen?: boolean } = {},
) {
  const preview = { cancel: vi.fn() };
  const session = {
    beginPreview: vi.fn(() => ({ ok: true as const, preview: preview as never })),
    committedProject: () => project,
    previewOpen: () => options.previewOpen ?? false,
  };
  const audio = {
    isPlaying: () => options.playing ?? false,
    play: vi.fn(async () => {}),
    pause: vi.fn(),
    positionTicks: () => 384,
    seekTicks: vi.fn(),
    auditionTrack: vi.fn(async () => true),
  };
  const selectTrack = vi.fn();
  const selectArrangement = vi.fn();
  let dispose = () => {};
  const link = createRoot((done) => {
    dispose = done;
    return useAskEditorLink({
      project: () => project,
      session,
      audio,
      selectTrack,
      selectArrangement,
      mayStartSound: () => options.mayStartSound ?? true,
    });
  });
  return { link, preview, session, audio, selectTrack, selectArrangement, dispose };
}

describe("the editor's side of a question's options (GRV-42)", () => {
  it("previews an option's changes and plays the song, then puts both back", () => {
    const h = harness();
    expect(h.link.canHear(PREVIEW)).toBe(true);
    h.link.hear(PREVIEW);
    expect(h.session.beginPreview).toHaveBeenCalledWith([
      expect.objectContaining({ type: "parameter.set", payload: slower.payload }),
    ]);
    expect(h.audio.play).toHaveBeenCalledOnce();

    h.link.stopHearing();
    expect(h.preview.cancel).toHaveBeenCalledOnce();
    expect(h.audio.pause).toHaveBeenCalledOnce();
    expect(h.audio.seekTicks).toHaveBeenCalledWith(384);
    // A second stop has nothing left to undo.
    h.link.stopHearing();
    expect(h.preview.cancel).toHaveBeenCalledOnce();
  });

  it("leaves a song that was already playing to play on", () => {
    const h = harness({ playing: true });
    h.link.hear(PREVIEW);
    expect(h.audio.play).not.toHaveBeenCalled();
    h.link.stopHearing();
    expect(h.preview.cancel).toHaveBeenCalledOnce();
    expect(h.audio.pause).not.toHaveBeenCalled();
  });

  it("plays one note through a track's instrument", () => {
    const h = harness();
    const track = project.song.tracks.find((candidate) => candidate.instrument);
    if (!track) throw new Error("the reference project needs an instrument track");
    h.link.hear({ kind: "track", trackId: track.id });
    expect(h.audio.auditionTrack).toHaveBeenCalledWith(
      track.id,
      auditionTrigger(track),
      TICKS_PER_QUARTER,
      0.8,
    );
    expect(h.session.beginPreview).not.toHaveBeenCalled();
  });

  it("waits for the page to have been used before a hover makes a sound; a key may", () => {
    const h = harness({ mayStartSound: false });
    h.link.hear(PREVIEW);
    expect(h.session.beginPreview).not.toHaveBeenCalled();
    h.link.hear(PREVIEW, true);
    expect(h.session.beginPreview).toHaveBeenCalledOnce();
  });

  it("leaves a preview something else opened to stand, on a hover and on Space", () => {
    const h = harness({ previewOpen: true });
    h.link.hear(PREVIEW);
    h.link.hear(PREVIEW, true);
    expect(h.session.beginPreview).not.toHaveBeenCalled();
    expect(h.audio.play).not.toHaveBeenCalled();
  });

  it("puts a preview away when the editor goes", () => {
    const h = harness();
    h.link.hear(PREVIEW);
    h.dispose();
    expect(h.preview.cancel).toHaveBeenCalledOnce();
  });

  it("draws a hovered reference and selects a picked one", () => {
    const h = harness();
    const placement = project.song.placements[0];
    if (!placement) throw new Error("the reference project needs a placement");
    expect(h.link.bands()).toEqual([]);
    h.link.highlight({ kind: "clip", clipId: placement.clipId });
    flush();
    expect(h.link.bands().length).toBeGreaterThan(0);
    h.link.highlight(null);
    flush();
    expect(h.link.bands()).toEqual([]);

    h.link.select({ kind: "clip", clipId: placement.clipId });
    expect(h.selectTrack).toHaveBeenCalledWith(placement.trackId);
    expect(h.selectArrangement).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "clips" }),
    );
  });
});
