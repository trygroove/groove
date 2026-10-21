import { afterEach, describe, expect, it } from "vitest";
import { installFocusRescue } from "./focusRescue";

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

describe("focus rescue (#76)", () => {
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
