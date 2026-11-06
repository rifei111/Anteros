/**
 * 语言策略：只做收拾，不做发明。
 *
 * 历史教训（v1.0.11 → v1.0.12）：这里曾经试着"帮模型补标点"——句末补「。」、
 * 长串里插「，」。结果分条把一句话切在两半时，前半截被补上一个句号，
 * 「是在测试我反应快不快嘛」变成「…反应快。不快嘛」，读起来像结巴。
 * 所以这里回退到最保守的做法：**只删多余的空白和重复标点，一个字都不加**。
 *
 * 标点该怎么打，是模型自己的事（提示词里已经说清楚）；这一层只保证
 * 不乱码、不出现「？？？」「。。」这类肉眼可见的脏东西。
 */

/** 「？。」「，，」「！！」这类连续标点收拾成一个。 */
function collapseRepeatedPunctuation(text: string): string {
  return text
    .replace(/([，。！？、；：,.!?;:])\s*[，。！？、；：,.!?;:]+/g, "$1")
    .replace(/([。！？])[。！？]+/g, "$1")
    .replace(/[，,]\s*([。！？])/g, "$1");
}

/**
 * 收拾一条消息：压掉多余空白、合并重复标点、去掉首尾空白。
 * 纯函数，可单测；**绝不新增任何标点**。
 */
export function polishPunctuation(raw: string): string {
  const text = String(raw ?? "")
    .replace(/\r\n?/g, " ")
    .replace(/[ \t\u3000]+/g, " ")
    .trim();
  if (text.length === 0) return "";
  return collapseRepeatedPunctuation(text).trim();
}