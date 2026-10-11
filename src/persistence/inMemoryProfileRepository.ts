import type { JsonObject } from "../domain/serialize";
import { type Clock, systemClock } from "../shared/clock";
import type { WriteRecord } from "./inMemoryProjectRepository";
import {
  decodeProfile,
  encodeProfile,
  type ProducerProfile,
  producerProfileSchema,
  profileDocumentPath,
} from "./profileDocuments";
import {
  type ProfileLoadResult,
  type ProfileRepository,
  type ProfileSaveResult,
  profileFailure,
} from "./profileRepository";

/**
 * The in-memory profile store (GRV-25): the encoded document at its real
 * path, run through the same encode/decode as the Firestore store, so the
 * shared contract suite exercises the actual mapping. Like the other
 * in-memory stores it has no notion of identity; the rules that keep one
 * user out of another's profile are proved in the emulator suite.
 */
export class InMemoryProfileRepository implements ProfileRepository {
  private readonly documents = new Map<string, JsonObject>();
  private readonly writeLog: WriteRecord[] = [];
  private readonly clock: Clock;

  constructor(options: { clock?: Clock } = {}) {
    this.clock = options.clock ?? systemClock;
  }

  get writes(): readonly WriteRecord[] {
    return this.writeLog;
  }

  /** Writes a stored document verbatim, bypassing validation (test seeding). */
  writeDocument(path: string, data: JsonObject): void {
    this.documents.set(path, structuredClone(data));
  }

  async loadProfile(uid: string): Promise<ProfileLoadResult> {
    const stored = this.documents.get(profileDocumentPath(uid));
    if (!stored) return { ok: true, profile: null };
    const profile = decodeProfile(structuredClone(stored));
    return profile
      ? { ok: true, profile }
      : profileFailure("unreadable", "The stored profile could not be read");
  }

  async saveProfile(uid: string, profile: ProducerProfile): Promise<ProfileSaveResult> {
    const parsed = producerProfileSchema.safeParse({
      ...profile,
      modifiedAt: this.clock.now(),
    });
    if (!parsed.success) {
      return profileFailure("invalid_profile", parsed.error.message);
    }
    const path = profileDocumentPath(uid);
    this.documents.set(path, encodeProfile(parsed.data));
    this.writeLog.push({ kind: "set", path });
    return { ok: true, profile: parsed.data };
  }
}

export function createInMemoryProfileRepository(
  options: { clock?: Clock } = {},
): InMemoryProfileRepository {
  return new InMemoryProfileRepository(options);
}
