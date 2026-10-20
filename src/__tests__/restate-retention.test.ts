import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as DedupModule from "../dedup.js";
import type * as RetentionModule from "../restate/retention.js";
import { testDb } from "./helpers/test-db.js";

let dedup: typeof DedupModule;
let retention: typeof RetentionModule;
let warn: ReturnType<typeof vi.spyOn>;

beforeEach(async () => {
  ({ dedup, retention } = (
    await testDb({
      modules: {
        dedup: () => import("../dedup.js"),
        retention: () => import("../restate/retention.js"),
      },
    })
  ).modules);
  warn = vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  warn.mockRestore();
});

function seed(key: string, value: string): void {
  dedup.getDb().prepare("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)").run(key, value);
}

const kinds = [
  { name: "restate", key: "restate_retention_days", get: () => retention.getRestateRetentionDays(), set: (n: number) => retention.setRestateRetentionDays(n) },
  { name: "volume snapshot", key: "volume_snapshot_retention_days", get: () => retention.getVolumeSnapshotRetentionDays(), set: (n: number) => retention.setVolumeSnapshotRetentionDays(n) },
];

for (const k of kinds) {
  describe(`${k.name} retention days`, () => {
    it("defaults to 14 with no row and no warning", () => {
      expect(k.get()).toBe(14);
      expect(warn).not.toHaveBeenCalled();
    });

    it("reads a valid row, including the boundaries", () => {
      for (const v of ["30", "1", "60"]) {
        seed(k.key, v);
        expect(k.get()).toBe(Number(v));
      }
      expect(warn).not.toHaveBeenCalled();
    });

    it.each(["0", "61", "abc", "1.5", "", "10abc", "-3"])("answers 14 and warns once for %j", (v) => {
      seed(k.key, v);
      expect(k.get()).toBe(14);
      expect(warn).toHaveBeenCalledTimes(1);
    });

    it.each([0, 61, 1.5, NaN])("rejects %s naming the field", (n) => {
      expect(() => k.set(n)).toThrow(k.key);
    });

    it("writes a valid value", () => {
      k.set(10);
      expect(k.get()).toBe(10);
    });
  });
}

it("the two rows are independent", () => {
  retention.setRestateRetentionDays(5);
  expect(retention.getVolumeSnapshotRetentionDays()).toBe(14);
  retention.setVolumeSnapshotRetentionDays(7);
  expect(retention.getRestateRetentionDays()).toBe(5);
});

it("restateRetentionMs is days times 86_400_000", () => {
  expect(retention.restateRetentionMs()).toBe(14 * 86_400_000);
  retention.setRestateRetentionDays(10);
  expect(retention.restateRetentionMs()).toBe(10 * 86_400_000);
});
