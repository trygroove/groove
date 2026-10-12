# Design principles

How Groove looks, and why. These principles hold on every surface: the
arrangement, the instrument view, the mixer, the library and the dialogs.
[`faceplate-system.html`](./faceplate-system.html) is the reference design
they came from, and it plays. The library follows
[`library-browser.html`](./library-browser.html) (#449), which plays too.
The Export dialog follows the Release design in
[`export-dialog.html`](./export-dialog.html) (#724), which plays too.
The Post-Alpha instruments (synth, wavetable, FM, drum synth and the
sampler) follow [`instrument-faceplates.html`](./instrument-faceplates.html),
which plays too.
[`src/theme.css`](../src/theme.css) is the only
place a colour is written down. Where a rule below is enforced by a test, the
test is named.

## 1. Square corners

Nothing is rounded. Panels, buttons, fields, wells, menus, meters, M and S,
and the selection are all square. A rounded corner reads as a consumer app.
A square one reads as an instrument panel, and it lines up with the grid
beside it.

- Write `border-radius: 0`, or nothing at all. Never a small radius "to soften"
  a control.
- There is one exception, because the shape is the meaning: the round drag
  handles on a well.
- Enforced by `src/theme.test.ts`: a non-zero radius outside that exception
  fails.

## 2. A monochrome palette, with colour kept for meaning

The interface is greyscale: every token is a neutral grey, with R, G and B
equal. Colour is kept for the few things that must stand out.

- **State is brightness, not hue.** Pressed, chosen, focused and playing are
  the brightest thing in their neighbourhood: a white fill with black on it.
  Hover is one step up the grey ramp.
- **The selected track is black.** Wherever tracks are listed, the one the
  editor is showing sinks to the ground colour: the arrangement's header, the
  instrument rail, the mixer strip, and the selected pad row. It reads as a
  hole in the panel, while pressed toggles stay white.
- **A track's own colour is the one hue.** It is domain data, not theme. It
  marks the track (its swatch, its strip's top edge, its header bar) and is
  the ink its wells draw in (`--track-ink`). Nothing else takes it.
- **A level meter's clip is the one status in colour.** A meter is green while
  its track peaks under 0 dBFS, and red for a moment after a peak goes over
  (`--signal-ok`, `--signal-clip`). Only `LevelMeter.css` may read them.
- **A toast is the one notice in colour** (GRV-88): the shared toast
  (`src/components/Toast.tsx`, bottom left, closing itself) fills a muted dark
  red, `--toast-alert`, so "your change was discarded" or "can't undo" reads
  as a problem without becoming a bright alert. A product-owner decision like
  the meters' pair; only `Toast.css` may read it.
- **A marked control is outlined in white** (`UI-004`): dashed while a
  proposed change to it is previewed, solid once the change has landed. One
  rule draws it for every part (`src/controls/controlMarks.css`), and an
  outline moves nothing.
- **Errors speak through emphasis and words**: framing, weight and wording,
  never red text.
- Style against semantic aliases (`--color-text`, `--color-background-secondary`),
  not ramp steps, and never add a near-duplicate of a token that already exists.
- Enforced by `src/theme.test.ts`: no colour literal outside the theme, no
  tinted grey, no tint that borrows anything but black or white, no hue beside
  the signal pair and the toast's dark red, and every token that is read is defined.

## 3. Clearly organised sections

Every surface is built from the same layers, in the same order, so a user who
knows one knows them all.

- **A view has a title row.** "Instrument" with its kind picker, and "Mixer"
  with its new-track buttons. The title says where you are, and the row holds
  the view's own actions at its right.
- **The rack.** Instruments and devices are units at most `--rack-unit-width`
  (1000px) wide, stacked in signal order down the page, with `--rack-gap` of
  rack showing between them. The mixer is the exception: it spans the screen.
- **A unit opens with its header row.** The track's colour bar, its slot and
  kind over its name, a few key readouts as label over value, the meter, and
  one bold white action (Audition) at the right.
- **Then columns on a 12-column grid.** Each section is a column: a well on
  top that draws the section, its faders beneath, and one group rule
  (uppercase title and a hairline) over both.
- **Fixed rows line up across repeats.** Every mixer strip has the same rows,
  and every track header is the same 84px row in the arrangement and the rail.
  Switching views moves nothing: `tests/e2e/emulator/trackHeader.spec.ts` asserts
  it to the pixel.

## 4. One design language: shared parts

A control looks and behaves the same wherever it appears. Each part is one
component, and a surface only sizes it; it never restyles it.

| Part | Component |
| --- | --- |
| Hairline fader: 1px track, 2px fill, a cap, and a value field you can type into | `FillSlider` (and `DbFader` for volume) |
| Well: a black frame that draws the sound, with handles dragged directly | `Well`, `DragSurface` |
| Group rule | `ControlGroup` |
| Switch: a stack of options, the chosen one white | `OptionGroup` |
| Header row | `InstrumentHeader` |
| Track header: swatch and colour picker, bold name, M and S, volume, level | `TrackHeader` |
| M and S | `MuteSoloToggles` |
| Sample slot: a filled button with the library's sound icon, naming the sound, with a caret. The one way to choose a sound: the sampler's sample, every drum pad's, and a loop track's loop | `SampleSlot` |
| Level meter | `LevelMeter` |
| Dropdown | the one `select` rule in `app.css` |
| Ghost button: a hairline border | `NewTrackButtons` |

- **Behaviour is shared too.** Touching a track surface selects its track: a
  click on it, or any value changed on it (`trackSurfaceHandlers`). A press
  anywhere but a control starts a reorder drag, and the handle shows the grab
  cursor. Keys come only from the shortcut registry.
- **Sizes and type come from tokens**: `--font-size-*`, `--rack-*`,
  `--muted-opacity`. A muted track or pad, or a bypassed device, recedes: its
  text drops to the dimmed-text grey (never an opacity, which would take it
  under AA contrast, #76) and its graphics fade to that one opacity. Its M
  and S stay at full strength.
- **Before adding a part, look for the one that exists.** A second way to draw
  a fader, a toggle or a slot is the first step to an interface that looks
  assembled rather than designed.
