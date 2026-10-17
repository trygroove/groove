/**
 * Thumbs up and down on one assistant reply (GRV-103). Quiet until the reply
 * is under the pointer or holds focus (always shown on a touch screen, and
 * once rated); the chosen thumb is the brightest thing beside it. The same
 * thumb again clears the rating. What a rating does (analytics, the
 * sad-session detector, a kept transcript) is `AssistantChat.rateReply`'s.
 */
import type { JSX } from "@solidjs/web";
import { For } from "solid-js";
import type { ReplyRating as Rating } from "../../assistant/transcripts";
import { ThumbDownIcon, ThumbUpIcon } from "../../components/icons";

const THUMBS: readonly { rating: Rating; label: string; icon: () => JSX.Element }[] = [
  { rating: "up", label: "Good reply", icon: () => <ThumbUpIcon size={12} /> },
  { rating: "down", label: "Bad reply", icon: () => <ThumbDownIcon size={12} /> },
];

export default function ReplyRating(props: {
  readonly rating: Rating | undefined;
  onRate(rating: Rating): void;
}): JSX.Element {
  return (
    <fieldset
      class={{
        "assistant-rating": true,
        "assistant-rating-rated": props.rating !== undefined,
      }}
      aria-label="Rate this reply"
    >
      <For each={THUMBS}>
        {(thumb) => (
          <button
            type="button"
            class="assistant-rating-button"
            aria-label={thumb.label}
            title={thumb.label}
            aria-pressed={props.rating === thumb.rating ? "true" : "false"}
            onClick={() => props.onRate(thumb.rating)}
          >
            {thumb.icon()}
          </button>
        )}
      </For>
    </fieldset>
  );
}
