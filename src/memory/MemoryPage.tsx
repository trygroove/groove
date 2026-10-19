import type { JSX } from "@solidjs/web";
import { createSignal, For, Match, Show, Switch } from "solid-js";
import { ASSISTANT_NAME } from "../../site.config.mjs";
import { type Analytics, analytics as defaultAnalytics } from "../analytics/analytics";
import { useAuth } from "../auth/AuthProvider";
import ConfirmDialog from "../components/ConfirmDialog";
import TapeLoader from "../components/TapeLoader";
import { MASK_CONTENT } from "../monitoring/replayPrivacy";
import { CONSENT_LABEL, CONSENT_NOTE } from "../onboarding/MemoryCard";
import {
  EXPERIENCE_CHOICES,
  GOAL_CHOICES,
  typedItems,
  uniqueItems,
} from "../onboarding/questions";
import { logValidation } from "../onboarding/validation";
import {
  EMPTY_MEMORY,
  MAX_ARTISTS_CHARS,
  MAX_NOTE_CHARS,
  type MemoryField,
  type ProducerMemory,
  type ProducerProfile,
} from "../persistence/profileDocuments";
import type { ProfileRepository } from "../persistence/profileRepository";
import {
  forgetEverything,
  forgetField,
  forgetNote,
  MEMORY_FIELD_LABELS,
} from "./memoryEdits";
import { useProducerProfile } from "./useProducerProfile";
import "./MemoryPage.css";

export interface MemoryPageProps {
  readonly analytics?: Analytics;
  readonly profiles?: () => Promise<ProfileRepository>;
}

/** The fields, in the order the page lists them. */
const FIELDS: readonly MemoryField[] = [
  "taste",
  "artists",
  "experience",
  "goal",
  "learn",
  "gear",
];

/** A draft of the page's edits: each field as typed, and each note's text. */
interface Draft {
  readonly fields: Readonly<Record<MemoryField, string>>;
  readonly notes: Readonly<Record<string, string>>;
}

function draftOf(profile: ProducerProfile | null): Draft {
  const memory = profile?.memory ?? EMPTY_MEMORY;
  return {
    fields: {
      taste: memory.taste.join(", "),
      artists: memory.artists,
      experience: memory.experience ?? "",
      goal: memory.goal ?? "",
      learn: memory.learn.join(", "),
      gear: memory.gear.join(", "),
    },
    notes: Object.fromEntries((profile?.notes ?? []).map((note) => [note.id, note.text])),
  };
}

/** The draft's fields as memory. */
function memoryOf(draft: Draft): ProducerMemory {
  const experience = EXPERIENCE_CHOICES.find(
    ([, value]) => value === draft.fields.experience,
  );
  const goal = GOAL_CHOICES.find(([, value]) => value === draft.fields.goal);
  return {
    taste: uniqueItems(typedItems(draft.fields.taste)),
    artists: draft.fields.artists.trim().slice(0, MAX_ARTISTS_CHARS),
    experience: experience?.[1] ?? null,
    goal: goal?.[1] ?? null,
    learn: uniqueItems(typedItems(draft.fields.learn)),
    gear: uniqueItems(typedItems(draft.fields.gear)),
  };
}

/**
 * The Memory page (GRV-25): every field and note Coproducer remembers, editable,
 * with Forget on each and Forget everything, and the box to share the
 * answers' choices for customer validation. Only the producer and Coproducer ever
 * read it; it is never in a project.
 *
 * Analytics: `memory_forgotten` with what was forgotten (a field, a note, or
 * everything), never what it said, and the validation event when the box is
 * ticked.
 */
export default function MemoryPage(props: MemoryPageProps): JSX.Element {
  const analytics = props.analytics ?? defaultAnalytics;
  const auth = useAuth();
  const store = useProducerProfile({
    uid: () => auth.user?.uid ?? null,
    repository: props.profiles,
  });
  /** The page's edits, or null while it shows the profile as saved. */
  const [edits, setEdits] = createSignal<Draft | null>(null);
  const [status, setStatus] = createSignal<"idle" | "saving" | "saved" | "failed">(
    "idle",
  );
  const [confirming, setConfirming] = createSignal(false);
  const draft = () => edits() ?? draftOf(store.profile());

  const edit = (change: (current: Draft) => Draft) => {
    setEdits(change(draft()));
    setStatus("idle");
  };

  async function save(
    change: (profile: ProducerProfile) => ProducerProfile,
  ): Promise<ProducerProfile | null> {
    setStatus("saving");
    const saved = await store.update(change);
    setStatus(saved ? "saved" : "failed");
    return saved;
  }

  async function saveEdits(): Promise<void> {
    const current = draft();
    const saved = await save((profile) => ({
      ...profile,
      memory: memoryOf(current),
      notes: profile.notes
        .map((note) => ({ ...note, text: (current.notes[note.id] ?? note.text).trim() }))
        .filter((note) => note.text.length > 0)
        .map((note) => ({ ...note, text: note.text.slice(0, MAX_NOTE_CHARS) })),
    }));
    if (saved) {
      setEdits(null);
      logValidation(analytics, saved);
    }
  }

  /**
   * Forgets something and saves it at once. Unsaved edits elsewhere on the
   * page stay; only the draft of what was forgotten goes with it.
   */
  async function forget(
    what: "field" | "note" | "everything",
    change: (profile: ProducerProfile) => ProducerProfile,
    keep: (current: Draft) => Draft | null = () => null,
  ): Promise<void> {
    if (await save(change)) {
      setEdits((current) => (current ? keep(current) : null));
      analytics.log("memory_forgotten", { what });
    }
  }

  async function setConsent(consent: boolean): Promise<void> {
    const saved = await save((profile) => ({ ...profile, validationConsent: consent }));
    if (saved && consent) logValidation(analytics, saved);
  }

  return (
    <div class="memory-page">
      <a class="memory-page-back" href="/projects">
        Back to projects
      </a>
      <p class="memory-page-intro">
        What {ASSISTANT_NAME} remembers about you, to make its suggestions yours. Only you
        and {ASSISTANT_NAME} see it, and it is never part of a project.
      </p>
      <Switch>
        <Match when={!store.loaded()}>
          <TapeLoader label="Loading memory" />
        </Match>
        <Match when={store.failed()}>
          <p class="memory-page-error" role="alert">
            Couldn't load your memory. Reload the page to try again.
          </p>
        </Match>
        <Match when={store.loaded()}>
          <section class="memory-page-section" aria-labelledby="memory-about">
            <h2 id="memory-about">About you</h2>
            <For each={FIELDS}>
              {(field) => (
                <div class="memory-page-row">
                  <label for={`memory-${field}`}>{MEMORY_FIELD_LABELS[field]}</label>
                  <FieldInput
                    field={field}
                    value={draft().fields[field]}
                    onInput={(value) =>
                      edit((current) => ({
                        ...current,
                        fields: { ...current.fields, [field]: value },
                      }))
                    }
                  />
                  <button
                    type="button"
                    class="memory-page-forget"
                    aria-label={`Forget ${MEMORY_FIELD_LABELS[field]}`}
                    onClick={() =>
                      void forget(
                        "field",
                        (profile) => forgetField(profile, field),
                        (current) => ({
                          ...current,
                          fields: { ...current.fields, [field]: "" },
                        }),
                      )
                    }
                  >
                    Forget
                  </button>
                </div>
              )}
            </For>
          </section>
          <section class="memory-page-section" aria-labelledby="memory-notes">
            <h2 id="memory-notes">Notes</h2>
            <Show
              when={(store.profile()?.notes.length ?? 0) > 0}
              fallback={
                <p class="memory-page-empty">
                  No notes yet. When you tell {ASSISTANT_NAME} something about yourself,
                  it asks before it remembers it.
                </p>
              }
            >
              <ul class="memory-page-notes">
                <For each={store.profile()?.notes ?? []}>
                  {(note, index) => (
                    <li class="memory-page-row">
                      <label class="visually-hidden" for={`memory-note-${note.id}`}>
                        Note {index() + 1}
                      </label>
                      <input
                        id={`memory-note-${note.id}`}
                        class={["memory-page-input", MASK_CONTENT]}
                        maxlength={MAX_NOTE_CHARS}
                        value={draft().notes[note.id] ?? note.text}
                        onInput={(event) => {
                          const value = event.currentTarget.value;
                          edit((current) => ({
                            ...current,
                            notes: { ...current.notes, [note.id]: value },
                          }));
                        }}
                      />
                      <button
                        type="button"
                        class="memory-page-forget"
                        aria-label={`Forget note ${index() + 1}`}
                        onClick={() =>
                          void forget(
                            "note",
                            (profile) => forgetNote(profile, note.id),
                            (current) => ({
                              ...current,
                              notes: Object.fromEntries(
                                Object.entries(current.notes).filter(
                                  ([id]) => id !== note.id,
                                ),
                              ),
                            }),
                          )
                        }
                      >
                        Forget
                      </button>
                    </li>
                  )}
                </For>
              </ul>
            </Show>
          </section>
          <div class="memory-page-actions">
            <button
              type="button"
              class="memory-page-save"
              disabled={edits() === null || status() === "saving"}
              onClick={() => void saveEdits()}
            >
              Save changes
            </button>
            <output class="memory-page-status">
              {status() === "saving"
                ? "Saving…"
                : status() === "saved"
                  ? "Saved."
                  : status() === "failed"
                    ? "Couldn't save. Try again."
                    : ""}
            </output>
          </div>
          <label class="memory-page-consent">
            <input
              type="checkbox"
              checked={store.profile()?.validationConsent ?? false}
              onChange={(event) => void setConsent(event.currentTarget.checked)}
            />
            <span>
              {CONSENT_LABEL}
              <small>{CONSENT_NOTE}</small>
            </span>
          </label>
          <div class="memory-page-danger">
            <button
              type="button"
              class="memory-page-forget-all"
              onClick={() => setConfirming(true)}
            >
              Forget everything
            </button>
          </div>
          <Show when={confirming()}>
            <ConfirmDialog
              title="Forget everything?"
              message={`${ASSISTANT_NAME} forgets every answer and note. Your projects are not touched.`}
              confirmLabel="Forget everything"
              busy={status() === "saving"}
              onConfirm={() => {
                setConfirming(false);
                void forget("everything", forgetEverything);
              }}
              onCancel={() => setConfirming(false)}
            />
          </Show>
        </Match>
      </Switch>
    </div>
  );
}

function FieldInput(props: {
  readonly field: MemoryField;
  readonly value: string;
  onInput(value: string): void;
}): JSX.Element {
  const id = () => `memory-${props.field}`;
  return (
    <Switch
      fallback={
        <input
          id={id()}
          class={["memory-page-input", MASK_CONTENT]}
          value={props.value}
          placeholder={props.field === "artists" ? "" : "Separate with commas"}
          maxlength={MAX_ARTISTS_CHARS}
          onInput={(event) => props.onInput(event.currentTarget.value)}
        />
      }
    >
      <Match when={props.field === "experience" || props.field === "goal"}>
        <select
          id={id()}
          class="memory-page-input"
          value={props.value}
          onChange={(event) => props.onInput(event.currentTarget.value)}
        >
          <option value="">Not said</option>
          <For each={props.field === "experience" ? EXPERIENCE_CHOICES : GOAL_CHOICES}>
            {([label, value]) => <option value={value}>{label}</option>}
          </For>
        </select>
      </Match>
    </Switch>
  );
}
