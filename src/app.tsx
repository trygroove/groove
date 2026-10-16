import { Title } from "@solidjs/meta";
import { useLocation } from "@solidjs/router";
import { Errored, Loading } from "@solidjs/web";
import { type Accessor, createEffect, createSignal, onSettled } from "solid-js";
import { APP_TITLE } from "../site.config.mjs";
import AppErrorFallback from "./components/AppErrorFallback";
import FloatingTelemetryDisclosure from "./components/FloatingTelemetryDisclosure";
import ReleaseBadge from "./components/ReleaseBadge";
import TapeLoader from "./components/TapeLoader";
import { Router } from "./router";
import { syncInternalTraffic } from "./shared/internalTraffic";
import {
  createRouteTracker,
  initTelemetry,
  surfaceForPath,
  type Telemetry,
} from "./telemetry";
import "./app.css";

/**
 * Keeps telemetry in step with the route (PRD `OPS-02`: "Every event carries
 * ... the surface it came from"). Rendered inside the Router so it can observe
 * navigation; it renders nothing itself.
 *
 * Navigation off the landing page is client-side — the CTA calls
 * `navigate("/projects")` with no page load — so this is also where monitoring
 * starts and `app_opened` fires for a session that entered on `/`. Handing the
 * surface to `Telemetry` rather than to `analytics` directly is what makes that
 * one decision instead of three.
 *
 * It also sends a page view for every pathname the session visits, since the
 * analytics vendor's own pageview capture is off (`createRouteTracker`).
 *
 * The compute phase reads both the pathname and the telemetry accessor, so the
 * effect re-runs with the current pathname once `initTelemetry` has finished;
 * until then the surface still reaches the analytics boundary directly and
 * nothing is lost to mount order. Both reads must stay in the compute half:
 * Solid 2 only tracks what the compute function touches, so a read moved into
 * the apply half below would silently stop the effect reacting to it.
 */
function SurfaceTracker(props: { telemetry: Accessor<Telemetry | null> }) {
  const location = useLocation();
  const track = createRouteTracker();
  createEffect(
    () => ({
      pathname: location.pathname,
      telemetry: props.telemetry(),
    }),
    ({ pathname, telemetry }) => track(pathname, telemetry),
  );
  return null;
}

/**
 * The last resort, for an error nothing inside the app caught: the router
 * itself, or the badge and disclosure that sit outside the shell's boundary.
 *
 * This replaces `@solidjs/vite-plugin`'s default boundary (`errorBoundary:
 * false` in `vite.config.ts`), which says the same thing in the same place but
 * through a `style` attribute baked into its template, and a CSP without
 * 'unsafe-inline' refuses that (GRV-105). The look is `.app-uncaught-error`.
 */
function UncaughtErrorFallback(props: { error: unknown }) {
  console.error(props.error);
  return <span class="app-uncaught-error">Error | Uncaught Client Exception</span>;
}

export default function App() {
  // Drop the prerendered landing markup (`src/Document.tsx`) now that the live
  // tree is about to replace it. Synchronous and in the component body rather
  // than in `onSettled`, because this runs inside the same task as the client
  // `render()` that inserts the app: the browser never gets a chance to paint
  // a frame with both copies in it, or with neither.
  //
  // In production the shell for a deep link never contains this node at all
  // (`scripts/emit-app-shell.mjs`), and the dev server's copy has already
  // removed itself. This is the landing path's case, and the backstop for the
  // other two.
  document.getElementById("landing-static")?.remove();

  const [telemetry, setTelemetry] = createSignal<Telemetry | null>(null);

  // PRD `OPS-01`: mark internal/team traffic once per app load so it can be
  // excluded from the section 11 measures. Outside the Router's layout render
  // prop so it runs once regardless of which route was entered, not once per
  // navigation.
  //
  // `onSettled` rather than 1.x's `onMount`, and the teardown is the returned
  // cleanup rather than a nested `onCleanup` — in Solid 2 that nesting is no
  // longer the idiom, and the returned function is what the lifecycle actually
  // honours.
  onSettled(() => {
    syncInternalTraffic();

    // PRD `OPS-02`/`OPS-03`: install the global error handlers and the
    // analytics transport. Monitoring itself is scheduled by `setSurface`,
    // which the tracker above drives, so a session that starts on the
    // marketing landing page and navigates into the app is still monitored
    // while one that stays on the landing page loads no monitoring SDK
    // (ADR 0001); there it loads only the analytics SDK (GRV-123).
    const instance = initTelemetry({
      surface: surfaceForPath(window.location.pathname),
    });
    setTelemetry(() => instance);

    return () => {
      void instance.dispose();
    };
  });

  return (
    <Errored fallback={(err) => <UncaughtErrorFallback error={err()} />}>
      <Router>
        {(props) => (
          <>
            <Title>{APP_TITLE}</Title>
            <SurfaceTracker telemetry={telemetry} />
            <Errored
              fallback={(err, reset) => (
                <AppErrorFallback error={err()} reset={reset} area="shell" />
              )}
            >
              <Loading fallback={<TapeLoader label="Loading" />}>
                {props.children}
              </Loading>
            </Errored>
            {/* Outside the shell's Errored/Loading boundary so the deployed revision
					    stays visible/inspectable even while the app is loading or has
					    hit an error -- exactly when knowing the build matters most. */}
            <ReleaseBadge />
            {/* Also outside the boundary: the PRD OPS-02 opt-out must stay
					    reachable even on the error screen -- which is why this stands
					    down for the landing page's own inline copy (`LOOP-001b`, per
					    DEC-009) only while that copy is actually mounted, rather than
					    for the whole route. */}
            <FloatingTelemetryDisclosure />
          </>
        )}
      </Router>
    </Errored>
  );
}
