/**
 * Recommending a tutorial video from YouTube (GRV-16, ADR 0009).
 *
 * Like a sound recommendation (`recommendation.ts`), a video is not a change
 * to the song, so it is not one of the command tools in `tools.ts`: the model
 * calls {@link RECOMMEND_VIDEO_TOOL} with a YouTube video ID and a line on why
 * it helps. There is no allowlist (ADR 0009 decision 1): any YouTube video may
 * be named, so the ID is model output that may be wrong, and the gateway
 * checks every one before the browser sees it (decision 5). A video YouTube's
 * oEmbed endpoint does not describe (removed, private, not embeddable, never
 * existed) is dropped, and so is every video when that check cannot be made.
 *
 * The check is made here, on the server, through an injected `fetch`
 * ({@link createOEmbedVideoVerifier}), so it never runs from the user's
 * browser: a user who never presses play sends YouTube nothing (decision 3).
 * The title and channel the card shows are oEmbed's, not the model's, so a
 * card never names a video that is not the one it plays.
 *
 * The gateway offers the tool only when it has a verifier
 * (`AssistantGatewayDeps.verifyVideo`), so a deployment that cannot check a
 * video never shows one. Like the rest of `src/assistant`, this imports no
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
  /** How long one oEmbed check may take before the video is dropped. */
  checkTimeoutMs: 4_000,
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
  videoId: youtubeVideoIdSchema.describe(
    "The YouTube video's ID: the 11 characters after watch?v= in its URL.",
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
  "Recommend one YouTube tutorial video that shows the producer a technique they asked how to do, when watching it would teach more than words. Name a real video by its ID, one you are confident exists and teaches exactly this; Groove checks it with YouTube and drops it if it does not exist or cannot be embedded, so never guess an ID. It plays in the panel only when the producer presses play. At most two per reply.";

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
 * private, not embeddable, never existed), or the check could not be made
 * (`unchecked`: a timeout, a network failure, an answer in another shape).
 * The turn log counts them apart, so a model naming IDs that do not exist
 * reads differently from YouTube being out of reach.
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

/**
 * How a turn's video calls fared: what is shown, how many were dropped, and
 * how many of those were dropped because the check could not be made.
 */
export interface CheckedVideos {
  readonly videos: readonly AssistantVideo[];
  readonly dropped: number;
  readonly unchecked: number;
}

/** A turn with no video calls. */
export const NO_VIDEOS: CheckedVideos = { videos: [], dropped: 0, unchecked: 0 };

/**
 * The turn's video calls, checked: each well-formed call's video, in the
 * order the model named them, without repeats and at most
 * {@link VIDEO_LIMITS.maxPerTurn}, kept only if `verify` vouches for it.
 * Without a verifier every call is dropped. The checks run side by side.
 */
export async function checkVideoCalls(
  calls: readonly AssistantToolCall[],
  verify: VideoVerifier | undefined,
  signal: AbortSignal,
): Promise<CheckedVideos> {
  const videoCalls = calls.filter(isVideoCall);
  if (videoCalls.length === 0) return NO_VIDEOS;
  const wanted: VideoRecommendationInput[] = [];
  for (const call of videoCalls) {
    const parsed = videoRecommendationInputSchema.safeParse(call.input);
    if (!parsed.success) continue;
    if (wanted.some((entry) => entry.videoId === parsed.data.videoId)) continue;
    if (wanted.length < VIDEO_LIMITS.maxPerTurn) wanted.push(parsed.data);
  }
  if (!verify) {
    return { videos: [], dropped: videoCalls.length, unchecked: videoCalls.length };
  }
  const facts = await Promise.all(
    wanted.map((entry) =>
      verify(entry.videoId, signal).catch((): VideoRefusal => "unchecked"),
    ),
  );
  const videos = wanted.flatMap((entry, index): AssistantVideo[] => {
    const known = facts[index];
    return typeof known === "object"
      ? [
          {
            videoId: entry.videoId,
            title: known.title,
            channel: known.channel,
            reason: entry.reason,
          },
        ]
      : [];
  });
  return {
    videos,
    dropped: videoCalls.length - videos.length,
    unchecked: facts.filter((fact) => fact === "unchecked").length,
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
