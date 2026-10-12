/**
 * A tutorial video the assistant recommends (GRV-16, ADR 0009), after the
 * mocks in docs/design/mocks/07-assistant-video*.png: a still card, the
 * player in the panel, and the player over the whole window.
 *
 * - **Nothing reaches YouTube until Play** (ADR 0009 decision 3). The still
 *   card is drawn from the video's ID, title and channel alone: no thumbnail,
 *   which would come from Google's servers. The player's iframe is created
 *   only by the producer's press, and the press is what starts it playing.
 * - **The privacy-enhanced player, given nothing** (decision 2). The iframe is
 *   `youtube-nocookie.com`, built from the video ID alone, with no message
 *   channel and a referrer of Groove's origin only, never the project's path.
 *   It plays beside the song: nothing here touches the transport or the audio.
 * - **Focus stays put.** Play hands focus to the card's own Close video, never
 *   into the player, so the editor's keys keep working until the producer
 *   clicks the player.
 * - **Failure stays in the card.** A player that does not load in time says
 *   so here, with Try again and a link to watch on YouTube; the card is also
 *   wrapped in an error boundary by the conversation.
 * - **Full screen** fills the window with the same iframe (only its frame
 *   moves, so the video carries on where it was); Close or Escape
 *   (`view.close_surface`) puts it back.
 * - **The disclosure** names YouTube and its terms before Play (decision 6).
 *
 * Analytics: `assistant_video_played`, `assistant_video_expanded` and
 * `assistant_video_failed`, with no parameters: never the video's ID, title,
 * channel or URL.
 */
import type { JSX } from "@solidjs/web";
import { createSignal, onCleanup, Show } from "solid-js";
import type { Analytics } from "../../analytics/analytics";
import {
  type AssistantVideo,
  youtubeEmbedUrl,
  youtubeWatchUrl,
} from "../../assistant/video";
import { CloseIcon, PlayIcon } from "../../components/icons";
import { type ShortcutHandlers, useShortcuts } from "../../shortcuts";

/** How long the player has to load before the card says it did not. */
export const VIDEO_LOAD_TIMEOUT_MS = 15_000;

/** YouTube's terms, and Google's privacy policy, which govern the player. */
export const YOUTUBE_TERMS_URL = "https://www.youtube.com/t/terms";
export const GOOGLE_PRIVACY_URL = "https://policies.google.com/privacy";

/** What the card says when the player did not load. */
export const VIDEO_FAILED =
  "This video didn't load. Nothing else is affected: your song and the conversation are as they were.";

/**
 * What the iframe may do: run YouTube's own player, go full screen and open
 * YouTube in a new tab when asked. Never navigate the editor.
 */
const SANDBOX =
  "allow-scripts allow-same-origin allow-presentation allow-popups allow-popups-to-escape-sandbox";

type VideoState = "idle" | "playing" | "failed";

export interface VideoCardProps {
  readonly video: AssistantVideo;
  readonly analytics?: () => Analytics;
  /** Defaults to {@link VIDEO_LOAD_TIMEOUT_MS}. */
  readonly loadTimeoutMs?: number;
}

export default function VideoCard(props: VideoCardProps): JSX.Element {
  const [state, setState] = createSignal<VideoState>("idle");
  const [expanded, setExpanded] = createSignal(false);
  let closeButton: HTMLButtonElement | undefined;
  let expandButton: HTMLButtonElement | undefined;
  let overlayClose: HTMLButtonElement | undefined;
  let loadTimer: ReturnType<typeof setTimeout> | undefined;
  onCleanup(() => clearTimeout(loadTimer));

  const log = (
    event:
      | "assistant_video_played"
      | "assistant_video_expanded"
      | "assistant_video_failed",
  ) => props.analytics?.().log(event, {});

  function fail(): void {
    clearTimeout(loadTimer);
    if (state() !== "playing") return;
    setExpanded(false);
    setState("failed");
    log("assistant_video_failed");
  }

  function play(): void {
    setState("playing");
    clearTimeout(loadTimer);
    loadTimer = setTimeout(fail, props.loadTimeoutMs ?? VIDEO_LOAD_TIMEOUT_MS);
    log("assistant_video_played");
    props.analytics?.().logFeatureFirstUse("assistant_video");
    // The button pressed is gone: focus goes to the card's own control, never
    // into the player.
    setTimeout(() => closeButton?.focus(), 0);
  }

  function close(): void {
    clearTimeout(loadTimer);
    setExpanded(false);
    setState("idle");
  }

  function expand(): void {
    setExpanded(true);
    log("assistant_video_expanded");
    setTimeout(() => overlayClose?.focus(), 0);
  }

  function collapse(): void {
    setExpanded(false);
    setTimeout(() => expandButton?.focus(), 0);
  }

  const title = () => props.video.title;
  const channel = () => props.video.channel;

  return (
    <section
      class={[
        "assistant-card assistant-video",
        { "assistant-video-expanded": expanded() },
      ]}
      aria-label={`Tutorial video: ${title()}`}
    >
      <div class="assistant-video-stage">
        <Show when={expanded()}>
          <CloseOnEscape onClose={collapse} />
          <div class="assistant-video-overlay-bar">
            <span class="assistant-video-tag">Recommended by the assistant</span>
            <span class="assistant-video-overlay-title">{title()}</span>
            <button
              ref={overlayClose}
              type="button"
              class="assistant-button"
              onClick={collapse}
            >
              <CloseIcon size={10} /> Close
            </button>
          </div>
        </Show>
        <Show
          when={state() === "playing"}
          fallback={
            <Show
              when={state() === "failed"}
              fallback={
                <div class="assistant-video-poster">
                  <span class="assistant-video-tag">YouTube · Tutorial</span>
                  <button
                    type="button"
                    class="assistant-video-play"
                    aria-label={`Play ${title()} from YouTube`}
                    onClick={play}
                  >
                    <PlayIcon size={22} />
                  </button>
                  <span class="assistant-video-poster-channel">{channel()}</span>
                </div>
              }
            >
              <div class="assistant-video-poster assistant-video-failed" role="alert">
                <b>The video didn't load</b>
                <span>{VIDEO_FAILED}</span>
              </div>
            </Show>
          }
        >
          {/* Made when Play is pressed, and gone when it is closed or fails, so
              Try again makes a new player. */}
          <iframe
            class="assistant-video-frame"
            src={youtubeEmbedUrl(props.video.videoId)}
            title={`YouTube video: ${title()}`}
            allow="autoplay; encrypted-media; picture-in-picture; fullscreen"
            allowfullscreen
            referrerpolicy="strict-origin"
            sandbox={SANDBOX}
            onLoad={() => clearTimeout(loadTimer)}
            onError={fail}
          />
        </Show>
      </div>
      <div class="assistant-video-body">
        <b class="assistant-video-title">{title()}</b>
        <Show when={channel()}>
          <span class="assistant-video-channel">{channel()}</span>
        </Show>
        <p class="assistant-video-why">{props.video.reason}</p>
        <div class="assistant-video-actions">
          <Show when={state() === "playing"}>
            <button
              ref={expandButton}
              type="button"
              class="assistant-button"
              onClick={expand}
            >
              Full screen
            </button>
            <button
              ref={closeButton}
              type="button"
              class="assistant-button"
              onClick={close}
            >
              Close video
            </button>
          </Show>
          <Show when={state() === "failed"}>
            <button type="button" class="assistant-button-primary" onClick={play}>
              Try again
            </button>
          </Show>
          <a
            class="assistant-button assistant-video-link"
            href={youtubeWatchUrl(props.video.videoId)}
            target="_blank"
            rel="noopener noreferrer"
          >
            Watch on YouTube
          </a>
        </div>
        <p class="assistant-video-disclosure">
          Plays from YouTube when you press play, under YouTube's{" "}
          <a href={YOUTUBE_TERMS_URL} target="_blank" rel="noopener noreferrer">
            terms
          </a>{" "}
          and Google's{" "}
          <a href={GOOGLE_PRIVACY_URL} target="_blank" rel="noopener noreferrer">
            privacy policy
          </a>
          . A suggestion, not an endorsement.
        </p>
      </div>
    </section>
  );
}

/** `view.close_surface` (Escape) while the player fills the window. */
function CloseOnEscape(props: { onClose(): void }): JSX.Element {
  useShortcuts({
    handlers: (): ShortcutHandlers => ({
      "view.close_surface": { run: () => props.onClose() },
    }),
    contexts: () => [],
  });
  return null;
}
