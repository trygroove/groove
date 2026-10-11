import { doc, type Firestore, getDoc, setDoc } from "firebase/firestore";
import { type Clock, systemClock } from "../shared/clock";
import {
  decodeProfile,
  encodeProfile,
  type ProducerProfile,
  producerProfileSchema,
  profileDocumentPath,
} from "./profileDocuments";
import {
  type ProfileFailure,
  type ProfileLoadResult,
  type ProfileRepository,
  type ProfileSaveResult,
  profileFailure,
} from "./profileRepository";

/**
 * The Firestore profile store (GRV-25): one document at
 * `users/{uid}/profile/current`, read with one `getDoc` and written whole
 * with one `setDoc`, so an offline write is queued and applied when the
 * session reconnects.
 *
 * Like the other Firestore stores, the `Firestore` instance is injected, so
 * the emulator suite runs the identical code through the real security rules.
 */
export class FirestoreProfileRepository implements ProfileRepository {
  private readonly db: Firestore;
  private readonly clock: Clock;

  constructor(db: Firestore, options: { clock?: Clock } = {}) {
    this.db = db;
    this.clock = options.clock ?? systemClock;
  }

  async loadProfile(uid: string): Promise<ProfileLoadResult> {
    try {
      const snapshot = await getDoc(doc(this.db, profileDocumentPath(uid)));
      if (!snapshot.exists()) return { ok: true, profile: null };
      const profile = decodeProfile(snapshot.data());
      return profile
        ? { ok: true, profile }
        : profileFailure("unreadable", "The stored profile could not be read");
    } catch (error) {
      return toFailure(error);
    }
  }

  async saveProfile(uid: string, profile: ProducerProfile): Promise<ProfileSaveResult> {
    const parsed = producerProfileSchema.safeParse({
      ...profile,
      modifiedAt: this.clock.now(),
    });
    if (!parsed.success) {
      return profileFailure("invalid_profile", parsed.error.message);
    }
    try {
      await setDoc(doc(this.db, profileDocumentPath(uid)), encodeProfile(parsed.data));
      return { ok: true, profile: parsed.data };
    } catch (error) {
      return toFailure(error);
    }
  }
}

function toFailure(error: unknown): ProfileFailure {
  const code =
    typeof error === "object" && error !== null && "code" in error
      ? String((error as { code: unknown }).code)
      : undefined;
  if (code === "permission-denied") {
    return profileFailure("not_allowed", "The current user may not access this profile");
  }
  return profileFailure(
    "unavailable",
    error instanceof Error ? error.message : String(error),
  );
}
