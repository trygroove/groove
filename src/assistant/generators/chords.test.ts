import { describe, expect, it } from "vitest";
import { bassNote, parseChord, pitchIn, voiceChord } from "./chords";

function voiced(name: string, octave = 4): number[] {
  const parsed = parseChord(name);
  if (!parsed.ok) throw new Error(parsed.reason);
  return voiceChord(parsed.chord, octave);
}

function reason(name: string): string {
  const parsed = parseChord(name);
  if (parsed.ok) throw new Error(`expected ${name} to be refused`);
  return parsed.reason;
}

describe("chord names (GRV-141)", () => {
  it("puts middle C in octave 4", () => {
    expect(pitchIn(0, 4)).toBe(60);
    expect(pitchIn(9, 4)).toBe(69);
  });

  it("voices majors and minors in close root position, in every spelling", () => {
    expect(voiced("C")).toEqual([60, 64, 67]);
    expect(voiced("Cmaj")).toEqual([60, 64, 67]);
    expect(voiced("CM")).toEqual([60, 64, 67]);
    expect(voiced("Am")).toEqual([69, 72, 76]);
    expect(voiced("Amin")).toEqual([69, 72, 76]);
    expect(voiced("A-")).toEqual([69, 72, 76]);
    expect(voiced("Bdim")).toEqual([71, 74, 77]);
    expect(voiced("Caug")).toEqual([60, 64, 68]);
    expect(voiced("C+")).toEqual([60, 64, 68]);
  });

  it("voices 7ths", () => {
    expect(voiced("G7")).toEqual([67, 71, 74, 77]);
    expect(voiced("Cmaj7")).toEqual([60, 64, 67, 71]);
    expect(voiced("CM7")).toEqual([60, 64, 67, 71]);
    expect(voiced("Dm7")).toEqual([62, 65, 69, 72]);
    expect(voiced("Dmin7")).toEqual([62, 65, 69, 72]);
    expect(voiced("CmMaj7")).toEqual([60, 63, 67, 71]);
    expect(voiced("Bdim7")).toEqual([71, 74, 77, 80]);
    expect(voiced("Bm7b5")).toEqual([71, 74, 77, 81]);
  });

  it("voices sus chords", () => {
    expect(voiced("Dsus4")).toEqual([62, 67, 69]);
    expect(voiced("Dsus")).toEqual([62, 67, 69]);
    expect(voiced("Gsus2")).toEqual([67, 69, 74]);
    expect(voiced("G7sus4")).toEqual([67, 72, 74, 77]);
  });

  it("reads flats and sharps on the root and the bass", () => {
    expect(voiced("F#m7")).toEqual([66, 69, 73, 76]);
    expect(voiced("Bb7")).toEqual([70, 74, 77, 80]);
    expect(voiced("Ebmaj7")).toEqual([63, 67, 70, 74]);
    expect(voiced("Cb")).toEqual([71, 75, 78]);
    expect(voiced("B#")).toEqual([60, 64, 67]);
    expect(voiced("Bb/D")).toEqual([62, 70, 74, 77]);
    expect(voiced("D/F#")).toEqual([54, 62, 66, 69]);
  });

  it("puts a slash bass below the root, the nearest such note", () => {
    expect(voiced("C/E")).toEqual([52, 60, 64, 67]);
    expect(voiced("G/B")).toEqual([59, 67, 71, 74]);
    expect(voiced("Am/G")).toEqual([67, 69, 72, 76]);
    // A slash bass that is the root itself sounds an octave below it.
    expect(voiced("C/C")).toEqual([48, 60, 64, 67]);
  });

  it("names the bass a bass part plays: the slash bass, else the root", () => {
    const slash = parseChord("C/E");
    const plain = parseChord("Am");
    if (!slash.ok || !plain.ok) throw new Error("expected chords");
    expect(bassNote(slash.chord, 2)).toBe(40);
    expect(bassNote(plain.chord, 2)).toBe(45);
  });

  it("voices in the octave asked for", () => {
    expect(voiced("C", 3)).toEqual([48, 52, 55]);
  });

  it("refuses an unknown quality with the reason and the qualities there are", () => {
    for (const name of ["Cadd9", "C9", "C13", "C6", "Cm6"]) {
      expect(reason(name)).toMatch(/is not a chord Groove voices: ".+" is not a quality/);
      expect(reason(name)).toContain("maj7");
      expect(reason(name)).toContain("slash bass");
    }
  });

  it("refuses a name with no root, or a bass that is not a note", () => {
    expect(reason("H")).toMatch(
      /^"H" is not a chord: a chord name starts with its root, A to G/,
    );
    expect(reason("")).toMatch(/is not a chord: a chord name starts/);
    expect(reason("am")).toMatch(/is not a chord: a chord name starts/);
    expect(reason("C/H")).toMatch(/"\/H" is not a quality/);
  });
});
