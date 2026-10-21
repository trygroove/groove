# Groove Sample Library Plan

| Field | Value |
| --- | --- |
| Status | Draft for implementation |
| Scope | Private-alpha factory packs |
| Licensing posture | CC0-first; explicit raw-redistribution rights required |
| Primary outcome | A coherent, editable electronic-music palette that supports fast loop creation and complete tracks |

Related document: [Product principles](./prd.md)

## 1. Purpose

Groove needs a sample library that is useful immediately, broad enough to support its initial genres, small enough to curate properly, and legally safe to expose through a sampler, stem export, and Ableton Live export.

The library is not a large undifferentiated download catalogue. It is an opinionated factory collection whose assets work together, cover the roles needed to build complete electronic tracks, and give the assistant reliable material for creating editable ideas.

It is delivered as **packs** (PRD `LIB-04`): named, versioned, independently deliverable collections such as "Techno Drums" or "Orchestral Sounds". A pack is the unit a user browses, a project depends on, and this plan curates. Everything below — rights, intake, taxonomy, targets, and delivery — applies within and across packs; section 5.1 defines the model and section 6.5 lists the starter packs.

This plan defines:

- Which rights are required to bundle an asset.
- Initial sources and how they must be audited.
- The pack model, and the library taxonomy, metadata, and technical standards.
- Content targets for featured and supporting genres.
- The relationship among raw samples, kits, presets, and clips.
- The intake, curation, quality, delivery, and expansion process.

This is a content-acquisition and implementation plan, not legal advice. Any ambiguous source or high-risk content requires qualified legal review or direct written permission from its rights holder.

## 2. Library principles

1. **Rights before sound.** An excellent sample without raw-redistribution rights does not enter the factory library.
2. **Curated beats comprehensive.** Every asset must fill a musical role, add a distinct character, or support a genre requirement.
3. **Genre-aware, never genre-locked.** Genre tags improve discovery and generation but do not restrict where an asset can be used.
4. **Everything remains editable.** Starters use normal samples, clips, devices, MIDI events, and automation rather than hidden backing tracks.
5. **Support complete tracks.** Include transitions, textures, ambience, fills, and contrasting sounds, not only loop-friendly drums.
6. **Leave room for accidents.** At least 15% of the collection should be strange, abrasive, organic, or difficult to categorize.
7. **Prefer foundations over recognizable phrases.** Strong one-shots, multisamples, short textures, and modular loops create more user ownership than distinctive premade melodies.
8. **Consistent technical quality, varied sonic quality.** Files should be cleanly prepared without making every sound polished, loud, bright, or conventional.
9. **Provenance is product data.** Source, authorship, licence evidence, transformations, and checksums travel with every asset.
10. **No URL identity.** Stable asset IDs survive CDN, storage, format, and source-location changes.
11. **Packs organize; tags discover.** A pack is a curated set with one rights position, one publisher, and a stated purpose — never a folder that exists to hold leftovers. Genre, role, and character tags cut across packs and stay many-to-many, so a pack theme never becomes a restriction (principle 3).

## 3. Licensing policy

### 3.1 Why royalty-free is insufficient

Most commercial and free sample-pack licences let a producer incorporate samples into finished music but prohibit redistribution of the raw files. Groove exposes individual sounds in a browser, lets users load them into samplers, and copies or renders content during stem and Ableton export. That use resembles a sample library or DAW factory-content distribution, not merely use in a composition.

For example:

- [99Sounds](https://99sounds.org/license/) permits commercial creative work but prohibits selling or redistributing its audio files, including free redistribution.
- [Splice](https://splice.com/terms) prohibits sublicensing or redistributing isolated sounds and prohibits competitive sample-library use.
- [MusicRadar SampleRadar](https://www.musicradar.com/news/sampleradar-digital-vs-analogue-samples) allows use in music but asks users not to redistribute the samples.

None of those standard licences permits bundling in Groove. They may be revisited only through a separate OEM, partnership, or direct-licensing agreement.

A royalty-free licence is not rejected for being royalty-free. It is rejected because of what it forbids, so a royalty-free pack whose licence text explicitly permits redistributing the raw samples is acceptable (section 3.2).

### 3.2 Accepted rights for the alpha

An asset may be bundled only when one of these applies:

- It is released under CC0 1.0 by a credible rights holder with recorded provenance.
- Groove created it entirely from sources it owns or that independently satisfy this policy.
- It is released under a royalty-free licence whose own text explicitly permits redistributing the raw sample files (for example, inclusion in software, sample libraries, or products that pass the sounds on to their users), requires no attribution, and is granted by the person who made the recordings. The exact granting sentence is quoted in the pack's licence evidence, and the licence identifier is `royalty-free-redistributable`. A licence that permits "use in your music" but is silent on redistribution does not qualify.
- **Private alpha only.** The product owner may admit content whose rights grant is informal or unconfirmed while Groove is a free, invite-only alpha. The licence identifier is `private-alpha`. It goes in its own pack, its evidence records what is known about the source and quotes whatever permission exists, and it is approved only while `release.config.mjs` says the stage is `private-alpha` and `FOR_PROFIT` is `false`. Changing either value makes `library:build` reject these packs, so leaving the alpha forces them to be replaced, cleared, or removed (CNT-003).
- A commissioned creator signed an agreement explicitly allowing commercial raw-sample redistribution inside a DAW, user audition and manipulation, project collaboration, WAV/stem export, native-project export, caching, format conversion, and derivative processing.
- A third-party owner granted Groove equivalent written OEM rights.

The alpha factory library will not bundle CC-BY, CC-BY-SA, CC-BY-NC, CC-ND, GPL-licensed audio, or assets with custom attribution terms. Some may legally be usable, but they add user-facing attribution, share-alike, DRM, export, or interpretation obligations that are unnecessary while suitable CC0 material exists.

**`DEC-003` is decided** (recorded in PRD section 16). The alpha bundles CC0 1.0 and Solid-Groove-owned content only, and commissions nothing — the commissioning budget is zero and premium or commissioned sources are deferred to a later milestone. Because CC0 carries no attribution obligation, there is no user-facing attribution and no per-asset export exclusion: every bundled asset is safe in stems and Ableton packages, and the export-exclusion machinery exists for future OEM content, not the alpha. Sourcing runs three routes in priority order — synthesis (section 15.1), trusted bulk CC0 archives (section 15.8: VCSL, Producer Space, FreePats CC0 banks), and the Freesound API filtered to CC0 against named coverage gaps (section 15.10) — and the alpha library is expected to be usable but not yet rounded, which is an accepted state for a prototype. This unblocks `CNT-002` on licensing; the specific shipped pack list remains `DEC-010`.

**`DEC-010` widened this on 2026-09-29.** The product owner accepted royalty-free packs whose licence explicitly permits raw redistribution (the new section 3.2 route, identifier `royalty-free-redistributable`), and recordings of commercial drum machines and synthesizers made by the licensor (section 3.3). This was so classic drum-machine kits such as the TR-909 can ship. Such packs carry their own pack and rights position, never the CC0 one.

### 3.3 Additional rights checks

CC0 or a permissive copyright licence does not automatically resolve every right. Intake must also consider:

- Performer consent and personality/publicity rights for vocals, speech, and identifiable people.
- Composition rights for recognizable melodies, lyrics, performances, and arrangements.
- Trademark and passing-off concerns in names, artwork, and marketing.
- Whether the uploader actually created the recording or sampled another pack, record, film, or game. A recording the licensor made of hardware they played — a drum machine, synthesizer, or other commercial instrument — is acceptable. Re-hosted recordings are not, unless the original recordist's grant is in the evidence.
- Contractual restrictions inherited from software instruments, presets, source libraries, or recording locations.
- Content-ID disputes and whether the sound is already widely registered inside released tracks.
- Privacy and sensitive-context concerns in field recordings.

Vocal phrases and recognizable performances are excluded from the first intake unless provenance includes a suitable performer release. Historical recordings require collection-level rights review even when a source calls them public domain or free to remix.

### 3.4 Licence evidence

Every accepted asset needs an immutable evidence record containing:

- Source page and direct download URL.
- Source creator, uploader, and original filename.
- Licence identifier and canonical licence URL.
- A saved copy or timestamped capture of the applicable licence statement.
- Retrieval date and SHA-256 of the original download.
- Pack/archive checksum where applicable.
- Any direct permission or commissioned-content agreement ID.
- Known source tools or recordings when supplied.
- Modifications made by Groove.
- Reviewer, review date, and approval status.

If the evidence disappears later, the archived record must still establish what was granted at acquisition time. A takedown process must be able to disable an asset for new projects without breaking existing project documents.

### 3.5 Existing prototype assets

The current `public/samples/house/drums/bd/909-bd.wav` and `909-oh.wav` files are prototype inputs, not approved factory content. The repository contains no recorded source, creator, licence, or checksum evidence for them.

They must remain outside the approved manifest and be replaced with internally synthesized or reviewed CC0 equivalents unless their complete provenance and raw-redistribution rights are established. Existing filenames must not be treated as proof that a recording is free to redistribute, and cleared replacements should use descriptive user-facing names rather than third-party product branding.

## 4. Initial source shortlist

### 4.1 Tier 1: clear bundling candidates

| Source | What to use | Licence position | Intake notes |
| --- | --- | --- | --- |
| [Producer Space](https://producerspace.com/) | Electronic one-shots, percussion, house material, MIDI, selected non-vocal loops | The [official clearance](https://producerspace.com/license) places the entire library under CC0 and expressly grants reproduction, modification, and distribution rights | Audit pack authorship and avoid vocals until performer provenance is documented |
| [FreePats](https://freepats.zenvoid.org/) | Electronic percussion, synth bass multisamples, pads, leads, tuned percussion, selected acoustic instruments | Licences are stated per bank; use CC0 banks only | Begin with [electronic percussion](https://freepats.zenvoid.org/Percussion/electric-percussion.html), [synth bass](https://freepats.zenvoid.org/Synthesizer/synth-bass.html), and [synth pads](https://freepats.zenvoid.org/Synthesizer/synth-pad.html) |
| [Versilian Community Sample Library](https://versilian-studios.com/vcsl/) | Experimental instruments, organic percussion, mallets, unusual resonances, textures, and multisamples | CC0; the publisher explicitly permits commercial software, DAWs, granular synths, and samplers | Select a small electronic-production subset rather than ingesting the full multi-gigabyte library |
| Internally synthesized and recorded content | Core drum hits, noise, sub tones, oscillator cycles, risers, impacts, and processing-derived textures | Owned by Groove when created without restricted source presets or samples | Highest-priority route for a coherent core kit and reliable genre coverage |

### 4.2 Tier 2: useful after asset-level audit

| Source | What to use | Licence position | Intake notes |
| --- | --- | --- | --- |
| [Signature Sounds](https://signaturesounds.org/) | 808-style basses, organic percussion, ambience, drones, textures, impacts, bells, and unusual field recordings | The site states its packs include CC0 licence files | Verify the licence file, creator, and provenance inside every selected pack; do not treat a site-wide claim as the only evidence |
| [Freesound](https://freesound.org/) | Targeted gap-filling: foley, field recordings, noise, mechanical sounds, percussion, ambience, and some loops | Use sounds marked CC0 only; the catalogue also contains CC-BY and CC-BY-NC | Record sound ID/uploader/licence, manually assess provenance, avoid recognizable media, and do not bulk-import search results blindly |
| [Kenney audio assets](https://www.kenney.nl/assets) | Interface sounds, impacts, short effects, and raw sound-design material | Kenney states its asset-page downloads are CC0 | Useful mainly for application and transition effects rather than core musical identity |
| [OpenGameArt](https://opengameart.org/) | Selected CC0 impacts, percussion, ambience, and experimental audio | Licence varies per download; use CC0 only | Downloaded assets and previews may differ; archive and review the actual download rather than preview audio |
| [Freesound Loop Dataset](https://zenodo.org/records/3967852) | Discovery and metadata for tempo/key-labelled loops | Individual audio files have separate Creative Commons licences recorded in metadata | Filter to CC0, then apply the same uploader/provenance and musical-quality review as direct Freesound intake |

### 4.3 Partnership candidates

These sources have musically relevant catalogues but their standard licences do not permit factory-library redistribution:

- 99Sounds, particularly electronic loops, dub material, glitch, percussion, transitions, and textures.
- Independent pack makers such as Samples From Mars, Goldbaby, and specialist genre sound designers.
- Labels currently distributed through Splice or other marketplaces, contacted directly rather than licensed through a consumer account.

Any outreach should request a written quote for a perpetual, worldwide, non-exclusive OEM licence covering browser delivery, individual audition, sampler use, user projects, collaboration, stems, project export, CDN caching, and continued use in existing projects after the agreement ends.

## 5. Logical library structure

### 5.1 Packs

The library is divided into packs. A pack is a named, versioned collection of assets that belong together — by genre ("Techno Drums", "Dubstep Bass"), by instrument family ("Orchestral Sounds"), or by role ("Core Electronic Drums") — and it is what a user chooses when they sit down to work: a producer starting a dubstep track picks a dubstep pack instead of filtering an undifferentiated catalogue.

A pack record carries:

| Field | Meaning |
| --- | --- |
| ID | Stable, opaque, and permanent. Never derived from the name. |
| Name and description | User-facing. The description states what the pack is for and what it does not contain. |
| Version | Immutable once published. Changed audio or changed metadata is a new version. |
| Publisher | Groove for factory packs; later a user or a third party. |
| Kind | `factory`, `user`, or `third-party`. |
| Rights position | One licence and redistribution posture covering every asset in the pack (section 3). |
| Coverage claim | The roles, genres, and tempo range the pack claims to serve, and the intensity range it covers. |
| Asset list | The assets it contains, each with its section 9 metadata record. |

Rules that follow from the model:

- **One pack per asset.** An asset belongs to exactly one pack. Reuse across genres is a tagging question, not a membership question, so an asset is never duplicated into a second pack merely to make it findable there.
- **Pack-qualified identity.** An asset is identified by its ID together with its owning pack, so two packs can each hold a "Rounded Kick 01" without a collision and without either being renamed.
- **One rights position per pack.** Every asset in a pack shares its licence and redistribution terms. An asset whose rights differ belongs in a different pack — this is what makes a takedown, an export policy, or a licence question answerable at pack level rather than per file.
- **A pack is self-contained.** It must be usable on its own for its stated purpose. A genre pack that cannot build a basic loop in its own genre is not finished.
- **Packs never restrict.** Membership is organization. Any asset from any available pack loads onto any track, instrument, or pad, and clearing a pack filter reveals everything (PRD `LIB-02`).
- **Versions are pinned by projects, and move only as an explicit, undoable step.** A project records the packs and versions it uses, so republishing a pack cannot change music someone has already made (section 12). Inserting a sound from a newer version of a pack the project already uses moves the project's pin to that version in the same transaction, so one undo takes back both (#892). When every sound the project uses from the pack is still in the newer version (same content-addressed audio), the upgrade happens without asking; when some would go missing, the library's footer says how many and offers **Upgrade anyway** or **Cancel**. Sounds that go missing are reported as missing, never deleted or substituted.

The taxonomy below describes the structure **within** a pack. A pack does not have to cover the whole tree — most will not — but every role it claims in its coverage claim must be genuinely present.

### 5.2 Taxonomy

The user-facing library is metadata-driven. Storage paths may be optimized independently and must not define taxonomy or identity.

```text
library
  one-shots
    drums
      kick
      snare
      clap
      rim
      closed-hat
      open-hat
      cymbal
      tom
      percussion
    bass
      sub
      sustained
      stab
      reese
    tonal
      chord
      stab
      pluck
      key
      mallet
      bell
    texture
      noise
      ambience
      drone
      mechanical
      organic
    fx
      impact
      riser
      downer
      sweep
      reverse
      glitch
  loops
    drums
    tops
    percussion
    bass
    melodic
    harmonic
    texture
    transition
  instruments
    multisamples
    drum-kits
    synth-presets
  processing
    device-presets
    chains
```

### Asset types

- **One-shot:** A single triggerable sound with optional pitch/root information.
- **Audio loop:** Bar-aligned audio with verified BPM, bar count, and seamless boundaries.
- **Multisample zone:** One recording within a playable sampled instrument.
- **Instrument definition:** Mapping from samples to pitches, velocities, envelopes, and defaults.
- **Drum kit:** A stable mapping from pad roles to one-shot asset IDs and pad parameters.
- **Device preset:** Parameter values for one processing device; contains no third-party audio unless separately licensed.
- **Processing chain:** Ordered factory devices with parameters, gain staging, and intended role.

## 6. Alpha size and coverage targets

### 6.1 Delivery milestones

| Milestone | Unique one-shots | Audio loops | Drum kits | Sampled instruments | Processing presets/chains | Purpose |
| --- | ---: | ---: | ---: | ---: | ---: | --- |
| Bootstrap | 80 | 12 | 4 | 2 | 12 | Replace the current two-sample prototype and exercise metadata/browser/audio paths |
| Production seed | 250 | 60 | 12 | 8 | 36 | Build all editors, generators, export, caching, and curation workflows |
| Private alpha | 600 | 360 | 24 | 30 | 72 | Rounded factory library covering every required genre |

Counts are minimums, not acquisition quotas. Duplicates, low-quality alternates, near-identical processing variations, and legally ambiguous files do not count.

### 6.2 Private-alpha one-shot allocation

| Role | Target | Required range |
| --- | ---: | --- |
| Kicks | 80 | Clean, soft, acoustic-derived, short, long, sub-heavy, distorted, and layered |
| Snares, claps, and rims | 90 | Tight, wide, dry, roomy, synthetic, organic, and noisy |
| Hats and cymbals | 100 | Closed/open pairs, rides, crashes, metallic/noise variants, short/long tails |
| Toms and conventional percussion | 60 | Tuned toms, congas, shakers, blocks, bells, and hand percussion |
| Found and experimental percussion | 70 | Metal, glass, wood, stone, mechanical, glitch, and processed foley |
| Bass and sub one-shots | 60 | Clean sine/sub, 808-style, reese, distorted, short stab, and sustained tones |
| Chords, stabs, plucks, keys, and mallets | 70 | Major/minor/neutral material, tonal hits, organ/piano colors, synthetic and organic |
| Impacts, sweeps, risers, reverses, and glitches | 70 | Short/long transitions, noise movement, drop impacts, fills, and unexpected effects |

### 6.3 Private-alpha loop allocation

| Role | Target | Requirements |
| --- | ---: | --- |
| Full drum loops and breaks | 100 | Modular, minimally processed versions preferred; no uncleared famous break recordings |
| Tops and percussion loops | 60 | Layerable hats, shakers, percussion, and syncopated movement |
| Bass loops | 45 | Clean and processed variants across straight, swung, syncopated, and halftime patterns |
| Melodic and harmonic loops | 55 | Short modular phrases; key-labelled; avoid recognizable or overly complete hooks |
| Textures, drones, ambience, and rhythmic noise | 60 | Drumless and atmospheric material, including seamless and evolving options |
| Transitions and fills | 40 | One-, two-, four-, and eight-bar builds, drops, turnarounds, and effects phrases |

Loops should not dominate the library. The assistant should normally combine editable MIDI, drum events, instruments, and modular audio rather than assemble songs entirely from finished loops.

### 6.4 Character balance

- At least 30% of one-shots must be dry or lightly processed enough to shape substantially.
- At least 20% must be organic, recorded, or derived from non-instrument sources.
- At least 15% must be explicitly experimental, abrasive, unstable-sounding, or cross-genre.
- No more than 20% of the library may be near-identical variations of one source family.
- At least half of drum loops must have separable or complementary top/percussion content.
- Every genre in sections 7.1-7.6 must have usable options at low, medium, and high intensity.

### 6.5 Starter packs

The alpha ships a set of factory packs. All are bundled, free, and present for every user; there is no installation, entitlement, or purchase model until `LIB-05`.

The list below is a **proposal, not a commitment**. What can actually be cleared determines it: a pack exists when there is enough approved material to make it useful on its own, and a pack that cannot meet its own coverage claim is merged into another or dropped rather than shipped thin. Names are working titles.

| Proposed pack | Purpose | Draws mainly on |
| --- | --- | --- |
| Core Electronic Drums | The role-complete, lightly processed drum foundation every other pack can lean on. Genre-neutral by design. | Internally synthesized (section 4.1) |
| Techno Drums | Driven kicks, metallic hats, industrial percussion, and rumble-ready tails at 125-150 BPM. | Synthesized plus CC0 percussion |
| House Foundations | Rounded kicks, claps, offbeat hats, shakers, organ/piano stabs, and warm plucks at 118-132 BPM. | Producer Space, synthesized |
| Dubstep Bass | Clean subs, growl and reese source tones, halftime drums, impacts, and tension effects at 135-150 BPM. | Synthesized, FreePats synth bass |
| Orchestral Sounds | Mallets, bells, strings, resonances, and organic one-shots for tonal and cinematic material across genres. | VCSL, FreePats |
| Ambient Textures | Drones, evolving pads, field recordings, room tones, and granular-ready snippets; tempo-free. | VCSL, Freesound CC0, synthesized |
| Broken and Found | Metal, glass, wood, mechanical, glitch, and processed foley — the section 6.4 experimental floor as a browsable set. | Freesound CC0, Signature Sounds, synthesized |

Pack-level rules:

- Every genre in PRD `LIB-02` must be servable by some combination of available packs, whether or not it has a pack of its own. A genre without a dedicated pack is covered by the shared foundation packs plus tags, exactly as section 7.7 already describes for supporting genres.
- The section 6.1 milestone counts and the section 6.4 character balances are measured across the whole approved library, not per pack. A pack is not required to hit 20% organic content on its own; the library is.
- Every pack states what it does not contain, so a user picking "Techno Drums" is not surprised by the absence of tonal material.

## 7. Genre coverage

Assets can count toward multiple genres when the tags are honest. Dedicated counts below measure discoverable coverage, not necessarily unique files.

### 7.1 House

| Attribute | Plan |
| --- | --- |
| Tempo coverage | 118-132 BPM |
| Essential drums | Solid short kicks, round/deep kicks, claps, offbeat open hats, shuffled closed hats, shakers, congas, rides |
| Tonal material | Organ/piano chords, minor and dominant stabs, warm plucks, disco-derived but original bass tones, vocal-like synth chops |
| Loops | Straight and swung drums, tops, percussion, bass grooves, chord rhythms, fills |
| Processing | Pumping compression presets, filtered delay, plate/room reverb, saturation, dub delay, gentle bus glue |
| Variation goals | Deep, classic, garage-influenced, acid-adjacent, raw, and modern club palettes |
| Minimum coverage | 4 kits, 80 tagged one-shots, 50 loops, 12 processing presets/chains |

Avoid baking side-chain pumping or large reverb into every source. Provide dry foundations and demonstrate movement through devices and automation.

### 7.2 Techno

| Attribute | Plan |
| --- | --- |
| Tempo coverage | 125-150 BPM |
| Essential drums | Clean and driven kicks, rumble-ready tails, hard claps, metallic hats, rides, tuned toms, industrial percussion |
| Tonal material | Minimal stabs, drones, atonal hits, FM tones, alarm-like textures, noise, resonant sequences |
| Loops | Driving percussion, rolling low-end, polyrhythmic tops, industrial movement, sparse tonal loops |
| Processing | Overdrive, saturation, resonant filtering, long feedback delay, dark reverb, compression, destructive chains |
| Variation goals | Hypnotic, raw, industrial, dub, melodic-adjacent, and broken-beat possibilities |
| Minimum coverage | 4 kits, 80 tagged one-shots, 50 loops, 14 processing presets/chains |

Do not equate techno with one fixed kick or arrangement. Experimental percussion and automation are central to techno coverage.

### 7.3 Hip Hop and Trap

| Attribute | Plan |
| --- | --- |
| Tempo coverage | 65-105 BPM and double-time metadata through 170 BPM |
| Essential drums | Punchy kicks, dry and wide snares, claps, rims, detailed hats, rolls, open hats, percussion, tuned 808-style bass |
| Tonal material | Keys, mallets, plucks, pads, original dusty textures, short chords, sub and distorted basses |
| Loops | Swung drums, halftime patterns, hat/top loops, bass phrases, sparse melodic fragments, turnarounds |
| Processing | Tape/lofi color, saturation, clipping, filtered sampling chains, short room reverb, delay throws, 808 distortion |
| Variation goals | Boom-bap-adjacent, modern trap, drill-adjacent, soulful, dark, sparse, and experimental |
| Minimum coverage | 4 kits, 90 tagged one-shots, 50 loops, 12 processing presets/chains |

Do not bundle uncleared record chops, branded producer imitations, or vinyl noise copied from records. Record or synthesize every texture and break from a cleared source.

### 7.4 Drum & Bass and Jungle

| Attribute | Plan |
| --- | --- |
| Tempo coverage | 160-180 BPM |
| Essential drums | Tight kicks, layered snares, ghost hits, rides, hats, percussion, original recorded/synthesized breaks and slices |
| Tonal material | Sub tones, reese basses, mid-bass stabs, pads, atmospheres, rave-adjacent but original chord hits |
| Loops | Full breaks, isolated tops, shuffled percussion, bass movement, pads, fills and edits |
| Processing | Parallel drum compression, saturation, break filtering, reese chains, short rooms, long atmospheric reverb, delay |
| Variation goals | Liquid, jungle-influenced, rolling, minimal, dark, and heavier bass-focused palettes |
| Minimum coverage | 4 kits, 90 tagged one-shots, 55 loops, 14 processing presets/chains |

Do not ship a copied Amen, Think, or other historically common break merely because it is widely sampled. Commission or record original break performances that teach the same chopping techniques without uncertain source rights.

### 7.5 Dubstep and Bass Music

| Attribute | Plan |
| --- | --- |
| Tempo coverage | 135-150 BPM |
| Essential drums | Heavy kicks, halftime snares, claps, sharp hats, metallic percussion, impacts, fills |
| Tonal material | Clean subs, reese and growl source tones, FM/wavetable-like one-shots, dark stabs, drones, noise movement |
| Loops | Halftime drums, syncopated percussion, bass rhythms, sparse atmospheres, tension and release effects |
| Processing | Multistage distortion, saturation, filtering, compression, feedback delay, large reverb, resampling-oriented chains |
| Variation goals | Deep 140, dub-influenced, heavy, spacious, halftime, leftfield, and experimental |
| Minimum coverage | 4 kits, 80 tagged one-shots, 45 loops, 16 processing presets/chains |

Dubstep coverage should demonstrate the product's extreme processing range. Prefer simple source tones plus editable devices over a library made entirely of frozen finished growls.

### 7.6 Ambient

| Attribute | Plan |
| --- | --- |
| Tempo coverage | Tempo-free plus 50-120 BPM metadata where rhythmic |
| Essential material | Drones, evolving pads, field recordings, room tones, bells, mallets, resonances, noise, organic textures, granular-ready snippets |
| Loops | Drumless textures, slow pulses, seamless ambience, evolving harmonic beds, sparse percussion |
| Processing | Long and unusual reverbs, feedback delays, filtering, saturation, pitch shifting when available, destructive texture chains |
| Variation goals | Warm, dark, environmental, minimal, noisy, beatless, and rhythmic ambient |
| Minimum coverage | 2 kits, 60 tagged one-shots, 50 loops, 14 processing presets/chains |

Ambient validates that the library does not assume a kick, fixed tempo, or conventional song density. Long files must still meet streaming, caching, and memory budgets.

### 7.7 Supporting genre coverage

| Genre | Required additions beyond shared library | Coverage gate |
| --- | --- | --- |
| Lofi | Soft drums, dusty but original textures, tape-like chains, keys, mallets, subdued ambience | An editable idea can be built without relying on an uncleared record sample |
| Trance | Clean club drums, rolling bass, plucks, pads, noise risers, long transitions, tempo-synced delays | A 132-140 BPM idea with build/release automation can be built |
| UK Garage | Shuffled kicks/snares, skippy hats, rim/percussion, sub bass, organ/chord stabs | A swung idea can be built whose groove is not a renamed house pattern |
| Breakbeat | Original breaks and slices, punchy one-shots, bass stabs, edits, fills | An idea can be built from cleared original break sources |
| Electronic Pop | Versatile drums, synth bass, keys, pads, plucks, transitions, restrained processing | An instrumental idea with verse/chorus contrast and room for vocals can be built |

## 8. Genre starters (not planned)

Genre starters and project templates are not planned (`LOOP-015`, closed as not planned). A new project starts from the one "New Project" starter (`src/editor/composition/starterProject.ts`), and genre coverage is judged by what a user can build from the packs (section 7), not by bundled demo projects. This section keeps its number so the cross-references to later sections stay valid.

## 9. Asset metadata

A manifest describes one pack. Its header is the pack record from section 5.1, and its entries are that pack's assets:

```json
{
  "pack": {
    "id": "pak_gTt3xQ9mZ1s7Kd0bWv2Lp",
    "slug": "techno-drums",
    "name": "Techno Drums",
    "version": "1.0.0",
    "publisher": "Groove",
    "kind": "factory",
    "description": "Driven kicks, metallic hats, and industrial percussion for 125-150 BPM techno. Drums and percussion only; no tonal material.",
    "coverage": {
      "roles": ["kick", "clap", "closed-hat", "open-hat", "cymbal", "tom", "percussion"],
      "genres": ["techno"],
      "bpmRange": [125, 150],
      "intensity": ["low", "medium", "high", "extreme"]
    },
    "rights": { "licence": "CC0-1.0", "rawRedistribution": true, "attributionRequired": false },
    "releasedAt": "2026-07-25",
    "assetCount": 84
  },
  "assets": [ /* the records below */ ]
}
```

`pack.version` is a `major.minor.patch` string and `pack.rights` is `{ licence, rawRedistribution, attributionRequired }` — the exact shape `FND-002b`'s `packVersionSchema` and `packRightsSchema` require (`src/domain/entities.ts`), so a manifest's `pack` header parses directly as a domain `Pack` once the client strips this section's manifest-only fields (`slug`, `coverage`, `releasedAt`, `assetCount`).

Each asset record should support a shape equivalent to:

```json
{
  "id": "sg-one-shot-kick-0001",
  "pack": { "id": "pak_gTt3xQ9mZ1s7Kd0bWv2Lp", "version": "1.0.0" },
  "version": 1,
  "name": "Rounded Analog Kick 01",
  "type": "one-shot",
  "role": "kick",
  "files": {
    "master": {
      "storageKey": "sha256/ab/cd/...wav",
      "sha256": "...",
      "bytes": 123456,
      "format": "wav"
    }
  },
  "audio": {
    "sampleRate": 48000,
    "bitDepth": 24,
    "channels": 1,
    "durationSeconds": 0.42,
    "peakDbfs": -1.2,
    "loudnessLufs": -14.8,
    "rootNote": "C1",
    "tuningCents": -3,
    "tuningStatus": "detected",
    "spectralSketch": [80, 80, 41, 12, 0, 9, 22 /* … 32 bands in all */],
    "bpm": null,
    "bars": null,
    "loopable": false
  },
  "tags": {
    "genres": ["house", "techno"],
    "characters": ["round", "clean", "short"],
    "intensity": "medium",
    "sourceTypes": ["synthesized"]
  },
  "license": {
    "id": "CC0-1.0",
    "sourceUrl": "https://example.com/source",
    "creator": "Example Creator",
    "retrievedAt": "2026-07-23",
    "evidencePath": "licenses/example/2026-07-23.html",
    "rawRedistributionAllowed": true,
    "agreementId": null
  },
  "provenance": {
    "originalFilename": "kick-01.wav",
    "originalSha256": "...",
    "modifications": ["trim", "fade", "resample-48000", "rename"],
    "reviewer": "...",
    "reviewedAt": "..."
  }
}
```

A pack's `rights` is the position every asset in it shares; an asset's own `license` block stays because provenance is per file — a CC0 pack still records which creator and which source page each file came from. The two must agree (an asset's `license.id` must equal its pack's `rights.licence`), and validation fails when an asset claims terms its pack does not cover.

### Controlled vocabulary

- Pack IDs are stable, opaque, and permanent. The slug is a URL-friendly convenience and is never identity; renaming a pack does not change its ID.
- Genre tags use stable IDs and may be many-to-many.
- Role is functional: kick, bass, texture, transition, chord, and similar.
- Character tags describe audible qualities such as dry, distorted, metallic, warm, noisy, short, dark, wide, or organic.
- Mood is separate from genre and character.
- Intensity uses a small ordered scale: low, medium, high, extreme.
- Source type distinguishes recorded, synthesized, field recording, resampled, processed, and commissioned.
- Instrument and kit definitions reference pack-qualified asset IDs, never filenames or URLs.

Manifest validation fails CI when an asset is missing its checksum, rights evidence, creator/source, required audio metadata, or raw-redistribution approval; when it belongs to no pack or to a pack the manifest set does not define; when its licence terms exceed its pack's; or when a pack does not deliver the roles and genres its coverage claim advertises.

## 10. Audio preparation standards

### Master files

- Store lossless PCM WAV masters at 48 kHz and 24-bit where the source quality supports it.
- Preserve genuine mono sources as mono. Use stereo only when spatial information is musically meaningful.
- Do not upsample or increase bit depth merely to claim a higher specification; record source format and conversion honestly.
- Remove DC offset, corrupt chunks, unintended leading/trailing silence, and accidental clicks.
- Use very short fades where necessary without softening intended transients.
- Do not brick-wall normalize the collection. Prevent clipping and provide perceptually reasonable audition levels while retaining useful dynamics.
- Measure every master's integrated loudness (ITU-R BS.1770-4) and flag an asset that sits far from the rest of its role band, for a person to re-prepare or retire. The measurement is recorded, never applied (section 15.12).
- Keep a checksum of the untouched source and treat processed masters as derived assets.

### One-shots

- Trim start latency tightly enough for rhythmic use.
- Preserve natural or designed tails unless silence is clearly accidental.
- Detect and review root note and tuning for tonal drums, basses, stabs, and instruments. The build measures each declared root's settled pitch and fails one more than 50 cents off (section 15.12).
- Record choke relationships for open/closed hats and similar pairs.
- Identify near duplicates using audio fingerprints and human review. The build fingerprints every master and reports close pairs for a person to hear (section 15.12).

### Loops

- Verify BPM by listening and bar-grid alignment; never trust filenames alone.
- Record exact bar count, time signature, key where applicable, and whether the file is truly seamless.
- Align boundaries to integer sample positions and test at repeated playback for at least 32 cycles.
- Reject loops with clipped reverb/delay tails, hidden count-ins, or tempo drift unless intentionally categorized as free-time.
- Prefer dry or stem-like modular loops over complete mixed phrases.

### Sampled instruments

- Validate root keys, zone boundaries, velocity layers, loop points, gain consistency, and release behavior.
- Convert SFZ mappings into a documented internal instrument definition rather than requiring a third-party player.
- Preserve the source SFZ and licence evidence for traceability.
- Load only zones required for the active register where practical; do not decode an entire multi-gigabyte source library eagerly.

## 11. Curation and quality workflow

### Intake states

1. **Candidate:** Link and initial musical reason recorded; asset cannot ship.
2. **Rights review:** Licence and provenance checked; ambiguous assets rejected or escalated.
3. **Quarantine:** Original downloaded, hashed, scanned, and isolated from production manifests.
4. **Audio preparation:** Format conversion, trimming, fades, analysis, and derived master generation.
5. **Metadata review:** Owning pack, role, genre, character, musical metadata, and user-facing name checked. An asset whose rights differ from its pack's is reassigned, not relabelled.
6. **Musical review:** Auditioned alone, in at least two relevant project contexts, and alongside the rest of its pack.
7. **Approved:** Manifest entry reviewed and eligible for kits, presets, and production delivery.
8. **Deprecated:** Hidden from new selection while existing project references remain resolvable.
9. **Removed:** Delivery disabled for legal/security reasons with a documented project-recovery strategy.

A pack has its own gate on top of the per-asset states: it ships only when it meets its coverage claim, its rights position covers every asset in it, and it can build a usable idea in its stated genre or role without help from another pack.

### Musical review rubric

Each approved asset must pass:

- **Distinctness:** It adds something not already covered better.
- **Usefulness:** It can serve a clear role or valuable experimental purpose.
- **Editability:** It leaves room for user processing unless its finished character is the point.
- **Technical integrity:** It has no accidental clipping, clicks, corrupt data, or false metadata.
- **Context fit:** It works in a real Groove kit, instrument, loop, or project.
- **Pack fit:** It belongs in the pack that holds it — it serves that pack's stated purpose and shares its rights position.
- **Naming:** The name describes the sound without unauthorized brands, artist imitation, or misleading genre claims.

At least two reviewers should approve commissioned packs and high-volume source imports. Spot checking is not sufficient for bulk acceptance.

## 12. Delivery and performance

- Keep only the bootstrap set and the "New Project" starter's assets in the initial application cache.
- Deliver metadata per pack. A client fetches a small index of available packs, then the manifest of a pack it opens or a project needs — never one manifest containing every asset in the library. This is what keeps the metadata budget below flat as the number of packs grows.
- A published pack version is immutable. A project resolves the pack versions it recorded, so republishing a pack cannot change an existing track, and a client can cache a pack manifest indefinitely by version.
- Store the complete alpha library in Cloud Storage for Firebase behind stable asset records and cacheable versioned URLs.
- Fetch masters lazily on selection, audition, project load, or explicit prefetch.
- Prefetch all assets required by the open project and likely alternates for the current browser view without decoding the entire library.
- Cache decoded buffers through the shared audio-runtime asset cache and release them according to the Web Audio lifecycle requirements.
- Generate compact waveform peaks during ingestion; clients should not download a full long asset merely to display its browser waveform.
- A missing or failed asset is isolated, produces an actionable state, and never blocks unrelated project playback. A whole unavailable pack behaves the same way at pack scale: the affected tracks and clips are named, and everything else keeps playing, editing, and exporting.
- Cross-origin headers must allow Web Audio decoding and offline export in every supported browser.
- The library manifest can be searched locally after a compact metadata fetch; search must not enumerate Cloud Storage objects.
- Export and collaboration resolve immutable asset versions so a later library update cannot silently change an existing track.

Initial performance targets:

- Pack index below 32 KiB compressed, and any single pack manifest below 1 MiB compressed. The whole private-alpha catalogue stays below 1 MiB compressed as well, but the per-pack budget is the one that has to keep holding as packs are added.
- Search/filter response below 50 ms for 1,000 assets on the 2019 Intel MacBook Pro baseline after metadata load.
- First audition begins within 500 ms for a cached one-shot and within 2 seconds for a typical uncached asset on broadband.
- Starter fallback assets add no more than 40 MiB to the first-project download before normal browser caching.

## 13. Implementation phases

Phase A is implemented and phase B's one-shot targets are met by the starter library in section 15, now delivered on the pack model (section 15.8). Phases C, D, E, and F are open.

### Phase A: policy and tooling

- Approve this licence policy and commissioned-content agreement requirements.
- Define the pack record, the manifest schema, controlled vocabulary, stable ID rules, and validation command.
- Build source/evidence archiving, checksum, audio-analysis, waveform, and manifest-generation scripts.
- Implement candidate, review, approval, deprecation, and takedown states.

Exit criteria: one asset can travel from original download through reviewed evidence and generated delivery manifest without manual data duplication.

### Phase B: bootstrap library

- Create an internal core electronic drum set and noise/transition sources.
- Import reviewed CC0 FreePats electronic percussion, synth bass, and selected pad assets.
- Select small VCSL percussion and experimental-instrument subsets.
- Reach the bootstrap counts and replace prototype filenames with stable asset IDs.

Exit criteria: browser, sampler, drum machine, instruments, cache, missing-asset flow, and export work against the real manifest.

### Phase C: production seed

- Curate Producer Space non-vocal material and individually evidenced Signature Sounds packs.
- Add targeted Freesound CC0 foley, ambience, and unusual percussion.
- Build 12 coherent drum kits and initial processing chains.

Exit criteria: every genre in sections 7.1-7.6 can produce at least three materially different playable loops using only approved assets.

### Phase D: rounded private-alpha library

- Settle the shipped pack list against what has actually been cleared, and finish each pack against its coverage claim.
- Reach the private-alpha asset targets without relaxing review standards.
- Commission missing core drums, breaks, bass sources, transitions, and genre-specific material.
- Meet every section 7 genre coverage gate.
- Run duplicate, loudness, licence, missing-file, decode, loop-boundary, and export audits.

Exit criteria: a project built in every required genre opens, plays, saves, renders, exports stems, and exports to the supported Ableton handoff without a missing or unlicensed asset.

### Phase E: partnerships and user growth

- Pursue OEM licences with selected sample labels, each delivered as its own pack with its own rights position.
- Add user imports as user-kind packs, keeping user-owned storage separate from factory content while reusing one browser, resolver, and audition path.
- Use search, audition, replacement, and project-use telemetry to identify gaps without recording creative content.
- Retire weak assets and add curated packs through immutable versioned releases.

### Phase F: marketplace (much later)

Creator-published packs, acquisition, and premium packs (PRD `LIB-05`, section 16 below). Deliberately last: it needs Phase E's user-owned content, a rights and payout agreement, moderation, and a product people already finish tracks in. No Phase A-E work is shaped around it beyond keeping packs versioned, self-describing, and rights-carrying.

## 14. Immediate acquisition backlog

Items 6 and 8 are done: the starter library in section 15 ships 200 original synthesized one-shots with their generation recipes retained, and the manifest validator gates CI.

Every selection in items 1-5 records the pack it is destined for at review time (section 5.1), so a file is never accepted into the library before someone has decided what set it belongs to.

Items 1-5 are **unblocked but unstarted**. The acquisition pipeline in section 15.5 exists and is tested, and the tier-1 and tier-2 sources are registered with their licence positions; what remains is the human half — choosing individual files, pinning them, and reviewing them. `sources.lock.json` is empty, so no third-party audio is in the repository yet. `DEC-003` still owns the commissioning budget, attribution policy, and any export exclusions; it does not gate CC0 selections from the already-approved section 4.1 sources.

1. Download and archive the Producer Space full pack and official licence; quarantine vocals and select the first 40 clearly sourced non-vocal assets.
2. Import FreePats CC0 electronic percussion, Lately Bass, Synth Bass #1/#2, and a small pad set with original SFZ mappings.
3. Select 30-50 VCSL files covering organic percussion, mallets, resonances, and experimental textures.
4. Audit Signature Sounds packs for 808-style basses, unusual percussion, ambient loops, impacts, and transitions; accept only packs containing a matching CC0 licence file and credible provenance.
5. Curate at most 50 Freesound CC0 candidates for gaps that the named collections cannot fill; review every asset manually.
6. Create 80 original drum/noise/transition one-shots with Tone/Web Audio or owned recordings, retaining generation recipes and source sessions.
7. Assemble four bootstrap kits: clean electronic, driven club, broken/organic, and experimental.
8. Implement the manifest validator before adding further bulk content.

## 15. Implemented starter library

The first slice of this plan is built. `CNT-000` delivers a **starter library of 200 synthesized one-shots** — PRD requirement `LIB-00` — so that the browser, sampler, drum machine, caching, and export are developed against real audio and real metadata instead of two prototype WAV files.

It is testing content, not factory content. It executes phase A end to end and covers phase B's one-shot targets; it does not replace phases C and D, and its assets are not counted towards the section 6.1 approved-asset milestones.

### 15.1 Two halves: synthesized and acquired

The library is built from two independent routes through section 3.2, and both are implemented.

| | Synthesized (`library:build`) | Acquired (`library:acquire`) |
| --- | --- | --- |
| Rights route | 3.2 route 2 — created entirely from sources Groove owns | 3.2 route 1 — CC0 1.0 from a credible rights holder |
| Source | `scripts/starter-library/catalog/` | The section 4 sources, pinned in `sources.lock.json` |
| Needs network | No | Yes |
| Reproducible | Byte-for-byte from a seed | By checksum, against a pinned download |
| Ships today | 200 assets | 0 assets — nothing is pinned yet |
| Closes 6.4 organic floor | No, by construction | Yes |

**Synthesis** is deterministic, needs no counterparty, and runs offline, so the library always builds and CI can verify it byte-for-byte. It cannot produce recorded or field-recorded material, so it cannot reach the section 6.4 floor of 20% organic sources.

**Acquisition** is what closes that gap. It is deliberately not a downloader: nothing is fetched that is not declared in `acquire/sources.mjs`, selected file-by-file in `sources.lock.json`, pinned to a SHA-256, and attributed to a named reviewer. There is no crawl mode and no search mode, because section 4.2 forbids importing search results blindly and a tool that *can* do it will eventually be used to do it.

The synthesized library's rights position is recorded in [`docs/licenses/starter-library-v1.md`](./licenses/starter-library-v1.md). Acquired content captures its licence statement per source at fetch time, into `docs/licenses/sources/`.

### 15.2 What it contains

200 one-shots covering every role in the section 5 taxonomy, allocated in the section 6.2 proportions:

| Family | Count | Roles |
| --- | ---: | --- |
| Drums | 111 | 24 kicks, 13 snares, 9 claps, 5 rims, 12 closed hats, 7 open hats, 9 cymbals, 8 toms, 24 percussion |
| Bass | 21 | 8 sub, 5 sustained, 4 reese, 4 stab |
| Tonal | 25 | 7 chord, 4 stab, 4 pluck, 4 key, 3 mallet, 3 bell |
| Texture | 19 | 5 noise, 4 ambience, 4 drone, 3 mechanical, 3 organic |
| FX | 24 | 6 impact, 5 riser, 4 downer, 3 sweep, 3 reverse, 3 glitch |

Every genre in PRD `LIB-02` has at least 10 tagged assets spanning at least three families. Masters are 48 kHz / 24-bit mono WAV, DC-corrected, tail-trimmed, edge-faded, and peak-normalized to -1.5 dBFS — headroom management, not the brick-walling section 10 rejects. Total payload is roughly 42 MiB of audio and 72 KiB of gzipped metadata, against the 1 MiB metadata budget in section 12.

Against section 6.4 the library meets the experimental floor (23.5% against 15%) and the dry, shapeable floor (34.0% against 30%), and no single role exceeds the 20% ceiling. It does **not** meet the 20% organic and recorded-source target, because everything shipped so far is synthesized. The validator reports that as a standing warning rather than passing it silently or satisfying it by relabelling; pinning CC0 recordings through `library:acquire` is what clears it.

### 15.3 Commands

```sh
bun run library                     # print the workflow and the current on-disk state
bun run library:build               # render synthesized assets, merge acquired, write the manifest
bun run library:audition            # serve the merged library locally so you can listen to it
bun run library:validate            # build and validate without writing (run after changing the library)
bun run library:audit               # the release audit over the bytes that would ship (section 15.11)
bun run library:upload              # publish to Cloud Storage; idempotent
bun run library:test                # the library test suites only

bun run library:manage              # review candidate pages, verify selections (section 15.7)
bun run library:candidates          # regenerate candidates.json from the mined sources
bun run library:acquire -- --plan   # what is approved and what is pinned; no network
bun run library:acquire -- --pin    # download declared selections and record checksums
bun run library:acquire             # download, verify, prepare, and ingest pinned CC0 content
```

`library:audition` builds the library **in memory** and serves it at
`http://127.0.0.1:4180`, so what you hear is exactly the bytes `library:upload`
would publish — there is no stale-build failure mode where the audition sounds
right and the upload ships something else. The page renders its waveforms from
the manifest's own `waveform.peaks`, so browsing it also exercises the section 12
claim that a client can draw an asset without downloading its audio.

Auditioning is not optional polish. Delivery keys are content hashes
(`sha256/ab/cd/…wav`), so the output directory is unbrowsable by ear, and the
validator only proves an asset is well-formed — that it has a checksum, rights,
headroom, and honest metadata. Whether a kick sounds like a kick is a question
only listening answers.

`library:build` merges whatever `library:acquire` last ingested. With nothing acquired it produces the 200 synthesized assets and needs no network — which is why CI can gate on it unconditionally.

`library:upload` accepts `--dry-run` (plan only, no network), `--bucket <name>`, `--force` (re-upload existing objects), and `--configure-bucket` (apply the CORS policy in `storage.cors.json`). Credentials come from `GOOGLE_APPLICATION_CREDENTIALS` or `FIREBASE_SERVICE_ACCOUNT`; see `.env.example`.

To exercise the whole publish path with no real project, point it at the Storage emulator:

```sh
firebase emulators:start --only storage --project demo-solid-groove
FIREBASE_STORAGE_EMULATOR_HOST=127.0.0.1:9199 \
  bun run library:upload -- --bucket demo-solid-groove.firebasestorage.app
```

The policy admits any origin for GET/HEAD: `storage.rules` already makes `library/**` world-readable and denies every other path, and the origins that need it — Hosting preview channels, `https://<project-id>--pr-<n>-<hash>.web.app` — carry a hash minted at deploy time that no list can name, while Cloud Storage matches an origin exactly and supports no subdomain wildcard (issue #259).

Bucket CORS is the one thing the emulator cannot exercise — it answers `setCorsConfiguration` with "Not Implemented" and serves permissive CORS regardless — so the script reports it as skipped rather than failing.

### 15.4 Delivery layout

The library ships on the pack model — see section 15.8 for the current layout. Identity is still the SHA-256 of the bytes, so a storage key cannot collide, a re-run uploads only what changed, and a project can pin an exact asset version. `storage.rules` denies every client write and every path outside `library/`.

### 15.5 Adding CC0 content

Acquisition is a review workflow with a script attached, not a download button. The steps are deliberately manual where section 4.2 requires judgement:

1. **Choose a source** from `acquire/sources.mjs`. Adding a source is a rights decision: it needs a licence the section 3.2 allowlist accepts, a canonical licence URL, and a written note on what may and may not be taken. Tier-2 sources host mixed licences, so a site-wide CC0 claim is never evidence for an individual file.
2. **Select individual files** and add them to `sources.lock.json` with their download URL, the source page a reviewer actually read, the creator, and the role/tag mapping. Vocals, recognizable media, and identifiable people stay out (section 3.3). `bun run library:manage` (section 15.7) is the fast path for this step: it steps through the curated candidate pages and writes a reviewed draft selection on each Verify.
3. **Pin them** with `library:acquire -- --pin`. This downloads into quarantine, records the SHA-256 of exactly what arrived, and writes it back for review. It never ingests.
4. **Review and commit** the lockfile. A named reviewer is required — `"unreviewed"` fails validation, so a pin cannot be mistaken for a decision.
5. **Ingest** with `library:acquire`. It re-checks rights, verifies every checksum, captures each source's licence statement into `docs/licenses/sources/`, extracts only the pinned archive member, decodes, prepares to the section 10 standard, and emits manifest entries in the same shape the synthesized library produces.

A checksum mismatch is a hard failure at every stage. The bytes a person reviewed are not the bytes that arrived, and which of the two is wrong is not something a script can decide.

Acquired assets take IDs from `sg-one-shot-<family>-<role>-5001` upward so the two ranges can never collide. Downloaded originals and prepared masters are gitignored; the lockfile and the captured licence statements are committed, because those are the evidence.

### 15.6 Code

```text
scripts/starter-library/
  dsp.mjs           seeded RNG, oscillators, noise, filters, saturation, reverb, delay
  music.mjs         note names, frequencies, chord voicings
  voices.mjs        one renderer per sound family; conditioning chain
  taxonomy.mjs      the section 5 and 9 controlled vocabulary
  catalog/          the 200 synthesized entries, as data, split by family
  acquire/
    sources.mjs     approved sources, licence allowlist, and what may be taken
    lockfile.mjs    pinned selections, drafts, and their validation
    fetch.mjs       download, quarantine, checksum, licence-evidence capture
    archive.mjs     zip member extraction
    audio.mjs       decode, resample, and the section 10 preparation chain
    ingest.mjs      selection -> manifest entry; the acquired-bundle writer
    vcsl.mjs        VCSL bulk CC0 ingest: clone, subset, delete (section 15.8)
    candidates.mjs  candidate schema + best-effort page crawler (section 15.7)
    candidates.json the committed candidate sample pages (generated, ~1000)
    candidateEssentials.mjs  the hand-picked essential sounds
    generateCandidates.mjs   regenerates candidates.json from mined sources
    candidate-sources/       committed mined inputs (FSLD annotations)
  sources.lock.json the committed pins
  manifest.mjs      section 9 manifest records; merges every acquired bundle
  validate.mjs      per-asset and collection-level rules; the CI gate
  audit.mjs         the release audit over the shipped bytes (section 15.11)
  audits.mjs        library-wide audio audits and their thresholds: loudness, tuning, duplicates (section 15.12)
  acquire.mjs       CLI: plan, pin, ingest
  manage.mjs        CLI + local review UI server (section 15.7)
  managePage.mjs    the review page served by library:manage
  build.mjs         render and merge to disk
  upload.mjs        publish to Cloud Storage
```

Asset IDs are `sg-one-shot-<family>-<role>-NNNN`, numbered by position within a role group. Groups are **append-only**: reordering or removing an entry renumbers every later asset and breaks IDs that saved projects reference, so `catalog.test.mjs` pins the numbering.

### 15.7 Curator tooling for CC0 acquisition

The rights machinery in 15.5 is sound but slow to feed by hand: a curator has to open each source page, listen, find the actual download, and hand-write a lockfile entry. `bun run library:manage` (PRD `LIB-04`) is a local review tool that removes the typing without removing the judgement.

It reads `acquire/candidates.json` — a committed list of candidate sample **pages**, each naming an approved source, a page URL, a licence-confidence tier, and a seed role/tag mapping — and serves a review UI at `http://127.0.0.1:4181`. It steps through the candidates one at a time: the source page in an embedded frame so the curator can listen, and a best-effort guess of the direct file URL, creator, licence hint, and metadata in an editable form beside it. Some sources (GitHub, Freesound) refuse to be embedded (`X-Frame-Options: DENY`); for those the frame shows an "open in a new tab" fallback instead of a blank panel, and the curator listens on the source page. The inline audio preview still plays a direct file URL either way.

The tool is deliberately the opposite of a crawler. It fetches only the pages the config already names, one at a time and on demand as the curator reaches each one — never up front, never discovering or following a link, and never downloading audio for redistribution. Every scraped value is a suggestion; the curator confirms or corrects it. This keeps the section 4.2 prohibition on bulk-importing search results intact — there is still no crawl mode and no search mode, only a faster way to review a list a person wrote.

Clicking **Verify** writes a *draft* selection to `sources.lock.json`: the reviewed download URL, source page, creator, filename, a real reviewer name, and the role/tag mapping — but **no checksum**. A draft is intentionally not yet shippable; `validateLockfile` still fails on the missing `sha256` until the existing `library:acquire --pin` step downloads the file and records the checksum of exactly what arrived. Nothing else in the pipeline changes: a verified draft flows through the same pin → review → commit → ingest path as a hand-written selection, and a checksum that later disagrees still fails rather than being re-pinned. `library:acquire --plan` lists verified drafts separately from fully pinned selections so it is obvious what still needs `--pin`.

Re-verifying a candidate replaces its draft rather than duplicating it, and reopening the tool shows selections already committed to the lockfile instead of a blank form, so review is resumable across sessions.

#### The candidate list is generated, not hand-written

`candidates.json` holds ~1000 candidate pages and is **generated** by `bun run library:candidates` (`acquire/generateCandidates.mjs`) from mined, committed inputs under `acquire/candidate-sources/`. It is regenerated by hand when those inputs change, never hand-edited, and the management tool only ever reads the committed output. The generator fabricates nothing: every `pageUrl` is built from a real instrument folder or a real sound ID. Its inputs are:

- **A hand-picked essentials set** (`candidateEssentials.mjs`) — a small number of specific pages on approved sources (a FreePats synth-percussion bank, a FreePats synth-bass bank) carrying nicer curated names and tags than the generator would produce. They share IDs with generated entries and win the de-dupe, so a regeneration keeps them. An earlier draft seeded placeholder Freesound essentials (a 909 kick, an 808, hat pairs, …); those were removed because their sound IDs could not be confirmed without the Freesound API, and the mined list already covers every role they targeted.
- **FreePats** — the CC0-candidate bank pages. Licences vary per bank, so the curator confirms CC0 on each page.
- **The Freesound Loop Dataset** (`candidate-sources/fsld-loops.json`, from Zenodo record 3967852) — real Freesound sound IDs from the annotation subset, with BPM/key/genre/instrumentation used to seed the form. The per-sound licence lives only inside the dataset's 8.8 GB archive, so these are `unconfirmed`: the curator confirms CC0 on each Freesound page. Vocal-flagged and annotator-discarded loops are filtered out at generation.

VCSL is deliberately **not** a candidate source. Because its whole repository is CC0, reviewing it page-by-page would be busywork; it is bulk-ingested instead (section 15.8).

Each candidate carries a `licenseConfidence` of `verified-cc0`, `likely-cc0`, or `unconfirmed`, surfaced in the review UI (today the generated list is entirely `unconfirmed`, since every candidate source hosts per-item licences). It is a review-order hint, **never** a rights decision — a candidate could say `verified-cc0` and still be rejected on the page, and the authoritative position is always the licence evidence captured at ingest. The tool treats the whole list as an inbox: an unverified candidate is a lead to audition, and only a Verify — a person confirming the file on the actual page — writes anything.

Most Freesound candidates are loops rather than one-shots; the seed role is the closest one-shot role and the curator corrects it. A dedicated loop family in the taxonomy is future work.

### 15.8 VCSL as a trusted bulk source

The per-file review workflow (15.5, 15.7) exists because Tier-2 sources host mixed licences: a page is not evidence for a file. VCSL is different. The whole `sgossner/VCSL` repository is dedicated to the public domain under CC0 1.0, confirmed against [github.com/sgossner/VCSL](https://github.com/sgossner/VCSL). When the rights hold library-wide, auditioning each file to re-confirm the licence is busywork, so VCSL takes a separate path — a *trusted bulk source* rather than a lockfile source.

```sh
bun run library:vcsl                 # clone, ingest a curated subset, delete the clone
# equivalently: bun run library:acquire -- --vcsl
```

`acquire/vcsl.mjs` shallow-clones the repo, records the commit SHA it resolved to, captures the repository's own `LICENSE` as the section 3.4 evidence (`docs/licenses/sources/vcsl.md`), ingests a curated subset, writes it as an acquired bundle for `library:build` to merge, and **deletes the clone** — the multi-gigabyte checkout is third-party bytes that are never committed, exactly like the quarantine directory.

Two things keep this honest rather than a back door around the section 3 policy:

- **It is a curated subset, not a bulk dump.** Section 4.1 is explicit: "select a small electronic-production subset rather than ingesting the full multi-gigabyte library." The ingest maps VCSL's Hornbostel–Sachs families to the taxonomy (idiophones → mallets/bells/percussion, membranophones → drums, plucked and bowed chordophones → tonal, electrophones → keys) and takes **one representative sample per instrument** — roughly 90 instruments, not the 4231 WAVs in the repo. Aerophones (winds, organs) are dropped as out of scope. Bowed strings are included as sustained tonal material.
- **The provenance says what it is.** Acquired VCSL assets carry `sourceType: recorded`, `reviewState: metadata-review` with a `<source>-cc0-bulk` reviewer, the pinned commit in their `downloadUrl`, and the per-file GitHub URL of the sample they came from. Their IDs sit in a `sg-one-shot-<family>-<role>-6NNN` range, disjoint from both the synthesized catalogue and the lockfile ingest (base 5000), so no two paths can collide.

The acquired directory now holds one bundle per ingest path (`acquired-library/lockfile/`, `acquired-library/vcsl/`), each an `entries.json` beside its `audio/`. `manifest.loadAcquiredAssets` merges every bundle, so `library:build` combines lockfile-pinned CC0, bulk VCSL, and the synthesized catalogue, groups the result by pack, and emits one manifest per pack (section 15.8). Both acquisition routes still close the section 6.4 organic-source floor that synthesis cannot reach.

### 15.9 Bulk CC0 archives beyond VCSL (Producer Space, FreePats banks)

VCSL is not the only archive-wide CC0 source. `DEC-003` generalizes the trusted-bulk pattern to two more section 4.1 sources whose CC0 clearance is archive-wide rather than per file, so a curator confirms the licence once on the page and the whole archive is ingested as a unit:

- **Producer Space** — its official [`/license`](https://producerspace.com/license) clearance places the *entire library* under CC0 with an express redistribution grant, so a downloaded pack `.zip` is a bulk CC0 unit; every member shares the one licence.
- **FreePats CC0 banks** — FreePats states its licence *per bank*, so a bank whose page states CC0 is a bulk CC0 unit for that bank; the whole bank archive shares the one licence.

```sh
bun run library:producer-space -- <bulk-source-id>   # ingest a confirmed CC0 pack archive
bun run library:freepats-bank  -- <bulk-source-id>   # ingest a confirmed CC0 bank archive
bun run library:acquire -- --list-bulk               # the declared bulk sources and their licence pages
```

`acquire/bulkSources.mjs` declares each bulk source (its exact archive URL, licence-statement URL, one-sentence rights note, taxonomy mapping, and a disjoint asset-ID range), and `acquire/bulk.mjs` downloads the archive, decodes and prepares every audio member to the section 10 standard, captures the archive-wide licence as section 3.4 evidence, and writes an acquired bundle in the same shape as VCSL. The honesty boundary is narrow and load-bearing: a bulk source is valid **only where one archive carries exactly one CC0 licence**. A mixed-licence host (a Freesound search, a Signature Sounds pack with a stray CC-BY file) is never declared here — it stays on the per-file `library:manage` path where a person confirms each file. Section 4.2's rule that "a site-wide claim is not evidence for an individual file" is untouched; a bulk source is the opposite case — a genuinely archive-wide dedication — not a loophole around it.

**A bulk source can be a git repository instead of a `.zip`.** FreePats mirrors every bank to `github.com/freepats/<bank>`, with its CC0 statement in the bank's README. A source that declares `repoUrl` is shallow-cloned rather than downloaded (the same route as VCSL), its `include` pattern chooses which files to take, and the resolved commit is the pin recorded in `downloadUrl` and in the evidence. The clone is deleted afterwards. A pitched bank is taken as one note with its `rootNote` recorded, so the sampler plays it at the right pitch. A bank can also name several files, each with its own display name and taxonomy. `bun run library:acquire -- --bulk freepats` ingests the declared FreePats banks (synthesizer percussion, world percussion, and one note from each pitched synth bank), and `-- --bulk karoryfer` ingests Karoryfer's CC0 Caveman Cosmonaut.

**Private-alpha drum-machine kits.** `acquire/alphaSources.mjs` declares the DEC-010 kits in one file: the Rob Roy TR-909 and Fischer TR-808 sets (from `fluid-music/open-drums`, WAV) and nine machines from `smpldsnds/drum-machines` (Ogg Opus, decoded with `ogg-opus-decoder` because `node-web-audio-api` cannot). They ingest with `bun run library:acquire -- --bulk open-drums` and `-- --bulk smpldsnds` into the `alpha-drum-machines` pack under the `private-alpha` rights position. Their evidence quotes the recordist's or host's own words, not a licence. They may keep machine names such as "TR-909", and they are left out of the section 6.4 balance, because they are not part of the approved library and leave with CNT-003.

Two guardrails keep it honest:

- **A placeholder archive URL refuses to ingest.** The declared `archiveUrl` starts as the source's landing or bank page; the ingest fails until a curator confirms CC0 on that page and sets `archiveUrl` to the exact `.zip` they reviewed. A real acquisition needs the specific archive, not the page it was found on.
- **The provenance says what it is.** Bulk-archive assets carry `sourceType: recorded`, `reviewState: metadata-review` with a `<source>-cc0-bulk` reviewer, the archive URL in `downloadUrl`, and the member path they came from. Producer Space IDs sit in a `7NNN` range and FreePats in an `8NNN` range, both disjoint from the synthesized catalogue (base <5000), the lockfile ingest (5000), and VCSL (6000), so no two paths can collide.

### 15.10 Freesound via the API, filtered to CC0

The mined Freesound Loop Dataset candidates (section 15.7) are all `unconfirmed` because the per-sound licence lives only inside the dataset's 8.8 GB archive, so a curator had to open each page to find the CC0 ones — the source of the "too noisy to review" problem `DEC-003` set out to fix. The Freesound API resolves this at the source: it returns each sound's `license` directly and supports `filter=license:"Creative Commons 0"` server-side.

```sh
FREESOUND_API_KEY=… bun run library:freesound        # query named gaps, write CC0 candidates
FREESOUND_API_KEY=… bun run library:freesound -- --dry
bun run library:candidates                            # fold them into candidates.json
```

`acquire/freesoundGaps.mjs` is a short, hand-written list of *named coverage gaps* — the classic drum-machine hits (909/808/707), a few organic kit pieces, and some texture/FX material — each a query plus the taxonomy and seed tags a match should land under. `library:freesound` (`freesound.mjs`, `acquire/freesoundApi.mjs`) runs each query filtered to CC0, defensively re-checks the `license` field on every result, and writes the CC0 sounds to `acquire/candidate-sources/freesound-cc0.json`. `library:candidates` folds that file into `candidates.json` as `verified-cc0` entries that sort to the top of the review queue, so the curator reviews musical quality and provenance (section 3.3), not the licence.

This is still not a crawl and not a "download this tag" mode: a person writes each gap query, and every result is only a candidate *page* that flows through the unchanged pin → review → commit → ingest path (section 15.5). The API resolves the licence; a Freesound download still needs OAuth at `--pin` time exactly as before. Adding a gap is a content-coverage decision, not a rights one — the API filter and the section 3.2 allowlist still gate what is bundleable.

### 15.8 Repacking the starter library

`CNT-000b` moved the library onto the pack model (section 5.1): every asset belongs to exactly one pack, the build emits one manifest per pack plus a pack index, and asset identity, the delivery layout, and the acquisition lockfile all carry a pack. It was scheduled in Alpha Milestone 0 for one reason: the change was cheap while it was still nearly free — before Alpha Milestone 0 there are no saved projects whose asset references would need migrating.

**The pack list.** `scripts/starter-library/packs.mjs` is the one place pack membership is decided. The synthesized 200 split along the lines they already have — the section 15.2 families and their genre tags — into five packs, none thin enough to merge:

| Pack | Family | Assets | Rights position |
| --- | --- | ---: | --- |
| Core Electronic Drums | `drums` | 111 | `solid-groove-owned` |
| Foundation Bass | `bass` | 21 | `solid-groove-owned` |
| Tonal Elements | `tonal` | 25 | `solid-groove-owned` |
| Ambient Textures | `texture` | 19 | `solid-groove-owned` |
| Transitions & FX | `fx` | 24 | `solid-groove-owned` |

Every pack's `coverage` claim (its declared roles, genres, and intensities) is checked at build time against what it actually delivers — a pack cannot claim a role or genre none of its assets carry — and every pack's description states what it does not contain (section 6.5). These packs stay testing content at the `metadata-review` intake state, exactly as before; splitting the catalogue does not promote it, and `CNT-002` still supersedes it.

Acquired CC0 content is delivered in three focused packs, each with its own coverage claim (CNT-002). They replaced the single `cc0-community` grab-bag, which is retired. **Drums & Percussion** (`cc0-percussion`) holds VCSL drums and hand percussion, FreePats world percussion, and FreePats synthesizer drum hits. **Keys, Mallets & Bells** (`cc0-keys-mallets`) holds VCSL's pitched instruments. **Synth Tones** (`cc0-synth-tones`) holds the FreePats pitched synth banks and Karoryfer Caveman Cosmonaut. Every bulk source names its destination pack, and VCSL routes by family (drums to percussion, everything else to keys). A pack ref is written into each acquired bundle at ingest, so re-run the ingests after a pack change.

**Delivery layout:**

```text
library/
  audio/sha256/<aa>/<bb>/<sha256>.wav          unchanged — content-addressed, immutable, shared across packs
  packs/index.json                             mutable pointer list of available packs, max-age=60
  packs/<pack-slug>/v<major.minor.patch>.json  immutable pack manifest, max-age=1y
  packs/<pack-slug>/latest.json                mutable pointer, max-age=60
```

Audio storage keys did not change. Identity is still the SHA-256 of the bytes, so two packs containing the same audio would share one object, and a repack re-uploads no audio — verified by running `library:build` twice into separate output directories and diffing them byte-for-byte, and by uploading twice against the Storage emulator: the second run uploads only the mutable pointers, and bumping one pack's `version` and re-running uploads exactly that pack's new manifest, nothing else (see `docs/testing.md`).

**Asset identity.** Synthesized asset IDs are unchanged (`sg-one-shot-<family>-<role>-NNNN`, still append-only and pinned by `catalog.test.mjs`) — only a `pack: { id, version }` field was added to each asset record. Nothing needed renumbering because packs align exactly with the families the IDs already encode.

**Validation.** `validate.mjs` gained the section 9 pack rules, checked per pack manifest: exactly one pack per asset, no asset licence exceeding its pack's rights position (an asset's `license.id` must equal its pack's `rights.licence`), no undefined pack referenced (both a manifest's own `pack.slug` and every lockfile selection's destination pack are checked against `packs.mjs`), and every pack delivering the roles and genres its coverage claim advertises. The section 6.4 collection balance and section 6.1 taxonomy-coverage rules still run once, across every pack's assets concatenated — section 6.5 is explicit that those are measured library-wide, not per pack.

**Acquisition.** A lockfile selection names its destination pack (`asset.pack`, a slug) at pin time; `validateLockfile`/`validateDraft` reject an unknown pack or one whose rights position the source's licence cannot satisfy, and `ingestSelection` re-checks both before writing a single byte. `library:manage`'s review form carries the same destination-pack field. The VCSL bulk path has no per-file lockfile entry, so it targets the reserved `cc0-community` pack directly in code.

### 15.9 Generalized ingestion: loops, presets, derived masters, and intake states

`CNT-000` built the pipeline for one asset type. `CNT-001` generalizes it to the rest of the section 5 "Asset types" list rather than starting a second pipeline beside it: one catalogue, one set of builders, one validator, one delivery layout, one uploader, and one pack index, with a `type` discriminator and a per-type block where the types genuinely differ.

**Asset types.** `taxonomy.mjs` owns the vocabulary; the ID scheme is `sg-<type>-<family>-<role>-NNNN`, so the four ranges cannot collide however each grows and a stored reference states what it points at. Group numbering stays append-only in every range.

| Type | Role vocabulary | Master | Type-specific block |
| --- | --- | --- | --- |
| `one-shot` | `TAXONOMY` (section 5.2) | `.wav` | `audio.rootNote`, `audio.chokeGroup` |
| `loop` | `LOOP_TAXONOMY` — `full-loop`, `top-loop`, `percussion-loop`, `bassline`, `chord-loop`, `melodic-loop`, `atmosphere-loop` | `.wav` | `audio.grid`, `audio.seam`, `audio.timeSignature` |
| `preset` | `PRESET_KINDS` — `drum-kit`, `instrument`, `device-chain` | `.json` | `preset` (pads, zones, or devices) |
| `derived` | inherited from its source | `.wav` | `derivedFrom` |

**Loops are measured, not claimed.** Section 10 requires a verified BPM, an exact bar count and time signature, integer sample boundaries, and at least 32 clean cycles. Each of those is a *measurement* the pipeline writes into the manifest and the validator then checks:

- `audio.grid` compares the buffer that exists against the buffer the declared BPM, bars, and time signature require. A non-zero `errorSamples` is a wrong tempo, and `sampleAligned: false` is a bar length that is not a whole number of samples — 4/4 at 48 kHz needs `11,520,000 / BPM` to be an integer, which is why the catalogue's loops sit at 90, 96, 100, 120, 128, 150, and 180 BPM.
- `audio.seam` concatenates the loop 32 times and compares the largest sample-to-sample step that appears *only* at a wrap point against the largest step inside the loop. A wrap step that is an outlier is a click, and the loop is rejected.

Synthesized loops are seamless by construction — `loops.mjs` mixes each pattern hit with wrap-around, so a hat tail that runs past the last bar reappears at the top of the loop — but they are measured anyway, because the same rules have to reject an acquired loop whose filename lied.

**Presets carry no audio.** A preset's master is the deterministic JSON of its definition, content-addressed and delivered through the same path as a WAV (`contentTypeForKey` picks the content type from the key's extension). Its body references pack-qualified asset IDs, never filenames or URLs (section 9), and the validator resolves every pad and zone library-wide: a reference to an asset that is not delivered — including one that was quarantined — is a broken path, and a reference into another pack breaks section 5.1's self-containment rule. Multisample instruments additionally have their zones checked for contiguity, overlap, and roots that lie inside their own range (section 10, "Sampled instruments").

**Derived masters record their source.** Section 10 says to keep a checksum of the untouched source and treat processed masters as derived assets, so `derivedFrom` names the source asset ID, the transform, and the source's SHA-256, and the validator checks the checksum against the source's actual master and that `provenance.modifications` records the transform.

**Intake states and quarantine.** `intake.mjs` implements the section 11 ladder. `metadata-review` is the delivery floor; `candidate`, `rights-review`, `quarantine`, `audio-preparation`, and `removed` are withheld, and an unknown state is withheld too — a typo must never be the reason something unreviewed reaches a bucket. `deprecated` still ships, because section 11 state 8 keeps existing project references resolvable; hiding it from new selection is a browser concern.

Isolation is a build-time partition, not an error: `buildAllPacks` splits what it produced into what ships and what is held back, reports the withheld list in `library:build`/`library:validate`, and carries on. That is also the missing/corrupt path — a record whose bytes are empty or disagree with the size the manifest declares is quarantined with a reason rather than taking the build down. If an undeliverable asset does reach a published manifest, the validator fails: the partition and the rule check each other.

**New validator rules.** On top of the section 9 and 5.1 rules `CNT-000b` added, `CNT-001` rejects: an ID whose type does not match the asset's `type`; the same asset ID in two packs (`validateLibraryReferences` — duplicate IDs were previously only checked within a pack); a licence evidence path that does not resolve to a file; an asset that requires attribution its pack's rights position does not carry, or claims raw redistribution its pack does not approve; a preset that claims audio metadata; a loop that clicks, is off its bar grid, is not sample-aligned, or was tested over fewer than 32 cycles; a derived master with no source, an unknown transform, an unrecorded transform, or a source checksum that does not match; and an undeliverable intake state inside a published manifest. Each rule is exercised by a fixture that violates it in `scripts/starter-library/ingestion.test.mjs`.

**The application consumes the generated manifest.** `bun run library:emit-runtime` writes `src/library/factoryLibrary.generated.ts` — the handful of assets the app must have before any manifest fetch — and renders their audio into `public/samples/starter-library/audio/<storageKey>`, at the same content-addressed key the bucket serves. `src/library/factoryLibrary.ts` is the app's read side, and the "New Project" starter builds its sampler asset from it rather than from a hard-coded name, path, and duration. It runs from `predev`, `prebuild`, and the browser suites' pre-hooks (via `bun run samples`), writes audio only when missing, and its `--check` mode fails on a stale committed module; the same assertion runs in the unit suite. This is not a bundled library — section 12's model is still that a client fetches the pack index and then the pack manifest it needs, which is `LOOP-013`.

### 15.11 The release audit

`bun run library:audit` (#78) is the section 13 Phase D audit set, run over exactly what `library:upload` would publish: it builds in memory, like `library:audition`, and judges the bytes rather than the records the build wrote about them. CI does not run it: run it by hand before a release. Errors fail it; warnings are findings for a curator, printed and never dropped. `--json` prints the same report as data.

| Audit | Fails on | Flags for review |
| --- | --- | --- |
| `pack` | Any section 9/5.1 rule `validatePackManifest` holds for that pack (coverage claim, rights position, licence evidence, payload budget); a description that does not say what the pack leaves out (section 6.5) | A pack with no coverage claim |
| `missing-file` | An entry with no delivered file, or one whose size disagrees with its record; a delivered file no entry names | |
| `decode` | Bytes that do not match the recorded SHA-256; a WAV that does not decode as 24-bit PCM; a rate, channel count or length that disagrees with the record; a preset that does not parse | |
| `loudness` | A measured peak more than 0.1 dB from the record, above -0.1 dBFS, or silent | RMS below -40 dBFS (too quiet to audition); a crest factor under 3 dB (brick-walled) |
| `tuning` | A pitched (`bass`, `tonal`) one-shot with no root note; a root with no tuning reading or more than 50 cents out | A pitched derived master with no root, since its transform moved the pitch; a root the detector found `undetectable` or `gliding` (section 15.12), left to the section 11 listening review. A loop is not tuned: its root is its key |
| `loop-boundary` | A loop re-measured off its bar grid, not sample-aligned, or clicking at the wrap over 32 cycles | |
| `duplicates` | The same master in two packs (the validator already rejects it inside one) | Two masters with the same length and the same 48-bin overview: a near duplicate to check by ear |

The report leads with one line per pack: pass or fail, version, asset count, its rights position, and how many roles and genres it claims. What the audit cannot hear is still the section 11 musical review: `library:audition` remains the step where a kick is checked for sounding like a kick.

### 15.12 Audio audits

`library:validate` (and `library:build`, `library:audition` and `library:upload`, which run the same checks) audits the audio itself, not only its metadata. Every measurement is taken from the delivered WAV bytes in `buildAllPacks` (`measureDelivered` in `manifest.mjs`), so synthesized and acquired masters go through one path, and every rule only *flags*: nothing in an audit changes a sample. The per-asset rules live in `validate.mjs`; the rules that compare an asset with the rest of the library live in `audits.mjs`, and each has a fixture that violates it in `audits.test.mjs`.

**Loudness.** `audio.loudnessLufs` is the integrated loudness per ITU-R BS.1770-4 (`integratedLoudness` in `dsp.mjs`): K-weighting, 400 ms blocks at 75% overlap, the -70 LUFS absolute gate and the relative gate 10 LU below. Channels are weighted 1.0 and a mono master is measured as one channel, as the sampler plays it. One extension is deliberate: BS.1770 gives no figure for material shorter than one 400 ms block, and many one-shots are, so a sound that short is measured as a single block of its own length. That is how loud the hit is while it sounds, which is what an audition level is about, but it is not a BS.1770 figure.

- A missing measurement fails, and so does `null`: every block fell under the absolute gate.
- An asset more than **12 LU** from the median of its role band (`family/role`, across every pack and type) is reported as an outlier: a warning that names it, for a person to audition. A band of fewer than three measured assets is compared with its family's median instead. 12 LU is roughly four times or a quarter as loud as the rest of the band. It is wide on purpose: section 10 keeps useful dynamics, and K-weighting reads sub-heavy material several LU quieter than it sounds (the synthesized octave-down sub sits 8.6 LU under its band for that reason alone).
- An outlier is a warning, not a failure, because a quiet sound is not by itself a defect. A sparse chord with a long decay measures far under a band of dense hits and is exactly the dynamics section 10 keeps; failing it would push the library towards the normalizing section 10 forbids. If the audition finds the level is a mistake, the remedy is to re-prepare the file or retire it, never to normalize the collection.
- A band mixes one-shots and loops. Split by type, most loop bands would be too thin to have a median and fall back to the family, which mixes them again.

Measured across the whole library with every acquired source ingested (476 audio assets: 216 synthesized; 260 acquired from VCSL, every FreePats bank, Karoryfer, both open-drums kits and the nine smpldsnds kits), one asset is reported: `sg-one-shot-tonal-chord-6020`, a VCSL Dan Tranh chord at -29 LUFS, 12.5 LU under the tonal/chord median of -16.5. It is sparse, with a long decay: the useful dynamics section 10 keeps, which is why an outlier is a warning. No synthesized asset is outside its band; the widest is that octave-down sub. CI builds without the acquired content, so these figures come from a local run with it ingested.

**Tuning.** For a one-shot or derived master whose `rootNote` names the pitch it sounds at, `audio.tuningCents` is now measured rather than claimed: the builders and ingest paths used to write `0` for every tonal asset, which recorded a hope, not a detection. `measureTuning` in `dsp.mjs` runs YIN over up to 24 frames from 20 ms after the peak, searching within 1.1 octaves of the root, and keeps only frames whose aperiodicity is under 0.1. A subharmonic check guards YIN's first-dip choice: when an upper harmonic dominates the fundamental, the sound nearly repeats at a fraction of its period (2/3 of it for a strong 3rd harmonic, a fifth sharp), so a later dip that is not a whole multiple of the first and at most half as aperiodic is taken as the period instead. The pitch is read from the later half of those frames, so a tom or a tuned bass is judged where its designed pitch drop settles, and it is folded to the nearest octave: tuning is the cents correction, and a periodicity detector cannot judge the octave reliably. `audio.tuningStatus` says what the detector found:

| `tuningStatus` | Meaning | `tuningCents` |
| --- | --- | --- |
| `detected` | A settled, periodic pitch | The offset from the root, in whole cents |
| `undetectable` | Too few periodic frames: noise, inharmonic partials (bells, modal struck bars, most chords and detuned stacks), or too short | `null` |
| `gliding` | Periodic, but the two halves of the settled stretch differ by more than 20 cents | `null` |
| `null` | Not audited: no `rootNote`, or a loop, whose `rootNote` is its key rather than one sounding pitch | unchanged |

- A pitched asset with no `tuningStatus`, or a `tuningCents` claimed where no pitch was detected, fails.
- A detected pitch more than **50 cents** from the root fails: past that the root names the wrong semitone, and a sampler mapping the sound by it plays every key out of tune. Inside it, the recorded `tuningCents` is the fine correction, which is metadata, not a fault.
- `undetectable` and `gliding` are not faults. The detector cannot judge them, so they stay with the section 11 listening review, and the build prints how many there are so "no tuning errors" is never read as "every root was checked".

Across the whole library with every acquired source ingested, 94 assets declare a pitch and none is beyond the tolerance: 65 are detected, all within ±9 cents, 27 are undetectable and 2 glide. Of those, the synthesized library's 77 are 49 detected (within ±9 cents), 26 undetectable (mostly the modal struck, chord, stab and reese voices, plus one short sub, one bass stab and one pluck) and 2 gliding (a short tom and a modal mallet). The acquired 17 (the pitched FreePats synth banks and Karoryfer's Caveman Cosmonaut; VCSL, the percussion banks and the drum-machine kits declare no root) are 16 detected within ±5 cents and one undetectable FreePats stab. The subharmonic check changes none of these readings; it is there for a harmonic-dominant timbre the library does not yet hold.

**Duplicate audio.** Two halves, both run across every pack:

- *Exact*: byte-identical masters, by SHA-256. Inside one pack this has always failed. Across packs it is how two packs share one stored object, so it is a warning, not a failure, but it is one sound and section 17 counts unique assets.
- *Near*: every master carries a fingerprint in two parts: the 48-bin `peaks` envelope it already had, and `audio.spectralSketch`, its long-term power spectrum in 32 log-spaced bands from 20 Hz to 16 kHz (`spectralSketch` in `dsp.mjs`; 8192-point Hann frames), each band in half-dB steps below the loudest and floored 40 dB down. Neither part changes with level. Two masters are near duplicates when their lengths are within 10%, their envelopes differ by at most 3% of full scale on average, and their sketches by at most 1 dB per band on average. A copy that was only re-gained, re-encoded or trimmed by a few percent sits well inside all three. Each pair is a warning that names both assets, because a fingerprint cannot tell a lazy copy from two deliberately close variations; that is the human review section 10 asks for. A missing or malformed sketch fails.

Across the whole library with every acquired source ingested (476 audio assets), no master is byte-identical to another and four pairs are reported. Three are among FreePats' synthesizer-percussion cymbals: `sg-one-shot-drums-cymbal-8005`, `-8006` and `-8007` ("Electric Percussion Cymbal 01 01" to "01 03", from `Cymbal01-01.flac` to `-03.flac`), which pair with each other within 0.8% in envelope and 0.84 dB in spectrum, most likely round-robin takes of one hit. The fourth is synthesized: `sg-one-shot-drums-kick-0001` ("Rounded Club Kick") and `sg-one-shot-drums-kick-0004` ("Soft Rounded Kick"), two sine-sweep kicks a few parameters apart. The next-closest pair, the tight and clicky house kicks (`-0002` and `-0009`), sits just outside the envelope limit; every other synthesized pair is clearly outside at least one limit. Whether to keep each flagged pair, the cymbals and the kicks, is the section 11 listening review's call: `-0001` is also the starter kick a new project is built with.

## 16. Pack marketplace

Deliberately out of scope until everything else is done. Recorded here so the pack model stays honest about what it is preparing for, not because any of it is alpha work.

The opportunity: users build their own packs from their own material and offer them to other users, third-party sound designers publish packs, and premium packs are sold. The pack model in section 5.1 is what makes that possible without a second content system — a pack is already versioned, self-describing, rights-carrying, and independently deliverable.

What it needs that the alpha does not build:

- **Authoring.** Tools for a user to assemble, name, tag, describe, preview, and version a pack from their own imported content (PRD `LIB-03`), with the same metadata and quality expectations this plan applies to factory content.
- **Rights.** A creator agreement covering what a publisher warrants about their material, what licence a buyer receives, what happens on a rights dispute, and revenue sharing. Nothing may be published that the publisher cannot grant.
- **Moderation and takedown.** A review path before publication, a reporting path after it, and a takedown that disables a pack for new use without breaking projects that already reference it — the section 11 `Removed` state, applied at pack scale.
- **Entitlement.** Per-user pack visibility, purchase and refund handling, and behaviour when access ends: a project that used an acquired pack must keep opening and playing, with any restriction stated plainly rather than discovered as silence.
- **Curation.** Discovery, ranking, and quality expectations for third-party packs, so the marketplace does not become the undifferentiated catalogue section 1 rejects.

Open questions belong to the product owner and are listed in PRD section 16.

## 17. Alpha acceptance checklist

- Every delivered factory asset has approved raw-redistribution rights and archived evidence.
- No standard consumer royalty-free pack is bundled without a separate OEM grant.
- No asset depends on a third-party URL remaining live.
- Every audio file resolves through a stable asset ID and immutable version.
- Every asset belongs to exactly one pack, and no asset's licence terms exceed its pack's rights position.
- Every shipped pack meets its coverage claim, can build a usable idea for its stated purpose on its own, and states what it does not contain.
- A project records the packs and versions it depends on; republishing a pack does not change an existing project, and an unavailable pack is reported with its affected tracks and clips rather than breaking playback or export.
- Bootstrap, production-seed, and alpha counts are measured from approved unique assets only.
- Lofi, Trance, UK Garage, Breakbeat, and Electronic Pop meet their section 7.7 coverage gates using the shared library.
- At least 15% of the approved collection is tagged and reviewed as experimental or cross-genre.
- All loops pass BPM/bar/seam tests and all tonal assets have reviewed tuning metadata.
- Every required asset decodes and plays in supported Firefox, Chrome, Edge, and Safari versions.
- The 2019 Intel MacBook Pro baseline meets search, first-audition, caching, and project-load targets.
- Stereo, stem, collaboration, and Ableton exports preserve or render every used asset according to its manifest and licence policy.
- Removing a library asset from new-project discovery does not corrupt existing project state.
