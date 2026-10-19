import { describe, expect, it } from "vitest";
import { NOTE_VELOCITY } from "../../domain/parameters";
import {
  ARPEGGIO_RATES,
  type ArpeggioInput,
  arpeggio,
  bassRoot,
  chordStabs,
  type GeneratedNote,
  type MelodicContext,
  type MelodicResult,
} from "./melodic";
import { seededRandom } from "./random";

const BAR = 768;
const V = NOTE_VELOCITY.defaultValue;
/** A step string's x, X and o, as a note's velocity. */
const X = Math.round((100 / 127) * 1000) / 1000;
const ACCENT = Math.round((120 / 127) * 1000) / 1000;

function context(overrides: Partial<MelodicContext> = {}): MelodicContext {
  return {
    lengthTicks: BAR,
    random: seededRandom("seed"),
    maxNotes: 999,
    ...overrides,
  };
}

function notesOf(result: MelodicResult): GeneratedNote[] {
  if (!result.ok) throw new Error(`${result.field}: ${result.reason}`);
  return result.notes;
}

function refusalOf(result: MelodicResult): string {
  if (result.ok) throw new Error("expected a refusal");
  return `${result.field}: ${result.reason}`;
}

const pitches = (notes: readonly GeneratedNote[]) => notes.map((note) => note[1]);

describe("arpeggio at variation 0 (GRV-141)", () => {
  it("plays each chord's tones up, a step each, starting again at each chord", () => {
    expect(notesOf(arpeggio({ chords: [["C", 1]], rate: "4th" }, context()))).toEqual([
      [0, 60, 192, V],
      [192, 64, 192, V],
      [384, 67, 192, V],
      [576, 60, 192, V],
    ]);
    expect(
      notesOf(
        arpeggio(
          {
            chords: [
              ["Am", 0.5],
              ["F", 0.5],
            ],
            rate: "4th",
          },
          context(),
        ),
      ),
    ).toEqual([
      [0, 69, 192, V],
      [192, 72, 192, V],
      [384, 65, 192, V],
      [576, 69, 192, V],
    ]);
  });

  it("goes down, up and down, and over octaves", () => {
    const of = (direction: "down" | "upDown", octaves = 1) =>
      pitches(
        notesOf(
          arpeggio({ chords: [["C", 1]], rate: "8th", direction, octaves }, context()),
        ),
      );
    expect(of("down")).toEqual([67, 64, 60, 67, 64, 60, 67, 64]);
    expect(of("upDown")).toEqual([60, 64, 67, 64, 60, 64, 67, 64]);
    expect(
      pitches(
        notesOf(arpeggio({ chords: [["C", 1]], rate: "8th", octaves: 2 }, context())),
      ),
    ).toEqual([60, 64, 67, 72, 76, 79, 60, 64]);
  });

  it("defaults to 16ths, up, one octave, from octave 4", () => {
    const notes = notesOf(arpeggio({ chords: [["C", 1]] }, context()));
    expect(notes).toHaveLength(16);
    expect(notes[1]).toEqual([48, 64, 48, V]);
  });

  it("steps at every rate it names, triplets included", () => {
    expect(ARPEGGIO_RATES).toEqual({
      "4th": 192,
      "8th": 96,
      "16th": 48,
      "32nd": 24,
      "8thTriplet": 64,
      "16thTriplet": 32,
    });
    const triplets = notesOf(
      arpeggio({ chords: [["C", 1]], rate: "8thTriplet" }, context()),
    );
    expect(triplets).toHaveLength(12);
    expect(triplets.map((note) => note[0]).slice(0, 4)).toEqual([0, 64, 128, 192]);
  });

  it("repeats the progression to fill the clip", () => {
    const notes = notesOf(
      arpeggio({ chords: [["C", 1]], rate: "4th" }, context({ lengthTicks: 2 * BAR })),
    );
    expect(notes).toHaveLength(8);
    expect(notes[4]).toEqual([768, 60, 192, V]);
  });

  it("shuffles a random arpeggio by the call at variation 0, and by the turn's seed above it", () => {
    const of = (seed: string, call: Partial<ArpeggioInput> = {}) =>
      pitches(
        notesOf(
          arpeggio(
            {
              chords: [["Cmaj7", 1]],
              rate: "16th",
              direction: "random",
              octaves: 2,
              ...call,
            },
            context({ random: seededRandom(seed) }),
          ),
        ),
      );
    expect(new Set(of("a"))).toEqual(new Set([60, 64, 67, 71, 72, 76, 79, 83]));
    // At 0 the output is exact: the same call, the same notes, whatever the turn.
    expect(of("b")).toEqual(of("a"));
    expect(of("b", { variation: 0 })).toEqual(of("a"));
    expect(of("a")).not.toEqual([
      60, 64, 67, 71, 72, 76, 79, 83, 60, 64, 67, 71, 72, 76, 79, 83,
    ]);
    // A different call is a different shuffle.
    const calls = new Set(
      ["Cmaj7", "Dm7", "Em7", "Fmaj7"].map((chord) =>
        of("a", { chords: [[chord, 1]] })
          .map((pitch, _, all) => [...new Set(all)].sort((x, y) => x - y).indexOf(pitch))
          .join(","),
      ),
    );
    expect(calls.size).toBeGreaterThan(1);
    // Above 0 the turn's seed shuffles it: the same seed, the same order.
    const varied = (seed: string) => of(seed, { variation: 0.01 });
    expect(varied("a")).toEqual(varied("a"));
    const orders = new Set(["a", "b", "c", "d"].map((seed) => varied(seed).join(",")));
    expect(orders.size).toBeGreaterThan(1);
  });
});

describe("chordStabs and bassRoot at variation 0 (GRV-141)", () => {
  it("holds each chord for its length without a rhythm", () => {
    expect(
      notesOf(
        chordStabs(
          {
            chords: [
              ["Am", 1],
              ["F", 1],
            ],
          },
          context({ lengthTicks: 2 * BAR }),
        ),
      ),
    ).toEqual([
      [0, 69, 768, X],
      [0, 72, 768, X],
      [0, 76, 768, X],
      [768, 65, 768, X],
      [768, 69, 768, X],
      [768, 72, 768, X],
    ]);
  });

  it("stabs the whole chord on each hit of the rhythm, for one step", () => {
    expect(
      notesOf(
        chordStabs({ chords: [["C", 1]], rhythm: "X...", stepTicks: 96 }, context()),
      ),
    ).toEqual([
      [0, 60, 96, ACCENT],
      [0, 64, 96, ACCENT],
      [0, 67, 96, ACCENT],
      [384, 60, 96, ACCENT],
      [384, 64, 96, ACCENT],
      [384, 67, 96, ACCENT],
    ]);
  });

  it("plays each chord's slash bass, else its root, in the octave asked for", () => {
    expect(
      notesOf(
        bassRoot(
          {
            chords: [
              ["C/E", 0.5],
              ["G", 0.5],
            ],
            rhythm: "x.......",
          },
          context(),
        ),
      ),
    ).toEqual([
      [0, 40, 48, X],
      [384, 43, 48, X],
    ]);
    expect(
      pitches(notesOf(bassRoot({ chords: [["A", 1]], octave: 1 }, context()))),
    ).toEqual([33]);
  });

  it("plays the chord a hit lands in, and cuts a hit short at the chord's end", () => {
    const notes = notesOf(
      bassRoot(
        {
          chords: [
            ["C", 0.25],
            ["F", 0.75],
          ],
          rhythm: "x.",
          stepTicks: 144,
        },
        context(),
      ),
    );
    expect(notes).toEqual([
      [0, 36, 144, X],
      [288, 41, 144, X],
      [576, 41, 144, X],
    ]);
    const cut = notesOf(
      bassRoot(
        {
          chords: [
            ["C", 0.25],
            ["F", 0.75],
          ],
          rhythm: "x",
          stepTicks: 144,
        },
        context(),
      ),
    );
    expect(cut[1]).toEqual([144, 36, 48, X]);
  });
});

describe("the melodic generators' refusals (GRV-141)", () => {
  it("refuses an unknown chord with the reason, naming where it is", () => {
    expect(
      refusalOf(
        chordStabs(
          {
            chords: [
              ["C", 0.5],
              ["Cadd9", 0.5],
            ],
          },
          context(),
        ),
      ),
    ).toMatch(/^chords\.1\.0: "Cadd9" is not a chord Groove voices/);
  });

  it("refuses a chord length that is not whole ticks, and a progression longer than the clip", () => {
    expect(refusalOf(bassRoot({ chords: [["C", 0.001]] }, context()))).toMatch(
      /^chords\.0\.1: 0\.001 bars is not a whole number of ticks/,
    );
    expect(
      refusalOf(
        arpeggio(
          {
            chords: [
              ["C", 1],
              ["G", 1],
            ],
          },
          context(),
        ),
      ),
    ).toMatch(/^chords: the chords last 2 bars, longer than the clip's 1/);
  });

  it("refuses a rhythm longer than the clip", () => {
    expect(
      refusalOf(chordStabs({ chords: [["C", 1]], rhythm: "x".repeat(17) }, context())),
    ).toMatch(/^rhythm: 17 steps of 48 ticks is 816 ticks, longer than the clip's 768/);
  });

  it("refuses a voicing past MIDI's range", () => {
    expect(
      refusalOf(arpeggio({ chords: [["B", 1]], octave: 8, octaves: 4 }, context())),
    ).toMatch(/^octave: the voicing reaches MIDI pitch \d+, outside 0 to 127/);
  });

  it("refuses more notes than the proposal has left", () => {
    expect(
      refusalOf(arpeggio({ chords: [["C", 1]] }, context({ maxNotes: 15 }))),
    ).toMatch(/more notes than the 15 this proposal has left/);
    expect(
      notesOf(arpeggio({ chords: [["C", 1]] }, context({ maxNotes: 16 }))),
    ).toHaveLength(16);
  });
});

describe("the melodic generators' variation (GRV-141)", () => {
  const varied = (seed: string, variation = 0.8) => ({
    arp: notesOf(
      arpeggio(
        {
          chords: [
            ["Am", 1],
            ["F", 1],
            ["C", 1],
            ["G", 1],
          ],
          octaves: 2,
          variation,
        },
        context({ lengthTicks: 4 * BAR, random: seededRandom(seed) }),
      ),
    ),
    bass: notesOf(
      bassRoot(
        { chords: [["Am", 1]], rhythm: "x.x.x.x.x.x.x.x.", variation },
        context({ lengthTicks: 4 * BAR, random: seededRandom(seed) }),
      ),
    ),
  });

  it("is the same for the same seed", () => {
    expect(varied("turn:0:0")).toEqual(varied("turn:0:0"));
  });

  it("differs for a different seed, and from the exact part", () => {
    expect(varied("turn:0:0")).not.toEqual(varied("turn:1:0"));
    expect(varied("turn:0:0")).not.toEqual(varied("turn:0:0", 0));
  });

  it("moves velocities within the note's range, and alters the arpeggio a little", () => {
    const { arp, bass } = varied("turn:0:0", 1);
    const exact = varied("turn:0:0", 0);
    const velocities = new Set([...arp, ...bass].map((note) => note[3]));
    expect(velocities.size).toBeGreaterThan(2);
    for (const velocity of velocities) {
      expect(velocity).toBeGreaterThanOrEqual(NOTE_VELOCITY.min);
      expect(velocity).toBeLessThanOrEqual(NOTE_VELOCITY.max);
    }
    expect(pitches(arp)).not.toEqual(pitches(exact.arp));
    // Every chord still starts on time.
    for (const start of [0, 768, 1536, 2304]) {
      expect(arp.some((note) => note[0] === start)).toBe(true);
    }
    // A ghost on a rest, or a hit dropped: the bass's hits move.
    expect(bass.map((note) => note[0])).not.toEqual(exact.bass.map((note) => note[0]));
  });

  it("is exact at 0, whatever the seed", () => {
    expect(varied("a", 0)).toEqual(varied("b", 0));
  });
});
