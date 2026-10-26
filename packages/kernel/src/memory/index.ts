/** 记忆内核的公开入口（供 app.ts / 测试使用；端口契约在 ../../contracts.ts）。 */
export { MemoryService } from "./service.js";
export { baseLevel, activation, recallProbability, emotionTerm, cueTerm, appendAccessLog } from "./actr.js";
export { buildReencodedEpisode, shouldReencode, reencodeText } from "./reencode.js";
export { extractRules, mergeExtractions } from "./extraction.js";
export { retrieve, collectPinned, textSimilarity } from "./retrieval.js";
