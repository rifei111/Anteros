/**
 * 语音策略（docs/语音条.md 10.1–10.3）。
 *
 * 这里只回答一个问题：**这一次回话，该不该出声**。
 * 答案必须能被解释——所以每个"不发"都带一句中文原因，直接进 media.status / 日志，
 * 而不是让用户猜"为什么它今天不说话了"。
 *
 * 阈值全部集中在下面四个常量里，改行为只改这里。
 */
import type { PresenceState, RelationStage } from "@anteros/shared";

/** 硬门槛：超过这个字数，念出来就是一封语音信，不是说话。 */
export const VOICE_MAX_CHARS = 56;
/**
 * 外部通道（那种「按住说话」的语音消息）单独的上限：对面的语音条上限是 60 秒，
 * 一条 200 字的话念出来约 40 秒，正好在限内。用 56 字卡外部通道，
 * 结果是「开关开了也永远不出声」——用户看到的就是「让它发语音它一直不发」。
 */
export const VOICE_EXTERNAL_MAX_CHARS = 200;
/** auto 档位里"关系够近"的分界：只有熟人/亲近的人值得听到声音。 */
export const VOICE_INTIMATE_STAGES: RelationStage[] = ["familiar", "close", "repairing"];
/** auto：情绪浓时（说得出来但不像念稿）的放宽上限。 */
export const VOICE_EMOTION_MAX_CHARS = 40;
/** auto：主动消息/冲动消息本来就短，放宽到 32 字。 */
export const VOICE_SPONTANEOUS_MAX_CHARS = 32;
/** auto：情绪"浓"的判据。 */
export const VOICE_EMOTION_VALENCE = 0.4;
export const VOICE_EMOTION_AROUSAL = 0.6;

export type VoiceOutboundSetting = "off" | "auto" | "always";

export interface VoiceContext {
  /** 设置里 media.voiceOutbound */
  outbound: VoiceOutboundSetting;
  /** 插件自报的合成能力；false 时永远不出声 */
  speakReady: boolean;
  /** 这条会话是不是外部通道（邮件、即时消息之类）：外部通道默认不出声，避免吓到对面 */
  externalChannel: boolean;
  /**
   * 这条会话要发语音条（外部通道的开关打开时由上层置 true）。
   * 为 true 时按语音消息的口径判：不算「外部通道默认不出声」这条，字数上限也用外部通道的。
   */
  voiceMessage?: boolean;
  /** 它现在在不在：sleep/busy 的时候不该开口 */
  presence: PresenceState;
  /** 这次回复用的文字（不分条前的全文） */
  fullText: string;
  /** 这次是不是降级回复（模型超时等），降级不配音 */
  degraded: boolean;
  trigger: "reply" | "proactive" | "impulse";
  stage: RelationStage;
  moodValence: number;
  moodArousal: number;
}

export interface VoiceDecision {
  action: "voice" | "off";
  /** 给人看的原因；action === "voice" 时说明为什么这次出声 */
  reason: string;
}

/** 纯函数：给定上下文，决定这次发不发语音。 */
export function decideVoice(ctx: VoiceContext): VoiceDecision {
  const len = [...ctx.fullText.replace(/\s+/g, "")].length;
  const asVoiceMessage = ctx.externalChannel ? ctx.voiceMessage === true : false;
  if (ctx.outbound === "off") {
    return {
      action: "off",
      // 说清楚该去哪儿开：外部通道的开关不在「声音」页，在它自己的通道页
      reason: ctx.externalChannel
        ? "外部通道的语音条没开（管理面板 → 通道 → 那个通道 → 语音条开关）"
        : "语音回复没开（设置里可以开）",
    };
  }
  if (!ctx.speakReady) return { action: "off", reason: "语音插件没就绪（没配 key 或没启用）" };
  if (ctx.externalChannel && !asVoiceMessage) return { action: "off", reason: "外部通道会话默认不出声" };
  if (ctx.presence === "sleep" || ctx.presence === "busy") {
    return { action: "off", reason: `它现在在场状态是 ${ctx.presence}，不该开口` };
  }
  if (ctx.degraded) return { action: "off", reason: "这次是降级回复，不配音" };
  const maxChars = asVoiceMessage ? VOICE_EXTERNAL_MAX_CHARS : VOICE_MAX_CHARS;
  if (len > maxChars) return { action: "off", reason: `太长（${len} 字 > ${maxChars} 字）` };
  if (ctx.stage === "strained") return { action: "off", reason: "关系紧张的时候发语音像在讨好" };

  // 语音条是一整条消息，没有「气泡」的概念：开关开了就发，不再按熟人/情绪挑
  if (asVoiceMessage) return { action: "voice", reason: "外部通道语音条已开启，按语音消息发" };

  if (ctx.outbound === "always") return { action: "voice", reason: "always 档位，除硬门槛全发" };

  if (VOICE_INTIMATE_STAGES.includes(ctx.stage) && len <= 24) {
    return { action: "voice", reason: `关系是 ${ctx.stage} 且话短（${len} 字）` };
  }
  if ((Math.abs(ctx.moodValence) >= VOICE_EMOTION_VALENCE || ctx.moodArousal >= VOICE_EMOTION_AROUSAL) && len <= VOICE_EMOTION_MAX_CHARS) {
    return { action: "voice", reason: `情绪浓（效价 ${ctx.moodValence.toFixed(2)} / 唤醒 ${ctx.moodArousal.toFixed(2)}）且话不长` };
  }
  if (ctx.trigger !== "reply" && len <= VOICE_SPONTANEOUS_MAX_CHARS) {
    return { action: "voice", reason: `${ctx.trigger} 这种主动开口本来就短` };
  }
  return { action: "off", reason: `auto 档位没到出声的门槛（${len} 字，关系 ${ctx.stage}）` };
}

/** §10.3 韵律：情绪高说快一点，累了慢一点；音量跟着亲近度和心情走。 */
export function prosodyFor(moodArousal: number, energy: number, warmth: number, moodValence: number): { rate: number; volume: number } {
  const rate = clamp(1.0 + 0.12 * moodArousal - 0.1 * (1 - energy), 0.85, 1.15);
  const volume = clamp(0.8 + 0.25 * warmth + 0.1 * moodValence, 0.7, 1.0);
  return { rate: Number(rate.toFixed(3)), volume: Number(volume.toFixed(3)) };
}

function clamp(v: number, lo: number, hi: number): number {
  if (!Number.isFinite(v)) return lo;
  return Math.min(hi, Math.max(lo, v));
}

/** §10.2 朗读稿改写用的系统提示：只做读法转换，不许增删信息。 */
export const SPEECH_REWRITE_SYSTEM = [
  "你把一句话改写成适合念出来的口语稿，只做读法转换。",
  "规则：",
  "1. 不改信息点，不加新内容，不删意思；不能变长。",
  "2. 书面词换口语词（例如「因此」→「所以」，「此外」→「还有」）。",
  "3. 数字、时间、金额、单位改成念出来的说法（例如 3.5% → 百分之三点五）。",
  "4. 去掉括号、星号、井号、颜文字、表情符、多余空格和 Markdown。",
  "5. 长句断开成短句，用逗号或句号，不超过二十个字一句。",
  "6. 不要加语气词，不要加开场白，不要解释你在做什么。",
  "只输出改写后的正文，不要任何前后缀。",
].join("\n");