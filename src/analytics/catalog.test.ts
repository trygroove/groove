import { describe, expect, it } from "vitest";
// The delivered factory pack set, the source of truth `pack_id` is pinned
// against — see the cross-reference test below.
import { PACKS } from "../../scripts/starter-library/packs.mjs";
import { PROPOSAL_ISSUE_CODES } from "../assistant/proposalIssues";
import { RECOMMENDATION_ISSUE_CODES } from "../assistant/recommendation";
import { PROPOSAL_CAPABILITIES } from "../assistant/tools";
import { CAPABILITY_IDS } from "../browser/capabilities";
import { COMMAND_TYPES } from "../commands/registry";
import { SCALE_IDS } from "../domain/musicalKey";
import type { SaveFailureReason } from "../persistence/projectRepository";
import { SUGGESTION_IDS } from "../projection/projectAnalysisProjection";
import { SHORTCUT_ACTION_IDS as REGISTERED_SHORTCUT_IDS } from "../shortcuts/registry";
import { BUCKET_SCALES, bucketLabels, bucketOf } from "./buckets";
import {
  ANALYTICS_EVENT_NAMES,
  ANALYTICS_EVENTS,
  type AnalyticsEventDefinition,
  type AnalyticsParam,
  ASSISTANT_PROPOSAL_CAPABILITIES,
  ASSISTANT_PROPOSAL_ISSUE_CODES,
  ASSISTANT_RECOMMENDATION_REFUSALS,
  ASSISTANT_SUGGESTION_IDS,
  BROWSER_CAPABILITY_IDS,
  COMMAND_IDS,
  DEVICE_OPERATIONS,
  declaredValues,
  FEATURE_KEYS,
  LIBRARY_PACK_SLUGS,
  PARAM_KINDS,
  SCALE_KEYS,
  SHORTCUT_ACTION_IDS,
  sampleRateKey,
  validateEventPayload,
} from "./catalog";
import { ERROR_CODES } from "./errorCodes";
import { PACK_KINDS, RESERVED_PACK_IDS } from "./packIdentity";

const definitions = Object.entries(ANALYTICS_EVENTS) as [
  string,
  AnalyticsEventDefinition,
][];

function everyParam(): {
  event: string;
  param: string;
  spec: AnalyticsParam;
}[] {
  return definitions.flatMap(([event, definition]) =>
    Object.entries(definition.params).map(([param, spec]) => ({
      event,
      param,
      spec,
    })),
  );
}

describe("event names", () => {
  // PRD OPS-02 event rules.
  it("are snake_case and at most 40 characters", () => {
    for (const name of ANALYTICS_EVENT_NAMES) {
      expect(name).toMatch(/^[a-z][a-z0-9_]*$/);
      expect(name.length).toBeLessThanOrEqual(40);
    }
  });

  it("avoid Google Analytics reserved prefixes", () => {
    for (const name of ANALYTICS_EVENT_NAMES) {
      expect(name.startsWith("firebase_")).toBe(false);
      expect(name.startsWith("google_")).toBe(false);
      expect(name.startsWith("ga_")).toBe(false);
    }
  });

  it("covers every event in the PRD OPS-02 catalog table", () => {
    // Pinned so an event cannot quietly disappear from the contract. Adding a
    // row to the PRD table means adding it here in the same change.
    expect([...ANALYTICS_EVENT_NAMES].sort()).toEqual(
      [
        "access_revoked",
        "account_upgraded",
        "allowlist_approved",
        "anon_session_created",
        "app_opened",
        "arrangement_milestone",
        "arrangement_outline_created",
        "asset_load_failed",
        "assistant_ask_answered",
        "assistant_ask_shown",
        "assistant_message_sent",
        "assistant_proposal_applied",
        "assistant_proposal_first_part_shown",
        "assistant_proposal_part_applied",
        "assistant_proposal_previewed",
        "assistant_proposal_cancelled",
        "assistant_proposal_rejected",
        "assistant_proposal_shown",
        "assistant_proposal_undone",
        "assistant_recommendation_kept",
        "assistant_recommendation_put_back",
        "assistant_recommendation_refused",
        "assistant_recommendation_shown",
        "assistant_recommendation_tried",
        "assistant_reply_rated",
        "assistant_result_edited",
        "assistant_retention_changed",
        "assistant_session_sad",
        "assistant_session_started",
        "assistant_suggestion_clicked",
        "assistant_video_expanded",
        "assistant_video_failed",
        "assistant_video_played",
        "assistant_video_shown",
        "audio_start_failed",
        "audio_underrun",
        "automation_lane_created",
        "browser_capability_missing",
        "clip_edited",
        "crash_reloaded",
        "cue_nudge_answered",
        "cue_nudge_shown",
        "device_added",
        "device_edit_failed",
        "exception",
        "export_completed",
        "export_failed",
        "export_started",
        "feature_first_use",
        "first_edit",
        "instrument_changed",
        "key_changed",
        "landing_cta_click",
        "landing_video_play",
        "library_audition",
        "library_favourite_changed",
        "library_pack_added",
        "library_pack_upgraded",
        "loop_range_set",
        "loop_toggled",
        "memory_forgotten",
        "memory_note_confirmed",
        "memory_note_proposed",
        "memory_note_undone",
        "note_edit_failed",
        "onboarding_completed",
        "onboarding_question_answered",
        "onboarding_skipped",
        "onboarding_started",
        "onboarding_validation",
        "onboarding_validation_chip",
        "placement_duplicated",
        "project_created",
        "project_deleted",
        "project_opened",
        "resources_leaked",
        "save_failed",
        "save_recovered",
        "section_created",
        "shortcut_used",
        "sign_in_blocked",
        "sound_import_failed",
        "sound_imported",
        "track_added",
        "track_reordered",
        "transport_play",
        "undo_refused",
        "undo_used",
        "unsaved_edits_replayed",
        "unsaved_exit_warned",
        "user_pack_created",
        "view_changed",
      ].sort(),
    );
  });
});

describe("parameter declarations", () => {
  it("uses only kinds that cannot carry free text", () => {
    // The structural guarantee behind "No project content, ever": there is no
    // string/text parameter kind, so no parameter can be declared that would
    // accept a project name, an assistant reply, a search term, or a token.
    // This test is what keeps that true for parameters added by later tasks.
    for (const { event, param, spec } of everyParam()) {
      expect(
        PARAM_KINDS,
        `${event}.${param} uses an unrecognized parameter kind`,
      ).toContain(spec.kind);
    }
  });

  it("admits an open value set only for a published pack's slug", () => {
    // `slug` is the one kind whose value set is not compiled in, because a
    // third-party pack is published out of band (LIB-08). Confine it to the
    // pack identifier so it cannot become a general-purpose string escape
    // hatch, and pin the shape it accepts.
    const slugParams = everyParam().filter(({ spec }) => spec.kind === "slug");
    expect(slugParams.map(({ event, param }) => `${event}.${param}`).sort()).toEqual([
      "library_audition.pack_id",
      "library_pack_added.pack_id",
    ]);

    // A published slug passes; free text, a display name, a `pak_` ID, an
    // email, a URL, or a path does not — it is dropped, not sent.
    const validated = validateEventPayload("library_pack_added", {
      pack_id: "midnight-tape-drums",
      pack_kind: "third_party",
    });
    expect(validated.issues).toEqual([]);
    expect(validated.params.pack_id).toBe("midnight-tape-drums");

    for (const rejected of [
      "Midnight Tape Drums",
      "pak_SdlN_OazweXrwury0j27Y",
      "user@example.com",
      "https://packs.example.com/x",
      "a/path/to/a/file.wav",
      "",
    ]) {
      const result = validateEventPayload("library_pack_added", {
        pack_id: rejected,
        pack_kind: "third_party",
      });
      expect(result.params, `accepted "${rejected}"`).not.toHaveProperty("pack_id");
      // Never echoed back, not even in the issue text.
      expect(result.issues.join(" ")).not.toContain(rejected || "\0");
    }
  });

  it("names parameters in snake_case", () => {
    for (const { event, param } of everyParam()) {
      expect(param, `${event}.${param}`).toMatch(/^[a-z][a-z0-9_]*$/);
    }
  });

  it("declares a known bucket scale for every bucket parameter", () => {
    for (const { event, param, spec } of everyParam()) {
      if (spec.kind !== "bucket") continue;
      expect(BUCKET_SCALES, `${event}.${param}`).toHaveProperty(spec.scale);
    }
  });

  it("bounds every count parameter", () => {
    for (const { event, param, spec } of everyParam()) {
      if (spec.kind !== "count") continue;
      expect(spec.max, `${event}.${param}`).toBeGreaterThan(0);
      // Bucketed cardinality: an unbounded count is a re-identification risk
      // and an analytics cardinality problem.
      expect(spec.max, `${event}.${param}`).toBeLessThanOrEqual(1000);
    }
  });
});

describe("no project content (PRD OPS-02 / section 10)", () => {
  // This is the catalog half of the acceptance criterion. The Sentry-payload
  // half lives in src/monitoring/scrub.test.ts, which exercises the scrubbing
  // functions directly.
  const FORBIDDEN_VALUE_SHAPES: readonly { name: string; pattern: RegExp }[] = [
    { name: "a URL", pattern: /[a-z]+:\/\//i },
    { name: "a bare host", pattern: /\b[\w-]+\.(com|net|org|io|app|dev)\b/i },
    { name: "an email address", pattern: /@/ },
    { name: "whitespace (free text rather than a key)", pattern: /\s/ },
    { name: "a file extension", pattern: /\.(wav|mp3|aiff|flac|ogg|json)$/i },
    { name: "a long opaque token", pattern: /^[A-Za-z0-9_-]{32,}$/ },
  ];

  it("declares no value that looks like user content, a URL, or a token", () => {
    for (const { event, param, spec } of everyParam()) {
      for (const value of declaredValues(spec)) {
        for (const { name, pattern } of FORBIDDEN_VALUE_SHAPES) {
          expect(
            pattern.test(value),
            `${event}.${param} declares "${value}", which looks like ${name}`,
          ).toBe(false);
        }
      }
    }
  });

  it("declares no parameter whose name suggests it carries content", () => {
    // A name-level check as well as a kind-level one: it catches a parameter
    // that is *shaped* correctly but conceptually wrong, e.g. an enum of
    // project names.
    const FORBIDDEN_NAME =
      /(^|_)(name|title|label|text|message|query|search|prompt|reply|url|uri|path|file|filename|email|token|secret)($|_)/;
    for (const { event, param } of everyParam()) {
      expect(
        FORBIDDEN_NAME.test(param),
        `${event}.${param} is named as though it carries free text`,
      ).toBe(false);
    }
  });

  it("rejects a value outside a parameter's declared set at runtime", () => {
    // Defense behind the types, for untyped edges.
    const { params, issues } = validateEventPayload("clip_edited", {
      editor: "My Demo Track",
      event_count_bucket: "1_4",
    });
    // Two issues: the value is rejected, and the required parameter is then
    // missing — so the event is dropped rather than sent half-populated.
    expect(issues.join(" ")).toContain("outside its declared set");
    expect(issues.join(" ")).toContain("missing required parameter");
    expect(params).not.toHaveProperty("editor");
  });

  it("never repeats a rejected value in the issue text", () => {
    // An issue string can be logged. It must not become the leak it reports.
    const { issues } = validateEventPayload("clip_edited", {
      editor: "Secret Project Name",
      event_count_bucket: "1_4",
    });
    expect(issues.join(" ")).not.toContain("Secret Project Name");
  });

  it("drops a parameter the event does not declare", () => {
    const { params, issues } = validateEventPayload("app_opened", {
      project_name: "Midnight Drive",
    });
    expect(params).toEqual({});
    expect(issues.join(" ")).toContain("has no parameter");
    expect(issues.join(" ")).not.toContain("Midnight Drive");
  });
});

describe("catalog cross-references", () => {
  it("pins exactly the registered command types as first_edit's command_id", () => {
    // Keeps "analytics ships with the feature" enforced: adding a command
    // without deciding how it appears in analytics fails here.
    expect([...COMMAND_IDS].sort()).toEqual([...COMMAND_TYPES].sort());
  });

  it("pins exactly the detected browser capabilities as browser_capability_missing's capability", () => {
    // A capability probe added without an analytics decision fails here.
    expect([...BROWSER_CAPABILITY_IDS]).toEqual([...CAPABILITY_IDS]);
  });

  it("pins exactly the recommendation's refusal codes as its refused event's reason", () => {
    // A way to refuse a recommendation added without an analytics decision
    // fails here (GRV-23).
    expect([...ASSISTANT_RECOMMENDATION_REFUSALS].sort()).toEqual(
      [...RECOMMENDATION_ISSUE_CODES].sort(),
    );
    expect(
      [
        ...declaredValues(
          ANALYTICS_EVENTS.assistant_recommendation_refused.params.reason,
        ),
      ].sort(),
    ).toEqual([...RECOMMENDATION_ISSUE_CODES].sort());
  });

  it("pins exactly the proposal validator's issue codes as the rejected event's issue_code", () => {
    // A new way to refuse a proposal added without an analytics decision
    // fails here (GRV-98).
    expect([...ASSISTANT_PROPOSAL_ISSUE_CODES]).toEqual([...PROPOSAL_ISSUE_CODES]);
    expect([
      ...declaredValues(ANALYTICS_EVENTS.assistant_proposal_rejected.params.issue_code),
    ]).toEqual([...PROPOSAL_ISSUE_CODES]);
  });

  it("pins exactly the assistant's capability keys as the proposal events' capability", () => {
    // A tool family added to the assistant's tool set without an analytics
    // decision fails here (GRV-4).
    expect([...ASSISTANT_PROPOSAL_CAPABILITIES].sort()).toEqual(
      [...PROPOSAL_CAPABILITIES].sort(),
    );
    for (const event of [
      "assistant_proposal_shown",
      "assistant_proposal_applied",
      "assistant_proposal_cancelled",
      "assistant_proposal_undone",
    ] as const) {
      const params = ANALYTICS_EVENTS[event].params;
      expect([...declaredValues(params.capability)].sort(), event).toEqual(
        [...PROPOSAL_CAPABILITIES].sort(),
      );
      expect(params.command_count_bucket, event).toEqual({
        kind: "bucket",
        scale: "command_count",
        optional: false,
      });
    }
  });

  it("pins exactly the analysis's suggestions as assistant_suggestion_clicked's suggestion_id", () => {
    // A next step added to the analysis without an analytics decision fails
    // here (GRV-26).
    expect([...ASSISTANT_SUGGESTION_IDS].sort()).toEqual([...SUGGESTION_IDS].sort());
    expect(
      [
        ...declaredValues(
          ANALYTICS_EVENTS.assistant_suggestion_clicked.params.suggestion_id,
        ),
      ].sort(),
    ).toEqual([...SUGGESTION_IDS].sort());
  });

  it("pins exactly the registered shortcut actions as shortcut_used's action_id", () => {
    // Same rule for the KEY-01 registry: a mapping added without an
    // analytics decision fails here rather than shipping unmeasured.
    expect([...SHORTCUT_ACTION_IDS].sort()).toEqual([...REGISTERED_SHORTCUT_IDS].sort());
  });

  it("pins exactly the delivered pack slugs as our own published pack list", () => {
    // The "analytics ships with the feature" rule (PRD section 14) still holds
    // for the packs *we* publish: one added to the factory library has to be
    // given an analytics decision here. It no longer closes the `pack_id` value
    // set, because a third-party pack is published out of band and no table
    // compiled into the app can list it (LIB-08) — see the slug-kind tests.
    const deliveredSlugs = PACKS.map((pack: { slug: string }) => pack.slug);
    expect([...LIBRARY_PACK_SLUGS].sort()).toEqual([...deliveredSlugs].sort());
  });

  it("declares pack_id the same way on both library events, so they join", () => {
    for (const event of ["library_audition", "library_pack_added"] as const) {
      const spec = ANALYTICS_EVENTS[event].params.pack_id;
      expect(spec.kind, event).toBe("slug");
      expect([...declaredValues(spec)].sort(), event).toEqual(
        [...RESERVED_PACK_IDS].sort(),
      );
      expect(
        [...declaredValues(ANALYTICS_EVENTS[event].params.pack_kind)].sort(),
        event,
      ).toEqual([...PACK_KINDS].sort());
    }
  });

  it("covers every persistence failure reason with an error code", () => {
    const reasons: SaveFailureReason[] = [
      "revision_conflict",
      "not_found",
      "already_exists",
      "unsupported_schema_version",
      "invalid_document",
      "document_too_large",
      "unavailable",
    ];
    for (const reason of reasons) {
      expect(ERROR_CODES).toContain(reason);
    }
  });

  it("pins key_changed's scales to the domain's scale list", () => {
    expect([...SCALE_KEYS]).toEqual([...SCALE_IDS]);
  });

  it("declares the PRD OPS-02 feature_first_use keys", () => {
    expect([...FEATURE_KEYS].sort()).toEqual(
      [
        "arrangement",
        "arrangement_selection",
        "arrangement_toggle_select",
        "arrangement_extend_select",
        "arrangement_drag_copy",
        "arrangement_create_clip",
        "arrangement_clip_list",
        "arrangement_clip_resize",
        "assistant",
        "assistant_ask",
        "assistant_message",
        "assistant_proposal",
        "assistant_proposal_part",
        "assistant_recommendation",
        "assistant_retention",
        "assistant_video",
        "assistant_rating",
        "audio_loop",
        "automation",
        "crash_reload",
        "device_chain",
        "drum_machine",
        "eq_curve",
        "eq_device",
        "export_stems",
        "export_stems_selection",
        "export_stereo",
        "export_with_missing_sounds",
        "library_browser",
        "limiter_device",
        "mixer",
        "memory",
        "musical_key",
        "note_audition",
        "note_clipboard",
        "onboarding",
        "pack_browser",
        "piano_roll",
        "playhead_seek",
        "sampler",
        "sections",
        "send_return",
        "shortcut_guide",
        "step_clear_row",
        "step_editor",
        "step_euclidean",
        "step_pattern",
        "step_random",
        "swing",
        "drum_pad_rename",
        "synth",
        "track_color",
        "velocity_lane",
        "track_delete",
        "instrument_add_track",
        "landing_v2",
        "library_similar",
        "library_shuffle",
        "library_pack_preview",
        "clip_length",
        "pack_upgrade",
        "log_in",
        "sign_out",
        "library_favourites",
        "library_recently_heard",
        "sequence_add_pad",
        "user_packs",
        "allowlist_admin",
      ].sort(),
    );
  });
});

describe("section 11 measure coverage", () => {
  // PRD section 11: "A measure that no catalogued event can produce is a gap
  // in the catalog." Each measure names the events it is derived from.
  const MEASURES: Record<string, readonly string[]> = {
    "track progression rate": [
      "project_created",
      "arrangement_milestone",
      "transport_play",
      "export_completed",
    ],
    "time to first audible edit": ["project_created", "first_edit"],
    "features reached for first": ["feature_first_use", "app_opened", "project_created"],
    "session frequency": ["app_opened", "project_opened"],
    "loop to three sections": [
      "section_created",
      "arrangement_outline_created",
      "arrangement_milestone",
    ],
    "export rate": ["export_started", "export_completed"],
    "assistant proposal rates": [
      "assistant_proposal_shown",
      "assistant_proposal_applied",
      "assistant_proposal_cancelled",
      "assistant_proposal_undone",
      "assistant_proposal_rejected",
    ],
    "assistant result ownership": [
      "assistant_proposal_applied",
      "assistant_result_edited",
    ],
    "project reopen rate": ["project_opened"],
    reliability: [
      "save_failed",
      "save_recovered",
      "unsaved_exit_warned",
      "unsaved_edits_replayed",
      "asset_load_failed",
      "audio_start_failed",
      "audio_underrun",
      "export_failed",
      "device_edit_failed",
    ],
    // Crash-free session rate comes from Sentry Release Health (ADR 0001),
    // with `exception` available to cross-check it.
    "crash-free sessions": ["exception"],
  };

  it("derives every measure from catalogued events", () => {
    for (const [measure, events] of Object.entries(MEASURES)) {
      for (const event of events) {
        expect(
          ANALYTICS_EVENT_NAMES,
          `the "${measure}" measure needs an event "${event}" the catalog does not declare`,
        ).toContain(event);
      }
    }
  });
});

describe("buckets", () => {
  it("places values in the expected bucket", () => {
    expect(bucketOf("track_count", 0)).toBe("0");
    expect(bucketOf("track_count", 1)).toBe("1_2");
    expect(bucketOf("track_count", 50)).toBe("21_50");
    expect(bucketOf("track_count", 51)).toBe("50_plus");
  });

  it("puts the section 11 two-minute threshold on a bucket edge", () => {
    // The primary measure is "at least ... two minutes of content", so 120s
    // must not fall inside a bucket that also contains shorter projects.
    expect(bucketOf("musical_duration", 119)).toBe("1_2m");
    expect(bucketOf("musical_duration", 120)).toBe("2_5m");
  });

  it("is total for negative and non-finite input", () => {
    // Bucketing runs inside telemetry paths that must never throw.
    expect(bucketOf("elapsed_seconds", -10)).toBe("0_5s");
    expect(bucketOf("elapsed_seconds", Number.NaN)).toBe("0_5s");
    expect(bucketOf("elapsed_ms", Number.POSITIVE_INFINITY)).toBe("60s_plus");
  });

  it("produces only labels the scale declares", () => {
    for (const scale of Object.keys(BUCKET_SCALES) as (keyof typeof BUCKET_SCALES)[]) {
      const labels = bucketLabels(scale) as readonly string[];
      for (const value of [-1, 0, 1, 7, 100, 10_000, 1e9]) {
        expect(labels).toContain(bucketOf(scale, value) as string);
      }
    }
  });

  it("has unique labels within a scale", () => {
    for (const scale of Object.keys(BUCKET_SCALES) as (keyof typeof BUCKET_SCALES)[]) {
      const labels = bucketLabels(scale) as readonly string[];
      expect(new Set(labels).size).toBe(labels.length);
    }
  });
});

describe("sampleRateKey", () => {
  it("maps known rates to their key", () => {
    expect(sampleRateKey(48000)).toBe("48000");
    expect(sampleRateKey(44100)).toBe("44100");
  });

  it("collapses an unusual rate rather than logging it exactly", () => {
    // An exact unusual rate helps identify a machine.
    expect(sampleRateKey(37231)).toBe("other");
  });
});

describe("validateEventPayload", () => {
  it("accepts a well-formed payload", () => {
    const { params, issues } = validateEventPayload("exception", {
      fatal: true,
      area: "audio",
      error_code: "autoplay_blocked",
    });
    expect(issues).toEqual([]);
    expect(params).toEqual({
      fatal: true,
      area: "audio",
      error_code: "autoplay_blocked",
    });
  });

  it("reports a missing required parameter", () => {
    const { issues } = validateEventPayload("exception", { fatal: true });
    expect(issues.join(" ")).toContain("missing required parameter");
  });

  it("clamps a count to its declared maximum", () => {
    const { params } = validateEventPayload("save_failed", {
      error_code: "unavailable",
      retry_count: 9999,
    });
    expect(params.retry_count).toBe(20);
  });

  it("returns an issue rather than throwing for an unregistered event", () => {
    // Only reachable from an untyped edge, but it must fail open: the caller
    // is editing or playback code, which must never see an analytics throw.
    const { params, issues } = validateEventPayload("not_a_real_event" as never, {
      anything: 1,
    });
    expect(params).toEqual({});
    expect(issues.join(" ")).toContain("is not a registered event");
  });

  it("treats an omitted optional parameter as valid", () => {
    const { issues } = validateEventPayload("project_created", {
      source: "blank",
    });
    expect(issues).toEqual([]);
  });

  it("carries the instrument a new track was created with", () => {
    // `track_type` alone reports "instrument" for a sampler, a drum machine,
    // and a synth alike, so the kind the user chose travels beside it (#223).
    const { params, issues } = validateEventPayload("track_added", {
      track_type: "instrument",
      instrument_type: "drum_machine",
    });
    expect(issues).toEqual([]);
    expect(params.instrument_type).toBe("drum_machine");

    // A track with no instrument (an audio track, a return) simply omits it.
    expect(validateEventPayload("track_added", { track_type: "audio" }).issues).toEqual(
      [],
    );
  });
  it("attributes a failed device edit to its operation without naming the chain", () => {
    const { params, issues } = validateEventPayload("device_edit_failed", {
      operation: "add",
      error_code: "internal",
    });
    expect(issues).toEqual([]);
    expect(params).toEqual({ operation: "add", error_code: "internal" });
    // The reliability event carries no chain, track, or project identity at
    // all — the whole declared parameter set is these two.
    expect(Object.keys(ANALYTICS_EVENTS.device_edit_failed.params).sort()).toEqual([
      "error_code",
      "operation",
    ]);
  });

  it("declares one device_edit_failed operation per device command the chain UI sends", () => {
    expect([...DEVICE_OPERATIONS].sort()).toEqual(
      ["add", "bypass", "duplicate", "remove", "reorder", "reset"].sort(),
    );
    for (const operation of DEVICE_OPERATIONS) {
      expect(
        validateEventPayload("device_edit_failed", { operation, error_code: "unknown" })
          .issues,
      ).toEqual([]);
    }
  });
});
