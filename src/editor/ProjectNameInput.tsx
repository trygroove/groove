import type { JSX } from "@solidjs/web";
import { MASK_CONTENT } from "../monitoring/replayPrivacy";
import { useShortcutScope } from "../shortcuts";

export interface ProjectNameInputProps {
  readonly name: string;
  /** A changed, non-empty name, already trimmed. */
  onRename(name: string): void;
  /** The edit is over: committed, cancelled, or focus left. */
  onDone(): void;
}

/**
 * The open project's name, typed in place. Enter or focus leaving commits a
 * changed name; an empty or unchanged one puts the project's own back. Escape,
 * while the name has focus, is the registry's `view.close_surface`, as in
 * `TrackNameInput`. It mounts focused with the name selected, because it only
 * exists after a click asked for it.
 */
export default function ProjectNameInput(props: ProjectNameInputProps): JSX.Element {
  let input: HTMLInputElement | undefined;
  useShortcutScope({
    handlers: () => ({
      "view.close_surface": {
        run: () => {
          if (!input) return;
          input.value = props.name;
          input.blur();
        },
        isEnabled: () => input !== undefined && document.activeElement === input,
      },
    }),
    contexts: () => [],
  });

  return (
    <input
      ref={(el) => {
        input = el;
        queueMicrotask(() => {
          el.focus();
          el.select();
        });
      }}
      class={`project-name-input ${MASK_CONTENT}`}
      type="text"
      aria-label="Project name"
      maxlength={120}
      value={props.name}
      onBlur={() => props.onDone()}
      onChange={(event) => {
        const name = event.currentTarget.value.trim();
        if (name && name !== props.name) {
          props.onRename(name);
        } else {
          event.currentTarget.value = props.name;
        }
        props.onDone();
      }}
    />
  );
}
