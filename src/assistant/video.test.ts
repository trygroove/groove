import { describe, expect, it, vi } from "vitest";
import { assistantTools } from "./tools";
import {
  assistantVideoSchema,
  checkVideoCalls,
  createOEmbedVideoVerifier,
  droppedVideoNote,
  RECOMMEND_VIDEO_TOOL,
  VIDEO_LIMITS,
  videoRecommendationTool,
  youtubeEmbedUrl,
} from "./video";

const ID = "tH9LHIyJ0c8";
const signal = () => new AbortController().signal;

function respond(status: number, body: unknown): typeof fetch {
  return vi.fn(async () => new Response(JSON.stringify(body), { status }));
}

describe("the oEmbed video check (ADR 0009 decision 5)", () => {
  it("asks YouTube's oEmbed endpoint about the watch URL, and keeps its title and channel", async () => {
    const fetcher = respond(200, {
      title: "Acid Basslines Explained",
      author_name: "Underdog",
      type: "video",
    });
    const facts = await createOEmbedVideoVerifier(fetcher)(ID, signal());
    expect(facts).toEqual({ title: "Acid Basslines Explained", channel: "Underdog" });
    const [url] = vi.mocked(fetcher).mock.calls[0] ?? [];
    expect(String(url)).toBe(
      `https://www.youtube.com/oembed?format=json&url=${encodeURIComponent(`https://www.youtube.com/watch?v=${ID}`)}`,
    );
  });

  it.each([
    ["missing", 404, "missing"],
    ["private or not embeddable", 401, "missing"],
    ["malformed", 400, "missing"],
    ["rate limited", 429, "unchecked"],
    ["down", 503, "unchecked"],
  ])("drops a video oEmbed answers %s (%i) as %s", async (_, status, refusal) => {
    const verify = createOEmbedVideoVerifier(respond(status, { error: "x" }));
    expect(await verify(ID, signal())).toBe(refusal);
  });

  it("drops a video when oEmbed is unreachable or answers in another shape", async () => {
    const down = createOEmbedVideoVerifier(async () => {
      throw new TypeError("fetch failed");
    });
    expect(await down(ID, signal())).toBe("unchecked");
    const odd = createOEmbedVideoVerifier(respond(200, { html: "<iframe>" }));
    expect(await odd(ID, signal())).toBe("unchecked");
  });

  it("gives up on a check that takes too long", async () => {
    const hang: typeof fetch = (_, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
      });
    expect(await createOEmbedVideoVerifier(hang, 10)(ID, signal())).toBe("unchecked");
  });

  it("never asks about something that is not a video ID", async () => {
    const fetcher = respond(200, { title: "x", author_name: "y" });
    const verify = createOEmbedVideoVerifier(fetcher);
    expect(await verify("../watch?v=x", signal())).toBe("missing");
    expect(await verify("short", signal())).toBe("missing");
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("cuts a long title and channel to what a card may show", async () => {
    const verify = createOEmbedVideoVerifier(
      respond(200, { title: "t".repeat(500), author_name: "c".repeat(500) }),
    );
    const facts = await verify(ID, signal());
    if (typeof facts !== "object") throw new Error("expected the video's facts");
    expect(facts.title).toHaveLength(VIDEO_LIMITS.maxTitleChars);
    expect(facts.channel).toHaveLength(VIDEO_LIMITS.maxChannelChars);
  });
});

describe("checkVideoCalls", () => {
  const call = (videoId: string, name = RECOMMEND_VIDEO_TOOL) => ({
    id: `t-${videoId}`,
    name,
    input: { videoId, reason: "Why." },
  });
  const verify = async (videoId: string) => ({ title: `T ${videoId}`, channel: "C" });

  it("keeps at most two videos per turn, without repeats, in the model's order", async () => {
    const ids = ["aaaaaaaaaaa", "aaaaaaaaaaa", "bbbbbbbbbbb", "ccccccccccc"];
    const checked = await checkVideoCalls(
      ids.map((id) => call(id)),
      verify,
      signal(),
    );
    expect(checked.videos.map((video) => video.videoId)).toEqual([
      "aaaaaaaaaaa",
      "bbbbbbbbbbb",
    ]);
    expect(checked.dropped).toBe(2);
    for (const video of checked.videos) {
      expect(assistantVideoSchema.safeParse(video).success).toBe(true);
    }
  });

  it("ignores every other tool's calls", async () => {
    const checked = await checkVideoCalls(
      [call("aaaaaaaaaaa", "recommend_sounds")],
      verify,
      signal(),
    );
    expect(checked).toEqual({ videos: [], dropped: 0, unchecked: 0 });
  });

  it("counts the videos it could not check apart from the ones YouTube refused", async () => {
    const checked = await checkVideoCalls(
      [call("aaaaaaaaaaa"), call("bbbbbbbbbbb")],
      async (videoId) => {
        if (videoId === "aaaaaaaaaaa") return "missing";
        throw new Error("unreachable");
      },
      signal(),
    );
    expect(checked).toEqual({ videos: [], dropped: 2, unchecked: 1 });
  });
});

describe("droppedVideoNote (GRV-16 QA)", () => {
  const video = { videoId: ID, title: "T", channel: "C", reason: "R" };

  it("says nothing when no video was dropped", () => {
    expect(droppedVideoNote("Here.", { videos: [video], dropped: 0, unchecked: 0 })).toBe(
      "",
    );
  });

  it("says there is no video when every one was dropped, as its own paragraph", () => {
    const note = droppedVideoNote("Sidechain the pad to the kick.", {
      videos: [],
      dropped: 1,
      unchecked: 0,
    });
    expect(note).toMatch(/^\n\nI couldn't find a video on YouTube/);
    expect(note).toMatch(/no video this time\.$/);
  });

  it("is the whole reply when the model wrote nothing but the video", () => {
    const note = droppedVideoNote("  ", { videos: [], dropped: 1, unchecked: 0 });
    expect(note).toMatch(/^I couldn't find a video/);
  });

  it("says one was left out when another is shown", () => {
    expect(
      droppedVideoNote("Two.", { videos: [video], dropped: 1, unchecked: 0 }),
    ).toMatch(/One of the videos I picked couldn't be found on YouTube/);
  });
});

describe("the recommend_video tool", () => {
  it("takes an object, under a provider-safe name no command tool uses", () => {
    const tool = videoRecommendationTool();
    expect(tool.name).toMatch(/^[a-zA-Z0-9_-]{1,64}$/);
    expect(tool.input_schema.type).toBe("object");
    expect(assistantTools().map((entry) => entry.name)).not.toContain(tool.name);
    expect(JSON.stringify(tool.input_schema)).toContain("videoId");
  });
});

describe("youtubeEmbedUrl (ADR 0009 decision 2)", () => {
  it("is the privacy-enhanced player, built from the ID alone", () => {
    const url = new URL(youtubeEmbedUrl(ID));
    expect(url.origin).toBe("https://www.youtube-nocookie.com");
    expect(url.pathname).toBe(`/embed/${ID}`);
    expect([...url.searchParams.keys()].sort()).toEqual(
      ["autoplay", "playsinline", "rel"].sort(),
    );
  });

  it("refuses anything that is not a video ID", () => {
    expect(() => youtubeEmbedUrl("x/../../y")).toThrow();
  });
});
