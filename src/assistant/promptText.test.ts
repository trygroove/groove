import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { deviceTypes } from "../domain/devices";
import { SYNTH_PARAMETERS } from "../domain/parameters";
import { MINIMAL_ASSISTANT_CONTEXT } from "../testing/scriptedAssistantProvider";
import {
  ASSISTANT_SYSTEM_PROMPT,
  assistantSystemPrompt,
  buildSystemBlocks,
  DRUM_STEP_STRINGS_LINE,
  describeParameter,
  GUIDED_BUILD_RULE,
  PATTERN_GENERATORS_LINE,
  PROMPT_DROP_GROUPS,
  PROMPT_RULES_IN_TOOLS,
  type PromptDropTactic,
  type PromptTactics,
  type PromptTextLevel,
  SHARED_TOOL_RULES,
  withPromptRules,
} from "./prompt";
import { TACTIC_DEFAULTS, TACTICS, type TacticValues } from "./tactics";
import { videoRecommendationTool } from "./video";

const LEVELS = TACTICS.promptText.values as readonly PromptTextLevel[];
const DROPS = Object.keys(PROMPT_DROP_GROUPS) as PromptDropTactic[];

/** Every drop tactic at `keep`, so a later change of default leaves a test standing. */
const KEEP_ALL = Object.fromEntries(DROPS.map((id) => [id, "keep"])) as PromptTactics;

/** The four older tactics that change the fixed prompt, every combination of them. */
const OLDER_TACTICS = [
  "oneResponseProposal",
  "guidedBuild",
  "drumStepStrings",
  "patternGenerators",
] as const;

function olderCombinations(): PromptTactics[] {
  return Array.from({ length: 2 ** OLDER_TACTICS.length }, (_, mask) =>
    Object.fromEntries(
      OLDER_TACTICS.map((id, bit) => [id, mask & (1 << bit) ? "on" : "off"]),
    ),
  );
}

const prompt = (tactics: PromptTactics) =>
  assistantSystemPrompt({ ...KEEP_ALL, promptText: "full", ...tactics });

/** How a proposal is built, and its room: `oneResponseProposal`'s text (GRV-142). */
const PROPOSAL_STEPS =
  /Build it in steps.*?in the same step\.|Write the whole proposal.*?ends with explain_change\./;
const PROPOSAL_ROOM =
  /## Keeping (?:each step|a response)[\s\S]*?(?=\n\n## The producer)/;

const SYNTH_LINE = SYNTH_PARAMETERS.map(describeParameter).join("; ");
const DEVICE_LINES = deviceTypes().map(
  (device) =>
    `- ${device.type} (${device.label}): ${device.parameters.map(describeParameter).join("; ")}`,
);

/** The prompt's own words: everything but the generated reference and GRV-142's text. */
function ownText(text: string): string {
  let own = text
    .replace(PROPOSAL_STEPS, "")
    .replace(PROPOSAL_ROOM, "")
    .replace(SYNTH_LINE, "");
  for (const line of DEVICE_LINES) own = own.replace(line, "");
  return own;
}

describe("the promptText and promptDrop tactics (GRV-147)", () => {
  it("default to the prompt as written, with every group kept", () => {
    expect(TACTICS.promptText.default).toBe("full");
    for (const id of DROPS) {
      expect(TACTICS[id].values).toEqual(["keep", "drop"]);
      expect(TACTICS[id].default).toBe("keep");
    }
    expect(ASSISTANT_SYSTEM_PROMPT).toBe(assistantSystemPrompt(TACTIC_DEFAULTS));
  });

  // Pinned from origin/main before GRV-147 restructured the prompt into
  // passages: the 16 prompts the older prompt tactics make, at full with every
  // group kept. Re-pin only when the full text itself is meant to change.
  it("leaves full with nothing dropped byte-identical to the prompt before GRV-147", () => {
    const texts = olderCombinations().map((tactics) => prompt(tactics));
    expect(createHash("sha256").update(texts.join("\u0000")).digest("hex")).toBe(
      "b1a8d33ac22be47332a1ae4304c207f0e05134bce899448f29350fc8021eea33",
    );
  });

  it("keeps every tactic's own text and the generated reference verbatim at every level and drop", () => {
    for (const level of LEVELS) {
      for (const drop of [undefined, ...DROPS]) {
        for (const older of olderCombinations()) {
          const tactics: PromptTactics = {
            ...older,
            promptText: level,
            ...(drop ? { [drop]: "drop" } : {}),
          };
          const text = prompt(tactics);
          const full = prompt(older);
          const label = `${level} ${drop ?? "none"} ${JSON.stringify(older)}`;
          expect(text.match(PROPOSAL_STEPS)?.[0], label).toBe(
            full.match(PROPOSAL_STEPS)?.[0],
          );
          expect(text.match(PROPOSAL_ROOM)?.[0], label).toBe(
            full.match(PROPOSAL_ROOM)?.[0],
          );
          expect(text.includes(GUIDED_BUILD_RULE), label).toBe(
            older.guidedBuild === "on",
          );
          expect(text.includes(DRUM_STEP_STRINGS_LINE), label).toBe(
            older.drumStepStrings === "on",
          );
          expect(text.includes(PATTERN_GENERATORS_LINE), label).toBe(
            older.patternGenerators === "on",
          );
          expect(text, label).toContain(SYNTH_LINE);
          for (const line of DEVICE_LINES) expect(text, label).toContain(line);
        }
      }
    }
  });

  it("leaves the blocks after the prompt, and GRV-146's shared rules, the same at every level and drop", () => {
    const blocks = (tactics: Partial<TacticValues>) =>
      buildSystemBlocks(
        MINIMAL_ASSISTANT_CONTEXT,
        { packs: [] } as never,
        "S".repeat(17),
        { profile: {} } as never,
        { ...TACTIC_DEFAULTS, ...tactics },
      );
    for (const toolText of TACTICS.toolText.values) {
      const control = blocks({ toolText });
      for (const level of LEVELS) {
        for (const drop of [undefined, ...DROPS]) {
          const variant = blocks({
            toolText,
            promptText: level,
            ...(drop ? { [drop]: "drop" } : {}),
          });
          expect(variant.slice(1)).toEqual(control.slice(1));
          expect(variant[0].text.endsWith(`\n\n${SHARED_TOOL_RULES}`)).toBe(
            toolText !== "full",
          );
        }
      }
    }
  });

  // The targets are on the prompt's own words: the generated reference (the
  // synth's and devices' parameters) and how a proposal is built (GRV-142)
  // are not this tactic's to reword. Against the whole fixed prompt the
  // levels come to about -21% and -44% (see the PR).
  it("meets its length targets on the prompt's own words", () => {
    const own = Object.fromEntries(
      LEVELS.map((level) => [level, ownText(prompt({ promptText: level })).length]),
    ) as Record<PromptTextLevel, number>;
    const whole = Object.fromEntries(
      LEVELS.map((level) => [level, prompt({ promptText: level }).length]),
    );
    console.info(
      `prompt chars, whole: ${JSON.stringify(whole)}; own words: ${JSON.stringify(own)}`,
    );
    expect(own.moderate).toBeLessThanOrEqual(own.full * 0.75);
    expect(own.aggressive).toBeLessThanOrEqual(own.full * 0.5);
  });

  it("keeps the phrases checks and other tactics lean on at every level", () => {
    for (const level of LEVELS) {
      const text = prompt({ promptText: level });
      // GRV-145's rule quotes it.
      expect(text, level).toContain("without asking again");
      // Check pointsToGenerate (GRV-101 QA).
      expect(text, level).toContain("try more patterns for a row in the Generate panel");
      for (const name of [
        "explain_change",
        "ask_producer",
        "recommend_sounds",
        "remember_producer",
        "memoryQuestion",
        "askLater",
        "track_create",
        "placement_update",
        "device_add",
        '"down 1 dB"',
        "looped: true",
        '{"bypassed": false, "preset": null}',
      ]) {
        expect(text, `${level}: ${name}`).toContain(name);
      }
    }
  });

  it("names each of the app's panels at every level", () => {
    for (const level of LEVELS) {
      const section = prompt({ promptText: level })
        .split("## What Groove has")[1]
        ?.split("\n## ")[0];
      for (const panel of [
        "Synth",
        "Drum machine",
        "Sampler",
        "Step editor",
        "Piano roll",
        "Generate panel",
        "Transform panel",
        "Loop panel",
        "Library",
        "My packs",
        "Mixer",
        "device chain",
        "Sends",
        "Returns",
        "Master",
        "level meter",
        "Sections",
        "loop brace",
        "metronome",
        "Export dialog",
      ]) {
        expect(section, `${level}: ${panel}`).toContain(panel);
      }
      expect(section, level).not.toMatch(/\b[a-z]+_[a-z_]+\b/);
    }
  });

  it("drops only its own group, at every level", () => {
    const groups: Record<PromptDropTactic, RegExp> = {
      promptDropAppFeatures: /\n\n## What Groove has[\s\S]*?(?=\n\n## What a change)/,
      promptDropToolAddressing:
        /\n\n## How the tools address things[\s\S]*?(?=\n\n## Sounds)/,
      promptDropStaleDescription:
        / It is never out of date[^\n]*?newer than that reply\./,
      promptDropDrumSoundPads: /\n- A drum sound the producer names[^\n]*/,
    };
    for (const id of DROPS) {
      const full = prompt({});
      expect(full, id).toMatch(groups[id]);
      expect(prompt({ [id]: "drop" }), id).toBe(full.replace(groups[id], ""));
      for (const level of LEVELS) {
        const kept = prompt({ promptText: level });
        const dropped = prompt({ promptText: level, [id]: "drop" });
        expect(dropped.length, `${id} ${level}`).toBeLessThan(kept.length);
        // Every heading but a dropped section's stays.
        const headings = (text: string): string[] => text.match(/^## .+$/gm) ?? [];
        const lost = headings(kept).filter(
          (heading) => !headings(dropped).includes(heading),
        );
        expect(lost, `${id} ${level}`).toEqual(
          id === "promptDropAppFeatures"
            ? ["## What Groove has"]
            : id === "promptDropToolAddressing"
              ? ["## How the tools address things"]
              : [],
        );
      }
    }
  });

  it("keeps a tactic's bullets under their heading when the tool-addressing group is dropped", () => {
    for (const level of LEVELS) {
      const text = prompt({
        promptText: level,
        promptDropToolAddressing: "drop",
        drumStepStrings: "on",
        patternGenerators: "on",
      });
      expect(text).toContain(
        `## How the tools address things\n\n${PATTERN_GENERATORS_LINE}\n${DRUM_STEP_STRINGS_LINE}\n\n## Sounds`,
      );
    }
  });

  it("says recommend_video's rules in its description at the trimmed levels, and only there", () => {
    const tool = videoRecommendationTool();
    expect(withPromptRules(tool, "full")).toBe(tool);
    expect(prompt({})).toContain("and recommend_video is among your tools");
    for (const level of ["moderate", "aggressive"] as const) {
      const moved = withPromptRules(tool, level);
      expect(moved.description).toBe(
        `${tool.description} ${PROMPT_RULES_IN_TOOLS[level].recommend_video}`,
      );
      expect(moved.input_schema).toBe(tool.input_schema);
      expect(prompt({ promptText: level })).not.toContain("recommend_video");
    }
    // A tool no rule moves into is left as it is.
    const other = { name: "parameter_set", description: "Set one parameter." };
    expect(withPromptRules(other, "aggressive")).toBe(other);
  });
});
