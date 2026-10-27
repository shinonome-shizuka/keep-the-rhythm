import { describe, test, expect } from "@jest/globals";
import { materialize, liveDeltas, normalizeServerUrl } from "../src/sync/model";
import type { SyncEvent } from "../src/sync/model";
const delta = (id: string, w: number): SyncEvent => ({
	id,
	clock: 1,
	kind: "delta",
	value: {
		date: "2026-10-27",
		filePath: "笔记.md",
		wordCountStart: 100,
		charCountStart: 300,
		timeKey: "10:00",
		w,
		c: w * 2,
	},
});
const total = (events: SyncEvent[]) =>
	materialize(events).reduce(
		(sum, row) => sum + row.changes.reduce((s, c) => s + c.w, 0),
		0,
	);

describe("server event projection", () => {
	test("concurrent writing adds; repeated delivery does not", () => {
		expect(total([delta("a", 10), delta("b", 20), delta("a", 10)])).toBe(
			30,
		);
	});
	test("two devices deleting the same observed writing do not subtract twice", () => {
		const events: SyncEvent[] = [
			delta("a", 10),
			delta("b", 20),
			{ id: "d1", clock: 2, kind: "remove", targets: ["a"] },
			{ id: "d2", clock: 2, kind: "remove", targets: ["a"] },
		];
		expect(total(events)).toBe(20);
		expect(total([...events].reverse())).toBe(20);
	});
	test("rename and delete work on migrated events without replaying history", () => {
		const seed: SyncEvent = {
			id: "seed",
			clock: 0,
			kind: "seed",
			rows: [
				{
					date: "2026-01-01",
					filePath: "old.md",
					wordCountStart: 40,
					charCountStart: 90,
					changes: [{ timeKey: "12:00", w: -3, c: -6 }],
				},
			],
		};
		const events: SyncEvent[] = [
			seed,
			{
				id: "rename",
				clock: 1,
				kind: "rename",
				targets: ["seed:0:0"],
				path: "new.md",
			},
		];
		expect(materialize(events)[0]).toMatchObject({
			filePath: "new.md",
			wordCountStart: 40,
		});
		expect(total(events)).toBe(-3);
		expect(
			liveDeltas([
				...events,
				{
					id: "delete",
					clock: 2,
					kind: "remove",
					targets: ["seed:0:0"],
				},
			]).size,
		).toBe(0);
	});
	test("concurrent renames converge regardless of arrival order", () => {
		const events: SyncEvent[] = [
			delta("a", 10),
			{
				id: "r1",
				clock: 2,
				kind: "rename",
				targets: ["a"],
				path: "one.md",
			},
			{
				id: "r2",
				clock: 2,
				kind: "rename",
				targets: ["a"],
				path: "two.md",
			},
		];
		expect(materialize(events)).toEqual(materialize([...events].reverse()));
		expect(materialize(events)[0].filePath).toBe("two.md");
	});
	test("plain HTTP is restricted to loopback; credentials cannot be in URL", () => {
		expect(normalizeServerUrl("https://ktr.example.com/")).toBe(
			"https://ktr.example.com",
		);
		expect(normalizeServerUrl("http://127.0.0.1:8787")).toBe(
			"http://127.0.0.1:8787",
		);
		expect(() => normalizeServerUrl("http://ktr.example.com")).toThrow();
		expect(() =>
			normalizeServerUrl("https://user:pass@ktr.example.com"),
		).toThrow();
	});
});
