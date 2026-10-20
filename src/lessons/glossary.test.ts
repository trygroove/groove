import { describe, expect, it } from "vitest";
import { starterWorld } from "../testing/lessonWorld";
import { ALL_BITES } from "./chapters";
import { GLOSSARY, instructionParts, isTermId, plainInstruction } from "./glossary";
import { BEAT_STYLES } from "./style";

describe("a lesson's terms (GRV-43)", () => {
  it("splits a step's words into text and terms to tap", () => {
    expect(instructionParts("Put the [kick](kick) on [beat](beat) 1.")).toEqual([
      { kind: "text", text: "Put the " },
      { kind: "term", text: "kick", term: "kick" },
      { kind: "text", text: " on " },
      { kind: "term", text: "beat", term: "beat" },
      { kind: "text", text: " 1." },
    ]);
    expect(plainInstruction("Put the [kick](kick) on [beat](beat) 1.")).toBe(
      "Put the kick on beat 1.",
    );
  });

  it("leaves a term the glossary does not have as its words", () => {
    expect(instructionParts("A [thing](not-a-term) here")).toEqual([
      { kind: "text", text: "A thing here" },
    ]);
  });

  it("defines every term every step names, in every style", () => {
    for (const style of BEAT_STYLES) {
      for (const bite of ALL_BITES) {
        for (const step of bite.steps) {
          const words = step.instruction(starterWorld(), { style });
          for (const match of words.matchAll(/\[[^\]]+\]\(([a-z-]+)\)/g)) {
            expect(isTermId(match[1]), `${bite.id}/${step.id}: ${match[1]}`).toBe(true);
          }
        }
      }
    }
    for (const entry of Object.values(GLOSSARY)) {
      expect(entry.definition.length).toBeGreaterThan(10);
    }
  });
});
