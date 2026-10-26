import { useEffect, useMemo, useState } from "react";
import type { PersonaPreset } from "@anteros/shared";
import { finishOnboarding } from "../lib/app";
import { useAppState } from "../lib/store";
import { labelOf } from "../lib/labels";

interface TraitChip {
  label: string;
  value: number;
}

function traitChips(preset: PersonaPreset): TraitChip[] {
  const traits = preset.persona.traits;
  return [
    { label: "话多", value: traits.detailPref },
    { label: "温暖", value: traits.warmth },
    { label: "主动", value: traits.initiative },
    { label: "幽默", value: traits.humor },
  ];
}

/**
 * 首次引导：选一个预设人格 → 确认昵称/城市 → 进聊天。
 * 明确告知记忆与人格只存在本机，不提供"云同步"这类选项。
 */
export function Onboarding() {
  const state = useAppState();
  const presets = state.presets;
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const selected = useMemo(
    () => presets.find((preset) => preset.id === selectedId) ?? null,
    [presets, selectedId],
  );

  const [name, setName] = useState("");
  const [city, setCity] = useState("");

  useEffect(() => {
    if (selected) {
      setName(selected.persona.name);
      setCity(selected.persona.city);
      return;
    }
    if (state.persona) {
      setName(state.persona.name);
      setCity(state.persona.city);
    }
  }, [selected, state.persona]);

  const canStart = name.trim().length > 0 && !state.onboardingSaving;

  const start = async (): Promise<void> => {
    if (!canStart) return;
    await finishOnboarding({ presetId: selected?.id ?? null, name, city });
  };

  return (
    <div className="center-screen">
      <div className="onboarding-card">
        <header className="onboarding-head">
          <h1>先决定它是谁</h1>
          <p>
            人格、记忆、密钥都只存在这台电脑上（{state.dataDir || "本机数据目录"}）。之后可以在管理面板里再调整。
          </p>
        </header>

        <div className="preset-grid">
          {presets.map((preset) => (
            <button
              key={preset.id}
              className={`preset-card ${selectedId === preset.id ? "selected" : ""}`}
              onClick={() => setSelectedId(preset.id)}
              type="button"
            >
              <div className="preset-name">{preset.name}</div>
              <div className="preset-city">{preset.persona.city}</div>
              <div className="preset-summary">{preset.summary}</div>
              <div className="preset-traits">
                {traitChips(preset).map((chip) => (
                  <span className="trait-chip" key={chip.label}>
                    {chip.label} {(chip.value * 100).toFixed(0)}%
                  </span>
                ))}
              </div>
              <div className="preset-style">
                口癖：{preset.persona.speechStyle.habits.slice(0, 3).join("、") || "—"}
              </div>
            </button>
          ))}
          {presets.length === 0 ? (
            <div className="empty-note">
              {state.presetsLoading ? "正在读取预设人格…" : "内核没有返回预设人格，将使用当前默认人格。"}
            </div>
          ) : null}
        </div>

        <section className="onboarding-form">
          <label className="field">
            <span>它叫什么</span>
            <input value={name} onChange={(event) => setName(event.target.value)} placeholder="昵称" maxLength={20} />
          </label>
          <label className="field">
            <span>它在哪座城市</span>
            <input value={city} onChange={(event) => setCity(event.target.value)} placeholder="城市" maxLength={20} />
          </label>
          {selected ? (
            <div className="field-hint">
              关系阶段：{labelOf({ stranger: "陌生", acquainted: "认识", familiar: "熟悉", close: "亲密", strained: "疏远", repairing: "修复中" }, state.relation?.stage)} · 完全体默认关闭，开启需要二次确认
            </div>
          ) : null}
        </section>

        <footer className="onboarding-foot">
          <div className="onboarding-note">不选择预设也可以，直接用当前默认人格开始。</div>
          <button className="btn btn-primary btn-lg" onClick={() => void start()} disabled={!canStart}>
            {state.onboardingSaving ? "正在写入人格…" : "开始聊天"}
          </button>
        </footer>
      </div>
    </div>
  );
}
