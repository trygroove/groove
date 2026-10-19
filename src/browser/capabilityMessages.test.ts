import { describe, expect, it } from "vitest";
import { CAPABILITY_IDS } from "./capabilities";
import {
  audioStartFailureMessage,
  CAPABILITY_MESSAGES,
  soundLoadFailureMessage,
} from "./capabilityMessages";

describe("CAPABILITY_MESSAGES", () => {
  it.each(CAPABILITY_IDS)(
    "says what is wrong, what it costs, and what to do: %s",
    (id) => {
      const message = CAPABILITY_MESSAGES[id];
      expect(message.title.length).toBeGreaterThan(0);
      expect(message.detail.length).toBeGreaterThan(0);
      // Actionable (#75): the action names a supported browser or a setting to
      // change, never only that something is broken.
      expect(message.action).toMatch(/Chrome, Edge or Firefox|settings/);
    },
  );
});

describe("audioStartFailureMessage", () => {
  it("tells a producer whose browser blocked sound to press Play again or allow sound", () => {
    const message = audioStartFailureMessage("autoplay_blocked");
    expect(message.title).toBe("The browser blocked sound");
    expect(message.action).toMatch(/Press Play again/);
    expect(message.action).toMatch(/allow sound for this site/);
  });

  it("explains a missing audio engine as the missing-Web-Audio capability", () => {
    expect(audioStartFailureMessage("not_supported")).toBe(CAPABILITY_MESSAGES.web_audio);
    expect(audioStartFailureMessage("context_unavailable")).toBe(
      CAPABILITY_MESSAGES.web_audio,
    );
  });

  it("falls back to a retry for any other failure", () => {
    expect(audioStartFailureMessage("unknown").action).toMatch(/Press Play to try again/);
  });

  it("points a closed context at the output device, then Play (GRV-55)", () => {
    const message = audioStartFailureMessage("context_closed");
    expect(message.title).toBe("Sound stopped");
    expect(message.action).toMatch(/speakers or headphones/);
    expect(message.action).toMatch(/press Play/);
  });

  it("says a failed start keeps the edits when it suggests reloading (GRV-55)", () => {
    expect(audioStartFailureMessage("unknown").action).toMatch(
      /reload the page; your edits are kept/,
    );
  });
});

describe("soundLoadFailureMessage (GRV-55)", () => {
  it("says how many sounds are silent and what to do", () => {
    expect(soundLoadFailureMessage(1).title).toBe("A sound didn't load");
    const many = soundLoadFailureMessage(3);
    expect(many.title).toBe("3 sounds didn't load");
    expect(many.detail).toMatch(/stay silent/);
    expect(many.action).toMatch(/Check your connection, then reload the page/);
  });
});
