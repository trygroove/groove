import type { CapabilityReport } from "../browser/capabilities";
import {
  audioStartFailureMessage,
  CAPABILITY_MESSAGES,
  soundLoadFailureMessage,
} from "../browser/capabilityMessages";
import type { CompatibilityNoticeItem } from "./CompatibilityNotice";
import type { AudioStartFailure, SoundLoadFailure } from "./useProjectAudio";

/**
 * Everything the editor has to explain about this browser (#75): each missing
 * capability, then the last failure to start sound, then the sounds that
 * could not be loaded (GRV-55). Anything that would only
 * repeat a missing-Web-Audio notice already on screen is left out, so the
 * producer reads the same advice once.
 */
export function compatibilityNoticeItems(
  report: CapabilityReport,
  startFailure: AudioStartFailure | null,
  loadFailure: SoundLoadFailure | null = null,
): CompatibilityNoticeItem[] {
  // Decoding needs an audio engine to decode with, so without Web Audio its
  // notice would only repeat the first one.
  const explained = report.missing.includes("web_audio")
    ? report.missing.filter((capability) => capability !== "audio_decoding")
    : report.missing;
  const items: CompatibilityNoticeItem[] = explained.map((capability) => ({
    key: `capability:${capability}`,
    message: CAPABILITY_MESSAGES[capability],
  }));
  if (startFailure) {
    const message = audioStartFailureMessage(startFailure.code);
    const repeatsMissingAudio =
      message === CAPABILITY_MESSAGES.web_audio && report.missing.includes("web_audio");
    if (!repeatsMissingAudio) {
      items.push({ key: `audio-start:${startFailure.attempt}`, message });
    }
  }
  if (loadFailure) {
    items.push({
      key: `sound-load:${loadFailure.attempt}`,
      message: soundLoadFailureMessage(loadFailure.count),
    });
  }
  return items;
}
