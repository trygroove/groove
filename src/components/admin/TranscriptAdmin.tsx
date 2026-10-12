import { For, type JSX, Show } from "@solidjs/web";
import { createSignal, onSettled } from "solid-js";
import {
  exportTranscriptCase,
  transcriptCaseFileName,
} from "../../assistant/evals/transcriptCase";
import type {
  TranscriptOutcomeFilter,
  TranscriptSummary,
} from "../../assistant/transcriptAdmin";
import type {
  TranscriptAdminClient,
  TranscriptListQuery,
} from "../../assistant/transcriptAdminClient";
import type { TranscriptRecord } from "../../assistant/transcripts";
import { getTranscriptAdminClient } from "../../assistantClientProvider";
import DataTable from "../DataTable";
import TapeLoader from "../TapeLoader";
import "./TranscriptAdmin.css";

export interface TranscriptAdminProps {
  /** Overridden in tests; defaults to the app's transcript client. */
  client?: () => Promise<TranscriptAdminClient>;
  /** Overridden in tests; saves a turn's eval case as a file. */
  download?: (fileName: string, contents: string) => void;
}

const dateFormat = new Intl.DateTimeFormat(undefined, {
  dateStyle: "medium",
  timeStyle: "short",
});
const formatTime = (ms: number) => dateFormat.format(new Date(ms));

const OUTCOME_OPTIONS: readonly (readonly [TranscriptOutcomeFilter | "", string])[] = [
  ["", "Any"],
  ["rejected", "Rejected"],
  ["applied", "Applied"],
  ["cancelled", "Cancelled"],
  ["undone", "Undone"],
  ["none", "No outcome"],
];

const TRAFFIC_OPTIONS = [
  ["", "Everyone"],
  ["external", "Producers only"],
  ["internal", "Internal only"],
] as const;

/** A turn's last outcome as the table reads it. */
function outcomeLabel(outcome: TranscriptSummary["outcome"]): string {
  return outcome ? outcome[0].toUpperCase() + outcome.slice(1) : "None";
}

/** Saves `contents` as a file through a temporary link. */
function downloadFile(fileName: string, contents: string): void {
  const url = URL.createObjectURL(new Blob([contents], { type: "application/json" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = fileName;
  link.click();
  // Revoking in the same task can cancel the download (Firefox does), so the
  // URL is released once the click has been handled.
  setTimeout(() => URL.revokeObjectURL(url), 1_000);
}

/**
 * Kept assistant turns, for admins (GRV-98): the newest turns, narrowed by
 * account, project, outcome and traffic, and one opened beside them with the
 * message, the reply, every tool call with its input, the outcomes and a
 * rejection's issues side by side. Reads go through the
 * `assistantTranscriptsAdmin` callable; the page logs nothing about them.
 * A turn downloads as an eval case for `bun run eval:assistant --
 * --from-transcript`.
 */
export default function TranscriptAdmin(props: TranscriptAdminProps): JSX.Element {
  const client = props.client ?? getTranscriptAdminClient;
  const download = props.download ?? downloadFile;

  const [uid, setUid] = createSignal("");
  const [projectId, setProjectId] = createSignal("");
  const [outcome, setOutcome] = createSignal<TranscriptOutcomeFilter | "">("");
  const [traffic, setTraffic] = createSignal<"" | "external" | "internal">("");
  const [loading, setLoading] = createSignal(true);
  const [loadError, setLoadError] = createSignal(false);
  const [turns, setTurns] = createSignal<readonly TranscriptSummary[]>([]);
  const [open, setOpen] = createSignal<TranscriptRecord | null>(null);
  const [openError, setOpenError] = createSignal<string | null>(null);

  const query = (): TranscriptListQuery => ({
    uid: uid().trim() || undefined,
    projectId: projectId().trim() || undefined,
    outcome: outcome() || undefined,
    internal: traffic() === "" ? undefined : traffic() === "internal",
  });

  const load = () => {
    setLoading(true);
    setLoadError(false);
    client()
      .then((transcripts) => transcripts.list(query()))
      .then((listed) => setTurns(listed))
      .catch((error: unknown) => {
        console.error("Error loading assistant transcripts:", error);
        setLoadError(true);
      })
      .finally(() => setLoading(false));
  };

  onSettled(() => load());

  const openTurn = async (summary: TranscriptSummary) => {
    setOpenError(null);
    try {
      const turn = await (await client()).get(summary.uid, summary.turnId);
      setOpen(turn);
      if (!turn) setOpenError("That turn is gone: it expired or was deleted.");
    } catch (error) {
      console.error("Error opening an assistant transcript:", error);
      setOpen(null);
      setOpenError("Couldn't open that turn. Try again.");
    }
  };

  const onSubmit = (event: SubmitEvent) => {
    event.preventDefault();
    load();
  };

  return (
    <section
      class="allowlist-section transcripts-admin"
      aria-labelledby="transcripts-heading"
    >
      <h2 id="transcripts-heading" class="allowlist-section-title">
        Assistant transcripts
      </h2>
      <form class="transcripts-filters" aria-label="Filter turns" onSubmit={onSubmit}>
        <label>
          <span class="allowlist-label">Account</span>
          <input
            class="transcripts-input"
            value={uid()}
            placeholder="uid"
            onInput={(event) => setUid(event.currentTarget.value)}
          />
        </label>
        <label>
          <span class="allowlist-label">Project</span>
          <input
            class="transcripts-input"
            value={projectId()}
            placeholder="prj_…"
            onInput={(event) => setProjectId(event.currentTarget.value)}
          />
        </label>
        <label>
          <span class="allowlist-label">Outcome</span>
          <select
            class="transcripts-input"
            value={outcome()}
            onChange={(event) =>
              setOutcome(event.currentTarget.value as TranscriptOutcomeFilter | "")
            }
          >
            <For each={OUTCOME_OPTIONS}>
              {(option) => <option value={option[0]}>{option[1]}</option>}
            </For>
          </select>
        </label>
        <label>
          <span class="allowlist-label">Traffic</span>
          <select
            class="transcripts-input"
            value={traffic()}
            onChange={(event) =>
              setTraffic(event.currentTarget.value as "" | "external" | "internal")
            }
          >
            <For each={TRAFFIC_OPTIONS}>
              {(option) => <option value={option[0]}>{option[1]}</option>}
            </For>
          </select>
        </label>
        <button type="submit" class="allowlist-primary" disabled={loading()}>
          Show
        </button>
      </form>

      <Show when={!loading()} fallback={<TapeLoader label="Loading transcripts" />}>
        <Show
          when={!loadError()}
          fallback={
            <div class="allowlist-error" role="alert">
              <p>Couldn't load the transcripts.</p>
              <button type="button" onClick={load}>
                Try again
              </button>
            </div>
          }
        >
          <Show
            when={turns().length > 0}
            fallback={<p class="allowlist-empty">No kept turns match.</p>}
          >
            <DataTable
              label="Turns"
              class="allowlist-table transcripts-table"
              columns={[
                { label: "When", width: "210px" },
                { label: "Message" },
                { label: "Outcome", width: "110px" },
                { label: "Issues", width: "170px" },
                { label: "Open", width: "84px", hideLabel: true },
              ]}
            >
              <For each={turns()} keyed={(turn) => `${turn.uid}_${turn.turnId}`}>
                {(turn) => (
                  <tr
                    class={{
                      "transcripts-row-open":
                        open()?.uid === turn().uid && open()?.turnId === turn().turnId,
                    }}
                  >
                    <td>{formatTime(turn().createdAt)}</td>
                    <td class="allowlist-email">
                      <Show when={turn().internal}>
                        <span class="transcripts-tag">Internal</span>{" "}
                      </Show>
                      {turn().message}
                    </td>
                    <td>{outcomeLabel(turn().outcome)}</td>
                    <td class="allowlist-email">{turn().issueCodes.join(", ")}</td>
                    <td>
                      <button
                        type="button"
                        aria-label={`Open the turn from ${formatTime(turn().createdAt)}`}
                        onClick={() => void openTurn(turn())}
                      >
                        Open
                      </button>
                    </td>
                  </tr>
                )}
              </For>
            </DataTable>
          </Show>
        </Show>
      </Show>

      <Show when={openError()}>
        <p class="allowlist-error" role="alert">
          {openError()}
        </p>
      </Show>
      <Show when={open()}>
        {(turn) => (
          <TurnDetail
            turn={turn()}
            onDownload={() =>
              download(
                transcriptCaseFileName(turn().turnId),
                `${JSON.stringify(exportTranscriptCase(turn()), null, 2)}\n`,
              )
            }
          />
        )}
      </Show>
    </section>
  );
}

/** One turn in full: what was said on the left, what was proposed and what became of it on the right. */
function TurnDetail(props: {
  readonly turn: TranscriptRecord;
  readonly onDownload: () => void;
}): JSX.Element {
  const calls = () => props.turn.proposal?.calls ?? [];
  return (
    <article class="transcripts-detail" aria-label="Turn">
      <header class="transcripts-detail-head">
        <dl class="transcripts-meta">
          <dt>Account</dt>
          <dd>{props.turn.uid}</dd>
          <dt>Project</dt>
          <dd>
            {props.turn.projectId} at revision {props.turn.projectRevision}
          </dd>
          <dt>Model</dt>
          <dd>
            {props.turn.model}, prompt {props.turn.promptVersion}
            {props.turn.proposal
              ? `, tool set ${props.turn.proposal.toolsetVersion}`
              : ""}
          </dd>
          <dt>Stopped</dt>
          <dd>{props.turn.stopReason}</dd>
        </dl>
        <button type="button" onClick={() => props.onDownload()}>
          Download eval case
        </button>
      </header>
      <div class="transcripts-columns">
        <div class="transcripts-column">
          <h3 class="transcripts-heading">Message</h3>
          <p class="transcripts-text">{props.turn.userMessage}</p>
          <h3 class="transcripts-heading">Reply</h3>
          <p class="transcripts-text">{props.turn.reply}</p>
        </div>
        <div class="transcripts-column">
          <h3 class="transcripts-heading">Outcome</h3>
          <Show
            when={props.turn.outcomes.length > 0}
            fallback={<p class="allowlist-empty">Nothing became of it yet.</p>}
          >
            <ol class="transcripts-outcomes">
              <For each={props.turn.outcomes}>
                {(entry) => (
                  <li>
                    <b>{outcomeLabel(entry.outcome)}</b> at {formatTime(entry.at)}
                    <Show when={entry.issues}>
                      {(issues) => (
                        <ul class="transcripts-issues" aria-label="Issues">
                          <For each={issues()}>
                            {(issue) => (
                              <li>
                                <code>{issue.code}</code>
                                {issue.callName
                                  ? ` in ${issue.callName} (${issue.callId ?? "no id"})`
                                  : ""}
                                <Show when={issue.path}>
                                  <div class="transcripts-mono">{issue.path}</div>
                                </Show>
                                <Show when={issue.message}>
                                  <div class="transcripts-mono">{issue.message}</div>
                                </Show>
                              </li>
                            )}
                          </For>
                        </ul>
                      )}
                    </Show>
                  </li>
                )}
              </For>
            </ol>
          </Show>
          <h3 class="transcripts-heading">Tool calls ({calls().length})</h3>
          <Show
            when={calls().length > 0}
            fallback={<p class="allowlist-empty">No proposal.</p>}
          >
            <For each={calls()}>
              {(call) => (
                <details class="transcripts-call">
                  <summary>
                    <code>{call.name}</code> {call.id}
                  </summary>
                  <pre class="transcripts-mono">
                    {JSON.stringify(call.input, null, 2)}
                  </pre>
                </details>
              )}
            </For>
          </Show>
        </div>
      </div>
    </article>
  );
}
