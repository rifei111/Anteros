import { describe, expect, it } from "vitest";
import { DRIVE_DEFAULTS, DRIVE_NAMES, advanceDrives, emptyDrives } from "../src/mind/drives.js";

describe("驱动参数能不能真的越阈", () => {
  it("每个驱动的稳态值 rate/(rate+decay) 都高于自己的阈值", () => {
    for (const name of DRIVE_NAMES) {
      const params = DRIVE_DEFAULTS[name];
      const steady = params.rate / (params.rate + params.decay);
      expect(
        steady,
        `${name} 的稳态只有 ${steady.toFixed(3)}，低于阈值 ${params.threshold}，永远不可能越阈`,
      ).toBeGreaterThan(params.threshold + 0.02);
    }
  });

  it("安静一整天，想/闷/无趣至少各有一个能真正越阈", () => {
    const start = emptyDrives(Date.now() - 24 * 3_600_000);
    const after = advanceDrives(start, 24);
    const crossed = DRIVE_NAMES.filter((name) => after[name] >= DRIVE_DEFAULTS[name].threshold);
    expect(crossed.length).toBeGreaterThan(0);
    expect(crossed.some((name) => name === "loneliness" || name === "longing" || name === "boredom")).toBe(true);
  });
});