/**
 * 模型输出的清洗：把「思考过程」从正文里剥掉。
 *
 * 起因：有的推理模型（DeepSeek-V4 / Qwen 系列等）在 OpenAI 兼容接口下
 * 会把思维链直接写进 `message.content`，标签还可能是残缺的
 * （`<think` / `</think` 没有收尾的 `>`）。这些内容一旦进分条逻辑，
 * 就会被当成一条条气泡发给用户——实测出现过「<think」「我得说得软一点……」
 *
 * 这里只做一件事：正文之外的东西一律丢掉，绝不改写正文。
 */

const OPEN_TAG = /<\s*(?:think|thinking|thinker|reasoning|analysis|scratchpad)\b/gi;
const CLOSE_TAG = /<\s*\/\s*(?:think|thinking|thinker|reasoning|analysis|scratchpad)\b\s*>?/gi;

/** 整段包裹的思考块：`【思考】…【/思考】`、`[thinking]…[/thinking]`。 */
const CN_BLOCK = /【\s*(?:思考|分析|推理)】[\s\S]*?(?:【\s*\/\s*(?:思考|分析|推理)\s*】|$)/g;

/** 行首的「思考过程：」「分析：」这类标记（只在这些词后面紧跟冒号时才算）。 */
const LEADING_LABEL = /^\s*(?:思考过程|思考|分析过程|分析|推理过程|reasoning|thinking)\s*[:：]\s*/i;

/**
 * 剥掉思考内容。
 * - 完整的 `<think>…</think>`（以及残缺写法）整段删除；
 * - 只有开标签没有闭标签：从开标签删到结尾（后面通常没有正文了）；
 * - `【思考】…【/思考】` 同理；
 * - 开头若有「思考过程：」这种标签，连标签带内容一起删到第一个空行。
 */
export function stripReasoning(raw: string): { text: string; removedChars: number } {
  const original = raw ?? "";
  let text = original;

  // 1. 先处理成对的标签（含残缺的收尾标记）
  for (;;) {
    OPEN_TAG.lastIndex = 0;
    const open = OPEN_TAG.exec(text);
    if (!open) break;
    const openIndex = open.index;
    CLOSE_TAG.lastIndex = openIndex + open[0].length;
    const close = CLOSE_TAG.exec(text);
    if (close) {
      text = text.slice(0, openIndex) + text.slice(close.index + close[0].length);
      continue;
    }
    // 没有配对的收尾：把开标签之后的内容都当成思考，整段丢掉
    text = text.slice(0, openIndex);
    break;
  }

  // 2. 中文标记块
  text = text.replace(CN_BLOCK, "");

  // 3. 行首「思考过程：」标签：只删标签，删不掉就删到下一个空行
  text = text.replace(LEADING_LABEL, "");

  // 4. 清掉残留的孤立标签（例如被流式切碎后只剩 `<think`）
  text = text.replace(/<\/?\s*(?:think|thinking|thinker|reasoning|analysis|scratchpad)\b\s*>?/gi, "");

  // 5. 去掉开头几行"自言自语"式的整行括号旁白：（…）/ (…)，且明显是分析而非语气词
  text = dropLeadingAsideLines(text);

  // 6. 收尾：压掉多余空行与首尾空白
  text = text
    .split("\n")
    .map((line) => line.trimEnd())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  return { text, removedChars: Math.max(0, original.length - text.length) };
}

/**
 * 起始处整行都是括号旁白时丢掉它。
 * 判据保守：整行以（或( 开头、以）或) 结尾、长度 ≥ 12，且后面确实还有正文。
 * 这样 `（笑）` 这种正常语气词不会被误删。
 */
function dropLeadingAsideLines(input: string): string {
  const lines = input.split("\n");
  let start = 0;
  while (start < lines.length) {
    const line = lines[start]!.trim();
    if (line.length === 0) {
      start += 1;
      continue;
    }
    const isAside = /^[（(]/.test(line) && /[）)]$/.test(line) && line.length >= 12;
    if (!isAside) break;
    start += 1;
  }
  if (start === 0 || start >= lines.length) return input;
  return lines.slice(start).join("\n");
}