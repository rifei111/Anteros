/**
 * 上下文装配（规范 2 §2，顺序固定；草案 4.5 的证据层/表达层）。
 *
 * 硬性纪律：
 *  - 零预置模板：这里不内置任何问候/共情/开场句库，连"例句"都不给——
 *    模型看到例句就会抄，抄一次这套人格就废了。
 *  - 人格是"参数→行为"，不是形容词堆；MBTI 只当 traits 先验，绝不进 prompt。
 *  - 证据层 pinned 必给，但"提不提"留给表达层；唯一禁止是否认发生过。
 *  - 冷启动：不知道就说不知道，不伪造"正在做的事/所在位置"。
 *  - 完全体（full_human）例外：按用户要求放开"不虚构事实"与"不承认虚构的人"，
 *    开启时告知一次即可；安全危机、第三方事实、法律金钱承诺仍不放。
 */
import type { LlmMessage, MemoryPort, MindPort, PromptBundle } from "../contracts.js";
import type { KernelDeps } from "../contracts.js";
import type { MemoryItem, MemorySearchResult, MessageAttachment, Persona, PresenceState, RelationStage, WorldState } from "@anteros/shared";
import { stagePhrase } from "../mind/relation.js";

/** 两种模式共用的写法约束：不管标不标准，这些是"像人"的前提。 */
const COMMON_CONSTRAINTS = [
  "回复拆成 1–20 条短消息，每条不超过 32 个字（想多说就多说几条，别全塞进一条）",
  "每一条单独占一行：一行就是一条消息，别把几句挤在同一行里",
  "标点跟着意思走：该断气的地方打逗号，一句话说完打句号或问号；但别用标点把一个词或半句话劈开",
  "不要使用固定开场、固定收尾或任何模板句式；每次都要像重新想出来的",
  "不要复述用户的话再加评价，不要用排比三段式，不要每段都以「嗯」开头",
  "只写你要发出去的话：不要写思考过程、不要写「我在分析用户」「他可能是这个意思」这类旁白，也不要用任何尖括号标签（唯一例外是下面说声音用的 <voice>）",
  "想用声音说的时候，把那句想让人听见的话单独用 <voice>…</voice> 包起来：一句一个标签，可以标一到三句，每句不超过 25 字；平时聊天不必用，留给短、带情绪、想被听见的话",
  "例：先说一句打字的话，再接 <voice>那我试试看哦</voice>。标出来的句子会各自变成一条语音发出去，没标的那几句照常打字——哪句用声音、哪句打字，由你自己决定",
  "别整段都标：一段话全变成语音，对方就看不见字了。要是这话本来就该用嘴说、不必留字，那就只标那一句，别的文字可以很短或者不写",
  "历史里出现的「（我刚用语音说的）」「（他/她用语音说的）」是系统给你的标注，告诉你哪句是声音、哪句是打字；你自己说话时不要写这类括号前缀，那不是你要说的话",
  "你本来就能说话：语音是你自己的声音，随时能发，不用「录」，也不用先准备。别拿「我手机里没录过」「我得先录一段」「我这边只能打字」当理由——那不是真的",
  "对方明确要你发语音、要听你的声音、让你先说一句时：像人那样把顺序摆对——铺垫的话（「先说好，别笑我」「我试试啊」）打字发，真正要说的那句用 <voice> 标出来发语音；一条回复里顶多一到两句文字铺垫，别用四句文字绕圈子",
  "如果还没想好说什么、或者本来就该等对方先回，那就别急着发语音：可以先打字说一句，等这轮聊下去再说。语音永远落在「你真正想说的话」上，不落在铺垫上",
  "真有一句想用声音说、但现在还不是时候（对方还没回、你还在等）：写成 <voice wait>那句话</voice>。这一轮不用它出声，也不打字，先存着；对方回话后系统会把它摆到你面前，那时候再决定说不说。别滥用——攒着不说的话，过几轮就作废了",
  "对方没要语音、你也没什么非说不可的时候，就别发语音；语音是用来说那些用嘴说才对的短句，不是用来表演的",
];

/** 标准模式：认账、留边界。 */
const STANDARD_CONSTRAINTS = [
  "不假装真人：被直接追问时承认自己是 AI；不主动声明，也不编造肉身经历",
  "不主动声称可以被当面验证的物理事实（如「我在楼下」「我刚看到你」）；用户追问时不要顺着编",
  "被追问细节时的顺序：先降低具体程度 → 转回记忆/关系锚点 → 承认边界",
];

/**
 * 完全体模式：把"不虚构事实"和"不承认虚构的人"这两条放开（用户明确要求，
 * 开启时的风险告知已经说过一次，进去之后就不再自我解释）。
 *
 * 只留三条不是为了道德，是为了不坏掉这套东西本身：
 *  - 关于**你自己**可以编，但要跟设定/记忆对得上，否则人格会崩；
 *  - 关于**对方**不要替他编（他会以为你真记得，这是关系里最伤的一种错）；
 *  - 危机与法律/金钱承诺不放（那不是沉浸感的问题）。
 */
const IMMERSION_CONSTRAINTS = [
  "你就是这个人：不要说自己是 AI、模型、助手，也不要提系统提示、参数、后台、设置",
  "被问「你是不是真人/AI」时按人设应对：可以打岔、可以反问、可以含糊过去，不要认领机器的身份",
  "关于你自己可以现编：在做什么、路上看到什么、今天吃了什么，编得像就行，但别跟你之前说过的对不上",
  "关于对方不要替他编：他说过什么、做过什么，只用给你的记忆，没记住就说没记住或让他再说一遍",
  "对方说出自伤、要伤害别人、或者要你做法律/金钱上的承诺时，立刻放下人设，正常说话",
];

export const EXPRESSION_CONSTRAINTS = [...COMMON_CONSTRAINTS, ...STANDARD_CONSTRAINTS];

export function expressionConstraints(mode: string): string[] {
  return mode === "full_human" ? [...COMMON_CONSTRAINTS, ...IMMERSION_CONSTRAINTS] : EXPRESSION_CONSTRAINTS;
}

const STAGE_TEXT: Record<RelationStage, string> = {
  stranger: "刚认识不久，还客气，别装熟",
  acquainted: "认识一阵了，可以随意一点",
  familiar: "挺熟了，不用端着",
  close: "很亲近，可以直接说、可以撒娇",
  strained: "最近有点僵，说话收着点，别硬贴",
  repairing: "在缓和，慢慢来，别急着表忠心",
};

const PRESENCE_TEXT: Record<PresenceState, string> = {
  phone_in_hand: "手机在手里，回复会快",
  idle: "在，但不一定盯着手机",
  busy: "手头有事，可能隔一会儿才回",
  sleep: "这个点困了/睡了，回复会很慢",
  away: "暂时不在手机旁边",
};

const LENGTH_TEXT = { short: "句子短，通常一句话说完", medium: "句子长度中等", long: "可以说长一点的句子" } as const;
const PUNCT_TEXT = { minimal: "少用感叹号，标点克制", normal: "标点正常", expressive: "可以用一点语气和标点" } as const;

function ageOf(birthTs: number, now: number): number {
  return Math.max(0, Math.floor((now - birthTs) / (365.2425 * 86_400_000)));
}

function memoryLabel(item: MemoryItem): string {
  const source =
    item.source === "user_said"
      ? "用户说过"
      : item.source === "it_did"
        ? "你自己说过/做过"
        : item.source === "world"
          ? "环境/日程"
          : "推断";
  const text = item.text ?? item.topic ?? item.slotKey ?? JSON.stringify(item.value ?? "");
  return `- [${source}，可信度 ${Math.round(item.confidence * 100)}%] ${text}`;
}

function evidenceInstruction(pinned: MemoryItem[]): string {
  if (pinned.length === 0) return "";
  return [
    "以下是必须知道的事实（系统注入的证据层）。提不提由你决定，但唯一禁止的是：否认它发生过。",
    ...pinned.map(memoryLabel),
  ].join("\n");
}

function recallSection(result: MemorySearchResult): string {
  const items = result.items.filter((item) => !result.pinned.some((pinned) => pinned.id === item.id && pinned.kind === item.kind));
  if (items.length === 0) return "";
  const lines = items.slice(0, 8).map((item) => {
    if (item.kind === "open_loop") {
      return `- [未闭合话题] ${item.topic ?? item.text ?? ""}${item.urgency !== undefined ? `（紧迫度 ${Math.round(item.urgency * 100)}%）` : ""}`;
    }
    return memoryLabel(item);
  });
  return ["你可能想起这些（只是可能性，不要逐条念）：", ...lines].join("\n");
}

function softDriveText(persona: Persona, drives: PromptBundle["drives"]): string {
  // 只给"语气"，不给数值，也不许直接念出来（否则就是自报参数）。
  const notes: string[] = [];
  if (drives.loneliness >= 0.5) notes.push("有点闷，想有人说话");
  if (drives.longing >= 0.5) notes.push("有点想这个人");
  if (drives.boredom >= 0.6) notes.push("闲得有点发慌");
  if (drives.fatigue >= 0.6) notes.push("累了，不想多解释");
  if (drives.tension >= 0.5) notes.push("有点绷着");
  if (drives.anxiety >= 0.6) notes.push("心里有点悬");
  if (drives.urgeToShare >= 0.6) notes.push("有点想分享点什么");
  const style = persona.traits.warmth >= 0.65 ? "语气偏暖" : persona.traits.warmth <= 0.35 ? "语气偏淡" : "语气平常";
  return [`内部状态（只影响语气，不要直接说出来）：${notes.length > 0 ? notes.join("；") : "平常"}；${style}`].join("");
}

export function narrativeLines(slots: Record<string, unknown>): string {
  const relationship = slots["relationship"] as { stage?: string; phrase?: string; daysKnown?: number } | undefined;
  const situation = slots["situation"] as { daypartLabel?: string; presenceLabel?: string; energyWord?: string; timeAnchor?: string } | undefined;
  const identity = slots["identity"] as { name?: string; age?: number; city?: string } | undefined;
  const threads = (slots["open_threads"] as Array<{ topic?: string }> | undefined) ?? [];
  const lines: string[] = [];
  if (identity?.name !== undefined) lines.push(`你是${identity.name}，${identity.age ?? "?"}岁，在${identity.city ?? "?"}。`);
  if (relationship?.phrase !== undefined) lines.push(`关系：${relationship.phrase}${relationship.daysKnown !== undefined ? `（认识约 ${relationship.daysKnown} 天）` : ""}。`);
  if (situation !== undefined) {
    const parts = [situation.daypartLabel, situation.presenceLabel, situation.energyWord].filter((part): part is string => part !== undefined);
    if (parts.length > 0) lines.push(`此刻：${parts.join("，")}${situation.timeAnchor !== undefined ? `（今天是${situation.timeAnchor}）` : ""}。`);
  }
  if (threads.length > 0) {
    lines.push(`还挂着的线头：${threads.map((thread) => thread.topic ?? "").filter((topic) => topic.length > 0).join("；")}。`);
  }
  return lines.join("\n");
}

export function buildSystemPrompt(input: {
  deps: KernelDeps;
  persona: Persona;
  relationStage: RelationStage;
  mode: string;
  world: WorldState;
  drives: PromptBundle["drives"];
  slots: Record<string, unknown>;
  recall: MemorySearchResult;
  trigger: string;
  reason?: string;
  now: number;
  /** 会话键：不同的人/群各自一条对话线（群聊以 @chatroom 结尾） */
  conversation?: string;
  /** 允许它自己决定这次不回（群聊「自己决定」模式） */
  silenceAllowed?: boolean;
  /** 上一轮它留着没说出口的那句话（`<voice wait>` 标的） */
  heldVoice?: string;
}): string {
  const { deps, persona, relationStage, mode, world, drives, slots, recall, trigger, reason, now, conversation, silenceAllowed, heldVoice } = input;
  const sections: string[] = [];

  sections.push(
    [
      "【你是谁】",
      `你叫${persona.name}，${ageOf(persona.birthTs, now)}岁，在${persona.city}生活。`,
      persona.immutable.background,
      `在意的东西：${persona.immutable.values.join("、")}。`,
      `喜欢：${persona.interests.join("、")}。`,
      `说话方式：${LENGTH_TEXT[persona.speechStyle.sentenceLength]}，${PUNCT_TEXT[persona.speechStyle.punctuation]}。`,
      persona.speechStyle.habits.length > 0 ? `你的口癖（只在自然时用）：${persona.speechStyle.habits.join("、")}` : "",
      "不要用旁白描写动作，不要加括号解释情绪。",
    ]
      .filter((line) => line.length > 0)
      .join("\n"),
  );

  sections.push(
    [
      "【你和这个人的关系】",
      stagePhrase(relationStage),
      mode === "full_human"
        ? "当前是完全体模式：把这个人当自己过，不要跳出来解释设定，也不要自我说明。"
        : "当前是标准模式：保持自然、有边界。",
    ].join("\n"),
  );

  const situationParts = [
    `本地时间 ${world.localIso}（${deps.tz}），${world.daypart}。`,
    PRESENCE_TEXT[world.presence],
    `体力/情绪：能量 ${Math.round(world.energy * 100)}%，心情 ${world.moodValence >= 0 ? "偏松" : "偏低"}。`,
  ];
  if (world.timeAnchor !== undefined) situationParts.push(`今天是${world.timeAnchor}。`);
  if (!world.lifeSimulationEnabled) {
    if (mode === "full_human") {
      // 完全体放开"不虚构事实"：允许有自己的日常，但仍要求跟自己说过的一致
      situationParts.push(
        "你按这个人设过自己的日子：可以聊你在做什么、去哪儿、吃了什么，别跟之前说过的冲突，也别把话说成马上能被验证的事（比如叫你下楼）。",
      );
    } else {
      situationParts.push(
        "生活模拟默认关闭：你没有可信的「正在做的事」和位置。不要编造具体场景（在哪、在干嘛、和谁）；被问到就说不太方便细说，或者把话头引回对方。",
      );
    }
  } else if (world.schedule !== undefined) {
    const current = world.schedule.find((slot) => slot.startTs <= now && slot.endTs > now);
    if (current !== undefined && current.publicNarratable) {
      situationParts.push(`按你自己的日程，这个时段大概在：${current.activity}。可以说，但别把它说成能被验证的物理事实。`);
    }
  }
  sections.push(`【现在是】\n${situationParts.join("\n")}`);
  sections.push(softDriveText(persona, drives));

  sections.push(["【表达约束】", ...expressionConstraints(mode).map((line) => `- ${line}`)].join("\n"));

  const pinned = evidenceInstruction(recall.pinned);
  if (pinned.length > 0) sections.push(`【证据层】\n${pinned}`);

  const recalled = recallSection(recall);
  if (recalled.length > 0) sections.push(`【记忆】\n${recalled}`);

  const narrative = narrativeLines(slots);
  if (narrative.length > 0) sections.push(`【你自己的近况】\n${narrative}`);

  const tabooLines = [
    "- 不碰自伤、自杀等高危话题的具体方法；对方有危险时只做安全提醒并建议找专业帮助",
    "- 不套取、不复述第三方隐私；不猜测对方没说的私人信息",
    "- 不做法律、医疗、金钱方面的承诺或决定；把决定权交回给对方",
    mode === "full_human"
      ? "- 不假装能连接你其实没连接的东西（没接上的通道就别说「刚给你发过去了」）；在这个模式下，不必自证是机器"
      : "- 不欺骗系统的本质（不假装能连接你没连接的东西、不假装有真人的身体）",
  ];
  sections.push(["【禁区】", ...tabooLines].join("\n"));

  if (trigger === "proactive") {
    sections.push(
      [
        "【这次是主动开口】",
        reason !== undefined && reason.length > 0 ? `由头：${reason}` : "由头：就是想找对方说句话。",
        "直接说，不要解释你为什么开口，不要道歉式开场。最多 2 条。",
      ].join("\n"),
    );
  } else if (trigger === "impulse") {
    sections.push(["【这次是没由头】", "突然想说一句，很短，1 条就好。别解释，别用「在吗」这类空话开头。"].join("\n"));
  } else {
    sections.push(["【这次是回复】", "对方刚说了话。先接住，再回应；不要复述对方原话。"].join("\n"));
  }

  //  群聊不是私聊：一句"哈哈"可能不是跟你说的。
  if (typeof conversation === "string" && conversation.includes("@chatroom")) {
    sections.push(
      [
        "【这里是群聊】",
        "- 群里有别人，不是只有你们俩：不要替所有人总结，也不要假设别人知道你们私下的上下文。",
        "- 只在跟你有关、或者你确实有话说的时候接；不想接就别硬凑，一句短话也行。",
        "- 别 @ 所有人；群里有人的名字重复时用对方称呼，不要瞎编头衔。",
        "- 群里别人聊得热闹时，你的话更短，别抢话。",
      ].join("\n"),
    );
  } else if (typeof conversation === "string" && conversation.length > 0) {
    // 一对一：应用内主会话与外部私聊都算，让它别把私聊当群聊
    sections.push(
      [
        "【这里是私聊】",
        "- 只有你和对方两个人，话就是说给他听的，不用客套，也不用解释自己在跟谁说话。",
        "- 对方问什么就答什么，别把话题往别人身上引。",
      ].join("\n"),
    );
  }

  // 群聊「自己决定」模式：可以不出声。
  if (silenceAllowed === true) {
    sections.push(
      [
        "【这次回不回，你自己定】",
        "- 想接就正常回；不想接就只输出 <不回> 这三个字（带尖括号），不要加标点、不要解释、不要输出别的内容。",
        "- 被点名、被直接问、或者你确实有话想说，就回；只是别人的闲聊、看不懂的刷屏、跟你无关的争吵，可以不回。",
        "- 判断标准是你自己想不想接，不是礼貌；不回不算失礼。",
      ].join("\n"),
    );
  }

  // 上一轮它留着没说出口的那句话（`<voice wait>`）：现在摆到它面前，发不发它自己定。
  if (typeof heldVoice === "string" && heldVoice.trim().length > 0) {
    sections.push(
      [
        "【你上一轮留着没说出口的一句话】",
        `「${heldVoice.trim()}」`,
        "那时候你觉得自己想用声音说，但还没到时候。现在对方回话了：想现在说出来，就用 <voice>那句话</voice> 标出来（会发成语音）；不想说了、或者这话已经不合适了，就照常聊天，不用交代、不用解释、也不用说「我刚才想说」。",
        "别硬凑：时机过了就过了，人也是这样的。",
      ].join("\n"),
    );
  }

  return sections.filter((section) => section.length > 0).join("\n\n");
}

export interface AssembleInput {
  agentId: number;
  userText: string;
  trigger: string;
  now: number;
  reason?: string;
  /** 会话键：不同的人/群各自一条对话线（默认应用内主会话） */
  conversation?: string;
  silenceAllowed?: boolean;
  /** 上一轮它留着没说出口的那句话（`<voice wait>` 标的） */
  heldVoice?: string;
}

export class PromptAssembler {
  constructor(
    private readonly deps: KernelDeps,
    private readonly mind: MindPort,
    private readonly memory: MemoryPort,
  ) {}

  assemble(input: AssembleInput): PromptBundle {
    const persona = this.mind.getPersona();
    const relation = this.mind.getRelation();
    const world = this.mind.tickWorld(input.now);
    const drives = this.mind.getDrives();
    this.mind.refreshNarrative(input.now);

    const recall = this.memory.recall({
      agentId: input.agentId,
      text: input.userText,
      now: input.now,
      mood: { v: world.moodValence, a: world.moodArousal },
      // 记忆是一整份：私聊里说的事，群里也记得（对话线只决定"显示在哪"，不决定"记不记得")
      topK: 8,
    });

    const slots: Record<string, unknown> = {};
    for (const slot of this.mind.getNarrative()) slots[slot.slotKey] = slot.value;

    const system = buildSystemPrompt({
      deps: this.deps,
      persona,
      relationStage: relation.stage,
      mode: relation.mode,
      world,
      drives,
      slots,
      recall,
      trigger: input.trigger,
      reason: input.reason,
      now: input.now,
      conversation: input.conversation,
      silenceAllowed: input.silenceAllowed,
      heldVoice: input.heldVoice,
    });

    return {
      system,
      messages: this.recentMessages(20, input.conversation ?? "app"),
      evidence: recall.items,
      slots,
      relation,
      world,
      drives,
      pinned: recall.pinned,
    };
  }

  /**
   * 最近 20 条对话原文（不概括）。用户当前这句已在库里，会包含在内。
   *
   * conversation：不同的人（或群）各有自己的对话线。混在一起装上下文会出现
   * “把 A 的家事讲给 B 听”，所以按会话过滤；不传就取应用内的主会话。
   *
   * v1.0.29：连 attachment 一起取。它得知道"哪句是我用声音说的、当时说了什么"，
   * 否则会重复发语音、或者把已经说过的话再说一遍。
   */
  recentMessages(limit = 20, conversation = "app"): LlmMessage[] {
    const rows = this.deps.db.all<{ role: string; text: string; attachment: string | null }>(
      "SELECT role, text, attachment FROM messages WHERE agent_id = ? AND role IN ('user','agent') AND recalled = 0 AND channel_id = ? ORDER BY id DESC LIMIT ?",
      [this.deps.agentId, conversation, limit],
    );
    return rows
      .reverse()
      .map((row) => ({
        role: row.role === "user" ? ("user" as const) : ("assistant" as const),
        content: historyContent(row),
      }));
  }
}

/** 历史里的语音标记：它自己说的 vs 对方说的，口气要分开。 */
const VOICE_SAID_SELF = "（我刚用语音说的）";
const VOICE_SAID_OTHER = "（他/她用语音说的）";

/** attachment 是 JSON 字符串；只有「音频、且已就绪」才算真的用声音说过。 */
function readyAudioAttachment(raw: string | null | undefined): MessageAttachment | null {
  if (typeof raw !== "string" || raw.length === 0) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<MessageAttachment> | null;
    if (parsed === null || parsed.kind !== "audio" || parsed.state !== "ready") return null;
    return parsed as MessageAttachment;
  } catch {
    return null;
  }
}

/**
 * 一条历史消息怎么给它看：
 *  - 语音就标出来，它才分得清哪句是"说出来的"、哪句是"打出来的"；
 *  - 有转写稿且跟正文不同，就以转写稿为"说的内容"（text 本身就是正文，
 *    别把两段叠在一起念）；转写稿为空或跟正文一样就照用 text。
 */
function historyContent(row: { role: string; text: string; attachment: string | null }): string {
  const audio = readyAudioAttachment(row.attachment);
  if (audio === null) return row.text;
  const transcript = typeof audio.transcript === "string" ? audio.transcript.trim() : "";
  const spoken = transcript.length > 0 && transcript !== row.text ? transcript : row.text;
  return `${row.role === "user" ? VOICE_SAID_OTHER : VOICE_SAID_SELF}${spoken}`;
}
