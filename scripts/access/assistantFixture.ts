/**
 * `bun run assistant:fixture`: turn a production project into a scrubbed eval
 * fixture (GRV-109).
 *
 *   bun run assistant:fixture -- <projectId> [--name <fixture-id>] [--drop-unresolvable]
 *   bun run assistant:fixture -- --turn <turnId> [--name <fixture-id>]
 *
 * Reads the project's three tiers with the admin credential (`adminApp.ts`;
 * the emulators when `FIRESTORE_EMULATOR_HOST` and
 * `FIREBASE_AUTH_EMULATOR_HOST` are set) through the schema-v1 layout, scrubs
 * it (`src/assistant/evals/scrubFixture.ts`), and writes
 * `src/assistant/evals/fixtures/<fixture-id>.json`, which
 * `bun run assistant:try -- new <fixture-id>` and `eval:assistant` load. It
 * never writes to Firestore.
 *
 * `--turn` reads a kept transcript (GRV-98) for its project, and prints how the
 * turn stopped and what became of it; never its message, reply or history.
 *
 * The factory library the scrub keeps sounds from is the bundled starter
 * sounds plus the pack manifests of the packs the project uses, fetched from
 * `VITE_FIREBASE_STORAGE_BUCKET` (else `<project>.firebasestorage.app`), or,
 * against the emulators with no bucket set, read from the local
 * `bun run library:build` output.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import type { Firestore } from "firebase-admin/firestore";
import { EvalUsageError } from "../../src/assistant/evals/cli";
import {
  bundledFactorySounds,
  type FactorySound,
  factoryCatalog,
  manifestFactorySounds,
} from "../../src/assistant/evals/factoryCatalog";
import {
  defaultFixtureName,
  describeTurn,
  FIXTURE_USAGE,
  formatScrubReport,
  parseFixtureArgs,
} from "../../src/assistant/evals/fixtureTool";
import { fixtureNames, jsonFixturesDir } from "../../src/assistant/evals/namedFixtures";
import { scrubFixture } from "../../src/assistant/evals/scrubFixture";
import {
  ASSISTANT_TRANSCRIPTS_COLLECTION,
  type TranscriptRecord,
  transcriptRecordSchema,
} from "../../src/assistant/transcripts";
import type { Project } from "../../src/domain/entities";
import { serializeProject } from "../../src/domain/serialize";
import {
  LIBRARY_ROOT,
  libraryKey,
  libraryUrl,
  PACK_INDEX_KEY,
  packSummaries,
  parsePackIndex,
  parsePackManifest,
} from "../../src/library/manifest";
import {
  arrangementCollectionPath,
  clipsCollectionPath,
  projectDocumentPath,
  songDocumentPath,
} from "../../src/persistence/documents";
import { decodeStoredProject } from "../../src/persistence/migrations";
import { adminServices, fail } from "./adminApp";

async function readProject(db: Firestore, projectId: string): Promise<Project> {
  const metadata = await db.doc(projectDocumentPath(projectId)).get();
  if (!metadata.exists) fail(`No project ${projectId}.`);
  const [song, clips, arrangement] = await Promise.all([
    db.doc(songDocumentPath(projectId)).get(),
    db.collection(clipsCollectionPath(projectId)).get(),
    db.collection(arrangementCollectionPath(projectId)).get(),
  ]);
  const decoded = decodeStoredProject({
    projectId,
    metadata: metadata.data(),
    song: song.exists ? song.data() : undefined,
    clips: clips.docs.map((doc) => doc.data()),
    arrangement: arrangement.docs.map((doc) => doc.data()),
  });
  if (!decoded.ok) {
    fail(
      [
        `Project ${projectId} is not a valid project:`,
        ...decoded.issues
          .slice(0, 10)
          .map((issue) => `  ${issue.path.join(".")}: ${issue.message}`),
      ].join("\n"),
    );
  }
  return decoded.value;
}

async function readTurn(db: Firestore, turnId: string): Promise<TranscriptRecord> {
  const page = await db
    .collection(ASSISTANT_TRANSCRIPTS_COLLECTION)
    .where("turnId", "==", turnId)
    .limit(2)
    .get();
  if (page.empty) fail(`No kept transcript for turn ${turnId}.`);
  if (page.size > 1) fail(`More than one transcript names turn ${turnId}.`);
  const parsed = transcriptRecordSchema.safeParse(page.docs[0]?.data());
  if (!parsed.success)
    fail(`The transcript for turn ${turnId} is not a transcript record.`);
  return parsed.data;
}

/** Reads one library document from the bucket, or from the local build. */
function libraryReader(bucket: string | null): (key: string) => Promise<unknown> {
  if (bucket) {
    return async (key) => {
      const response = await fetch(libraryUrl(key, bucket));
      if (!response.ok) throw new Error(`${response.status} for ${libraryKey(key)}`);
      return response.json();
    };
  }
  return async (key) =>
    JSON.parse(readFileSync(join("public", LIBRARY_ROOT, libraryKey(key)), "utf8"));
}

/** The factory sounds the project's packs deliver, at the versions it pins. */
async function factorySounds(project: Project, bucket: string | null) {
  const sounds: FactorySound[] = bundledFactorySounds();
  const read = libraryReader(bucket);
  const where = bucket ? `gs://${bucket}` : `public/${LIBRARY_ROOT}`;
  let index: ReturnType<typeof packSummaries>;
  try {
    index = packSummaries(parsePackIndex(await read(PACK_INDEX_KEY)));
  } catch (error) {
    console.warn(
      `The library index could not be read from ${where} (${error instanceof Error ? error.message : String(error)}); only the bundled starter sounds resolve.`,
    );
    return sounds;
  }
  const byId = new Map(index.map((pack) => [pack.id, pack]));
  const pinned = [...project.metadata.packDependencies, ...project.metadata.addedPacks];
  const seen = new Set<string>();
  for (const { packId, version } of pinned) {
    const pack = byId.get(packId);
    const key = `${packId}@${version}`;
    if (!pack || pack.kind !== "factory" || seen.has(key)) continue;
    seen.add(key);
    try {
      const manifest = parsePackManifest(
        await read(`packs/${pack.slug}/v${version}.json`),
      );
      sounds.push(...manifestFactorySounds(manifest));
    } catch (error) {
      console.warn(
        `The ${pack.name} ${version} manifest could not be read (${error instanceof Error ? error.message : String(error)}).`,
      );
    }
  }
  return sounds;
}

function libraryBucket(projectId: string, usingEmulators: boolean): string | null {
  const configured = process.env.VITE_FIREBASE_STORAGE_BUCKET?.trim();
  if (configured) return configured;
  return usingEmulators ? null : `${projectId}.firebasestorage.app`;
}

async function main(): Promise<number> {
  if (process.argv.includes("--help") || process.argv.includes("-h")) {
    console.log(FIXTURE_USAGE);
    return 0;
  }
  let args: ReturnType<typeof parseFixtureArgs>;
  try {
    args = parseFixtureArgs(process.argv.slice(2));
  } catch (error) {
    if (error instanceof EvalUsageError) {
      console.error(error.message);
      return 2;
    }
    throw error;
  }

  const dir = jsonFixturesDir();
  const name = args.name ?? defaultFixtureName(fixtureNames(dir));
  const path = join(dir, `${name}.json`);
  if (existsSync(path))
    fail(`There is already a fixture "${name}" (${relative(".", path)}).`);

  const { db } = adminServices();
  const turn = args.turnId ? await readTurn(db, args.turnId) : null;
  const projectId = turn?.projectId ?? (args.projectId as string);
  const project = await readProject(db, projectId);
  if (turn) console.log(describeTurn(turn, project.metadata.revision).join("\n"));

  const usingEmulators = Boolean(
    process.env.FIRESTORE_EMULATOR_HOST && process.env.FIREBASE_AUTH_EMULATOR_HOST,
  );
  const firebaseProject =
    process.env.FIREBASE_PROJECT_ID ?? process.env.GOOGLE_CLOUD_PROJECT ?? "";
  const catalog = factoryCatalog(
    await factorySounds(project, libraryBucket(firebaseProject, usingEmulators)),
  );
  const result = scrubFixture(project, {
    catalog,
    seed: `fixture-${name}`,
    dropUnresolvable: args.dropUnresolvable,
  });
  const shown = { name, path: relative(".", path) };
  if (!result.ok) {
    console.error(formatScrubReport(result, shown));
    return 1;
  }
  mkdirSync(dir, { recursive: true });
  writeFileSync(path, `${JSON.stringify(serializeProject(result.project), null, 2)}\n`);
  // The repository's formatter has the last word on a file meant to be committed.
  spawnSync("bunx", ["biome", "format", "--write", path], { stdio: "ignore" });
  console.log(formatScrubReport(result, shown));
  return 0;
}

process.exitCode = await main();
