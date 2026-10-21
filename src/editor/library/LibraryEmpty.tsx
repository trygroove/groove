import type { JSX } from "@solidjs/web";
import EmptyView, { type EmptyViewFix } from "../composition/EmptyView";
import type { EditorViewName } from "../composition/editorViews";
import type { LibraryAim } from "./libraryTarget";

type NoTarget = Exclude<LibraryAim["kind"], "target">;

/** What the Library says when the selected track has no slot to fill (UI-002). */
const COPY: Record<
  NoTarget,
  { title: string; body: string; fixes: readonly EditorViewName[] }
> = {
  synth: {
    title: "Synths don't play samples",
    body: "The Library holds samples and loops. Select a sampler or drum machine track to browse sounds for it.",
    fixes: ["arrangement", "instrument"],
  },
  "no-slot": {
    title: "No sample slot",
    body: "This track has no sample slot to fill. Give it a sampler or drum machine, or a pad, in the instrument view.",
    fixes: ["instrument"],
  },
  "no-track": {
    title: "No track selected",
    body: "Select a sampler or drum machine track in the arrangement to browse sounds for it.",
    fixes: ["arrangement"],
  },
};

export interface LibraryEmptyProps {
  readonly kind: NoTarget;
  fix(view: EditorViewName): EmptyViewFix;
  onFix(view: EditorViewName): void;
}

/** The Library's empty screens: the shared one, with the Library's copy. */
export default function LibraryEmpty(props: LibraryEmptyProps): JSX.Element {
  const copy = () => COPY[props.kind];
  return (
    <EmptyView
      view="library"
      title={copy().title}
      body={copy().body}
      fixes={copy().fixes.map((view) => props.fix(view))}
      onFix={(view) => props.onFix(view)}
    />
  );
}
