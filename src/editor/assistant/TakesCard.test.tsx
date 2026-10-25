import { cleanup, render, screen, within } from "@solidjs/testing-library";
import { createSignal, flush } from "solid-js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createSliceFixtureProject } from "../../domain/fixtures";
import { clickAndFlush } from "../../testing/events";
import { offerTakesInput, TAKE_LABELS } from "../../testing/takes";
import TakesCard, { MORE_TAKES_LABEL, NO_TAKE_LABEL } from "./TakesCard";
import {
  type TakesCard as Card,
  hearingCommands,
  type TakeRow,
  takePatternLoop,
  takeStartTicks,
  takesStatusText,
} from "./takesCardModel";
import type { AssistantTakes } from "./useAssistantTakes";

/**
 * The takes card (GRV-207): four takes, each with its own Hear and Use this,
 * then "4 more" and "None of these", and one line that says where it stands.
 */

afterEach(cleanup);

const CHOOSING: Card = {
  status: "choosing",
  part: "Lead melody",
  partType: "melodic",
  trackName: "Lead",
  takes: TAKE_LABELS.map((label) => ({ label, fits: true })),
  hearing: null,
  picked: null,
  notice: null,
  reason: null,
};

function renderCard(initial: Card = CHOOSING, canAsk = true, parsed = true) {
  const [card, setCard] = createSignal<Card>(initial);
  const takes = {
    card: () => card(),
    receive: vi.fn(),
    hear: vi.fn((_entry: string, index: number) =>
      setCard({ ...card(), hearing: card().hearing === index ? null : index }),
    ),
    stopHearing: vi.fn(),
    pick: vi.fn((_entry: string, index: number) =>
      setCard({ ...card(), status: "picked", picked: index }),
    ),
    decline: vi.fn(() => setCard({ ...card(), status: "declined" })),
    more: vi.fn(() => setCard({ ...card(), status: "more" })),
    decided: () => false,
    canMore: () => parsed,
  } satisfies AssistantTakes;
  render(() => <TakesCard entryId="entry-1" takes={takes} canAsk={canAsk} />);
  flush();
  return { takes, setCard };
}

describe("TakesCard (GRV-207)", () => {
  it("lists the four takes, each with its own Hear and Use this", () => {
    renderCard();
    const card = screen.getByRole("region", { name: "Takes: Lead melody" });
    const rows = within(card).getAllByRole("listitem");
    expect(rows).toHaveLength(4);
    rows.forEach((row, index) => {
      expect(row.textContent).toContain(`Take ${index + 1}`);
      expect(row.textContent).toContain(TAKE_LABELS[index]);
      within(row).getByRole("button", { name: `Hear take ${index + 1}` });
      within(row).getByRole("button", { name: `Use take ${index + 1}` });
    });
    within(card).getByRole("button", { name: MORE_TAKES_LABEL });
    within(card).getByRole("button", { name: NO_TAKE_LABEL });
    expect(card.textContent).toContain("Nothing changes until you do.");
    // The head names the track the takes play on, not the turn's scope.
    expect(card.textContent).toContain("4 takes · Lead");
  });

  it("names no track when none of the takes fits", () => {
    renderCard({ ...CHOOSING, status: "invalid", trackName: null });
    const head = screen.getByRole("region").querySelector(".assistant-entry-label");
    expect(head?.textContent?.trim()).toBe("4 takes");
  });

  it("says which change did not fit when none of the takes fits", () => {
    renderCard({
      ...CHOOSING,
      status: "invalid",
      trackName: null,
      reason: "The assistant tried to add a note that doesn't fit your song.",
    });
    expect(screen.getByRole("status").textContent).toBe(
      "The assistant tried to add a note that doesn't fit your song. These takes don't fit your song as it is. Nothing changed.",
    );
  });

  it("hears a take, pressed in while it plays, and stops it pressed again", () => {
    const { takes } = renderCard();
    clickAndFlush(screen.getByRole("button", { name: "Hear take 2" }));
    expect(takes.hear).toHaveBeenCalledWith("entry-1", 1);
    const stop = screen.getByRole("button", { name: "Stop take 2" });
    expect(stop.getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByRole("status").textContent).toContain("Hearing take 2");
    clickAndFlush(stop);
    expect(screen.getByRole("button", { name: "Hear take 2" })).toBeTruthy();
  });

  it("uses one take and then offers none of them", () => {
    const { takes } = renderCard();
    clickAndFlush(screen.getByRole("button", { name: "Use take 3" }));
    expect(takes.pick).toHaveBeenCalledWith("entry-1", 2);
    expect(screen.queryAllByRole("listitem")).toHaveLength(0);
    expect(screen.queryByRole("button", { name: NO_TAKE_LABEL })).toBeNull();
    expect(screen.getByRole("status").textContent).toContain("Using take 3");
  });

  it("declines them all, or asks for four more", () => {
    const declined = renderCard();
    clickAndFlush(screen.getByRole("button", { name: NO_TAKE_LABEL }));
    expect(declined.takes.decline).toHaveBeenCalledWith("entry-1");
    expect(screen.getByRole("status").textContent).toContain("Nothing changed");
    cleanup();

    const more = renderCard();
    clickAndFlush(screen.getByRole("button", { name: MORE_TAKES_LABEL }));
    expect(more.takes.more).toHaveBeenCalledWith("entry-1");
    expect(screen.getByRole("status").textContent).toContain("Set aside for 4 more");
  });

  it("offers no four more while it cannot ask, and no take that does not fit", () => {
    renderCard(
      {
        ...CHOOSING,
        takes: CHOOSING.takes.map((take, index) => ({ ...take, fits: index !== 1 })),
      },
      false,
    );
    expect(
      (screen.getByRole("button", { name: MORE_TAKES_LABEL }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
    expect(
      (screen.getByRole("button", { name: "Use take 2" }) as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(
      (screen.getByRole("button", { name: "Use take 1" }) as HTMLButtonElement).disabled,
    ).toBe(false);
  });

  it("offers no four more when the offer did not parse, only declining it", () => {
    renderCard(
      { ...CHOOSING, status: "invalid", takes: [], trackName: null },
      true,
      false,
    );
    expect(
      (screen.getByRole("button", { name: MORE_TAKES_LABEL }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
    expect(
      (screen.getByRole("button", { name: NO_TAKE_LABEL }) as HTMLButtonElement).disabled,
    ).toBe(false);
  });

  it("says a stale offer can only be replaced or declined", () => {
    renderCard({ ...CHOOSING, status: "stale" });
    expect(
      (screen.getByRole("button", { name: "Hear take 1" }) as HTMLButtonElement).disabled,
    ).toBe(true);
    screen.getByRole("button", { name: MORE_TAKES_LABEL });
    expect(takesStatusText({ ...CHOOSING, status: "stale" })).toContain("Out of date");
  });
});

describe("where a take starts playing (GRV-207)", () => {
  it("is the earliest placement it adds", () => {
    const before = createSliceFixtureProject();
    const input = offerTakesInput(before);
    const placement = input.takes[0].calls[2].input as { startTicks: number };
    expect(placement.startTicks).toBe(0);
    const later = {
      ...before,
      song: {
        ...before.song,
        placements: [
          ...before.song.placements,
          {
            id: "plc_new",
            clipId: before.clips[0]?.id ?? "",
            trackId: before.song.tracks[0]?.id ?? "",
            startTicks: 3_072,
            durationTicks: 768,
            clipOffsetTicks: 0,
            looped: false,
          },
        ],
      },
    } as typeof before;
    expect(takeStartTicks(before, later)).toBe(3_072);
    expect(takeStartTicks(before, before)).toBeNull();
  });
});

describe("a drum pattern's takes (GRV-213)", () => {
  const DRUMS: Card = { ...CHOOSING, part: "Drum pattern", partType: "drums" };

  it("says a drum take is heard on a loop, and its Hear button says so", () => {
    renderCard(DRUMS);
    expect(
      screen.getByRole("button", { name: "Hear take 1" }).getAttribute("title"),
    ).toBe("Hear it on a loop in your song");
    expect(takesStatusText({ ...DRUMS, hearing: 1 })).toBe(
      "Hearing take 2 on a loop in your song. Nothing changes until you use one.",
    );
    expect(takesStatusText({ ...CHOOSING, hearing: 1 })).not.toContain("loop");
  });

  const placed = (
    before: ReturnType<typeof createSliceFixtureProject>,
    startTicks: number,
    durationTicks: number,
    lengthTicks: number,
  ) => {
    const clip = { ...(before.clips[0] as (typeof before.clips)[number]) };
    const newClip = { ...clip, id: "clp_new", lengthTicks } as typeof clip;
    return {
      ...before,
      clips: [...before.clips, newClip],
      song: {
        ...before.song,
        placements: [
          ...before.song.placements,
          {
            id: "plc_new",
            clipId: "clp_new",
            trackId: before.song.tracks[0]?.id ?? "",
            startTicks,
            durationTicks,
            clipOffsetTicks: 0,
            looped: true,
          },
        ],
      },
    } as typeof before;
  };

  it("loops on the pattern's own length from the bar it starts in, in whole bars", () => {
    const before = createSliceFixtureProject();
    // A one-bar pattern placed over four bars from bar 3 loops on bar 3.
    expect(takePatternLoop(before, placed(before, 1_536, 3_072, 768))).toEqual({
      startTicks: 1_536,
      endTicks: 2_304,
    });
    // A two-bar pattern loops on both its bars.
    expect(takePatternLoop(before, placed(before, 0, 3_072, 1_536))).toEqual({
      startTicks: 0,
      endTicks: 1_536,
    });
    // A part-bar pattern rounds out to the bar.
    expect(takePatternLoop(before, placed(before, 0, 3_072, 384))).toEqual({
      startTicks: 0,
      endTicks: 768,
    });
    expect(takePatternLoop(before, before)).toBeNull();
  });

  it("previews a drum take with the song's loop on its pattern, and a melodic take as it is", () => {
    const row: TakeRow = {
      label: "Busy",
      commands: [{ type: "clip.create", payload: {} }],
      startTicks: 0,
      endTicks: 3_072,
      trackName: "Drums",
      issue: null,
      issues: [],
      loop: { startTicks: 0, endTicks: 768 },
    };
    expect(hearingCommands(row)).toEqual([
      { type: "clip.create", payload: {} },
      { type: "loop.setRange", payload: { startTicks: 0, endTicks: 768 } },
      { type: "loop.setEnabled", payload: { enabled: true } },
    ]);
    expect(hearingCommands({ ...row, loop: null })).toEqual(row.commands);
    expect(hearingCommands({ ...row, commands: null })).toBeNull();
  });
});
