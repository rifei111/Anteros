import type { Persona, PersonaTraits } from "@anteros/shared";

/**
 * 人设文档：把人格渲染成一份**人能读、也能改回来**的 Markdown。
 *
 * 为什么要文档化：参数面板只能改数值，改不出"这个人经历过什么"；
 * 而用户想调整一个人的时候，脑子里想的是散文，不是 0.42。
 * 所以这里定一份固定骨架 —— 人读得懂、程序解析得回、改完能导入。
 *
 * 原则：
 * 1. 只写"人设层"（名字/城市/经历/兴趣/口癖/禁忌），**不写记忆**：记忆是会衰减的内容，不该被文档固化成设定。
 * 2. 参数（d、τ、s…）不写进正文，只在末尾附一张"内核"表供查看；导入时忽略它，避免手改数值打破区间约束。
 * 3. 解析尽最大努力：缺字段就跳过，不因为一个字写错就整份拒绝。
 */

const SECTION_BACKGROUND = "背景";
const SECTION_VALUES = "价值观";
const SECTION_HABITS = "口癖";
const SECTION_TABOO = "禁忌";
const SECTION_INTERESTS = "兴趣";

export interface PersonaDocResult {
  text: string;
  /** 建议文件名，客户端可直接拿去做保存对话框默认值 */
  filename: string;
}

export interface PersonaDocImport {
  /** 解析出来、可以写进人格的字段 */
  patch: Partial<Persona>;
  /** 读到了什么（给人看的回执） */
  applied: string[];
  /** 读不懂的地方（不阻断导入） */
  warnings: string[];
}

function formatBirth(ts: number): string {
  const date = new Date(ts);
  if (Number.isNaN(date.getTime())) return "未知";
  const month = `${date.getMonth() + 1}`.padStart(2, "0");
  const day = `${date.getDate()}`.padStart(2, "0");
  return `${date.getFullYear()}-${month}-${day}`;
}

function ageOf(birthTs: number, now: number): number {
  const age = (now - birthTs) / (365.25 * 24 * 3600 * 1000);
  return Math.max(0, Math.round(age));
}

function bulletList(items: readonly string[]): string {
  const list = items.map((item) => item.trim()).filter((item) => item.length > 0);
  if (list.length === 0) return "（没写）";
  return list.map((item) => `- ${item}`).join("\n");
}

/** 人格 → Markdown 文档 */
export function renderPersonaDoc(persona: Persona, now = Date.now()): PersonaDocResult {
  const traits: PersonaTraits = persona.traits;
  const punctuation = { minimal: "少用标点", normal: "正常标点", expressive: "爱加标点" }[persona.speechStyle.punctuation] ?? "正常标点";
  const sentenceLength = { short: "短句为主", medium: "长短交替", long: "偏长句" }[persona.speechStyle.sentenceLength];

  const lines: string[] = [];
  lines.push(`# 人设：${persona.name || "（未命名）"}`);
  lines.push("");
  lines.push("> 这份文档就是「它」的设定。改完可以直接导入回去；参数表在最后，仅供查看。");
  lines.push("");
  lines.push("## 基本信息");
  lines.push("");
  lines.push(`- 名字：${persona.name || "（未命名）"}`);
  lines.push(`- 城市：${persona.city || "（未写）"}`);
  lines.push(`- 出生日期：${formatBirth(persona.birthTs)}（现在约 ${ageOf(persona.birthTs, now)} 岁）`);
  lines.push(`- 说话风格：${sentenceLength}，${punctuation}`);
  lines.push("");
  lines.push(`## ${SECTION_INTERESTS}`);
  lines.push("");
  lines.push(bulletList(persona.interests));
  lines.push("");
  lines.push(`## ${SECTION_BACKGROUND}`);
  lines.push("");
  lines.push(persona.immutable.background?.trim() || "（没写）");
  lines.push("");
  lines.push(`## ${SECTION_VALUES}`);
  lines.push("");
  lines.push(bulletList(persona.immutable.values));
  lines.push("");
  lines.push(`## ${SECTION_HABITS}`);
  lines.push("");
  lines.push(bulletList(persona.speechStyle.habits));
  lines.push("");
  lines.push(`## ${SECTION_TABOO}`);
  lines.push("");
  lines.push(bulletList(persona.immutable.taboo));
  lines.push("");
  lines.push("## 内核参数（只读，导入时忽略）");
  lines.push("");
  lines.push("| 参数 | 值 | 含义 |");
  lines.push("| --- | --- | --- |");
  lines.push(`| 记忆衰减 d | ${traits.memoryD.toFixed(3)} | 越大越健忘 |`);
  lines.push(`| 提取阈值 τ | ${traits.memoryTau.toFixed(3)} | 越低越容易想起 |`);
  lines.push(`| 回忆噪声 s | ${traits.memoryS.toFixed(3)} | 越大越不稳定 |`);
  lines.push(`| 重构漂移 ρ | ${traits.reconstructRho.toFixed(3)} | 越大越会把记忆讲走样 |`);
  lines.push(`| 情绪增益 γ | ${traits.emotionGain.toFixed(3)} | 越大越容易被情绪影响 |`);
  lines.push(`| 细节偏好 | ${traits.detailPref.toFixed(2)} | 越高越爱抠细节 |`);
  lines.push(`| 温度 | ${traits.warmth.toFixed(2)} | 越高越暖 |`);
  lines.push(`| 主动性 | ${traits.initiative.toFixed(2)} | 越高越爱先开口 |`);
  lines.push(`| 幽默 | ${traits.humor.toFixed(2)} | 越高越爱开玩笑 |`);
  lines.push("");
  lines.push("---");
  lines.push("");
  lines.push("说明：文档只承载人设，不承载记忆。记忆会被遗忘曲线慢慢带走，不该被写死成设定。");
  lines.push("");

  const safeName = (persona.name || "persona").replace(/[\\/:*?"<>|\s]+/g, "-");
  return { text: `${lines.join("\n")}`, filename: `人设-${safeName}.md` };
}

function splitSections(text: string): Map<string, string> {
  const sections = new Map<string, string>();
  let current = "";
  const buffer: string[] = [];
  const flush = (): void => {
    if (current.length > 0) sections.set(current, buffer.join("\n").trim());
    buffer.length = 0;
  };
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    const heading = /^#{1,6}\s*(.+?)\s*$/.exec(line);
    if (heading) {
      flush();
      current = (heading[1] ?? "").trim();
      continue;
    }
    buffer.push(raw);
  }
  flush();
  return sections;
}

function readKeyValue(lines: string[], key: string): string | null {
  const re = new RegExp(`^\\s*[-*]?\\s*${key}\\s*[：:]\\s*(.+)$`);
  for (const raw of lines) {
    const match = re.exec(raw);
    if (match) {
      const value = (match[1] ?? "").trim();
      return value.length > 0 ? value : null;
    }
  }
  return null;
}

function readBullets(block: string): string[] {
  return block
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.startsWith("-") || line.startsWith("*"))
    .map((line) => line.replace(/^[-*]\s*/, "").trim())
    .filter((line) => line.length > 0 && line !== "（没写）");
}

function parseDate(value: string | null): number | null {
  if (!value) return null;
  // 导出时会在日期后面补「（现在约 N 岁）」，这里只取开头的年月日
  const match = /^(\d{4})\s*[-/年]\s*(\d{1,2})\s*[-/月]\s*(\d{1,2})/.exec(value.trim());
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (!Number.isFinite(year) || !Number.isFinite(month) || !Number.isFinite(day)) return null;
  const ts = new Date(year, month - 1, day, 12, 0, 0, 0).getTime();
  return Number.isFinite(ts) ? ts : null;
}

/**
 * Markdown 文档 → 人格补丁。
 *
 * 返回的 patch 只包含"文档能表达的字段"，没写到的字段保持不动 ——
 * 导入是**修改**，不是覆盖：手写文档常常只写一小段，不该把参数表清空。
 */
export function parsePersonaDoc(text: string): PersonaDocImport {
  const applied: string[] = [];
  const warnings: string[] = [];
  const patch: Partial<Persona> = {};
  const sections = splitSections(text);
  const basic = sections.get("基本信息") ?? "";

  const name = readKeyValue(basic.split(/\r?\n/), "名字");
  if (name) {
    patch.name = name.replace(/（未命名）$/, "").trim();
    applied.push(`名字：${patch.name}`);
  }

  const city = readKeyValue(basic.split(/\r?\n/), "城市");
  if (city && !city.includes("未写")) {
    patch.city = city.trim();
    applied.push(`城市：${patch.city}`);
  }

  const birth = parseDate(readKeyValue(basic.split(/\r?\n/), "出生日期"));
  if (birth !== null) {
    patch.birthTs = birth;
    applied.push(`出生日期：${new Date(birth).toISOString().slice(0, 10)}`);
  } else if (readKeyValue(basic.split(/\r?\n/), "出生日期")) {
    warnings.push("出生日期这一行没读懂（要写成 2003-04-12 这种格式），这次没改");
  }

  const interests = readBullets(sections.get(SECTION_INTERESTS) ?? "");
  if (interests.length > 0) {
    patch.interests = interests;
    applied.push(`兴趣：${interests.length} 条`);
  }

  const background = (sections.get(SECTION_BACKGROUND) ?? "").trim();
  if (background.length > 0 && background !== "（没写）") {
    patch.immutable = { background, values: [], taboo: [] };
    applied.push("背景：已更新");
  }

  const values = readBullets(sections.get(SECTION_VALUES) ?? "");
  const habits = readBullets(sections.get(SECTION_HABITS) ?? "");
  const taboo = readBullets(sections.get(SECTION_TABOO) ?? "");
  if (values.length === 0 && habits.length === 0 && taboo.length === 0 && patch.immutable === undefined) {
    // 都没写就什么都不动
  } else {
    patch.immutable = {
      background: patch.immutable?.background ?? "",
      values,
      taboo,
    };
    if (values.length > 0) applied.push(`价值观：${values.length} 条`);
    if (taboo.length > 0) applied.push(`禁忌：${taboo.length} 条`);
    patch.speechStyle = { habits, punctuation: "normal", sentenceLength: "medium" };
    if (habits.length > 0) applied.push(`口癖：${habits.length} 条`);
  }

  if (applied.length === 0) {
    warnings.push("一个字段都没读到：至少要有「## 基本信息」里的「- 名字：…」那一行");
  }
  return { patch, applied, warnings };
}