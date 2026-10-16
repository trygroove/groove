import type { JSX } from "@solidjs/web";
import { For, Show } from "solid-js";
import { requestAccessUrl } from "../../site.config.mjs";
import { ViewIcon } from "../editor/viewIcons";
import { AI_PRODUCER_ARRIVES, LANDING_FAQ } from "./landingCopy";
import "./LandingPage.css";

/**
 * The home page's markup and copy, with no behaviour of its own (#1135).
 *
 * Split out of `LandingPage.tsx` so the same tree can be rendered from two
 * places: the interactive page the client mounts, and the prerendered document
 * shell (`src/Document.tsx`), which is SSR-transformed at build time. Keeping
 * it props-only is what makes the second one possible — the shell must not
 * reach the analytics, auth, or consent module graphs, and this component
 * imports none of them.
 *
 * It is also the single copy of the copy: a claim edited here changes the
 * prerendered HTML and the live page together, so the two can never drift.
 *
 * ## Honesty is a requirement here, not a tone
 *
 * `PRJ-06`: the page "does not advertise capabilities beyond the current
 * milestone". The AI producer is the one capability on it that has not
 * shipped, and every mention of it is labelled with when it arrives
 * (`AI_PRODUCER_ARRIVES`) and shown as a design study, not a screenshot.
 * The four `STUDIO_ROWS` are what the alpha does today, each pictured by a
 * real screenshot `bun run landing:capture` records from the app; a row that
 * stops being true is edited here and re-recorded there.
 */

/**
 * Where every "Request an invite" call to action points: the request-access
 * form (#854). The alpha is invite-only, so asking to be let in is the front
 * door for anyone who has not been invited.
 *
 * A real link rather than an `onClick` alone, so it works before this page's
 * JavaScript has loaded, opens in a new tab on a middle-click, and is visible
 * to a crawler that does not execute scripts.
 *
 * "Sign in" stays a `<button>`: it opens an identity-provider popup and goes
 * nowhere on its own, so it is an action, not a destination.
 */
const REQUEST_ACCESS_HREF = requestAccessUrl;

/** Where "See what's inside" goes: the studio section. */
const INSIDE_ID = "inside";

/** The recorded assets, served from `public/landing/`. */
const ASSETS = "/landing";

/** Every still is captured at this size (`landing.screens.spec.ts`). */
const STILL = { width: 1280, height: 800 } as const;

/** Where a Request an invite link sits, for `landing_cta_click`'s placement. */
export type LandingCtaPlacement = "header" | "hero" | "close";

interface ProblemCard {
  title: string;
  body: string;
}

/** Section 3: the problem, in the words of PRD sections 2 and 4. */
const PROBLEMS: readonly ProblemCard[] = [
  {
    title: "Tutorials are about someone else's track.",
    body: "They teach a technique on a project that isn't yours, and you stop making music to watch them.",
  },
  {
    title: "Pro DAWs show everything at once.",
    body: "Every control is on screen before you know which three matter, and the timeline after your loop is blank.",
  },
  {
    title: "Generators hand you a song you didn't make.",
    body: "You get a result, but not the authorship, the control, or anything you learned for the next one.",
  },
];

/** Section 4: what the AI producer will do. */
const AI_POINTS: readonly ProblemCard[] = [
  {
    title: "Ask what to do next.",
    body: "Stuck after eight bars? Ask, and it suggests a concrete next step for the song you have, not a generic one.",
  },
  {
    title: "Hear it before you keep it.",
    body: "Every suggestion is a real change to your project. Preview it in place, then apply it, tweak it or undo it in one step.",
  },
  {
    title: "Learn why it works.",
    body: "Each change comes with the technique behind it and points at the controls it touched, so next time you can do it yourself.",
  },
];

interface StudioRow {
  id: string;
  label: string;
  title: string;
  body: string;
  image: string;
  alt: string;
}

/** Section 5: what the alpha does today, each with a real screenshot. */
const STUDIO_ROWS: readonly StudioRow[] = [
  {
    id: "arrange",
    label: "Arrange",
    title: "From loop to song.",
    body: "Lay clips out on a timeline, name the sections (intro, verse, drop) and build a song up to ten minutes long. Loop, copy and trim clips the way you would in any DAW.",
    image: "arrange.jpg",
    alt: "The arrangement: drums, bass, chords and a loop laid out across Intro, Verse, Drop and Outro sections.",
  },
  {
    id: "play",
    label: "Play",
    title: "Instruments that teach you what they do.",
    body: "A sampler, a drum machine and a synth, with controls in plain words: Cutoff, Resonance and Attack, not LP, Q and A. Envelopes and filters draw their shape, and redraw as you move them.",
    image: "play.jpg",
    alt: "A synth's faceplate: its waveform, a filter curve and an amp envelope drawn above labelled faders.",
  },
  {
    id: "shape",
    label: "Shape",
    title: "Shape the sound, then the mix.",
    body: "EQ, compressor, filter, delay, reverb, overdrive and saturator, chained on any track. A mixer with level meters, sends and a return. Every move can be undone.",
    image: "shape.jpg",
    alt: "The mixer during playback: a strip per track with level meters, a reverb return and the master.",
  },
  {
    id: "finish",
    label: "Finish",
    title: "Finish it, and take it anywhere.",
    body: "Sound packs you browse by feel, with loops matched to your song's tempo. Export a stereo WAV to share, or DAW-ready stems to mix anywhere else.",
    image: "finish.jpg",
    alt: "The library open on loops near the song's tempo of 120 BPM.",
  },
];

interface FitColumn {
  title: string;
  body: string;
  ours?: boolean;
}

/** Section 6: where Groove sits (PRD section 1). */
const FIT: readonly FitColumn[] = [
  {
    title: "Beat apps",
    body: "Quick to a loop, then stuck there. Little help turning eight bars into a song.",
  },
  {
    title: "Groove",
    body: `Real tracks, clips, devices and mixing, a step at a time, with an AI producer to suggest what's next (from ${AI_PRODUCER_ARRIVES}).`,
    ours: true,
  },
  {
    title: "Pro DAWs",
    body: "Everything you will ever need, all on screen at once, and nobody to tell you where to start.",
  },
];

/** Section 7. */
const STEPS: readonly ProblemCard[] = [
  {
    title: "Bring a loop.",
    body: "Start a project and make a beat on the step sequencer, or pick a loop from the library.",
  },
  {
    title: "Build it into a song.",
    body: `Lay out sections, add parts and shape the sound, with the AI producer suggesting what's next (from ${AI_PRODUCER_ARRIVES}).`,
  },
  {
    title: "Finish and share.",
    body: "Export a stereo WAV to share, or stems to take into another DAW.",
  },
];

export interface LandingPageContentProps {
  /** Whether a sign-in is in flight; disables Sign in while it is. */
  busy?: boolean;
  /** Shown in the hero when a sign-in attempt failed. */
  loginError?: string | null;
  /**
   * A "Request an invite" link was activated, and where it sits. The links go
   * to the form on their own, so this only observes the click (for analytics)
   * and never takes it over.
   */
  onRequestAccess?: (placement: LandingCtaPlacement) => void;
  /** Signs in an invited account. */
  onLogIn?: () => void;
  /** "See what's inside" was activated. The anchor scrolls on its own. */
  onSeeInside?: () => void;
  /**
   * The hero video, once it is in the document. The page decides whether to
   * play it (not under reduced motion); the markup never autoplays, so with
   * no script it shows its poster.
   */
  heroVideoRef?: (video: HTMLVideoElement) => void;
  /** The hero video started playing. */
  onHeroVideoPlay?: () => void;
  /**
   * The footer's telemetry disclosure (`DEC-009`), supplied by the caller.
   *
   * A slot rather than a direct render because the disclosure reads the
   * consent store, which is exactly the kind of module the prerendered shell
   * must not pull in. The client's copy of this page fills it; the shell
   * leaves it empty and the live page supplies it on mount.
   */
  disclosure?: JSX.Element;
}

function RequestInvite(props: {
  placement: LandingCtaPlacement;
  large?: boolean;
  onRequestAccess?: LandingPageContentProps["onRequestAccess"];
}) {
  return (
    <a
      class={`landing-button landing-button-primary${props.large ? " landing-button-large" : ""}`}
      href={REQUEST_ACCESS_HREF}
      onClick={() => props.onRequestAccess?.(props.placement)}
    >
      Request an invite
    </a>
  );
}

function SectionHeading(props: { id: string; eyebrow?: string; children: JSX.Element }) {
  return (
    <header class="landing-section-head">
      <Show when={props.eyebrow}>
        <p class="landing-eyebrow">{props.eyebrow}</p>
      </Show>
      <h2 id={props.id}>{props.children}</h2>
    </header>
  );
}

export default function LandingPageContent(props: LandingPageContentProps) {
  return (
    <div class="landing">
      <header class="landing-header">
        <a class="landing-brand" href="/">
          {/* The arrangement view's icon, which is also the favicon. */}
          <span class="landing-brand-mark">
            <ViewIcon view="arrangement" size={28} />
          </span>
          <span>Groove</span>
        </a>
        <nav class="landing-nav" aria-label="Get started">
          <button
            type="button"
            class="landing-button landing-button-quiet"
            disabled={props.busy}
            onClick={() => props.onLogIn?.()}
          >
            {props.busy ? "Signing in…" : "Sign in"}
          </button>
          <RequestInvite placement="header" onRequestAccess={props.onRequestAccess} />
        </nav>
      </header>

      <main class="landing-main">
        <section class="landing-hero" aria-labelledby="landing-headline">
          <div class="landing-hero-copy">
            <p class="landing-eyebrow">Invite-only alpha · runs in your browser</p>
            <h1 id="landing-headline">Finish the tracks you start.</h1>
            <p class="landing-lede">
              Groove is a music studio in your browser with an AI producer beside you. It
              works inside your project, suggests real changes and explains why they work.
              You keep, tweak or undo every one, and learn the skills for your next track.
            </p>
            <div class="landing-hero-actions">
              <RequestInvite
                placement="hero"
                large
                onRequestAccess={props.onRequestAccess}
              />
              <a
                class="landing-button landing-button-ghost landing-button-large"
                href={`#${INSIDE_ID}`}
                onClick={() => props.onSeeInside?.()}
              >
                See what's inside
              </a>
            </div>
            <p class="landing-hint">
              We're letting producers in in small batches. Nothing to install.
            </p>
            <Show when={props.loginError}>
              <p class="landing-error" role="alert">
                {props.loginError}
              </p>
            </Show>
          </div>
          {/* Decorative: what it shows is said in words further down, so it
              is hidden from assistive technology and never autoplays from
              the markup. `LandingPage` plays it when motion is welcome. */}
          <div class="landing-hero-media" aria-hidden="true">
            <video
              ref={(video) => props.heroVideoRef?.(video)}
              class="landing-hero-video"
              poster={`${ASSETS}/hero-poster.jpg`}
              width={STILL.width}
              height={STILL.height}
              muted
              loop
              playsinline
              preload="none"
              onPlay={() => props.onHeroVideoPlay?.()}
            >
              <source src={`${ASSETS}/hero.webm`} type="video/webm" />
            </video>
          </div>
        </section>

        <section class="landing-section" aria-labelledby="landing-who-heading">
          <SectionHeading id="landing-who-heading" eyebrow="Who it's for">
            For producers with a folder full of loops.
          </SectionHeading>
          <p class="landing-section-lede">
            You can make a beat. Turning it into a finished track is where it stalls, and
            the usual help doesn't help.
          </p>
          <ul class="landing-cards">
            <For each={PROBLEMS}>
              {(card) => (
                <li class="landing-card">
                  <h3>{card.title}</h3>
                  <p>{card.body}</p>
                </li>
              )}
            </For>
          </ul>
        </section>

        <section class="landing-section landing-ai" aria-labelledby="landing-ai-heading">
          <div class="landing-ai-copy">
            <p class="landing-badge">Coming in {AI_PRODUCER_ARRIVES}</p>
            <SectionHeading id="landing-ai-heading">
              An AI producer, beside you.
            </SectionHeading>
            <p class="landing-section-lede">
              Not a song generator. It works inside your project, with the same tracks,
              clips and controls you use.
            </p>
            <ol class="landing-points">
              <For each={AI_POINTS}>
                {(point) => (
                  <li>
                    <h3>{point.title}</h3>
                    <p>{point.body}</p>
                  </li>
                )}
              </For>
            </ol>
          </div>
          <figure class="landing-figure landing-ai-figure">
            <img
              src={`${ASSETS}/assistant-study.jpg`}
              alt="A design study of the AI producer's panel: it proposes three changes to a drum beat, previewed with dashed outlines, with Apply and Cancel."
              width={1180}
              height={781}
              loading="lazy"
              decoding="async"
            />
            <figcaption>
              Design study. The AI producer arrives in {AI_PRODUCER_ARRIVES}.
            </figcaption>
          </figure>
        </section>

        <section
          class="landing-section"
          id={INSIDE_ID}
          aria-labelledby="landing-studio-heading"
        >
          <SectionHeading id="landing-studio-heading" eyebrow="What's inside">
            In the studio today.
          </SectionHeading>
          <p class="landing-section-lede">
            Everything here works in the alpha now. The pictures are the app.
          </p>
          <div class="landing-rows">
            <For each={STUDIO_ROWS}>
              {(row) => (
                <article class="landing-row" aria-labelledby={`landing-row-${row.id}`}>
                  <figure class="landing-figure landing-row-figure">
                    <img
                      src={`${ASSETS}/${row.image}`}
                      alt={row.alt}
                      width={STILL.width}
                      height={STILL.height}
                      loading="lazy"
                      decoding="async"
                    />
                  </figure>
                  <div class="landing-row-copy">
                    <p class="landing-eyebrow">{row.label}</p>
                    <h3 id={`landing-row-${row.id}`}>{row.title}</h3>
                    <p>{row.body}</p>
                  </div>
                </article>
              )}
            </For>
          </div>
        </section>

        <section class="landing-section" aria-labelledby="landing-fit-heading">
          <SectionHeading id="landing-fit-heading" eyebrow="Where it fits">
            Deeper than a beat app. Simpler than a pro DAW.
          </SectionHeading>
          <ul class="landing-fit">
            <For each={FIT}>
              {(column) => (
                <li class={column.ours ? "landing-fit-ours" : undefined}>
                  <h3>{column.title}</h3>
                  <p>{column.body}</p>
                </li>
              )}
            </For>
          </ul>
          <p class="landing-note">
            Tracks, clips, effects and stems work the way they do in Ableton Live and
            Logic Pro, so what you learn here carries over.
          </p>
        </section>

        <section class="landing-section" aria-labelledby="landing-how-heading">
          <SectionHeading id="landing-how-heading" eyebrow="How it works">
            Three steps from loop to track.
          </SectionHeading>
          <ol class="landing-steps">
            <For each={STEPS}>
              {(step) => (
                <li>
                  <h3>{step.title}</h3>
                  <p>{step.body}</p>
                </li>
              )}
            </For>
          </ol>
        </section>

        <section class="landing-section" aria-labelledby="landing-faq-heading">
          <SectionHeading id="landing-faq-heading" eyebrow="FAQ">
            Questions, answered.
          </SectionHeading>
          <dl class="landing-faq">
            <For each={LANDING_FAQ}>
              {(item) => (
                <div class="landing-faq-item">
                  <dt>{item.question}</dt>
                  <dd>{item.answer}</dd>
                </div>
              )}
            </For>
          </dl>
        </section>

        <section class="landing-close" aria-labelledby="landing-close-heading">
          <h2 id="landing-close-heading">Bring a loop. Leave with a track.</h2>
          <p>We're letting producers in in small batches. Join the list.</p>
          <RequestInvite
            placement="close"
            large
            onRequestAccess={props.onRequestAccess}
          />
        </section>
      </main>

      <footer class="landing-footer">
        <p class="landing-footer-brand">Groove · invite-only alpha</p>
        {/* `DEC-009`/`FND-001c`: the disclosure and opt-out have their designed
				    home here. `src/app.tsx` renders the floating one on every other
				    surface, and skips it here so there is exactly one on the page. */}
        {props.disclosure}
      </footer>
    </div>
  );
}
