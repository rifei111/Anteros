import { describe, it, expect } from "vitest";
import { Db } from "../src/db/database.js";
import { DEFAULT_TRAITS } from "@anteros/shared";

describe("smoke", () => {
  it("sqlite memory db works", () => {
    const db = new Db(":memory:");
    db.migrate();
    db.run("INSERT INTO users(tz, created_ts) VALUES (?, ?)", ["Asia/Shanghai", 1]);
    expect(db.get<{ n: number }>("SELECT COUNT(*) AS n FROM users")?.n).toBe(1);
    expect(DEFAULT_TRAITS.memoryD).toBe(0.5);
  });
});
