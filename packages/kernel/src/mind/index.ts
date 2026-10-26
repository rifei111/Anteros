/** 心智内核的公开入口（供 app.ts / 测试使用；端口契约在 ../../contracts.ts）。 */
export { MindService } from "./service.js";
export { PersonaService, PERSONA_PRESETS, DEFAULT_PRESET_ID, findPreset, mbtiProjection } from "./persona.js";
export { sampleTraits, mergeTraits, validateTraits, TRAIT_RANGES } from "./traits.js";
export { RelationService, evaluateTransition, stagePhrase, relationDays, ALLOWED_NEXT, STAGE_PROMPT } from "./relation.js";
export { PresenceService, resolvePresence, isSleepWindow, PRESENCE_LABEL, SLEEP_START_MINUTES, SLEEP_END_MINUTES } from "./presence.js";
export { WorldService, daypartOf, timeAnchorOf, DAYPART_LABEL } from "./world.js";
export { DrivesService, advanceDrives, emptyDrives, DRIVE_DEFAULTS, DRIVE_LABEL, DRIVE_NAMES } from "./drives.js";
export { NarrativeService, projectSlots } from "./narrative.js";
export { buildCandidates } from "./actions.js";
