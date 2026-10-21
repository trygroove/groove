/**
 * The longest name a track, return, or drum pad may have: the `displayName`
 * limit in `src/domain/entities.ts`. The name fields stop there, so a longer
 * name cannot be typed and then silently rejected on commit.
 */
export const MAX_DISPLAY_NAME_LENGTH = 120;
