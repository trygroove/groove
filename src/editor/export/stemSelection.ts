/**
 * How the dialog writes a size (EXP-003, EXP-004). Which tracks are selected is the track
 * list's state (`trackListSelection`), export UI state that is never saved.
 */

const MiB = 1024 ** 2;
const GiB = 1024 ** 3;

/**
 * A size as the Export dialog writes it: binary MiB / GiB, as the 2 GiB ZIP
 * budget is. Below a GiB it is whole MiB with a floor of "1 MiB", so a tiny or
 * empty export still reads as 1 MiB. From a GiB up it keeps two decimals, so
 * 1.96 GiB never reads as the "2 GiB" limit; only a whole number of GiB, the
 * limit itself, drops them. This is deliberately not `formatStorageSize`
 * (`userData/userData.ts`), whose "KB / MB / GB" labels are the storage meter's.
 */
export function formatExportSize(bytes: number): string {
  if (bytes >= GiB) {
    return `${bytes % GiB === 0 ? bytes / GiB : (bytes / GiB).toFixed(2)} GiB`;
  }
  return `${Math.max(1, Math.round(bytes / MiB))} MiB`;
}
