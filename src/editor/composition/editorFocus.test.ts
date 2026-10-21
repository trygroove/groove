import { afterEach, describe, expect, it } from "vitest";
import { arrangementHasFocus, installFocusRescue } from "./editorFocus";

describe("arrangementHasFocus (#835)", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  function mount(html: string): void {
    document.body.innerHTML = html;
  }

  function focus(selector: string): void {
    const element = document.querySelector<HTMLElement>(selector);
    if (!element) throw new Error(`no ${selector}`);
    element.focus();
  }

  it("is the arrangement's while nothing has focus, as after a click on the canvas", () => {
    mount('<div class="arrangement-view"><canvas></canvas></div>');
    expect(arrangementHasFocus()).toBe(true);
  });

  it("is the arrangement's while one of its own controls has focus", () => {
    mount('<div class="arrangement-view"><button id="zoom">Zoom</button></div>');
    focus("#zoom");
    expect(arrangementHasFocus()).toBe(true);
  });

  it("is not while a text field inside the arrangement has focus", () => {
    mount('<div class="arrangement-view"><input id="name" type="text" /></div>');
    focus("#name");
    expect(arrangementHasFocus()).toBe(false);
  });

  it("is not while something outside it has focus, such as a popover's radio", () => {
    mount(
      '<div class="arrangement-view"></div><fieldset><input id="swatch" type="radio" /></fieldset>',
    );
    focus("#swatch");
    expect(arrangementHasFocus()).toBe(false);
  });
});

describe("focus rescue (#76)", () => {
  /** A root holding a home and a view with one button, rescue installed. */
  function setUp() {
    const root = document.createElement("main");
    const home = document.createElement("div");
    home.tabIndex = -1;
    const view = document.createElement("section");
    const button = document.createElement("button");
    view.append(button);
    root.append(home, view);
    document.body.append(root);
    const uninstall = installFocusRescue(root, () => home);
    return { root, home, view, button, uninstall };
  }

  /** Let the observer's microtask, and the task it defers the rescue to, run. */
  const settle = async () => {
    await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
  };

  afterEach(() => {
    document.body.replaceChildren();
  });

  it("puts focus on the home when the focused element leaves the page", async () => {
    const { home, view, button } = setUp();
    button.focus();
    view.remove();
    await settle();
    expect(document.activeElement).toBe(home);
  });

  it("leaves focus alone when something else already took it", async () => {
    const { root, view, button } = setUp();
    const opener = document.createElement("button");
    root.append(opener);
    button.focus();
    // A dialog closing hands focus back to its opener in the same turn.
    view.remove();
    opener.focus();
    await settle();
    expect(document.activeElement).toBe(opener);
  });

  it("lets a component hand focus on itself a microtask later", async () => {
    const { root, view, button } = setUp();
    const name = document.createElement("button");
    root.append(name);
    button.focus();
    view.remove();
    // A rename field gone, its name button takes focus back in a microtask.
    queueMicrotask(() => queueMicrotask(() => name.focus()));
    await settle();
    expect(document.activeElement).toBe(name);
  });

  it("leaves focus on the page when the user put it there", async () => {
    const { home, view, button } = setUp();
    button.focus();
    // A click on something that does not take focus, such as the canvas.
    button.blur();
    await settle();
    view.remove();
    await settle();
    expect(document.activeElement).not.toBe(home);
  });

  it("ignores focus lost outside its root", async () => {
    const { home } = setUp();
    const outside = document.createElement("button");
    document.body.append(outside);
    outside.focus();
    outside.remove();
    await settle();
    expect(document.activeElement).not.toBe(home);
  });

  it("stops watching once uninstalled", async () => {
    const { home, view, button, uninstall } = setUp();
    uninstall();
    button.focus();
    view.remove();
    await settle();
    expect(document.activeElement).not.toBe(home);
  });
});
