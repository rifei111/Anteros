import type { Persona, PersonaTraits } from "@anteros/shared";
import { useEffect, useState } from "react";
import { formatPercent } from "../../lib/format";
import { invoke } from "../../lib/kernel";
import { pushToast, setState, useAppState } from "../../lib/store";
import { LoadingLine, Section, reportError, useLoad } from "../helpers";

function splitList(raw: string): string[] {
  return raw
    .split(/[、,，;；/\s]+/)
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
}

interface TraitRow {
  label: string;
  value: string;
}

function traitRows(traits: PersonaTraits): TraitRow[] {
  return [
    { label: "细节敏感", value: formatPercent(traits.detailPref) },
    { label: "温度", value: formatPercent(traits.warmth) },
    { label: "主动性", value: formatPercent(traits.initiative) },
    { label: "幽默", value: formatPercent(traits.humor) },
    { label: "记忆衰减 D", value: traits.memoryD.toFixed(2) },
    { label: "记忆时间常数 τ", value: traits.memoryTau.toFixed(2) },
    { label: "记忆强度 S", value: traits.memoryS.toFixed(2) },
    { label: "重构系数 ρ", value: traits.reconstructRho.toFixed(2) },
    { label: "情绪增益", value: traits.emotionGain.toFixed(2) },
    { label: "打字延迟中位数", value: `${traits.delayMedianMs} ms` },
    { label: "错字率", value: formatPercent(traits.typoRate) },
    { label: "气泡数范围", value: `${traits.burstMin}–${traits.burstMax} 条` },
    { label: "MBTI", value: traits.mbti ?? "—" },
  ];
}

/**
 * 人格面板：名字 / 城市 / 兴趣 / 说话习惯可改；不可变内核只读。
 * 非 owner 只读——这里总是显示真实身份，不做「假装可改」。
 */
export function PersonaTab() {
  const state = useAppState();
  const persona = state.persona;
  const owner = useLoad(() => invoke("owner.status", {}), []);
  const [name, setName] = useState("");
  const [city, setCity] = useState("");
  const [interests, setInterests] = useState("");
  const [habits, setHabits] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!persona) return;
    setName(persona.name);
    setCity(persona.city);
    setInterests(persona.interests.join("、"));
    setHabits(persona.speechStyle.habits.join("、"));
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
  const dirty =
    name !== persona.name ||
    city !== persona.city ||
    interests !== persona.interests.join("、") ||
    habits !== persona.speechStyle.habits.join("、");

  const save = async (): Promise<void> => {
    if (saving) return;
    setSaving(true);
    try {
      const patch: Partial<Persona> = {
        name: name.trim() || persona.name,
        city: city.trim() || persona.city,
        interests: splitList(interests),
        speechStyle: { ...persona.speechStyle, habits: splitList(habits) },
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

  return (
    <div className="panel-stack">
      <Section
        title="人格"
        hint={
          editable
            ? "改的是这台电脑上的它，不是临时人设。"
            : "只有 owner 能改人格；现在以只读方式显示。"
        }
        action={
          <button className="btn btn-primary" onClick={() => void save()} disabled={!editable || saving || !dirty}>
            {saving ? "保存中…" : "保存"}
          </button>
        }
      >
        <div className="field">
          <label className="field-label" htmlFor="persona-name">
            名字
          </label>
          <input
            id="persona-name"
            className="input"
            value={name}
            maxLength={24}
            disabled={!editable}
            onChange={(event) => setName(event.target.value)}
          />
        </div>
        <div className="field">
          <label className="field-label" htmlFor="persona-city">
            所在城市
          </label>
          <input
            id="persona-city"
            className="input"
            value={city}
            maxLength={24}
            disabled={!editable}
            onChange={(event) => setCity(event.target.value)}
          />
        </div>
        <div className="field">
          <label className="field-label" htmlFor="persona-interests">
            兴趣（用顿号分隔）
          </label>
          <input
            id="persona-interests"
            className="input"
            value={interests}
            disabled={!editable}
            onChange={(event) => setInterests(event.target.value)}
          />
        </div>
        <div className="field">
          <label className="field-label" htmlFor="persona-habits">
            说话习惯（用顿号分隔）
          </label>
          <input
            id="persona-habits"
            className="input"
            value={habits}
            disabled={!editable}
            onChange={(event) => setHabits(event.target.value)}
          />
        </div>
        <p className="prose muted">
          说话风格：标点 {persona.speechStyle.punctuation} · 句长 {persona.speechStyle.sentenceLength}
        </p>
      </Section>

      <Section title="表达参数" hint="这些参数决定气泡条数、延迟与记忆衰减，属于人格的一部分，只读。">
        <dl className="kv-grid">
          {traitRows(persona.traits).map((row) => (
            <div key={row.label} className="kv-pair">
              <dt>{row.label}</dt>
              <dd>{row.value}</dd>
            </div>
          ))}
        </dl>
      </Section>

      <Section title="不可变内核" hint="这些不提供编辑入口：改了它就不是它了。">
        <dl className="kv-grid">
          <dt>背景</dt>
          <dd className="prose">{persona.immutable.background}</dd>
          <dt>价值观</dt>
          <dd>
            <ul className="bullet-list">
              {persona.immutable.values.map((value) => (
                <li key={value}>{value}</li>
              ))}
            </ul>
          </dd>
          <dt>禁区</dt>
          <dd>
            <ul className="bullet-list danger-list">
              {persona.immutable.taboo.map((item) => (
                <li key={item}>{item}</li>
              ))}
            </ul>
          </dd>
        </dl>
      </Section>
    </div>
  );
}
