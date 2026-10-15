/**
 * What the assistant tells a producer about what it sends and what Groove
 * keeps (GRV-8): the disclosure's copy, in one place so a wording change is
 * one edit. Approved in ADR 0007 decision 5; the four things it must stay
 * true and specific about are what is sent, what the provider may do with
 * it, what Groove keeps and for how long, and what the control does and does
 * not cover.
 *
 * Keeping is the default (GRV-97, ADR 0007 decision 9), so the first-run
 * dialog is a notice with a way out ("OK" or "Don't keep them"), not a
 * question, and every sentence here has to be true for an account that has
 * opted out as well as for one that has not.
 *
 * The retention window is read from the one configured value
 * (`TRANSCRIPT_RETENTION_DAYS`, which the server's expiry reads too), so the
 * copy and the deletion can never disagree.
 *
 * The provider's posture (the second paragraph) is written from Anthropic's
 * published terms, re-read on 2026-10-09 (ADR 0007 decision 6): the
 * commercial terms (effective 17 June 2025) say "Anthropic may not train
 * models on Customer Content from Services"; the commercial retention policy
 * says inputs and outputs are deleted "within 30 days of receipt or
 * generation", and kept "for up to 2 years" when flagged by its trust and
 * safety systems. Re-read them whenever this copy ships again.
 */
import { ASSISTANT_NAME } from "../../../site.config.mjs";
import { TRANSCRIPT_RETENTION_DAYS } from "../../assistant/transcripts";

export const SETTINGS_TITLE = `${ASSISTANT_NAME} settings`;

const DAYS = `${TRANSCRIPT_RETENTION_DAYS} days`;

export const DISCLOSURE_TITLE = `About ${ASSISTANT_NAME}`;

/** The disclosure's paragraphs, in order: what is sent, the provider, what Groove keeps. */
export const DISCLOSURE_PARAGRAPHS: readonly string[] = [
  `Groove sends Anthropic — the AI service behind ${ASSISTANT_NAME} — your message along with a description of the project you're working in: its name, your track and section names, the tempo and structure, your mixer settings, and the notes in whatever you currently have selected. It does not send your audio, and it does not send the rest of your project.`,
  "Anthropic does not use anything we send it to train their AI models, and they delete it within 30 days — unless their automated safety systems flag something, in which case they can keep it for up to two years.",
  `Separately, unless you tell it not to, Groove keeps your conversations — your messages, ${ASSISTANT_NAME}'s replies, and the changes it proposes, including any notes it writes for you — for ${DAYS}. Our goal is to make ${ASSISTANT_NAME} better. The team may read them. After ${DAYS} they are deleted.`,
];

/** The control's label, in the dialog and in the setting. */
export const RETENTION_LABEL = `Keep my conversations with ${ASSISTANT_NAME} for ${DAYS}`;

/**
 * The control's scope, which travels with it wherever it appears (ADR 0007
 * decision 8), so a producer who reads only the setting still reads it.
 */
export const RETENTION_SCOPE =
  "This controls Groove's own copy only. It does not take back anything already sent to Anthropic.";

export const DISCLOSURE_CLOSING = `${ASSISTANT_NAME} behaves exactly the same either way, and every other part of Groove works without it — if you would rather nothing was sent, you can simply not use ${ASSISTANT_NAME}.`;

/** What the first-run notice says Groove does, above its two answers. */
export const NOTICE_HEADING = `Groove keeps your conversations for ${DAYS}`;

/** Where the answer can be changed later, and what turning it off does. */
export const NOTICE_CHANGE = `You can change this at any time in ${SETTINGS_TITLE}. Turning it off deletes every conversation Groove has kept.`;

/** The two answers in the first-run notice, side by side and equal in size. */
export const ACCEPT_ANSWER = "OK";
export const DECLINE_ANSWER = "Don't keep them";

/** What turning the setting off does, said as it happens. */
export const OPTED_OUT_CONFIRMATION =
  "Groove has stopped keeping your conversations and deleted the ones it kept. This does not take back anything already sent to Anthropic.";

/**
 * What turning the setting on does, with the control's scope, so a producer
 * who reads only the confirmation reads it too (the issue's fourth criterion).
 */
export const OPTED_IN_CONFIRMATION = `Groove will keep your conversations from now on, for ${DAYS} each. ${RETENTION_SCOPE}`;

export const RETENTION_SAVE_FAILED = "Couldn't save your answer. Try again.";
