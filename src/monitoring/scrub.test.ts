import { describe, expect, it } from "vitest";
import {
  ALLOWED_TAGS,
  MAX_MESSAGE_LENGTH,
  pathOnly,
  redactText,
  type ScrubbableEvent,
  scrubBreadcrumb,
  scrubFramePath,
  scrubNetworkUrl,
  scrubPostHogEvent,
  scrubRoute,
  scrubSelector,
  scrubSentryEvent,
} from "./scrub";

/**
 * The forbidden content, from PRD `OPS-02` / `OPS-03` / section 10: "no
 * project content, assistant text, user-entered strings, asset URLs, or
 * tokens".
 *
 * Every value here is planted into a hostile payload below and must not
 * survive scrubbing. Deliberately checked against the *serialized* output
 * rather than field by field, so a field a future SDK version starts
 * populating is caught too.
 */
const FORBIDDEN = {
  projectName: "Midnight Drive Demo",
  trackName: "Lead Vocal Take 3",
  clipName: "Chorus Riff",
  sectionName: "Final Chorus",
  assetName: "my-secret-sample.wav",
  assetUrl: "https://storage.googleapis.com/solid-groove/users/u1/kick.wav",
  assistantText: "Make the chorus feel more euphoric with a wide pad",
  searchTerm: "dusty vinyl piano",
  email: "producer@example.com",
  token:
    "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U",
  apiKey: "AIzaSyDOCAbC123dEf456GhI789jKl012MnO345pQ",
} as const;

function expectScrubbed(serialized: string): void {
  for (const [label, value] of Object.entries(FORBIDDEN)) {
    expect(serialized.includes(value), `${label} survived scrubbing: ${value}`).toBe(
      false,
    );
  }
}

describe("redactText", () => {
  it("removes URLs, including the blob and data URLs an audio app creates", () => {
    expect(redactText(`failed to load ${FORBIDDEN.assetUrl}`)).not.toContain(
      "storage.googleapis.com",
    );
    expect(redactText("decode failed for blob:https://app/abc-123")).not.toContain(
      "blob:",
    );
    expect(redactText("data:audio/wav;base64,UklGRiQ")).not.toContain("base64");
  });

  it("removes email addresses", () => {
    expect(redactText(`no account for ${FORBIDDEN.email}`)).not.toContain("@");
  });

  it("removes JWTs and long opaque tokens", () => {
    expect(redactText(`auth failed: ${FORBIDDEN.token}`)).toContain("[token]");
    expect(redactText(`key ${FORBIDDEN.apiKey} rejected`)).not.toContain(
      FORBIDDEN.apiKey,
    );
  });

  it("removes quoted text, which is where user content usually appears", () => {
    expect(redactText(`Clip "${FORBIDDEN.clipName}" not found`)).not.toContain(
      FORBIDDEN.clipName,
    );
    expect(redactText(`Track '${FORBIDDEN.trackName}' is muted`)).not.toContain(
      FORBIDDEN.trackName,
    );
  });

  it("removes filesystem paths", () => {
    expect(redactText("/Users/alex/Music/Projects/midnight-drive.wav")).not.toContain(
      "midnight-drive",
    );
  });

  it("keeps an ordinary diagnostic message readable", () => {
    // The rules must not reduce every message to noise.
    expect(redactText("Cannot read properties of undefined")).toBe(
      "Cannot read properties of undefined",
    );
  });

  it("truncates rather than transmitting an unbounded message", () => {
    const long = "a".repeat(5_000);
    expect(redactText(long).length).toBeLessThanOrEqual(MAX_MESSAGE_LENGTH + 1);
  });

  it("never stringifies an arbitrary object", () => {
    // Its fields are exactly the project state this exists to keep out.
    expect(redactText({ project: FORBIDDEN.projectName })).toBe("[object]");
    expect(redactText(undefined)).toBe("");
  });
});

describe("scrubSelector", () => {
  it("keeps only tag names, dropping accessible names", () => {
    expect(
      scrubSelector(`button.delete[aria-label="Delete ${FORBIDDEN.trackName}"]`),
    ).toBe("button");
  });

  it("keeps a tag chain", () => {
    expect(scrubSelector("div > ul > li.track-row")).toBe("div > ul > li");
  });

  it("returns nothing when there is no tag to keep", () => {
    expect(scrubSelector("#Midnight-Drive")).toBeUndefined();
  });
});

describe("pathOnly and scrubFramePath", () => {
  it("reduces a URL to its path", () => {
    expect(pathOnly("https://app.example.com/projects/prj_abc?token=xyz")).toBe(
      "/projects/prj_abc",
    );
  });

  it("keeps a bundle path but drops its query and fragment", () => {
    // Source-map symbolication needs the path (PRD OPS-03); a query could
    // carry a token.
    expect(scrubFramePath("https://app.example.com/assets/editor-a1b2.js?t=123")).toBe(
      "https://app.example.com/assets/editor-a1b2.js",
    );
  });
});

describe("scrubRoute", () => {
  it("keeps route words we ship and reduces a prefixed ID to :id", () => {
    expect(scrubRoute("/projects/prj_abc123")).toBe("/projects/:id");
    expect(scrubRoute("/projects")).toBe("/projects");
    expect(scrubRoute("/")).toBe("/");
  });

  it("replaces a segment a user could have named", () => {
    // The rule that keeps a project name out of the transaction: no text
    // redaction can see a bare path segment, so the shape is rebuilt instead.
    expect(scrubRoute(`/projects/${FORBIDDEN.projectName}`)).toBe("/projects/:param");
    expect(scrubRoute(`/projects/${FORBIDDEN.projectName}`)).not.toContain("Midnight");
  });

  it("survives percent-encoding rather than being fooled by it", () => {
    expect(scrubRoute("/projects/Midnight%20Drive")).toBe("/projects/:param");
  });

  it("drops a query string and a transaction that is not a route", () => {
    expect(scrubRoute(`/projects?q=${FORBIDDEN.searchTerm}`)).toBe("/projects");
    expect(scrubRoute(FORBIDDEN.assistantText)).not.toContain("euphoric");
    expect(scrubRoute(undefined)).toBeUndefined();
    expect(scrubRoute("")).toBeUndefined();
  });
});

describe("scrubBreadcrumb", () => {
  it("drops console breadcrumbs entirely (ADR 0001)", () => {
    expect(
      scrubBreadcrumb({
        category: "console",
        message: `loaded project ${FORBIDDEN.projectName}`,
        data: { arguments: [FORBIDDEN.assistantText] },
      }),
    ).toBeNull();
  });

  it("keeps only method, status, and route shape for network breadcrumbs", () => {
    const crumb = scrubBreadcrumb({
      category: "fetch",
      message: FORBIDDEN.assetUrl,
      data: {
        url: `${FORBIDDEN.assetUrl}?token=${FORBIDDEN.token}`,
        method: "GET",
        status_code: 404,
      },
    });
    expectScrubbed(JSON.stringify(crumb));
    expect(crumb?.data?.method).toBe("GET");
    expect(crumb?.data?.status_code).toBe(404);
  });

  it("does not transmit an asset name carried inside a request URL", () => {
    // The leak class scrubRoute exists for: the name is a bare path segment,
    // so no text rule can see it, and it survives a plain pathname.
    const crumb = scrubBreadcrumb({
      category: "fetch",
      data: {
        url: `https://firebasestorage.googleapis.com/v0/b/sg/o/users%2Fu1%2F${encodeURIComponent(
          FORBIDDEN.assetName,
        )}?alt=media`,
        method: "GET",
        status_code: 200,
      },
    });
    const serialized = JSON.stringify(crumb);
    expectScrubbed(serialized);
    expect(serialized).not.toContain("secret");
    expect(crumb?.data?.url_path).toBe("/:param/:param/:param/:param/:param");
  });

  it("does not transmit the payload of a data or blob URL", () => {
    // pathOnly is not total for these schemes: the whole payload lands in the
    // pathname. The route shape has to hold for them too.
    expect(
      scrubBreadcrumb({
        category: "xhr",
        data: { url: "data:audio/wav;base64,UklGRiQAAABXQVZF" },
      })?.data?.url_path,
    ).toBe("/:param/:param");
    expect(
      scrubBreadcrumb({
        category: "xhr",
        data: { url: "blob:https://app.example.com/9f0c-uuid" },
      })?.data?.url_path,
    ).not.toContain("app.example.com");
  });

  it("reduces DOM breadcrumbs to a tag name", () => {
    const crumb = scrubBreadcrumb({
      category: "ui.click",
      message: `button.play[title="${FORBIDDEN.clipName}"]`,
    });
    expect(crumb?.message).toBe("button");
  });

  it("reduces navigation breadcrumbs to route shapes", () => {
    const crumb = scrubBreadcrumb({
      category: "navigation",
      data: {
        from: "https://app.example.com/projects?q=dusty vinyl piano",
        to: "https://app.example.com/projects/prj_abc123#token",
      },
    });
    expect(crumb?.data?.from).toBe("/projects");
    expect(crumb?.data?.to).toBe("/projects/:id");
    expect(JSON.stringify(crumb)).not.toContain("dusty");
  });

  it("does not transmit a project name carried in a navigated route", () => {
    const crumb = scrubBreadcrumb({
      category: "navigation",
      data: {
        from: `/projects/${FORBIDDEN.projectName}`,
        to: `/projects/${encodeURIComponent(FORBIDDEN.projectName)}`,
      },
    });
    const serialized = JSON.stringify(crumb);
    expectScrubbed(serialized);
    expect(serialized).not.toContain("Midnight");
    expect(crumb?.data?.to).toBe("/projects/:param");
  });

  it("redacts an unrecognized breadcrumb category", () => {
    // The default branch is what covers breadcrumbs added by later tasks.
    const crumb = scrubBreadcrumb({
      category: "some.future.category",
      message: `assistant said "${FORBIDDEN.assistantText}"`,
      data: { project: FORBIDDEN.projectName },
    });
    expectScrubbed(JSON.stringify(crumb));
    expect(crumb?.data).toBeUndefined();
  });
});

describe("scrubSentryEvent", () => {
  /** A deliberately hostile event: every forbidden shape, in every field. */
  function hostileEvent(): ScrubbableEvent {
    return {
      message: `Failed to save "${FORBIDDEN.projectName}"`,
      transaction: `/projects/${FORBIDDEN.projectName}`,
      request: {
        url: `https://app.example.com/projects?search=${FORBIDDEN.searchTerm}`,
        headers: { Authorization: `Bearer ${FORBIDDEN.token}` },
        cookies: { session: FORBIDDEN.token },
      },
      user: {
        email: FORBIDDEN.email,
        ip_address: "203.0.113.4",
        username: FORBIDDEN.email,
      },
      server_name: "alex-macbook.local",
      extra: {
        project: FORBIDDEN.projectName,
        assistantReply: FORBIDDEN.assistantText,
        apiKey: FORBIDDEN.apiKey,
      },
      contexts: {
        browser: { name: "Firefox", version: "142" },
        // A framework integration attaching application state.
        state: { song: { tracks: [{ name: FORBIDDEN.trackName }] } },
      },
      tags: {
        area: "persistence",
        error_code: "unavailable",
        project_name: FORBIDDEN.projectName,
      },
      exception: {
        values: [
          {
            type: "TypeError",
            value: `Clip '${FORBIDDEN.clipName}' missing from ${FORBIDDEN.assetUrl}`,
            stacktrace: {
              frames: [
                {
                  filename: "https://app.example.com/assets/editor-a1b2.js?token=abc",
                  abs_path: "https://app.example.com/assets/editor-a1b2.js?token=abc",
                  function: "saveClip",
                  lineno: 42,
                  colno: 7,
                  context_line: `const name = "${FORBIDDEN.sectionName}";`,
                  vars: {
                    clipName: FORBIDDEN.clipName,
                    asset: FORBIDDEN.assetName,
                  },
                },
              ],
            },
          },
        ],
      },
      breadcrumbs: [
        {
          category: "console",
          message: `saving ${FORBIDDEN.projectName}`,
          data: { arguments: [FORBIDDEN.assistantText] },
        },
        {
          category: "fetch",
          message: FORBIDDEN.assetUrl,
          data: {
            // The asset name planted *inside* the URL, where no text rule
            // can see it.
            url: `${FORBIDDEN.assetUrl}/${FORBIDDEN.assetName}`,
            method: "PUT",
            status_code: 500,
          },
        },
        {
          category: "navigation",
          data: {
            from: "/projects",
            to: `/projects/${FORBIDDEN.projectName}`,
          },
        },
        {
          category: "ui.input",
          message: `input#search[value="${FORBIDDEN.searchTerm}"]`,
        },
      ],
    };
  }

  it("removes every forbidden value from the whole payload", () => {
    // The acceptance criterion, exercised on the scrubbing function directly
    // so it also covers events and breadcrumbs added by later tasks.
    expectScrubbed(JSON.stringify(scrubSentryEvent(hostileEvent())));
  });

  it("drops request, user, extra, and server name outright", () => {
    const scrubbed = scrubSentryEvent(hostileEvent());
    expect(scrubbed.request).toBeUndefined();
    expect(scrubbed.user).toBeUndefined();
    expect(scrubbed.extra).toBeUndefined();
    expect(scrubbed.server_name).toBeUndefined();
  });

  it("allowlists contexts, dropping application state", () => {
    const scrubbed = scrubSentryEvent(hostileEvent());
    expect(scrubbed.contexts).toHaveProperty("browser");
    expect(scrubbed.contexts).not.toHaveProperty("state");
  });

  it("allowlists tags", () => {
    const scrubbed = scrubSentryEvent(hostileEvent());
    expect(scrubbed.tags).toEqual({
      area: "persistence",
      error_code: "unavailable",
    });
    for (const key of Object.keys(scrubbed.tags ?? {})) {
      expect(ALLOWED_TAGS).toContain(key as (typeof ALLOWED_TAGS)[number]);
    }
  });

  it("keeps the exception type and stack frame location for symbolication", () => {
    // PRD OPS-03 requires readable production stack traces; removing these
    // would defeat the source-map upload entirely.
    const frame = scrubSentryEvent(hostileEvent()).exception?.values?.[0]?.stacktrace
      ?.frames?.[0];
    expect(scrubSentryEvent(hostileEvent()).exception?.values?.[0]?.type).toBe(
      "TypeError",
    );
    expect(frame?.filename).toBe("https://app.example.com/assets/editor-a1b2.js");
    expect(frame?.function).toBe("saveClip");
    expect(frame?.lineno).toBe(42);
  });

  it("drops local variables and source context from frames", () => {
    const frame = scrubSentryEvent(hostileEvent()).exception?.values?.[0]?.stacktrace
      ?.frames?.[0];
    expect(frame?.vars).toBeUndefined();
    expect(frame?.context_line).toBeUndefined();
  });

  it("drops the console breadcrumb and keeps the scrubbed others", () => {
    const scrubbed = scrubSentryEvent(hostileEvent());
    expect(scrubbed.breadcrumbs).toHaveLength(3);
    expect(scrubbed.breadcrumbs?.map((crumb) => crumb.category)).toEqual([
      "fetch",
      "navigation",
      "ui.input",
    ]);
  });

  it("handles an empty event without throwing", () => {
    // beforeSend runs on the reporting path; it must be total.
    expect(() => scrubSentryEvent({})).not.toThrow();
  });

  it("preserves the mechanism that marks a session crashed", () => {
    // Release Health (and therefore the section 11 crash-free session rate)
    // depends on `handled: false` surviving scrubbing.
    const scrubbed = scrubSentryEvent({
      exception: {
        values: [
          {
            type: "Error",
            value: "boom",
            mechanism: { type: "solid_groove_boundary", handled: false },
          },
        ],
      },
    });
    expect(scrubbed.exception?.values?.[0]?.mechanism).toEqual({
      type: "solid_groove_boundary",
      handled: false,
    });
  });
});

describe("scrubPostHogEvent (ADR 0011 decision 3, GRV-120)", () => {
  /**
   * The `$exception` event PostHog builds from a hostile error: every
   * forbidden shape, in every field the SDK fills or could fill.
   */
  function hostileException() {
    return {
      uuid: "0199-event",
      event: "$exception",
      properties: {
        $exception_level: "error",
        area: "persistence",
        error_code: "unavailable",
        $current_url: "https://app.example.com/projects/prj_abc123",
        $exception_list: [
          {
            type: "TypeError",
            value: `Clip '${FORBIDDEN.clipName}' missing from ${FORBIDDEN.assetUrl}`,
            mechanism: {
              type: "generic",
              handled: true,
              synthetic: false,
              exception_id: 0,
              data: { project: FORBIDDEN.projectName },
            },
            module: FORBIDDEN.assetName,
            stacktrace: {
              type: "raw",
              frames: [
                {
                  platform: "web:javascript",
                  filename: "https://app.example.com/assets/editor-a1b2.js?token=abc",
                  abs_path: "https://app.example.com/assets/editor-a1b2.js?token=abc",
                  function: "saveClip",
                  lineno: 42,
                  colno: 7,
                  in_app: true,
                  chunk_id: "chunk-1",
                  context_line: `const name = "${FORBIDDEN.sectionName}";`,
                  vars: { clipName: FORBIDDEN.clipName, asset: FORBIDDEN.assetName },
                },
              ],
            },
          },
          {
            type: "Error",
            value: `caused by "${FORBIDDEN.trackName}" and ${FORBIDDEN.token}`,
          },
        ],
        $exception_steps: [{ $message: `opened ${FORBIDDEN.projectName}` }],
        $exception_message: FORBIDDEN.assistantText,
        $exception_source: FORBIDDEN.searchTerm,
      },
    };
  }

  it("removes every forbidden value from the whole exception event", () => {
    expectScrubbed(JSON.stringify(scrubPostHogEvent(hostileException())));
  });

  it("keeps what symbolication and grouping need", () => {
    const scrubbed = scrubPostHogEvent(hostileException());
    const [first] = scrubbed?.properties.$exception_list as {
      type: string;
      mechanism: Record<string, unknown>;
      stacktrace: { type: string; frames: Record<string, unknown>[] };
    }[];
    expect(first.type).toBe("TypeError");
    expect(first.mechanism).toEqual({
      type: "generic",
      handled: true,
      synthetic: false,
      exception_id: 0,
    });
    expect(first.stacktrace).toEqual({
      type: "raw",
      frames: [
        {
          platform: "web:javascript",
          filename: "https://app.example.com/assets/editor-a1b2.js",
          abs_path: "https://app.example.com/assets/editor-a1b2.js",
          function: "saveClip",
          lineno: 42,
          colno: 7,
          in_app: true,
          chunk_id: "chunk-1",
        },
      ],
    });
  });

  it("keeps the classification the sink sends", () => {
    const scrubbed = scrubPostHogEvent(hostileException());
    expect(scrubbed?.properties).toMatchObject({
      $exception_level: "error",
      area: "persistence",
      error_code: "unavailable",
    });
  });

  it("passes every other event through untouched", () => {
    const pageview = { event: "$pageview", properties: { $pathname: "/projects" } };
    expect(scrubPostHogEvent(pageview)).toBe(pageview);
    expect(scrubPostHogEvent(null)).toBeNull();
  });

  it("handles an exception event with no list", () => {
    expect(scrubPostHogEvent({ event: "$exception", properties: {} })).toEqual({
      event: "$exception",
      properties: { $exception_list: [] },
    });
  });
});

describe("scrubNetworkUrl (GRV-120)", () => {
  it("drops the query string and fragment, where tokens ride", () => {
    expect(
      scrubNetworkUrl(
        "https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=AIzaSy-secret#x",
      ),
    ).toBe("https://identitytoolkit.googleapis.com/v1/accounts:lookup");
    expect(scrubNetworkUrl("https://app.example.com/assets/editor-a1b2.js?v=1")).toBe(
      "https://app.example.com/assets/editor-a1b2.js",
    );
  });

  it("keeps only IDs in a Storage object path", () => {
    expect(
      scrubNetworkUrl(
        "https://firebasestorage.googleapis.com/v0/b/groove.firebasestorage.app/o/users%2FAbCdEfGhIjKlMnOpQrStUvWxYz12%2Fpacks%2Fpak_a1b2c3%2Fast_d4e5f6?alt=media&token=secret",
      ),
    ).toBe(
      "https://firebasestorage.googleapis.com/v0/b/:param/o/:param/AbCdEfGhIjKlMnOpQrStUvWxYz12/:param/pak_a1b2c3/ast_d4e5f6",
    );
  });

  it("never keeps a name in a Storage or Firestore path", () => {
    const urls = [
      `https://firebasestorage.googleapis.com/v0/b/b/o/library%2F${encodeURIComponent(FORBIDDEN.assetName)}?alt=media`,
      `https://storage.googleapis.com/solid-groove/users/u1/${encodeURIComponent(FORBIDDEN.trackName)}.wav`,
      `https://firestore.googleapis.com/v1/projects/p/databases/(default)/documents/${encodeURIComponent(FORBIDDEN.projectName)}`,
    ];
    expectScrubbed(JSON.stringify(urls.map(scrubNetworkUrl)));
  });

  it("keeps a Firestore path's structure and IDs", () => {
    expect(
      scrubNetworkUrl(
        "https://firestore.googleapis.com/google.firestore.v1.Firestore/Listen/channel?database=projects%2Fp&gsessionid=abc",
      ),
    ).toBe(
      "https://firestore.googleapis.com/google.firestore.v1.Firestore/Listen/channel",
    );
    expect(
      scrubNetworkUrl(
        "https://firestore.googleapis.com/v1/projects/groove/databases/(default)/documents/projects/prj_abc123/clips/clp_def456",
      ),
    ).toBe(
      "https://firestore.googleapis.com/v1/projects/:param/databases/(default)/documents/projects/prj_abc123/:param/clp_def456",
    );
  });

  it("keeps only the scheme of a data or blob URL", () => {
    expect(scrubNetworkUrl("data:audio/wav;base64,UklGRiQ")).toBe("data:");
    expect(scrubNetworkUrl("blob:https://app/abc-123")).toBe("blob:");
  });

  it("returns nothing for what it cannot read", () => {
    expect(scrubNetworkUrl("/relative/path")).toBeUndefined();
    expect(scrubNetworkUrl(42)).toBeUndefined();
  });
});
