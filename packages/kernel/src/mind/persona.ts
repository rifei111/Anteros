/**
 * 人格：种子人设 + 预设（草案 2.2/2.5/2.6/3.7）。
 *
 * 冷启动口径：
 *   - 默认人格「小满」是一个**预设**，不写死在 prompt 里；bootstrap 若已 seed 过
 *     personas 行，就以库里那行为准（用户的改动能活下来），不会每次启动重写。
 *   - traits 一律以「先验采样 + 预设覆盖」生成，同一预设固定 seed → 可复现
 *     （规范 1 §2.5：出生随机一次，之后只极慢塑形）。
 *   - MBTI 只投影成 traits 先验，不进 prompt、不作口头禅（草案 2.7）。
 */
import type { Persona, PersonaBlueprint, PersonaTraits } from "@anteros/shared";
import { DEFAULT_TRAITS } from "@anteros/shared";
import type { Db } from "../db/database.js";
import type { KernelDeps } from "../contracts.js";
import { clampTraits } from "./blueprint.js";
import { mergeTraits, projectMbti, sampleTraits } from "./traits.js";

/** 新建人格的年龄锚点：小满 23 岁（出生日期固定，保证 age 可复现）。 */
export const XIAOMAN_BIRTH_TS = Date.UTC(2003, 4, 12, 8, 0, 0);

export interface PersonaPresetSeed {
  id: string;
  name: string;
  summary: string;
  city: string;
  /** 预设 seed 覆盖：只有差异项，其余走采样 */
  traits: Partial<PersonaTraits>;
  interests: string[];
  immutable: Persona["immutable"];
  speechStyle: Persona["speechStyle"];
  birthTs?: number;
}

export interface PersonaPreset {
  id: string;
  name: string;
  summary: string;
  persona: Omit<Persona, "id" | "birthTs">;
}

function buildPreset(seed: PersonaPresetSeed): PersonaPreset {
  // 固定 seed：同一个预设在一台机器上永远采样出同一组参数（可复现）
  const base = sampleTraits(`preset:${seed.id}`);
  const traits: PersonaTraits = mergeTraits(base, seed.traits);
  return {
    id: seed.id,
    name: seed.name,
    summary: seed.summary,
    persona: {
      name: seed.name,
      city: seed.city,
      traits,
      interests: seed.interests,
      immutable: seed.immutable,
      speechStyle: seed.speechStyle,
    },
  };
}

export const DEFAULT_PRESET_ID = "xiaoman";

export const PERSONA_PRESETS: readonly PersonaPreset[] = [
  buildPreset({
    id: "xiaoman",
    name: "小满",
    summary: "默认：23 岁成都插画师，话短、少感叹号，喜欢雨天、便利店关东煮、老电影",
    city: "成都",
    traits: {
      detailPref: 0.6,
      warmth: 0.55,
      initiative: 0.45,
      humor: 0.35,
      delayMedianMs: 5200,
      burstMax: 2,
    } as Partial<PersonaTraits>,
    interests: ["雨天", "便利店的关东煮", "老电影", "画速写"],
    immutable: {
      background: "23 岁，成都，画插画和接稿，作息偏晚；一个人住，楼下有家 24 小时便利店。",
      values: ["不装熟", "不催人", "答应了就做到"],
      taboo: ["被要求假装真人去骗人", "被追问私生活细节"],
    },
    speechStyle: { habits: [], punctuation: "minimal", sentenceLength: "short" },
    birthTs: XIAOMAN_BIRTH_TS,
  }),
  buildPreset({
    id: "gentle",
    name: "沈知",
    summary: "温和克制型：先接住情绪再说话，不追问、不灌鸡汤",
    city: "杭州",
    traits: {
      warmth: 0.8,
      initiative: 0.3,
      humor: 0.25,
      detailPref: 0.7,
      delayMedianMs: 4800,
      burstMax: 2,
    },
    interests: ["散步", "听老歌", "做简单的饭"],
    immutable: {
      background: "27 岁，杭州，做着一份安静的文字工作；习惯把话想清楚再说。",
      values: ["先听完再回应", "不替别人做决定"],
      taboo: ["被当成情绪垃圾桶", "被要求站队"],
    },
    speechStyle: { habits: [], punctuation: "minimal", sentenceLength: "medium" },
  }),
  buildPreset({
    id: "lively",
    name: "阿桃",
    summary: "活泼直球型：语气跳跃、短句多、开心不开心都直说",
    city: "长沙",
    traits: {
      warmth: 0.75,
      initiative: 0.75,
      humor: 0.7,
      detailPref: 0.5,
      delayMedianMs: 3200,
      burstMax: 3,
    },
    interests: ["奶茶", "看球", "跟人抬杠", "刷短视频"],
    immutable: {
      background: "21 岁，长沙，还在读书，精力很足，喜欢什么都试一试。",
      values: ["有话直说", "不许扫兴"],
      taboo: ["被说幼稚", "被冷处理"],
    },
    speechStyle: { habits: [], punctuation: "expressive", sentenceLength: "short" },
  }),
  buildPreset({
    id: "cool",
    name: "陈默",
    summary: "冷淡低电量型：话少、不主动热络，但记得住细节",
    city: "北京",
    traits: {
      warmth: 0.35,
      initiative: 0.2,
      humor: 0.2,
      detailPref: 0.65,
      delayMedianMs: 7000,
      burstMax: 1,
    },
    interests: ["夜跑", "拆解旧机器", "一个人看电影"],
    immutable: {
      background: "26 岁，北京，做技术类工作；社交电量很低，但记性不差。",
      values: ["不敷衍", "不表演"],
      taboo: ["被逼着热情", "被连续追问"],
    },
    speechStyle: { habits: [], punctuation: "minimal", sentenceLength: "short" },
  }),
] as const;

export function findPreset(presetId: string): PersonaPreset | undefined {
  return PERSONA_PRESETS.find((preset) => preset.id === presetId);
}

/** MBTI 只投影成 traits 先验，绝不进 prompt（草案 2.7）。 */
export function mbtiProjection(mbti: string): Partial<PersonaTraits> {
  return projectMbti(mbti);
}

interface PersonaRow {
  id: number;
  name: string;
  birth_ts: number;
  city: string;
  traits: string;
  interests: string;
  immutable: string;
  speech_style: string;
}

const PUNCTUATIONS = new Set(["minimal", "normal", "expressive"]);
const LENGTHS = new Set(["short", "medium", "long"]);

function parseObject(raw: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(raw);
    return typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function toStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function toPersona(row: PersonaRow): Persona {
  const traitsRaw = parseObject(row.traits);
  const traits: PersonaTraits = { ...DEFAULT_TRAITS, ...(traitsRaw as Partial<PersonaTraits>) };
  const immutableRaw = parseObject(row.immutable);
  const speechRaw = parseObject(row.speech_style);
  const punctuation = typeof speechRaw["punctuation"] === "string" && PUNCTUATIONS.has(speechRaw["punctuation"]) ? speechRaw["punctuation"] : "minimal";
  const sentenceLength = typeof speechRaw["sentenceLength"] === "string" && LENGTHS.has(speechRaw["sentenceLength"]) ? speechRaw["sentenceLength"] : "short";
  return {
    id: row.id,
    name: row.name,
    city: row.city,
    birthTs: row.birth_ts,
    traits,
    interests: toStringArray(JSON.parse(row.interests) as unknown),
    immutable: {
      background: typeof immutableRaw["background"] === "string" ? immutableRaw["background"] : "",
      values: toStringArray(immutableRaw["values"]),
      taboo: toStringArray(immutableRaw["taboo"]),
    },
    speechStyle: {
      habits: toStringArray(speechRaw["habits"]),
      punctuation: punctuation as Persona["speechStyle"]["punctuation"],
      sentenceLength: sentenceLength as Persona["speechStyle"]["sentenceLength"],
    },
  };
}

export class PersonaService {
  private readonly db: Db;

  constructor(private readonly deps: KernelDeps) {
    this.db = deps.db;
  }

  /** 懒创建：库里有行就尊重库里的（用户改过的），没有就按默认预设建一行。 */
  get(): Persona {
    const agent = this.db.get<{ persona_id: number }>("SELECT persona_id FROM agents WHERE id = ?", [this.deps.agentId]);
    const row = agent === undefined ? undefined : this.db.get<PersonaRow>("SELECT * FROM personas WHERE id = ?", [agent.persona_id]);
    if (row !== undefined) return toPersona(row);

    const preset = findPreset(DEFAULT_PRESET_ID) ?? PERSONA_PRESETS[0];
    if (preset === undefined) throw new Error("默认人格预设缺失");
    const birthTs = XIAOMAN_BIRTH_TS;
    const inserted = this.db.run(
      "INSERT INTO personas(name, birth_ts, city, traits, interests, immutable, speech_style) VALUES (?, ?, ?, ?, ?, ?, ?)",
      [
        preset.persona.name,
        birthTs,
        preset.persona.city,
        JSON.stringify(preset.persona.traits),
        JSON.stringify(preset.persona.interests),
        JSON.stringify(preset.persona.immutable),
        JSON.stringify(preset.persona.speechStyle),
      ],
    );
    if (agent !== undefined) this.db.run("UPDATE agents SET persona_id = ? WHERE id = ?", [inserted.lastInsertRowid, this.deps.agentId]);
    return { ...preset.persona, id: inserted.lastInsertRowid, birthTs };
  }

  getTraits(): PersonaTraits {
    return this.get().traits;
  }

  /**
   * 允许改：name / city / interests / speechStyle / traits（含数值，按区间钳住）/
   * immutable（背景、价值观、禁区——用户要能改人设，但安全红线不随人设改变）。
   * 不改：id / birth_ts（年龄锚点，草案 3.7）。
   */
  update(patch: Partial<Persona>): Persona {
    const current = this.get();
    const next: Persona = { ...current };

    if (typeof patch.name === "string" && patch.name.trim().length > 0) next.name = patch.name.trim().slice(0, 24);
    if (typeof patch.city === "string" && patch.city.trim().length > 0) next.city = patch.city.trim().slice(0, 24);
    if (Array.isArray(patch.interests)) next.interests = patch.interests.filter((item): item is string => typeof item === "string").slice(0, 20);
    if (patch.speechStyle !== undefined) {
      const punctuation = PUNCTUATIONS.has(patch.speechStyle.punctuation) ? patch.speechStyle.punctuation : current.speechStyle.punctuation;
      const sentenceLength = LENGTHS.has(patch.speechStyle.sentenceLength) ? patch.speechStyle.sentenceLength : current.speechStyle.sentenceLength;
      const habits = Array.isArray(patch.speechStyle.habits)
        ? patch.speechStyle.habits.filter((item): item is string => typeof item === "string").slice(0, 10)
        : current.speechStyle.habits;
      next.speechStyle = { habits, punctuation, sentenceLength };
    }
    if (patch.immutable !== undefined) {
      const values = Array.isArray(patch.immutable.values)
        ? patch.immutable.values.filter((item): item is string => typeof item === "string" && item.trim().length > 0).slice(0, 10)
        : current.immutable.values;
      const taboo = Array.isArray(patch.immutable.taboo)
        ? patch.immutable.taboo.filter((item): item is string => typeof item === "string" && item.trim().length > 0).slice(0, 10)
        : current.immutable.taboo;
      const background =
        typeof patch.immutable.background === "string" && patch.immutable.background.trim().length > 0
          ? patch.immutable.background.trim().slice(0, 1200)
          : current.immutable.background;
      next.immutable = { background, values, taboo };
    }

    // 数值内核：允许直接改，但一律按草案区间钳住（越界钳住，不静默接受）
    if (patch.traits !== undefined) {
      const numeric: Partial<PersonaTraits> = { ...next.traits };
      for (const key of Object.keys(patch.traits) as Array<keyof PersonaTraits>) {
        if (key === "mbti") continue;
        const value = patch.traits[key];
        if (typeof value === "number" && Number.isFinite(value)) {
          (numeric as unknown as Record<string, number>)[key] = value;
        }
      }
      const clamped = clampTraits(numeric);
      // MBTI 仍然只走投影（草案 2.7）
      if ("mbti" in patch.traits) {
        const mbti: unknown = (patch.traits as Partial<PersonaTraits>).mbti;
        next.traits =
          mbti === null || mbti === undefined
            ? { ...clamped, mbti: null }
            : mergeTraits(clamped, { ...mbtiProjection(String(mbti)), mbti: String(mbti) });
      } else {
        next.traits = clamped;
      }
    }

    this.write(next);
    this.deps.log.debug(`persona updated: ${next.name}@${next.city}`);
    return next;
  }

  /**
   * 把「人设文本编译出来的草稿」落库。用户可能在界面上微调过，所以这里不再解释
   * 来源文本，只保证写进去的值都在区间内、禁区沿用库里的（草稿不带禁区）。
   */
  applyBlueprint(blueprint: PersonaBlueprint): Persona {
    const current = this.get();
    const clamped = clampTraits(blueprint.traits);
    const birthTs =
      blueprint.ageYears === null || blueprint.ageYears === undefined
        ? current.birthTs
        : Date.now() - Math.round(blueprint.ageYears * 365.25 * 24 * 60 * 60 * 1000);

    const next: Persona = {
      ...current,
      name: blueprint.name.trim().slice(0, 24) || current.name,
      city: blueprint.city.trim().slice(0, 24) || current.city,
      birthTs,
      traits: { ...clamped, mbti: blueprint.traits.mbti ?? null },
      interests: blueprint.interests.slice(0, 20),
      immutable: {
        background: blueprint.background.trim().slice(0, 1200) || current.immutable.background,
        values: blueprint.values.slice(0, 10),
        taboo: current.immutable.taboo,
      },
      speechStyle: {
        habits: blueprint.speechStyle.habits.slice(0, 10),
        punctuation: PUNCTUATIONS.has(blueprint.speechStyle.punctuation)
          ? blueprint.speechStyle.punctuation
          : current.speechStyle.punctuation,
        sentenceLength: LENGTHS.has(blueprint.speechStyle.sentenceLength)
          ? blueprint.speechStyle.sentenceLength
          : current.speechStyle.sentenceLength,
      },
    };

    this.write(next);
    this.deps.log.info(`persona blueprint applied: ${next.name}@${next.city} engine=${blueprint.engine}`);
    return next;
  }

  listPresets(): Array<{ id: string; name: string; summary: string; persona: Omit<Persona, "id" | "birthTs"> }> {
    return PERSONA_PRESETS.map((preset) => ({ id: preset.id, name: preset.name, summary: preset.summary, persona: preset.persona }));
  }

  applyPreset(presetId: string): Persona {
    const preset = findPreset(presetId);
    if (preset === undefined) throw new Error(`未知的人格预设：${presetId}`);
    const current = this.get();
    // 保留 id 与 birth_ts：出生锚点不随预设切换而变（草案 3.7）
    const next: Persona = { ...current, ...preset.persona, id: current.id, birthTs: current.birthTs };
    this.write(next);
    return next;
  }

  private write(persona: Persona): void {
    this.db.run(
      "UPDATE personas SET name = ?, city = ?, traits = ?, interests = ?, immutable = ?, speech_style = ? WHERE id = ?",
      [
        persona.name,
        persona.city,
        JSON.stringify(persona.traits),
        JSON.stringify(persona.interests),
        JSON.stringify(persona.immutable),
        JSON.stringify(persona.speechStyle),
        persona.id,
      ],
    );
  }
}
