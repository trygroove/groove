/**
 * Recommending a tutorial video from YouTube (GRV-16, ADR 0009).
 *
 * Like a sound recommendation (`recommendation.ts`), a video is not a change
 * to the song, so it is not one of the command tools in `tools.ts`: the model
 * calls {@link RECOMMEND_VIDEO_TOOL} with a short YouTube search for the
 * technique and a line on why it helps. The model never names a video ID: it
 * cannot recall real ones reliably, so in production almost every ID it named
 * did not exist and no card was ever shown (GRV-16 QA). The gateway searches
 * YouTube with the model's words instead ({@link createYouTubeVideoFinder}),
 * and checks the video it picks is still public and embeddable through
 * YouTube's oEmbed endpoint (decision 5) before the browser sees it. A search
 * that finds nothing that passes is dropped, and so is every video when the
 * search or the check cannot be made.
 *
 * Both requests are made here, on the server, through an injected `fetch`,
 * so neither runs from the user's browser: a user who never presses play
 * sends YouTube nothing (decision 3). The title and channel the card shows
 * are oEmbed's, not the model's, so a card never names a video that is not
 * the one it plays.
 *
 * The gateway offers the tool only when it can search
 * (`AssistantGatewayDeps.findVideo`), so a deployment without a YouTube key
 * never shows one. Like the rest of `src/assistant`, this imports no
 * Firebase and no SDK.
 */
import { z } from "zod";
import type { AssistantToolCall } from "./protocol";
import type { ProviderTool, ProviderToolInputSchema } from "./providerRequest";

/** The tool's name, as the model calls it. */
export const RECOMMEND_VIDEO_TOOL = "recommend_video";

/** Bounds on what a video recommendation carries. */
export const VIDEO_LIMITS = {
  /** The most videos one turn shows; later calls are dropped unchecked. */
  maxPerTurn: 2,
  maxReasonChars: 200,
  maxTitleChars: 200,
  maxChannelChars: 100,
  maxQueryChars: 100,
  /** How long one search or oEmbed check may take before the video is dropped. */
  checkTimeoutMs: 4_000,
  /** How many of a search's results are checked with oEmbed, in order. */
  maxCandidates: 3,
} as const;

/**
 * A YouTube video ID: eleven characters from YouTube's URL-safe alphabet. The
 * embed URL is built from it, so nothing else ever reaches one.
 */
export const youtubeVideoIdSchema = z
  .string()
  .regex(/^[A-Za-z0-9_-]{11}$/, "a YouTube video ID is 11 letters, digits, - or _");

/** What a recommendation call carries, before it is checked. */
export const videoRecommendationInputSchema = z.object({
  query: z
    .string()
    .trim()
    .min(1)
    .max(VIDEO_LIMITS.maxQueryChars)
    .describe(
      "What to search YouTube for: the technique in a few words, e.g. 'sidechain compression tutorial'.",
    ),
  reason: z
    .string()
    .trim()
    .min(1)
    .max(VIDEO_LIMITS.maxReasonChars)
    .describe("One short line on what the producer will learn from it."),
});
export type VideoRecommendationInput = z.infer<typeof videoRecommendationInputSchema>;

/** A recommended video the gateway has checked, as the browser shows it. */
export const assistantVideoSchema = z.strictObject({
  videoId: youtubeVideoIdSchema,
  /** The video's title, as YouTube reports it. */
  title: z.string().min(1).max(VIDEO_LIMITS.maxTitleChars),
  /** The channel that published it, as YouTube reports it. */
  channel: z.string().max(VIDEO_LIMITS.maxChannelChars),
  /** The model's line on why it helps. */
  reason: z.string().max(VIDEO_LIMITS.maxReasonChars),
});
export type AssistantVideo = z.infer<typeof assistantVideoSchema>;

const DESCRIPTION =
  "Recommend a YouTube tutorial video that shows the producer a technique they asked how to learn. Give a short search for the technique, not a video ID: Groove searches YouTube for it and shows the best embeddable result under your answer, with its own title. The search names only the technique, never anything from the project. It plays in the panel only when the producer presses play. At most two per reply.";

/** The tool as it is offered to the model. */
export function videoRecommendationTool(): ProviderTool {
  const { $schema: _dialect, ...inputSchema } = z.toJSONSchema(
    videoRecommendationInputSchema,
    { io: "input" },
  ) as Record<string, unknown>;
  return {
    name: RECOMMEND_VIDEO_TOOL,
    description: DESCRIPTION,
    input_schema: inputSchema as ProviderToolInputSchema,
    eager_input_streaming: true,
  };
}

/** Whether a tool call is a video recommendation. */
export function isVideoCall(call: Pick<AssistantToolCall, "name">): boolean {
  return call.name === RECOMMEND_VIDEO_TOOL;
}

/** What YouTube says about a video: its title and channel, or null when it cannot be shown. */
export interface VideoFacts {
  readonly title: string;
  readonly channel: string;
}

/**
 * Why a video is dropped: YouTube says it cannot be shown (`missing`: removed,
 * private, not embeddable, never existed, or a search that found nothing that
 * can), or the search or check could not be made (`unchecked`: a timeout, a
 * network failure, a used-up quota, an answer in another shape). The turn log
 * counts them apart, so a search that finds nothing reads differently from
 * YouTube being out of reach.
 */
export type VideoRefusal = "missing" | "unchecked";

/**
 * Checks one video ID is real and embeddable. Resolves to the video's facts,
 * or to why it is dropped; never rejects.
 */
export type VideoVerifier = (
  videoId: string,
  signal: AbortSignal,
) => Promise<VideoFacts | VideoRefusal>;

/** YouTube's oEmbed endpoint: public, no API key. */
export const YOUTUBE_OEMBED_URL = "https://www.youtube.com/oembed";

/** The watch page a video ID names. */
export function youtubeWatchUrl(videoId: string): string {
  return `https://www.youtube.com/watch?v=${videoId}`;
}

const oEmbedSchema = z.looseObject({
  title: z.string().trim().min(1),
  author_name: z.string().trim().optional(),
});

/**
 * A verifier over YouTube's oEmbed endpoint. oEmbed answers 200 with a title
 * and channel for a public, embeddable video, and a 4xx for one that is
 * missing, private or not embeddable; anything else (a 5xx, a timeout, a
 * network failure, an answer in another shape) is a check that could not be
 * made. Either way the video is dropped.
 */
export function createOEmbedVideoVerifier(
  fetcher: typeof fetch,
  timeoutMs: number = VIDEO_LIMITS.checkTimeoutMs,
): VideoVerifier {
  return async (videoId, signal) => {
    if (!youtubeVideoIdSchema.safeParse(videoId).success) return "missing";
    const controller = new AbortController();
    const onAbort = () => controller.abort();
    signal.addEventListener("abort", onAbort, { once: true });
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const url = `${YOUTUBE_OEMBED_URL}?format=json&url=${encodeURIComponent(youtubeWatchUrl(videoId))}`;
      const response = await fetcher(url, {
        signal: controller.signal,
        headers: { accept: "application/json" },
      });
      // A 429 is YouTube refusing to answer, not an answer about the video.
      if (response.status >= 400 && response.status < 500 && response.status !== 429) {
        return "missing";
      }
      if (response.status !== 200) return "unchecked";
      const parsed = oEmbedSchema.safeParse(await response.json());
      if (!parsed.success) return "unchecked";
      return {
        title: parsed.data.title.slice(0, VIDEO_LIMITS.maxTitleChars),
        channel: (parsed.data.author_name ?? "").slice(0, VIDEO_LIMITS.maxChannelChars),
      };
    } catch {
      return "unchecked";
    } finally {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
    }
  };
}

/** A video a search found and oEmbed vouches for. */
export interface FoundVideo extends VideoFacts {
  readonly videoId: string;
}

/**
 * Finds the video a recommendation's search names. Resolves to the video, or
 * to why there is none; never rejects.
 */
export type VideoFinder = (
  query: string,
  signal: AbortSignal,
) => Promise<FoundVideo | VideoRefusal>;

/** The YouTube Data API's search endpoint; it needs an API key. */
export const YOUTUBE_SEARCH_URL = "https://www.googleapis.com/youtube/v3/search";

const searchSchema = z.looseObject({
  items: z.array(
    z.looseObject({ id: z.looseObject({ videoId: z.string().optional() }) }),
  ),
});

export interface YouTubeVideoFinderOptions {
  readonly fetcher: typeof fetch;
  /** A YouTube Data API key. */
  readonly apiKey: string;
  /** Checks a search result; YouTube's oEmbed endpoint by default. */
  readonly verify?: VideoVerifier;
  readonly timeoutMs?: number;
}

/**
 * A finder over the YouTube Data API's search: embeddable videos only, with
 * strict SafeSearch, in YouTube's order of relevance. The first of the top
 * results that oEmbed vouches for is the one shown, so the card's title and
 * channel are oEmbed's and a result that stopped being embeddable is
 * skipped. A search that answers with nothing is `missing`; one that cannot
 * be made (a 4xx or 5xx, a used-up daily quota, a timeout, an answer in
 * another shape) is `unchecked`.
 */
export function createYouTubeVideoFinder(
  options: YouTubeVideoFinderOptions,
): VideoFinder {
  const timeoutMs = options.timeoutMs ?? VIDEO_LIMITS.checkTimeoutMs;
  const verify = options.verify ?? createOEmbedVideoVerifier(options.fetcher, timeoutMs);
  const search = async (
    query: string,
    signal: AbortSignal,
  ): Promise<string[] | "unchecked"> => {
    const controller = new AbortController();
    const onAbort = () => controller.abort();
    signal.addEventListener("abort", onAbort, { once: true });
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const params = new URLSearchParams({
        part: "id",
        type: "video",
        videoEmbeddable: "true",
        safeSearch: "strict",
        maxResults: String(VIDEO_LIMITS.maxCandidates),
        q: query,
        key: options.apiKey,
      });
      const response = await options.fetcher(`${YOUTUBE_SEARCH_URL}?${params}`, {
        signal: controller.signal,
        headers: { accept: "application/json" },
      });
      if (response.status !== 200) return "unchecked";
      const parsed = searchSchema.safeParse(await response.json());
      if (!parsed.success) return "unchecked";
      return parsed.data.items
        .map((item) => item.id.videoId ?? "")
        .filter((id) => youtubeVideoIdSchema.safeParse(id).success);
    } catch {
      return "unchecked";
    } finally {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
    }
  };
  return async (query, signal) => {
    const found = await search(query, signal);
    if (found === "unchecked") return "unchecked";
    let refusal: VideoRefusal = "missing";
    for (const videoId of found.slice(0, VIDEO_LIMITS.maxCandidates)) {
      const facts = await verify(videoId, signal).catch((): VideoRefusal => "unchecked");
      if (typeof facts === "object") return { videoId, ...facts };
      if (facts === "unchecked") refusal = "unchecked";
    }
    return refusal;
  };
}

/**
 * How a turn's video calls fared: what is shown, how many were dropped, and
 * how many of those were dropped because the search or check could not be
 * made.
 */
export interface CheckedVideos {
  readonly videos: readonly AssistantVideo[];
  readonly dropped: number;
  readonly unchecked: number;
}

/** A turn with no video calls. */
export const NO_VIDEOS: CheckedVideos = { videos: [], dropped: 0, unchecked: 0 };

/**
 * The turn's video calls, searched: each well-formed call's video, in the
 * order the model asked for them, at most {@link VIDEO_LIMITS.maxPerTurn},
 * kept only if `find` turns one up. A search the turn already made, or one
 * that lands on a video already shown, is a repeat, not a drop. Without a
 * finder every call is dropped. The searches run side by side.
 */
export async function checkVideoCalls(
  calls: readonly AssistantToolCall[],
  find: VideoFinder | undefined,
  signal: AbortSignal,
): Promise<CheckedVideos> {
  const videoCalls = calls.filter(isVideoCall);
  if (videoCalls.length === 0) return NO_VIDEOS;
  if (!find) {
    return { videos: [], dropped: videoCalls.length, unchecked: videoCalls.length };
  }
  const wanted: VideoRecommendationInput[] = [];
  let repeats = 0;
  for (const call of videoCalls) {
    const parsed = videoRecommendationInputSchema.safeParse(call.input);
    if (!parsed.success) continue;
    const query = parsed.data.query.toLowerCase();
    if (wanted.some((entry) => entry.query.toLowerCase() === query)) repeats += 1;
    else if (wanted.length < VIDEO_LIMITS.maxPerTurn) wanted.push(parsed.data);
  }
  const results = await Promise.all(
    wanted.map((entry) =>
      find(entry.query, signal).catch((): VideoRefusal => "unchecked"),
    ),
  );
  const videos: AssistantVideo[] = [];
  results.forEach((result, index) => {
    if (typeof result !== "object") return;
    if (videos.some((video) => video.videoId === result.videoId)) {
      repeats += 1;
      return;
    }
    videos.push({
      videoId: result.videoId,
      title: result.title,
      channel: result.channel,
      reason: wanted[index]?.reason ?? "",
    });
  });
  return {
    videos,
    dropped: videoCalls.length - videos.length - repeats,
    unchecked: results.filter((result) => result === "unchecked").length,
  };
}

/**
 * What the reply adds when a video it recommended was dropped. The model's
 * words streamed before the check, and may lead into a video the producer
 * will never see (GRV-16 QA); this line says plainly that there is none, and
 * is the whole reply when the model wrote nothing but the video. Empty when
 * nothing was dropped.
 */
export function droppedVideoNote(text: string, checked: CheckedVideos): string {
  if (checked.dropped === 0) return "";
  const note =
    checked.videos.length > 0
      ? "One of the videos I picked couldn't be found on YouTube, so I've left it out."
      : "I couldn't find a video on YouTube to show you for this one, so there's no video this time.";
  return text.trim().length === 0 ? note : `\n\n${note}`;
}

/**
 * The privacy-enhanced embed for a video (ADR 0009 decision 2), playing from
 * the user's press: `autoplay=1` only ever loads after that press, so the
 * press itself is what starts it. Nothing from the project goes into it.
 */
export function youtubeEmbedUrl(videoId: string): string {
  const id = youtubeVideoIdSchema.parse(videoId);
  return `https://www.youtube-nocookie.com/embed/${id}?autoplay=1&rel=0&playsinline=1`;
}
