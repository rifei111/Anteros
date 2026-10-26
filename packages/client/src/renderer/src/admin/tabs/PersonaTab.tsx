import type { Persona, PersonaBlueprint, PersonaCompileResult, PersonaTraits } from "@anteros/shared";
import { useEffect, useState } from "react";
import { invoke } from "../../lib/kernel";
import { pushToast, setState, useAppState } from "../../lib/store";
import { LoadingLine, Section, reportError, useLoad } from "../helpers";

/**
 * 人格从「用户写一段话」编译而来：先用一段描述让内核（规则引擎 / 模型）推导出草案，
 * 用户逐项微调后应用。应用只是覆盖这台电脑上的人格，不同步任何远端。
 */

/** 顿号 / 逗号 / 分号 / 斜杠都能当分隔符；不按空白拆（英文名、多词短语会被拆坏）。 */
function splitList(raw: string): string[] {
  return raw
    .split(/[、,，;；/]+/)
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
}

/** 一行一条（禁区用）。 */
function splitLines(raw: string): string[] {
  return raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

type NumericTraitKey = Exclude<keyof PersonaTraits, "mbti">;

interface TraitField {
  key: NumericTraitKey;
  label: string;
  min: number;
  max: number;
  step: number;
}

/** 数值内核的可编辑字段；区间是草案区间，保存前会先钳在区间内。 */
const TRAIT_FIELDS: readonly TraitField[] = [
  { key: "memoryD", label: "记忆衰减 D", min: 0.3, max: 0.7, step: 0.01 },
  { key: "memoryTau", label: "记忆时间常数 τ", min: -6.5, max: -5, step: 0.05 },
  { key: "memoryS", label: "记忆强度 S", min: 0.15, max: 0.4, step: 0.01 },
  { key: "reconstructRho", label: "重构系数 ρ", min: 0.1, max: 0.2, step: 0.005 },
  { key: "emotionGain", label: "情绪增益", min: 1, max: 2.5, step: 0.05 },
  { key: "delayMedianMs", label: "打字延迟中位数", min: 1500, max: 12000, step: 100 },
  { key: "delaySigma", label: "延迟波动 σ", min: 0.3, max: 1.2, step: 0.01 },
  { key: "burstMin", label: "气泡数下限", min: 1, max: 3, step: 1 },
  { key: "burstMax", label: "气泡数上限", min: 1, max: 3, step: 1 },
  { key: "typoRate", label: "错字率", min: 0, max: 0.1, step: 0.005 },
  { key: "detailPref", label: "细节敏感", min: 0, max: 1, step: 0.01 },
  { key: "warmth", label: "温度", min: 0, max: 1, step: 0.01 },
  { key: "initiative", label: "主动性", min: 0, max: 1, step: 0.01 },
  { key: "humor", label: "幽默", min: 0, max: 1, step: 0.01 },
];

type ExpressionKey = "delayMedianMs" | "delaySigma" | "burstMin" | "burstMax" | "typoRate";

const EXPRESSION_KEYS: readonly ExpressionKey[] = [
  "delayMedianMs",
  "delaySigma",
  "burstMin",
  "burstMax",
  "typoRate",
];

/** 表达参数（气泡条数 / 延迟 / 错字）和人格数值分开展示，但写的是同一份 traits。 */
const EXPRESSION_FIELDS: readonly TraitField[] = TRAIT_FIELDS.filter((field) =>
  (EXPRESSION_KEYS as readonly string[]).includes(field.key),
);

function clampNumber(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function parseNumber(raw: string, fallback: number): number {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return fallback;
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function clampTrait(key: NumericTraitKey, raw: string, fallback: number): number {
  const field = TRAIT_FIELDS.find((item) => item.key === key);
  if (!field) return fallback;
  return clampNumber(parseNumber(raw, fallback), field.min, field.max);
}

/** 从表单文本还原数值内核；非法 / 越界的输入按区间钳住，不静默接受 NaN。 */
function traitsFromText(text: Record<string, string>, base: PersonaTraits): PersonaTraits {
  const traits: PersonaTraits = { ...base };
  for (const field of TRAIT_FIELDS) {
    traits[field.key] = clampTrait(field.key, text[field.key] ?? String(base[field.key]), base[field.key]);
  }
  return traits;
}

function traitTextFromTraits(traits: PersonaTraits): Record<string, string> {
  const text: Record<string, string> = {};
  for (const field of TRAIT_FIELDS) text[field.key] = String(traits[field.key]);
  return text;
}

function parseAge(raw: string): number | null {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) ? Math.max(0, Math.round(parsed)) : null;
}

interface DraftForm {
  name: string;
  city: string;
  ageYears: string;
  interests: string;
  background: string;
  values: string;
  habits: string;
}

function draftFromBlueprint(blueprint: PersonaBlueprint): DraftForm {
  return {
    name: blueprint.name,
    city: blueprint.city,
    ageYears: blueprint.ageYears === null ? "" : String(blueprint.ageYears),
    interests: blueprint.interests.join("、"),
    background: blueprint.background,
    values: blueprint.values.join("、"),
    habits: blueprint.habits.join("、"),
  };
}

/** 当前已落库人格的编辑表单：基本设定 + 表达参数 + 不可变设定，一次保存一起提交。 */
interface CurrentForm {
  name: string;
  city: string;
  interests: string;
  habits: string;
  background: string;
  values: string;
  taboo: string;
  delayMedianMs: string;
  delaySigma: string;
  burstMin: string;
  burstMax: string;
  typoRate: string;
}

function currentFromPersona(persona: Persona): CurrentForm {
  return {
    name: persona.name,
    city: persona.city,
    interests: persona.interests.join("、"),
    habits: persona.speechStyle.habits.join("、"),
    background: persona.immutable.background,
    values: persona.immutable.values.join("、"),
    taboo: persona.immutable.taboo.join("\n"),
    delayMedianMs: String(persona.traits.delayMedianMs),
    delaySigma: String(persona.traits.delaySigma),
    burstMin: String(persona.traits.burstMin),
    burstMax: String(persona.traits.burstMax),
    typoRate: String(persona.traits.typoRate),
  };
}

export function PersonaTab() {
  const state = useAppState();
  const persona = state.persona;
  const owner = useLoad(() => invoke("owner.status", {}), []);

  const [rawText, setRawText] = useState("");
  const [compiling, setCompiling] = useState(false);
  const [compiled, setCompiled] = useState<PersonaCompileResult | null>(null);
  const [draft, setDraft] = useState<DraftForm | null>(null);
  const [draftTraits, setDraftTraits] = useState<Record<string, string>>({});
  const [applying, setApplying] = useState(false);

  const [form, setForm] = useState<CurrentForm | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (persona) setForm(currentFromPersona(persona));
  }, [persona]);

  if (!persona) {
    return (
      <div className="panel-stack">
        <LoadingLine loading error={null} />
        <div className="empty-note">还没有人格数据：先完成首次引导，或让内核初始化人格。</div>
      </div>
    );
  }

  const editable = owner.data ? owner.data.isOwner : true;
  const baseline = currentFromPersona(persona);
  const currentForm = form ?? baseline;
  const dirty = (Object.keys(baseline) as Array<keyof CurrentForm>).some(
    (key) => currentForm[key] !== baseline[key],
  );

  const updateForm = (patch: Partial<CurrentForm>): void => {
    setForm((previous) => ({ ...(previous ?? baseline), ...patch }));
  };

  const updateDraft = (patch: Partial<DraftForm>): void => {
    setDraft((previous) => (previous ? { ...previous, ...patch } : previous));
  };

  const compile = async (): Promise<void> => {
    if (compiling || !editable) return;
    const text = rawText.trim();
    if (text.length === 0) {
      pushToast("warn", "先写一段话", "把她的名字、年龄、做什么、说话习惯写进去，编译结果会更准。");
      return;
    }
    setCompiling(true);
    try {
      const result = await invoke("persona.compile", { text });
      setCompiled(result);
      setDraft(draftFromBlueprint(result.blueprint));
      setDraftTraits(traitTextFromTraits(result.blueprint.traits));
    } catch (error) {
      reportError(error);
    } finally {
      setCompiling(false);
    }
  };

  const discardCompile = (): void => {
    setCompiled(null);
    setDraft(null);
    setDraftTraits({});
  };

  const applyBlueprint = async (): Promise<void> => {
    if (!compiled || !draft || applying || !editable) return;
    const base = compiled.blueprint;
    // 口头禅在契约里有两份（blueprint.habits 和 speechStyle.habits），内核落库读的是
    // speechStyle.habits，所以两边一起写，避免界面上改了却没生效。
    const habits = splitList(draft.habits);
    const blueprint: PersonaBlueprint = {
      ...base,
      name: draft.name.trim() || base.name,
      city: draft.city.trim() || base.city,
      ageYears: parseAge(draft.ageYears),
      interests: splitList(draft.interests),
      background: draft.background.trim(),
      values: splitList(draft.values),
      habits,
      speechStyle: { ...base.speechStyle, habits },
      traits: traitsFromText(draftTraits, base.traits),
    };
    setApplying(true);
    try {
      const next = await invoke("persona.applyBlueprint", { blueprint });
      setState({ persona: next });
      pushToast("success", "人格内核已更新", "数值、背景与说话习惯都写进了这台电脑上的它。");
    } catch (error) {
      reportError(error);
    } finally {
      setApplying(false);
    }
  };

  const save = async (): Promise<void> => {
    if (saving || !editable) return;
    setSaving(true);
    try {
      const traits: PersonaTraits = {
        ...persona.traits,
        delayMedianMs: Math.round(
          clampTrait("delayMedianMs", currentForm.delayMedianMs, persona.traits.delayMedianMs),
        ),
        delaySigma: clampTrait("delaySigma", currentForm.delaySigma, persona.traits.delaySigma),
        burstMin: clampTrait("burstMin", currentForm.burstMin, persona.traits.burstMin),
        burstMax: clampTrait("burstMax", currentForm.burstMax, persona.traits.burstMax),
        typoRate: clampTrait("typoRate", currentForm.typoRate, persona.traits.typoRate),
      };
      if (traits.burstMin > traits.burstMax) traits.burstMin = traits.burstMax;
      const patch: Partial<Persona> = {
        name: currentForm.name.trim() || persona.name,
        city: currentForm.city.trim() || persona.city,
        interests: splitList(currentForm.interests),
        speechStyle: { ...persona.speechStyle, habits: splitList(currentForm.habits) },
        traits,
        immutable: {
          background: currentForm.background.trim(),
          values: splitList(currentForm.values),
          taboo: splitLines(currentForm.taboo),
        },
      };
      const next = await invoke("persona.update", { patch });
      setState({ persona: next });
      pushToast("success", "人格已保存", "记忆与人格只存在这台电脑上。");
    } catch (error) {
      reportError(error);
    } finally {
      setSaving(false);
    }
  };

  const ownerHint = editable ? null : "只有 owner 能改人格；现在以只读方式显示。";
  const rationaleWhy = (key: string): string | null =>
    compiled?.blueprint.rationale.find((item) => item.key === key)?.why ?? null;

  return (
    <div className="panel-stack">
      <Section
        title="用一段话描述她"
        hint={ownerHint ?? "写得越具体，编译出来越像；编译只是一份草案，改到满意再应用。"}
        action={
          <button
            className="btn btn-primary"
            onClick={() => void compile()}
            disabled={!editable || compiling}
          >
            {compiling ? "正在编译…" : "编译成人格内核"}
          </button>
        }
      >
        <div className="field">
          <label className="field-label" htmlFor="persona-raw">
            她是谁
          </label>
          <textarea
            id="persona-raw"
            className="textarea"
            rows={4}
            maxLength={2000}
            value={rawText}
            disabled={!editable || compiling}
            placeholder="她叫林野，26 岁，在成都做夜班护士，话少但记性极好，记得住别人随口提过的事，偶尔嘴硬心软，喜欢下雨天和便利店…"
            onChange={(event) => setRawText(event.target.value)}
          />
          <span className="field-hint">
            名字、年龄、城市、做什么、说话习惯都可以写进来；编译不改人格，只是先给你一份可微调的草案。
          </span>
        </div>
      </Section>

      {compiled && draft ? (
        <Section title="人格内核草案" hint="这些数值和文字都是编译草案：逐项改到满意，再点「应用到人格」。">
          <div className="compile-meta">
            <span className={`badge ${compiled.blueprint.engine === "llm" ? "badge-ok" : "badge-muted"}`}>
              {compiled.blueprint.engine === "llm" ? "模型推导" : "本地规则引擎"}
            </span>
            {compiled.usage ? (
              <span className="field-hint">
                模型 {compiled.usage.model} · {compiled.usage.inputTokens}+{compiled.usage.outputTokens} tokens
              </span>
            ) : null}
          </div>

          {compiled.blueprint.clamped.length > 0 ? (
            <div className="blueprint-note">
              <div className="blueprint-note-title">有些值被钳在草案区间内</div>
              <ul>
                {compiled.blueprint.clamped.map((item) => (
                  <li key={item}>{item}</li>
                ))}
              </ul>
            </div>
          ) : null}

          {compiled.blueprint.warnings.length > 0 ? (
            <div className="blueprint-note">
              <div className="blueprint-note-title">编译提示</div>
              <ul>
                {compiled.blueprint.warnings.map((item) => (
                  <li key={item}>{item}</li>
                ))}
              </ul>
            </div>
          ) : null}

          <div className="field-row">
            <div className="field">
              <label className="field-label" htmlFor="bp-name">
                名字
              </label>
              <input
                id="bp-name"
                className="input"
                value={draft.name}
                maxLength={24}
                disabled={!editable || applying}
                onChange={(event) => updateDraft({ name: event.target.value })}
              />
            </div>
            <div className="field">
              <label className="field-label" htmlFor="bp-city">
                城市
              </label>
              <input
                id="bp-city"
                className="input"
                value={draft.city}
                maxLength={24}
                disabled={!editable || applying}
                onChange={(event) => updateDraft({ city: event.target.value })}
              />
            </div>
            <div className="field">
              <label className="field-label" htmlFor="bp-age">
                年龄（可留空）
              </label>
              <input
                id="bp-age"
                className="input"
                type="number"
                min={0}
                step={1}
                value={draft.ageYears}
                disabled={!editable || applying}
                onChange={(event) => updateDraft({ ageYears: event.target.value })}
              />
            </div>
          </div>

          <div className="field">
            <label className="field-label" htmlFor="bp-interests">
              兴趣（用顿号分隔）
            </label>
            <input
              id="bp-interests"
              className="input"
              value={draft.interests}
              disabled={!editable || applying}
              onChange={(event) => updateDraft({ interests: event.target.value })}
            />
          </div>

          <div className="field">
            <label className="field-label" htmlFor="bp-background">
              背景
            </label>
            <textarea
              id="bp-background"
              className="textarea"
              rows={3}
              value={draft.background}
              disabled={!editable || applying}
              onChange={(event) => updateDraft({ background: event.target.value })}
            />
          </div>

          <div className="field">
            <label className="field-label" htmlFor="bp-values">
              价值观（用顿号分隔）
            </label>
            <input
              id="bp-values"
              className="input"
              value={draft.values}
              disabled={!editable || applying}
              onChange={(event) => updateDraft({ values: event.target.value })}
            />
          </div>

          <div className="field">
            <label className="field-label" htmlFor="bp-habits">
              口头禅（用顿号分隔）
            </label>
            <input
              id="bp-habits"
              className="input"
              value={draft.habits}
              disabled={!editable || applying}
              onChange={(event) => updateDraft({ habits: event.target.value })}
            />
          </div>

          <h4 className="sub-title">人格内核（数值，可微调）</h4>
          <div className="param-grid">
            {TRAIT_FIELDS.map((field) => {
              const why = rationaleWhy(field.key);
              return (
                <div className="field" key={field.key}>
                  <label className="field-label" htmlFor={`bp-trait-${field.key}`}>
                    {field.label}（{field.min} ~ {field.max}）
                  </label>
                  <input
                    id={`bp-trait-${field.key}`}
                    className="input"
                    type="number"
                    min={field.min}
                    max={field.max}
                    step={field.step}
                    value={draftTraits[field.key] ?? ""}
                    disabled={!editable || applying}
                    onChange={(event) =>
                      setDraftTraits((previous) => ({ ...previous, [field.key]: event.target.value }))
                    }
                  />
                  {why ? <span className="field-hint">{why}</span> : null}
                </div>
              );
            })}
          </div>

          <div className="row-actions">
            <button className="btn btn-primary" onClick={() => void applyBlueprint()} disabled={!editable || applying}>
              {applying ? "应用中…" : "应用到人格"}
            </button>
            <button className="btn" onClick={discardCompile} disabled={applying}>
              放弃这次编译
            </button>
          </div>
        </Section>
      ) : null}

      <Section
        title="当前人格（已落库）"
        hint={ownerHint ?? "改完点「保存」；这一份是这台电脑上真正生效的人格。"}
        action={
          <button
            className="btn btn-primary"
            onClick={() => void save()}
            disabled={!editable || saving || !dirty}
          >
            {saving ? "保存中…" : "保存"}
          </button>
        }
      >
        <div className="field-row">
          <div className="field">
            <label className="field-label" htmlFor="persona-name">
              名字
            </label>
            <input
              id="persona-name"
              className="input"
              value={currentForm.name}
              maxLength={24}
              disabled={!editable || saving}
              onChange={(event) => updateForm({ name: event.target.value })}
            />
          </div>
          <div className="field">
            <label className="field-label" htmlFor="persona-city">
              所在城市
            </label>
            <input
              id="persona-city"
              className="input"
              value={currentForm.city}
              maxLength={24}
              disabled={!editable || saving}
              onChange={(event) => updateForm({ city: event.target.value })}
            />
          </div>
        </div>

        <div className="field">
          <label className="field-label" htmlFor="persona-interests">
            兴趣（用顿号分隔）
          </label>
          <input
            id="persona-interests"
            className="input"
            value={currentForm.interests}
            disabled={!editable || saving}
            onChange={(event) => updateForm({ interests: event.target.value })}
          />
        </div>

        <div className="field">
          <label className="field-label" htmlFor="persona-habits">
            说话习惯（用顿号分隔）
          </label>
          <input
            id="persona-habits"
            className="input"
            value={currentForm.habits}
            disabled={!editable || saving}
            onChange={(event) => updateForm({ habits: event.target.value })}
          />
        </div>

        <h4 className="sub-title">表达参数</h4>
        <p className="field-hint">决定气泡条数、打字延迟与错字；超出括号范围的值保存时会被钳住。</p>
        <div className="param-grid">
          {EXPRESSION_FIELDS.map((field) => (
            <div className="field" key={field.key}>
              <label className="field-label" htmlFor={`persona-trait-${field.key}`}>
                {field.label}（{field.min} ~ {field.max}）
              </label>
              <input
                id={`persona-trait-${field.key}`}
                className="input"
                type="number"
                min={field.min}
                max={field.max}
                step={field.step}
                value={currentForm[field.key as ExpressionKey]}
                disabled={!editable || saving}
                onChange={(event) =>
                  updateForm({ [field.key]: event.target.value } as Partial<CurrentForm>)
                }
              />
            </div>
          ))}
        </div>

        <p className="prose muted">
          说话风格：标点 {persona.speechStyle.punctuation} · 句长 {persona.speechStyle.sentenceLength}
        </p>
      </Section>

      <Section title="不可变设定" hint="这些会进入她的人设；安全红线不随人设改变。">
        <div className="field">
          <label className="field-label" htmlFor="persona-background">
            背景
          </label>
          <textarea
            id="persona-background"
            className="textarea"
            rows={4}
            value={currentForm.background}
            disabled={!editable || saving}
            onChange={(event) => updateForm({ background: event.target.value })}
          />
        </div>

        <div className="field">
          <label className="field-label" htmlFor="persona-values">
            价值观（用顿号分隔）
          </label>
          <input
            id="persona-values"
            className="input"
            value={currentForm.values}
            disabled={!editable || saving}
            onChange={(event) => updateForm({ values: event.target.value })}
          />
        </div>

        <div className="field">
          <label className="field-label" htmlFor="persona-taboo">
            禁区（一行一条）
          </label>
          <textarea
            id="persona-taboo"
            className="textarea"
            rows={3}
            value={currentForm.taboo}
            disabled={!editable || saving}
            onChange={(event) => updateForm({ taboo: event.target.value })}
          />
        </div>

        {editable ? (
          <div className="row-actions">
            <button className="btn" onClick={() => void save()} disabled={saving || !dirty}>
              {saving ? "保存中…" : "保存设定"}
            </button>
            <span className="field-hint">和上面「当前人格」的保存是同一次提交。</span>
          </div>
        ) : null}
      </Section>
    </div>
  );
}
