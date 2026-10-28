import { describe, expect, it } from "vitest";
import type { Persona, PersonaTraits } from "@anteros/shared";
import { parsePersonaDoc, renderPersonaDoc } from "../src/expression/persona-doc.js";

const traits: PersonaTraits = {
  detailPref: 0.6,
  warmth: 0.7,
  initiative: 0.4,
  humor: 0.3,
  memoryD: 0.45,
  memoryTau: -6,
  memoryS: 0.3,
  reconstructRho: 0.15,
  emotionGain: 1.4,
  delayMedianMs: 4200,
  delaySigma: 0.7,
  burstMin: 1,
  burstMax: 3,
  typoRate: 0.02,
  mbti: "INFP",
};

function makePersona(patch: Partial<Persona> = {}): Persona {
  return {
    id: 1,
    name: "小满",
    city: "成都",
    birthTs: Date.UTC(2003, 4, 12, 8, 0, 0),
    traits,
    interests: ["纪录片", "散步听播客"],
    immutable: {
      background: "在一家小公司做排版，下班喜欢绕远路走回家。",
      values: ["不替别人做决定"],
      taboo: ["不聊工作里的具体项目名"],
    },
    speechStyle: { habits: ["嗯……"], punctuation: "minimal", sentenceLength: "short" },
    ...patch,
  };
}

describe("人设文档", () => {
  it("渲染出的文档包含基本字段，且带可读的参数表", () => {
    const doc = renderPersonaDoc(makePersona(), Date.UTC(2026, 0, 1));
    expect(doc.filename).toBe("人设-小满.md");
    expect(doc.text).toContain("# 人设：小满");
    expect(doc.text).toContain("- 城市：成都");
    expect(doc.text).toContain("- 出生日期：2003-05-12");
    expect(doc.text).toContain("## 背景");
    expect(doc.text).toContain("纪录片");
    expect(doc.text).toContain("| 记忆衰减 d | 0.450 |");
  });

  it("导出再导入是幂等的：字段原样回来", () => {
    const source = makePersona();
    const doc = renderPersonaDoc(source, Date.UTC(2026, 0, 1));
    const parsed = parsePersonaDoc(doc.text);
    expect(parsed.patch.name).toBe("小满");
    expect(parsed.patch.city).toBe("成都");
    // 文档只记"哪一天"，不记具体时刻：导入按本地中午重建，日期一致即可
    const formatDay = (ts: number): string => {
      const date = new Date(ts);
      return `${date.getFullYear()}-${date.getMonth() + 1}-${date.getDate()}`;
    };
    expect(formatDay(parsed.patch.birthTs ?? 0)).toBe(formatDay(source.birthTs));
    expect(parsed.patch.interests).toEqual(["纪录片", "散步听播客"]);
    expect(parsed.patch.immutable?.background).toContain("绕远路");
    expect(parsed.patch.immutable?.values).toEqual(["不替别人做决定"]);
    expect(parsed.patch.speechStyle?.habits).toEqual(["嗯……"]);
    expect(parsed.warnings).toEqual([]);
  });

  it("只写一段背景也能导入，且不碰没写的字段", () => {
    const parsed = parsePersonaDoc(`# 人设：随便写的\n\n## 基本信息\n\n- 名字：阿枝\n\n## 背景\n\n在县城开一间小书店。\n`);
    expect(parsed.patch.name).toBe("阿枝");
    expect(parsed.patch.interests).toBeUndefined();
    expect(parsed.patch.immutable?.background).toContain("小书店");
    expect(parsed.applied.join()).toContain("名字");
  });

  it("出生日期写错只记一条警告，不当成 1970 年", () => {
    const parsed = parsePersonaDoc(`## 基本信息\n\n- 名字：阿枝\n- 出生日期：2003年5月\n`);
    expect(parsed.patch.birthTs).toBeUndefined();
    expect(parsed.warnings.join()).toContain("出生日期");
    expect(parsed.patch.name).toBe("阿枝");
  });

  it("一个字都没读到时给出可操作的提示", () => {
    const parsed = parsePersonaDoc("随便一段没有任何结构的话");
    expect(Object.keys(parsed.patch)).toHaveLength(0);
    expect(parsed.warnings[0]).toContain("名字");
  });
});