import { cleanup, fireEvent, render, screen } from "@solidjs/testing-library";
import { flush } from "solid-js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Analytics } from "../../analytics/analytics";
import { ConsentStore } from "../../analytics/consent";
import { createRecordingTransport } from "../../analytics/transport";
import type { AssistantVideo } from "../../assistant/video";
import { clickAndFlush, fireAndFlush } from "../../testing/events";
import { memoryStorage } from "../../testing/storage";
import VideoCard, {
  GOOGLE_PRIVACY_URL,
  VIDEO_FAILED,
  YOUTUBE_TERMS_URL,
} from "./VideoCard";

const VIDEO: AssistantVideo = {
  videoId: "tH9LHIyJ0c8",
  title: "Acid Basslines Explained",
  channel: "Underdog",
  reason: "Shows how resonance and envelope mod make the squelch.",
};

function setup(loadTimeoutMs = 15_000) {
  const transport = createRecordingTransport();
  const analytics = new Analytics({
    transport,
    consent: new ConsentStore(memoryStorage()),
    storage: memoryStorage(),
  });
  analytics.setAccountType("registered");
  const view = render(() => (
    <VideoCard video={VIDEO} analytics={() => analytics} loadTimeoutMs={loadTimeoutMs} />
  ));
  flush();
  const named = (name: string) => transport.named(name);
  return { view, named };
}

/** Lets the card's deferred focus move land. */
const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("a recommended tutorial video (GRV-16, ADR 0009)", () => {
  it("is a still card that loads nothing from YouTube until Play", () => {
    const { view } = setup();
    expect(view.container.querySelector("iframe")).toBeNull();
    // No thumbnail, or anything else, fetched from Google before the press.
    expect(view.container.querySelector("img, video, source, picture")).toBeNull();
    expect(screen.getByText(VIDEO.title)).toBeInTheDocument();
    expect(screen.getAllByText(VIDEO.channel).length).toBeGreaterThan(0);
    expect(screen.getByText(VIDEO.reason)).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: `Play ${VIDEO.title} from YouTube` }),
    ).toBeInTheDocument();
  });

  it("names YouTube and its terms before Play", () => {
    const { view } = setup();
    const disclosure = view.container.querySelector(".assistant-video-disclosure");
    expect(disclosure?.textContent).toMatch(/YouTube/);
    expect(screen.getByRole("link", { name: "terms" })).toHaveAttribute(
      "href",
      YOUTUBE_TERMS_URL,
    );
    expect(screen.getByRole("link", { name: "privacy policy" })).toHaveAttribute(
      "href",
      GOOGLE_PRIVACY_URL,
    );
  });

  it("plays in the privacy-enhanced player, given nothing but the video, and keeps focus out of it", async () => {
    const { view, named } = setup();
    const play = screen.getByRole("button", { name: /^Play / });
    play.focus();
    clickAndFlush(play);
    const frame = view.container.querySelector("iframe");
    if (!frame) throw new Error("no player");
    const src = new URL(frame.getAttribute("src") ?? "");
    expect(src.origin).toBe("https://www.youtube-nocookie.com");
    expect(src.pathname).toBe(`/embed/${VIDEO.videoId}`);
    expect(frame.getAttribute("referrerpolicy")).toBe("strict-origin");
    expect(frame.getAttribute("sandbox")).not.toContain("allow-top-navigation");
    await settle();
    expect(document.activeElement).toBe(
      screen.getByRole("button", { name: "Close video" }),
    );
    expect(named("assistant_video_played")).toHaveLength(1);
    expect(named("feature_first_use").map((event) => event.params)).toEqual([
      expect.objectContaining({ feature: "assistant_video" }),
    ]);
    // Nothing about the video reaches analytics.
    expect(JSON.stringify(named("assistant_video_played"))).not.toContain(VIDEO.videoId);
  });

  it("goes back to the still card when the video is closed, with focus on Play", async () => {
    const { view } = setup();
    clickAndFlush(screen.getByRole("button", { name: /^Play / }));
    clickAndFlush(screen.getByRole("button", { name: "Close video" }));
    expect(view.container.querySelector("iframe")).toBeNull();
    await settle();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: /^Play / }));
  });

  it("says so in the card when the player does not load, and Try again makes a new one", async () => {
    vi.useFakeTimers();
    const { view, named } = setup(1_000);
    clickAndFlush(screen.getByRole("button", { name: /^Play / }));
    vi.advanceTimersByTime(1_000);
    flush();
    expect(view.container.querySelector("iframe")).toBeNull();
    expect(screen.getByRole("alert")).toHaveTextContent(VIDEO_FAILED);
    expect(named("assistant_video_failed")).toHaveLength(1);
    expect(screen.getByRole("link", { name: "Watch on YouTube" })).toHaveAttribute(
      "href",
      `https://www.youtube.com/watch?v=${VIDEO.videoId}`,
    );
    clickAndFlush(screen.getByRole("button", { name: "Try again" }));
    expect(view.container.querySelector("iframe")).not.toBeNull();
    expect(named("assistant_video_played")).toHaveLength(2);
  });

  it("does not fail a player that loaded", () => {
    vi.useFakeTimers();
    const { view, named } = setup(1_000);
    clickAndFlush(screen.getByRole("button", { name: /^Play / }));
    const frame = view.container.querySelector("iframe");
    if (!frame) throw new Error("no player");
    fireAndFlush(() => fireEvent.load(frame));
    vi.advanceTimersByTime(5_000);
    flush();
    expect(view.container.querySelector("iframe")).toBe(frame);
    expect(named("assistant_video_failed")).toHaveLength(0);
  });

  it("fills the window with the same player, and Escape puts it back", async () => {
    const { view, named } = setup();
    clickAndFlush(screen.getByRole("button", { name: /^Play / }));
    const frame = view.container.querySelector("iframe");
    clickAndFlush(screen.getByRole("button", { name: "Full screen" }));
    const card = view.container.querySelector(".assistant-video");
    expect(card).toHaveClass("assistant-video-expanded");
    // The same iframe, so the video carries on where it was.
    expect(view.container.querySelector("iframe")).toBe(frame);
    expect(named("assistant_video_expanded")).toHaveLength(1);
    await settle();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Close" }));

    fireAndFlush(() => fireEvent.keyDown(window, { key: "Escape" }));
    expect(card).not.toHaveClass("assistant-video-expanded");
    expect(view.container.querySelector("iframe")).toBe(frame);
  });
});
