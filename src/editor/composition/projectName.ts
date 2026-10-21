/**
 * Generates a name for a new project from the words dance and electronic
 * tracks are actually called: "Mood Energy", "Dance Takeover", "Acid Rain".
 *
 * A name is a lead word and a closing word. The leads are the scene's
 * modifiers and settings (house's "Deep", techno's "Warehouse", trance's
 * "Euphoric", trap's "Heavy", SoundCloud's "Lost"); the closers are the nouns
 * those tracks end on (garage's "Riddim", EDM's "Anthem", dubstep's
 * "Pressure", hip hop's "Hustle", the charts' "Fever"). Any lead reads with
 * any closer, so the lists stay independent and easy to extend.
 *
 * The random source is injectable so tests can pin the output.
 */

/** Words that open a name: modifiers, places, times, and scene words. */
export const LEAD_WORDS = [
  // House, disco, and garage.
  "Deep",
  "Soulful",
  "Disco",
  "Groove",
  "Velvet",
  "Golden",
  "Sunset",
  "Summer",
  "Mood",
  "Dance",
  "Garage",
  // Techno and the warehouse.
  "Acid",
  "Warehouse",
  "Concrete",
  "Industrial",
  "Analog",
  "Hypnotic",
  "Midnight",
  "Afterhours",
  "Dark",
  "Minimal",
  // Trance and EDM.
  "Euphoric",
  "Cosmic",
  "Stellar",
  "Solar",
  "Lunar",
  "Electric",
  "Neon",
  "Crystal",
  "Higher",
  "Endless",
  "Infinite",
  "Future",
  // Dubstep, drum and bass, and bass music.
  "Bass",
  "Sub",
  "Heavy",
  "Liquid",
  "Jungle",
  "Rude",
  // Hip hop and trap.
  "Block",
  "Street",
  "Gold",
  "Diamond",
  "Real",
  "Big",
  // Pop charts and the underground.
  "Wild",
  "Lost",
  "Ghost",
  "Phantom",
  "Digital",
  "Hyper",
  "Ultra",
  "Dream",
  "Paradise",
  "Night",
  "Club",
  "Rave",
] as const;

/** Words that close a name: the nouns a track title lands on. */
export const CLOSING_WORDS = [
  // House, disco, and garage.
  "Energy",
  "Takeover",
  "Groove",
  "Fever",
  "Heat",
  "Session",
  "Bounce",
  "Shuffle",
  "Riddim",
  "Vibes",
  // Techno.
  "Pressure",
  "Machine",
  "System",
  "Signal",
  "Circuit",
  "Sequence",
  "Protocol",
  "Ritual",
  "Tool",
  "Pulse",
  // Trance and EDM.
  "Anthem",
  "Euphoria",
  "Horizon",
  "Journey",
  "Gravity",
  "Frequency",
  "Rising",
  "Lights",
  "Skies",
  "Drop",
  // Dubstep and bass music.
  "Dub",
  "Bassline",
  "Tension",
  "Warning",
  "Weight",
  "Wobble",
  // Hip hop and trap.
  "Hustle",
  "Flow",
  "Mode",
  "Season",
  "Chain",
  "Cypher",
  // Pop charts and the underground.
  "Dreams",
  "Nights",
  "Motion",
  "Rush",
  "Theory",
  "Echoes",
  "Wave",
  "Mirage",
  "Fantasy",
  "State",
] as const;

/** A source of uniform numbers in `[0, 1)`, like `Math.random`. */
export type RandomSource = () => number;

function pick<T>(words: readonly T[], random: RandomSource): T {
  return words[Math.floor(random() * words.length)];
}

/** Returns a fresh two-word project name, never the same word twice. */
export function generateProjectName(random: RandomSource = Math.random): string {
  const lead = pick(LEAD_WORDS, random);
  const closers = CLOSING_WORDS.filter((word) => word !== lead);
  return `${lead} ${pick(closers, random)}`;
}
