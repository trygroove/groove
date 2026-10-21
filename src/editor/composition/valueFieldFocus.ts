import { createSignal } from "solid-js";

/**
 * What the shortcut registry reaches in the focused value field (ARR-010):
 * `value.nudge_up`/`value.nudge_down` nudge it. Escape is not the field's: it
 * closes the dialog the field sits in, as everywhere (#650). The field never
 * reads a key itself.
 */
export interface FocusedValueField {
  nudge(direction: 1 | -1): void;
}

// One field has focus at a time, so the editor needs one slot, not a registry.
const [focused, setFocused] = createSignal<FocusedValueField | null>(null);

/** The value field with focus, if any; the editor's shortcut contexts read it. */
export const focusedValueField = focused;

export function focusValueField(field: FocusedValueField): void {
  setFocused(() => field);
}

export function blurValueField(field: FocusedValueField): void {
  if (focused() === field) setFocused(null);
}
