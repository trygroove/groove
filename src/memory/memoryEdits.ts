/**
 * Changes to what Cue remembers (GRV-25), as pure functions of a profile: a
 * proposal confirmed, its undo, a question asked, and the memory a turn
 * carries. The editor's memory cards and the Memory page both go through
 * these, so memory is changed one way wherever it is changed.
 */
import type { AssistantMemoryContext, MemoryProposal } from "../assistant/memory";
import { experienceLabel, goalLabel } from "../onboarding/questions";
import {
  MAX_MEMORY_NOTES,
  type MemoryField,
  type MemoryNote,
  type OnboardingQuestionId,
  type ProducerMemory,
  type ProducerProfile,
} from "../persistence/profileDocuments";

/** What a turn carries of `profile`: its memory, its notes and one question to ask later. */
export function memoryContext(profile: ProducerProfile): AssistantMemoryContext {
  return {
    taste: [...profile.memory.taste],
    artists: profile.memory.artists,
    experience: profile.memory.experience,
    goal: profile.memory.goal,
    learn: [...profile.memory.learn],
    gear: [...profile.memory.gear],
    notes: profile.notes.map((note) => ({ id: note.id, text: note.text })),
    askLater: profile.laterQuestions[0] ?? null,
  };
}

/** How each field is named to the producer. */
export const MEMORY_FIELD_LABELS: Readonly<Record<MemoryField, string>> = {
  taste: "Music you love",
  artists: "Artists",
  experience: "Experience",
  goal: "Goal",
  learn: "Learning",
  gear: "Gear",
};

/** A field's value as the producer reads it. */
export function fieldText(memory: ProducerMemory, field: MemoryField): string {
  switch (field) {
    case "taste":
    case "learn":
    case "gear":
      return memory[field].join(", ");
    case "artists":
      return memory.artists;
    case "experience":
      return memory.experience ? experienceLabel(memory.experience) : "";
    case "goal":
      return memory.goal ? goalLabel(memory.goal) : "";
  }
}

/** A proposal in a line: `"Making more trap lately"`, or `Gear: Ableton Move, OP-1`. */
export function describeProposal(proposal: MemoryProposal): string {
  if (proposal.kind === "note") return `"${proposal.text}"`;
  const memory = setField(EMPTY_FIELDS, proposal);
  return `${MEMORY_FIELD_LABELS[proposal.field]}: ${fieldText(memory, proposal.field)}`;
}

const EMPTY_FIELDS: ProducerMemory = {
  taste: [],
  artists: "",
  experience: null,
  goal: null,
  learn: [],
  gear: [],
};

function setField(
  memory: ProducerMemory,
  proposal: Extract<MemoryProposal, { kind: "field" }>,
): ProducerMemory {
  return { ...memory, [proposal.field]: proposal.value } as ProducerMemory;
}

/** What a confirmed proposal replaced, so Undo can put it back. */
export type MemoryUndo =
  | {
      readonly kind: "note";
      readonly noteId: string;
      readonly dropped: MemoryNote | null;
    }
  | {
      readonly kind: "field";
      readonly field: MemoryField;
      readonly memory: ProducerMemory;
    };

/**
 * `profile` with `proposal` in it. A note goes at the end, and the oldest
 * goes once there are more than the cap; a field takes its new value, and a
 * question it answers is no longer one to ask later.
 */
export function applyProposal(
  profile: ProducerProfile,
  proposal: MemoryProposal,
  note: { readonly id: string; readonly createdAt: number },
): { readonly profile: ProducerProfile; readonly undo: MemoryUndo } {
  if (proposal.kind === "note") {
    const notes = [
      ...profile.notes,
      { id: note.id, text: proposal.text, createdAt: note.createdAt },
    ];
    const dropped = notes.length > MAX_MEMORY_NOTES ? (notes.shift() ?? null) : null;
    return {
      profile: { ...profile, notes },
      undo: { kind: "note", noteId: note.id, dropped },
    };
  }
  const field = proposal.field;
  return {
    profile: {
      ...profile,
      memory: setField(profile.memory, proposal),
      laterQuestions: profile.laterQuestions.filter(
        (question) => question !== questionFor(field),
      ),
    },
    undo: { kind: "field", field, memory: profile.memory },
  };
}

/** `profile` with a confirmed proposal taken back out. */
export function undoProposal(
  profile: ProducerProfile,
  undo: MemoryUndo,
): ProducerProfile {
  if (undo.kind === "note") {
    const notes = profile.notes.filter((note) => note.id !== undo.noteId);
    return {
      ...profile,
      notes: undo.dropped ? [undo.dropped, ...notes].slice(0, MAX_MEMORY_NOTES) : notes,
    };
  }
  return {
    ...profile,
    memory: {
      ...profile.memory,
      [undo.field]: undo.memory[undo.field],
    } as ProducerMemory,
  };
}

/** The onboarding question a field answers. */
function questionFor(field: MemoryField): OnboardingQuestionId {
  return field === "artists" ? "taste" : field;
}

/** `profile` once question `id` has been asked later: never again. */
export function markAsked(
  profile: ProducerProfile,
  id: OnboardingQuestionId,
): ProducerProfile {
  return {
    ...profile,
    laterQuestions: profile.laterQuestions.filter((question) => question !== id),
  };
}

/** `profile` with one field forgotten. */
export function forgetField(
  profile: ProducerProfile,
  field: MemoryField,
): ProducerProfile {
  return {
    ...profile,
    memory: { ...profile.memory, [field]: EMPTY_FIELDS[field] } as ProducerMemory,
  };
}

/** `profile` with one note forgotten. */
export function forgetNote(profile: ProducerProfile, noteId: string): ProducerProfile {
  return { ...profile, notes: profile.notes.filter((note) => note.id !== noteId) };
}

/**
 * `profile` with everything Cue remembers forgotten: every field, every note,
 * and every question it meant to ask later. Whether onboarding was done, and
 * the share box, are settings rather than memory, and stay.
 */
export function forgetEverything(profile: ProducerProfile): ProducerProfile {
  return { ...profile, memory: EMPTY_FIELDS, notes: [], laterQuestions: [] };
}
