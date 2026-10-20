import { cleanup, render } from "@solidjs/testing-library";
import { type JSX, Show } from "@solidjs/web";
import { createSignal, flush } from "solid-js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Analytics } from "../analytics/analytics";
import { ConsentStore } from "../analytics/consent";
import { createRecordingTransport } from "../analytics/transport";
import { memoryStorage } from "../testing/storage";
import { ShortcutController, type ShortcutHandlers } from "./ShortcutController";
import ShortcutRoot from "./ShortcutRoot";
import { useShortcutScope } from "./useShortcutScope";

afterEach(() => cleanup());

function pressEscape(): KeyboardEvent {
  const event = new KeyboardEvent("keydown", { key: "Escape", cancelable: true });
  window.dispatchEvent(event);
  return event;
}

function pressSpace(): KeyboardEvent {
  const event = new KeyboardEvent("keydown", { key: " ", cancelable: true });
  window.dispatchEvent(event);
  return event;
}

function Surface(props: {
  handlers: ShortcutHandlers;
  modal?: boolean;
  children?: JSX.Element;
}): JSX.Element {
  useShortcutScope({
    modal: props.modal,
    handlers: () => props.handlers,
    contexts: () => ["editor"],
  });
  return <>{props.children}</>;
}

function rootWithAnalytics() {
  const transport = createRecordingTransport();
  const analytics = new Analytics({
    transport,
    consent: new ConsentStore(memoryStorage()),
    storage: memoryStorage(),
  });
  analytics.setAccountType("anonymous");
  const controller = new ShortcutController({ platform: "other", analytics });
  return { controller, transport };
}

describe("useShortcutScope (GRV-186)", () => {
  it("gives Escape to the surface mounted last, once, and back to the earlier one when it unmounts", () => {
    const { controller, transport } = rootWithAnalytics();
    const outer = vi.fn();
    const inner = vi.fn();
    const [open, setOpen] = createSignal(true);
    render(() => (
      <ShortcutRoot controller={controller}>
        <Surface handlers={{ "view.close_surface": { run: outer } }}>
          <Show when={open()}>
            <Surface handlers={{ "view.close_surface": { run: inner } }} />
          </Show>
        </Surface>
      </ShortcutRoot>
    ));
    flush();

    pressEscape();
    expect(inner).toHaveBeenCalledTimes(1);
    expect(outer).not.toHaveBeenCalled();
    expect(transport.named("shortcut_used")).toHaveLength(1);

    setOpen(false);
    flush();
    pressEscape();
    expect(outer).toHaveBeenCalledTimes(1);
    expect(inner).toHaveBeenCalledTimes(1);
    expect(transport.named("shortcut_used")).toHaveLength(2);
  });

  it("keeps the editor's keys from firing while a modal scope is mounted over it", () => {
    const { controller } = rootWithAnalytics();
    const play = vi.fn();
    const undo = vi.fn();
    const close = vi.fn();
    const [modal, setModal] = createSignal(true);
    render(() => (
      <ShortcutRoot controller={controller}>
        <Surface
          handlers={{ "transport.play_stop": { run: play }, "edit.undo": { run: undo } }}
        />
        <Show when={modal()}>
          <Surface modal handlers={{ "view.close_surface": { run: close } }} />
        </Show>
      </ShortcutRoot>
    ));
    flush();

    const blocked = pressSpace();
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "z", ctrlKey: true }));
    expect(play).not.toHaveBeenCalled();
    expect(undo).not.toHaveBeenCalled();
    expect(blocked.defaultPrevented).toBe(false);

    pressEscape();
    expect(close).toHaveBeenCalledTimes(1);

    setModal(false);
    flush();
    pressSpace();
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "z", ctrlKey: true }));
    expect(play).toHaveBeenCalledTimes(1);
    expect(undo).toHaveBeenCalledTimes(1);
  });

  it("stops listening when the root unmounts", () => {
    const { controller } = rootWithAnalytics();
    const close = vi.fn();
    const { unmount } = render(() => (
      <ShortcutRoot controller={controller}>
        <Surface handlers={{ "view.close_surface": { run: close } }} />
      </ShortcutRoot>
    ));
    flush();
    pressEscape();
    expect(close).toHaveBeenCalledTimes(1);
    unmount();
    pressEscape();
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("serves a surface rendered with no root from one shared controller", () => {
    const first = vi.fn();
    const second = vi.fn();
    render(() => (
      <>
        <Surface handlers={{ "view.close_surface": { run: first } }} />
        <Surface handlers={{ "view.close_surface": { run: second } }} />
      </>
    ));
    flush();
    pressEscape();
    expect(second).toHaveBeenCalledTimes(1);
    expect(first).not.toHaveBeenCalled();
  });
});
