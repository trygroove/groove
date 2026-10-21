import { describe, expect, it } from "vitest";
import {
  ASSISTANT_HISTORY_TOKEN_BUDGET,
  ASSISTANT_MODELS,
  SMALLEST_CONTEXT_WINDOW_TOKENS,
} from "./config";
import { historyBudgetFor } from "./gateway";
import {
  boundHistory,
  estimateTokens,
  type HistoryEntry,
  historyOf,
  lessonNote,
  MAX_MESSAGE_CHARS,
} from "./history";
import type { AssistantMessage } from "./protocol";

const user = (text: string): AssistantMessage => ({ role: "user", text });
const assistant = (text: string): AssistantMessage => ({ role: "assistant", text });

describe("boundHistory", () => {
  it("keeps a conversation that fits, whole", () => {
    const messages = [user("a"), assistant("b"), user("c")];
    expect(boundHistory(messages, 1_000)).toEqual({ messages, dropped: 0 });
  });

  it("drops the oldest messages first and keeps the newest", () => {
    const messages = [user("x".repeat(300)), assistant("y".repeat(300)), user("newest")];
    const bounded = boundHistory(messages, 120);
    expect(bounded.messages).toEqual([user("newest")]);
    expect(bounded.dropped).toBe(2);
  });

  it("never starts the resent history with the assistant", () => {
    const messages = [user("x".repeat(300)), assistant("short"), user("newest")];
    const bounded = boundHistory(messages, 40);
    expect(bounded.messages[0].role).toBe("user");
  });

  it("returns nothing when even the newest message does not fit", () => {
    expect(boundHistory([user("x".repeat(900))], 10).messages).toEqual([]);
  });
});

describe("the history budget", () => {
  it("is sized for the smallest configured window, not the active model's", () => {
    expect(SMALLEST_CONTEXT_WINDOW_TOKENS).toBe(
      ASSISTANT_MODELS["claude-haiku-4-5"].contextWindowTokens,
    );
  });

  it("leaves room in the smallest window for the system prompt, history and reply", () => {
    const systemTokens = 20_000;
    const budget = historyBudgetFor(systemTokens);
    const reply = Math.max(
      ...Object.values(ASSISTANT_MODELS).map((m) => m.maxOutputTokens),
    );
    expect(budget).toBeLessThanOrEqual(ASSISTANT_HISTORY_TOKEN_BUDGET);
    expect(systemTokens + budget + reply).toBeLessThan(SMALLEST_CONTEXT_WINDOW_TOKENS);
  });

  it("shrinks as the project context grows, rather than overflowing", () => {
    expect(historyBudgetFor(190_000)).toBeLessThanOrEqual(0);
  });

  it("estimates conservatively: never fewer tokens than characters over four", () => {
    const text = "Push the kick up by two decibels in the chorus.";
    expect(estimateTokens(text)).toBeGreaterThanOrEqual(text.length / 4);
  });
});

describe("historyOf: what became of each proposal (GRV-150)", () => {
  const proposed = (proposal?: Extract<HistoryEntry, { kind: "reply" }>["proposal"]) =>
    historyOf([
      { kind: "message", text: "add a closed hi-hat on the offbeats" },
      {
        kind: "reply",
        text: "I'll add a Closed Hat track.",
        ...(proposal ? { proposal } : {}),
      },
      { kind: "proposal" },
    ]);

  it("says a cancelled proposal changed nothing, after the reply that made it", () => {
    expect(proposed("cancelled")).toEqual([
      user("add a closed hi-hat on the offbeats"),
      assistant(
        "I'll add a Closed Hat track.\n\n[The producer cancelled this proposal. Nothing in it is in the song.]",
      ),
    ]);
  });

  it("says an applied proposal was applied", () => {
    expect(proposed("applied").at(-1)?.text).toBe(
      "I'll add a Closed Hat track.\n\n[The producer applied this proposal. The project description shows the song as it is now.]",
    );
  });

  it("says an undone, a refused and an unanswered proposal changed nothing", () => {
    expect(proposed("undone").at(-1)?.text).toContain(
      "[The producer applied this proposal, then undid it. Nothing in it is in the song.]",
    );
    expect(proposed("rejected").at(-1)?.text).toContain(
      "[This proposal could not be applied. Nothing in it is in the song.]",
    );
    expect(proposed("pending").at(-1)?.text).toContain(
      "[The producer has not applied this proposal. Nothing in it is in the song.]",
    );
  });

  it("says nothing more of a reply that proposed nothing", () => {
    expect(proposed().at(-1)?.text).toBe("I'll add a Closed Hat track.");
  });

  it("keeps the note when the reply is as long as a message may be", () => {
    const [, reply] = historyOf([
      { kind: "message", text: "go" },
      { kind: "reply", text: "x".repeat(MAX_MESSAGE_CHARS), proposal: "cancelled" },
    ]);
    expect(reply.text).toHaveLength(MAX_MESSAGE_CHARS);
    expect(reply.text.endsWith("Nothing in it is in the song.]")).toBe(true);
  });
});

describe("historyOf after a reply that started a lesson (GRV-43)", () => {
  it("says the call started it, so a later ask calls it again", () => {
    // QA: after a chapter, "teach me to shape a sound" got "Starting it now"
    // and no card: the history showed only the sentence that started one.
    const history = historyOf([
      { kind: "message", text: "Teach me how to make a beat" },
      { kind: "reply", text: 'Starting "Make a beat" now.', lesson: "beat" },
      { kind: "message", text: 'Let\'s do "Pick a kick".' },
      { kind: "reply", text: "Open the Library." },
    ]);
    expect(history[1]).toEqual(
      assistant(`Starting "Make a beat" now.\n\n${lessonNote("beat")}`),
    );
    expect(lessonNote("beat")).toContain('start_lesson with chapter "beat"');
    // "Finish a track" (GRV-44) is resent the same way.
    expect(lessonNote("track")).toContain('start_lesson with chapter "track"');
    expect(history[3]).toEqual(assistant("Open the Library."));
  });
});
