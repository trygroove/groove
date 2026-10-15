// GENERATED FILE — do not edit.
//
// Emitted by `bun run library:emit-runtime` from the same manifest pipeline
// that produces the delivered pack manifests (`scripts/starter-library/`).
// `CNT-001`: the application resolves the assets it ships with through the
// generated manifest, not through a hand-maintained list of names and paths.
//
// The audio these entries point at is written to `public/` by the same
// command, at the same content-addressed key the bucket serves it from.
//
// Library release: 2026-07-25

import type { FactoryLibraryEntry } from "./factoryLibrary";

export const FACTORY_LIBRARY: readonly FactoryLibraryEntry[] = [
	{
		/** The sampler asset a new project's one track is created with (FND-009). */
		key: "starterKick",
		assetId: "sg-one-shot-drums-kick-0001",
		name: "Rounded Club Kick",
		type: "one-shot",
		role: "kick",
		pack: {
			id: "pak_SdlN_OazweXrwury0j27Y",
			name: "Core Electronic Drums",
			version: "1.1.0",
			publisher: "Groove",
			kind: "factory",
			description: "The role-complete, lightly processed drum foundation the other synthesized packs build on: kicks, snares, claps, rims, closed and open hats, cymbals, toms, and percussion across every featured genre. Contains no bass, tonal, texture, or FX material.",
			rights: {
				licence: "solid-groove-owned",
				rawRedistribution: true,
				attributionRequired: false,
			},
		},
		storageRef: "samples/starter-library/audio/sha256/82/f8/82f89d1d6d88af1effb235349953cc924e593e6eaf4d7728b1c78d97febe5fcf.wav",
		sha256: "82f89d1d6d88af1effb235349953cc924e593e6eaf4d7728b1c78d97febe5fcf",
		durationSeconds: 0.4385,
		sampleRate: 48000,
		channelCount: 1,
		licence: "solid-groove-owned",
	},
	{
		/** The second drum voice, for fixtures and multi-track smoke tests. */
		key: "starterClap",
		assetId: "sg-one-shot-drums-clap-0001",
		name: "Classic House Clap",
		type: "one-shot",
		role: "clap",
		pack: {
			id: "pak_SdlN_OazweXrwury0j27Y",
			name: "Core Electronic Drums",
			version: "1.1.0",
			publisher: "Groove",
			kind: "factory",
			description: "The role-complete, lightly processed drum foundation the other synthesized packs build on: kicks, snares, claps, rims, closed and open hats, cymbals, toms, and percussion across every featured genre. Contains no bass, tonal, texture, or FX material.",
			rights: {
				licence: "solid-groove-owned",
				rawRedistribution: true,
				attributionRequired: false,
			},
		},
		storageRef: "samples/starter-library/audio/sha256/0a/d8/0ad833024c4f732c8c499153510540e4c5038a8b5953f371fc2710c6fcd16c43.wav",
		sha256: "0ad833024c4f732c8c499153510540e4c5038a8b5953f371fc2710c6fcd16c43",
		durationSeconds: 0.3755,
		sampleRate: 48000,
		channelCount: 1,
		licence: "solid-groove-owned",
	},
	{
		/** The snare a new drum machine's SD pad starts with (#447). */
		key: "starterSnare",
		assetId: "sg-one-shot-drums-snare-0001",
		name: "Tight Studio Snare",
		type: "one-shot",
		role: "snare",
		pack: {
			id: "pak_SdlN_OazweXrwury0j27Y",
			name: "Core Electronic Drums",
			version: "1.1.0",
			publisher: "Groove",
			kind: "factory",
			description: "The role-complete, lightly processed drum foundation the other synthesized packs build on: kicks, snares, claps, rims, closed and open hats, cymbals, toms, and percussion across every featured genre. Contains no bass, tonal, texture, or FX material.",
			rights: {
				licence: "solid-groove-owned",
				rawRedistribution: true,
				attributionRequired: false,
			},
		},
		storageRef: "samples/starter-library/audio/sha256/99/8d/998dd23ee721b517d295e530c35f619b0428714a800b6fbd917cb8224c4b5d92.wav",
		sha256: "998dd23ee721b517d295e530c35f619b0428714a800b6fbd917cb8224c4b5d92",
		durationSeconds: 0.137,
		sampleRate: 48000,
		channelCount: 1,
		licence: "solid-groove-owned",
	},
	{
		/** The closed hat a new drum machine's HH pad starts with (#447). */
		key: "starterHat",
		assetId: "sg-one-shot-drums-closed-hat-0001",
		name: "Tight Closed Hat",
		type: "one-shot",
		role: "closed-hat",
		pack: {
			id: "pak_SdlN_OazweXrwury0j27Y",
			name: "Core Electronic Drums",
			version: "1.1.0",
			publisher: "Groove",
			kind: "factory",
			description: "The role-complete, lightly processed drum foundation the other synthesized packs build on: kicks, snares, claps, rims, closed and open hats, cymbals, toms, and percussion across every featured genre. Contains no bass, tonal, texture, or FX material.",
			rights: {
				licence: "solid-groove-owned",
				rawRedistribution: true,
				attributionRequired: false,
			},
		},
		storageRef: "samples/starter-library/audio/sha256/36/e5/36e542c92af2f8eb549fd43de0362064ea2fd1dc4ff96750e664deaba39fc897.wav",
		sha256: "36e542c92af2f8eb549fd43de0362064ea2fd1dc4ff96750e664deaba39fc897",
		durationSeconds: 0.0419,
		sampleRate: 48000,
		channelCount: 1,
		licence: "solid-groove-owned",
	},
	{
		/** An audio loop, so an audio-clip path has real bar-aligned material. */
		key: "starterLoop",
		assetId: "sg-loop-drums-full-loop-0001",
		name: "Four Four Club Groove",
		type: "loop",
		role: "full-loop",
		pack: {
			id: "pak_SdlN_OazweXrwury0j27Y",
			name: "Core Electronic Drums",
			version: "1.1.0",
			publisher: "Groove",
			kind: "factory",
			description: "The role-complete, lightly processed drum foundation the other synthesized packs build on: kicks, snares, claps, rims, closed and open hats, cymbals, toms, and percussion across every featured genre. Contains no bass, tonal, texture, or FX material.",
			rights: {
				licence: "solid-groove-owned",
				rawRedistribution: true,
				attributionRequired: false,
			},
		},
		storageRef: "samples/starter-library/audio/sha256/f1/66/f166266c67fe8384565e5a565e326d7f771a6231b16d7e193ffd71de6d0530f8.wav",
		sha256: "f166266c67fe8384565e5a565e326d7f771a6231b16d7e193ffd71de6d0530f8",
		durationSeconds: 2,
		sampleRate: 48000,
		channelCount: 1,
		licence: "solid-groove-owned",
	},
];
