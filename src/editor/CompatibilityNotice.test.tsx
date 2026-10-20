import { cleanup, render, screen } from "@solidjs/testing-library";
import { createSignal, flush } from "solid-js";
import { afterEach, describe, expect, it } from "vitest";
import { CAPABILITY_MESSAGES } from "../browser/capabilityMessages";
import { clickAndFlush } from "../testing/events";
import CompatibilityNotice, { type CompatibilityNoticeItem } from "./CompatibilityNotice";
import { compatibilityNoticeItems } from "./compatibilityNoticeItems";

afterEach(cleanup);

const webAudio: CompatibilityNoticeItem = {
  key: "capability:web_audio",
  message: CAPABILITY_MESSAGES.web_audio,
};
const storage: CompatibilityNoticeItem = {
  key: "capability:site_storage",
  message: CAPABILITY_MESSAGES.site_storage,
};

describe("CompatibilityNotice", () => {
  it("renders nothing when there is nothing to explain", () => {
    render(() => <CompatibilityNotice items={[]} />);
    expect(screen.queryByRole("region", { name: "Browser support" })).toBeNull();
  });

  it("states each limitation with what to do about it", () => {
    render(() => <CompatibilityNotice items={[webAudio, storage]} />);
    const notice = screen.getByRole("region", { name: "Browser support" });
    expect(notice).toHaveTextContent("This browser can't play sound.");
    expect(notice).toHaveTextContent(CAPABILITY_MESSAGES.web_audio.action);
    expect(notice).toHaveTextContent(CAPABILITY_MESSAGES.site_storage.action);
  });

  it("dismisses one notice at a time, and shows a new failure after a dismissed one", () => {
    const [items, setItems] = createSignal<CompatibilityNoticeItem[]>([
      webAudio,
      storage,
    ]);
    render(() => <CompatibilityNotice items={items()} />);

    clickAndFlush(
      screen.getByRole("button", { name: "Dismiss: This browser can't play sound" }),
    );
    expect(screen.queryByText(/This browser can't play sound/)).toBeNull();
    expect(screen.getByText(/Site data is blocked/)).toBeInTheDocument();

    clickAndFlush(screen.getByRole("button", { name: "Dismiss: Site data is blocked" }));
    expect(screen.queryByRole("region", { name: "Browser support" })).toBeNull();

    setItems([webAudio, storage, { ...webAudio, key: "audio-start:2" }]);
    flush();
    expect(screen.getByText(/This browser can't play sound/)).toBeInTheDocument();
  });
});

describe("compatibilityNoticeItems", () => {
  const capable = { available: {} as never, missing: [] };

  it("lists missing capabilities, then the last failure to start sound", () => {
    const items = compatibilityNoticeItems(
      { available: {} as never, missing: ["canvas_2d"] },
      { code: "autoplay_blocked", attempt: 3 },
    );
    expect(items.map((item) => item.key)).toEqual([
      "capability:canvas_2d",
      "audio-start:3",
    ]);
    expect(items[1]?.message.title).toBe("The browser blocked sound");
  });

  it("adds the sounds that failed to load, last, keyed by attempt (GRV-55)", () => {
    const items = compatibilityNoticeItems(capable, null, { count: 2, attempt: 4 });
    expect(items.map((item) => item.key)).toEqual(["sound-load:4"]);
    expect(items[0]?.message.title).toBe("2 sounds didn't load");
  });

  it("says nothing when the browser is capable and sound started", () => {
    expect(compatibilityNoticeItems(capable, null)).toEqual([]);
  });

  it("does not repeat the missing-Web-Audio advice, for decoding or for a play that failed", () => {
    const items = compatibilityNoticeItems(
      { available: {} as never, missing: ["web_audio", "audio_decoding"] },
      { code: "not_supported", attempt: 1 },
    );
    expect(items.map((item) => item.key)).toEqual(["capability:web_audio"]);
  });
});
