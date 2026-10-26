/** 表达层的公开入口（供 app.ts / 测试使用；端口契约在 ../../contracts.ts）。 */
export { ExpressionService } from "./service.js";
export { PromptAssembler, buildSystemPrompt, EXPRESSION_CONSTRAINTS } from "./prompt.js";
export { splitIntoParts, planParts, typingMsFor, delayAfterMsFor, semanticChunks, maxPartsFor, MAX_PART_CHARS } from "./planner.js";
export { AntiTemplateGuard, threeGramSimilarity, structureIssue, similarityToRecent } from "./antitemplate.js";
