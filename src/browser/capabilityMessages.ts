// What a missing capability means and what to do about it (PRD section 10:
// "The app detects unsupported Web Audio or decoding capabilities and explains
// the limitation"; #75: "Unsupported capability messages are actionable").
//
// Every message has the same three parts, so none of them can be only a
// complaint: what is wrong, what that costs the producer here, and the one
// thing they can do next. The browsers named are the PRD's gating set.

import type { CapabilityId } from "./capabilities";

export interface CapabilityMessage {
  /** What is wrong, in a few words. */
  readonly title: string;
  /** What that means for working in Groove in this browser. */
  readonly detail: string;
  /** The thing the producer can do about it. */
  readonly action: string;
}

const USE_A_SUPPORTED_BROWSER =
  "Open Groove in the current version of Chrome, Edge or Firefox.";

export const CAPABILITY_MESSAGES: Readonly<Record<CapabilityId, CapabilityMessage>> = {
  web_audio: {
    title: "This browser can't play sound",
    detail:
      "It doesn't provide Web Audio, so you can edit this project but not hear it or audition sounds.",
    action: USE_A_SUPPORTED_BROWSER,
  },
  audio_decoding: {
    title: "This browser can't load sounds",
    detail: "It can't decode audio files, so samples and loops will stay silent.",
    action: USE_A_SUPPORTED_BROWSER,
  },
  offline_audio: {
    title: "Export isn't available here",
    detail:
      "This browser can't render audio offline, so songs and stems can't be exported.",
    action:
      "Open this project in the current version of Chrome, Edge or Firefox to export it.",
  },
  site_storage: {
    title: "Site data is blocked",
    detail:
      "This browser won't keep you signed in or remember your settings after you close the tab.",
    action:
      "Allow site data for this site in your browser's settings, or leave private browsing.",
  },
  canvas_2d: {
    title: "The arrangement can't be drawn",
    detail:
      "Canvas drawing is turned off, so the timeline and waveforms won't appear. Every other view still works.",
    action:
      "Allow canvas for this site (privacy settings and extensions can block it), or use the current version of Chrome, Edge or Firefox.",
  },
  file_download: {
    title: "Files can't be saved from here",
    detail: "This browser can't download generated files, so exports won't save.",
    action:
      "Open this project in the current version of Chrome, Edge or Firefox to export it.",
  },
};

/**
 * Why pressing Play produced no sound, keyed by the `audio_start_failed`
 * `error_code` `useProjectAudio` reported. A code with no entry of its own
 * reads as the generic failure.
 */
export function audioStartFailureMessage(code: string): CapabilityMessage {
  switch (code) {
    case "autoplay_blocked":
      return {
        title: "The browser blocked sound",
        detail:
          "Sound didn't start because the browser stopped this page from playing audio.",
        action:
          "Press Play again. If it stays silent, allow sound for this site in your browser's site settings.",
      };
    case "not_supported":
    case "context_unavailable":
      return CAPABILITY_MESSAGES.web_audio;
    case "context_closed":
      // The browser closed the context under us: most often the output device
      // went away (headphones unplugged, an interface switched off) (GRV-55).
      // A closed context never resumes and the editor does not swap in
      // another, so reloading is the only advice. The edits are kept because
      // the editor writes its queued saves as the page unloads, and asks
      // before leaving while one is still unwritten.
      return {
        title: "Sound stopped",
        detail:
          "The audio output went away, as it does when headphones or an audio interface are unplugged.",
        action: "Reload the page to start sound again; your edits are kept.",
      };
    default:
      return {
        title: "Sound didn't start",
        detail: "The browser's audio engine failed to start.",
        action:
          "Press Play to try again, with your speakers or headphones connected. If it still fails, reload the page; your edits are kept.",
      };
  }
}

/**
 * Why some of the project's sounds are silent (GRV-55): they could not be
 * loaded or decoded to play. The project still names them; only this visit
 * to the editor is without them.
 */
export function soundLoadFailureMessage(count: number): CapabilityMessage {
  const one = count === 1;
  return {
    title: one ? "A sound didn't load" : `${count} sounds didn't load`,
    detail: one
      ? "One of this project's sounds couldn't be loaded, so it will stay silent."
      : "Some of this project's sounds couldn't be loaded, so they will stay silent.",
    action:
      "Check your connection, then reload the page to try again; your edits are kept.",
  };
}
