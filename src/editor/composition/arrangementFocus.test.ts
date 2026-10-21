import { afterEach, describe, expect, it } from "vitest";
import { arrangementHasFocus } from "./arrangementFocus";

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

describe("arrangementHasFocus (#835)", () => {
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
