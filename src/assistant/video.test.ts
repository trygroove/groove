import { describe, expect, it, vi } from "vitest";
import { assistantTools } from "./tools";
import {
  assistantVideoSchema,
  checkVideoCalls,
  createOEmbedVideoVerifier,
  createYouTubeVideoFinder,
  droppedVideoNote,
  RECOMMEND_VIDEO_TOOL,
  VIDEO_LIMITS,
  type VideoFinder,
  videoRecommendationTool,
  YOUTUBE_SEARCH_URL,
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

describe("the YouTube search finder (GRV-16)", () => {
  const KEY = "yt-key";
  const facts = { title: "Sidechain Compression Explained", channel: "Underdog" };

  /** A fetch that answers the search with `ids`, and oEmbed per `oEmbed`. */
  function youtube(
    ids: readonly string[],
    oEmbed: (id: string) => Response = () =>
      new Response(JSON.stringify({ title: facts.title, author_name: facts.channel })),
    searchStatus = 200,
  ): typeof fetch {
    return vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      if (url.origin + url.pathname === YOUTUBE_SEARCH_URL) {
        return new Response(
          JSON.stringify({
            items: ids.map((videoId) => ({ id: { kind: "youtube#video", videoId } })),
          }),
          { status: searchStatus },
        );
      }
      const watch = new URL(url.searchParams.get("url") ?? "");
      return oEmbed(watch.searchParams.get("v") ?? "");
    });
  }

  it("searches for embeddable videos with strict SafeSearch, and shows the first oEmbed vouches for", async () => {
    const fetcher = youtube([ID, "bbbbbbbbbbb"]);
    const found = await createYouTubeVideoFinder({ fetcher, apiKey: KEY })(
      "sidechain compression tutorial",
      signal(),
    );
    expect(found).toEqual({ videoId: ID, ...facts });
    const [search] = vi.mocked(fetcher).mock.calls[0] ?? [];
    const params = new URL(String(search)).searchParams;
    expect(Object.fromEntries(params)).toMatchObject({
      q: "sidechain compression tutorial",
      type: "video",
      videoEmbeddable: "true",
      safeSearch: "strict",
      key: KEY,
    });
    // One search and one check: the second result is never asked about.
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("skips a result oEmbed refuses and shows the next", async () => {
    const fetcher = youtube(["aaaaaaaaaaa", ID], (id) =>
      id === ID
        ? new Response(JSON.stringify({ title: facts.title, author_name: facts.channel }))
        : new Response("Unauthorized", { status: 401 }),
    );
    const found = await createYouTubeVideoFinder({ fetcher, apiKey: KEY })("q", signal());
    expect(found).toMatchObject({ videoId: ID });
  });

  it("finds nothing when the search is empty or every result is refused", async () => {
    expect(
      await createYouTubeVideoFinder({ fetcher: youtube([]), apiKey: KEY })(
        "q",
        signal(),
      ),
    ).toBe("missing");
    const refused = youtube([ID], () => new Response("Not Found", { status: 404 }));
    expect(
      await createYouTubeVideoFinder({ fetcher: refused, apiKey: KEY })("q", signal()),
    ).toBe("missing");
  });

  it("counts a search it could not make apart from one that found nothing", async () => {
    // 403 is what a used-up daily quota answers.
    const quota = youtube([ID], undefined, 403);
    expect(
      await createYouTubeVideoFinder({ fetcher: quota, apiKey: KEY })("q", signal()),
    ).toBe("unchecked");
    const down = createYouTubeVideoFinder({
      fetcher: async () => {
        throw new TypeError("fetch failed");
      },
      apiKey: KEY,
    });
    expect(await down("q", signal())).toBe("unchecked");
    const oEmbedDown = youtube([ID], () => new Response("", { status: 503 }));
    expect(
      await createYouTubeVideoFinder({ fetcher: oEmbedDown, apiKey: KEY })("q", signal()),
    ).toBe("unchecked");
  });

  it("ignores a result that is not a video ID", async () => {
    const fetcher = youtube(["../../evil", ID]);
    const found = await createYouTubeVideoFinder({ fetcher, apiKey: KEY })("q", signal());
    expect(found).toMatchObject({ videoId: ID });
  });

  it("gives up on a search that takes too long", async () => {
    const hang: typeof fetch = (_, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
      });
    const find = createYouTubeVideoFinder({ fetcher: hang, apiKey: KEY, timeoutMs: 10 });
    expect(await find("q", signal())).toBe("unchecked");
  });
});

describe("checkVideoCalls", () => {
  const call = (query: string, name = RECOMMEND_VIDEO_TOOL) => ({
    id: `t-${query}`,
    name,
    input: { query, reason: "Why." },
  });
  const idFor = (query: string) => query.slice(0, 1).repeat(11);
  const find: VideoFinder = async (query) => ({
    videoId: idFor(query),
    title: `T ${query}`,
    channel: "C",
  });

  it("keeps at most two videos per turn, without repeats, in the model's order", async () => {
    const queries = ["acid", "Acid", "bass", "chords"];
    const checked = await checkVideoCalls(
      queries.map((query) => call(query)),
      find,
      signal(),
    );
    expect(checked.videos.map((video) => video.videoId)).toEqual([
      idFor("acid"),
      idFor("bass"),
    ]);
    // The repeat is not a drop; the third search is.
    expect(checked.dropped).toBe(1);
    for (const video of checked.videos) {
      expect(assistantVideoSchema.safeParse(video).success).toBe(true);
    }
  });

  it("shows a video two searches both found once, and drops neither", async () => {
    const checked = await checkVideoCalls(
      [call("acid one"), call("acid two")],
      find,
      signal(),
    );
    expect(checked.videos).toHaveLength(1);
    expect(checked.dropped).toBe(0);
  });

  it("ignores every other tool's calls", async () => {
    const checked = await checkVideoCalls(
      [call("acid", "recommend_sounds")],
      find,
      signal(),
    );
    expect(checked).toEqual({ videos: [], dropped: 0, unchecked: 0 });
  });

  it("counts the searches it could not make apart from the ones that found nothing", async () => {
    const checked = await checkVideoCalls(
      [call("acid"), call("bass")],
      async (query) => {
        if (query === "acid") return "missing";
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
    // The model names a search, never an ID it might have made up.
    const properties = tool.input_schema.properties as Record<string, unknown>;
    expect(Object.keys(properties).sort()).toEqual(["query", "reason"]);
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
