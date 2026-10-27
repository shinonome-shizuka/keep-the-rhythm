import "fake-indexeddb/auto";
import Dexie from "dexie";
import { beforeEach, afterEach, test, expect, jest } from "@jest/globals";
import { SyncStore } from "../src/sync/store";
import type { SyncReply, Delta, SyncEvent } from "../src/sync/model";
import type { DailyActivity } from "../src/db/types";

let mockDB: Dexie & {
	dailyActivity: Dexie.Table<DailyActivity, number>;
	syncEvents: Dexie.Table;
	syncMeta: Dexie.Table;
};
jest.mock("../src/db/db", () => ({ getDB: () => mockDB }));
const config = {
	url: "https://example.com",
	token: "t".repeat(32),
	vaultId: "writing",
	mode: "create" as const,
	active: false,
};
const value: Delta = {
	date: "2026-10-27",
	filePath: "test.md",
	wordCountStart: 0,
	charCountStart: 0,
	timeKey: "12:00",
	w: 3,
	c: 6,
};
const empty = (): SyncReply => ({
	version: 1,
	accepted: [],
	events: [],
	cursor: 0,
	hasMore: false,
});

beforeEach(async () => {
	mockDB = new Dexie(`test-${crypto.randomUUID()}`) as typeof mockDB;
	mockDB.version(1).stores({
		dailyActivity: "++id, date, filePath, [date+filePath]",
		syncEvents: "id,pending",
		syncMeta: "key",
	});
	await mockDB.open();
});
afterEach(async () => {
	await mockDB.delete();
});

async function setup(transport: ConstructorParameters<typeof SyncStore>[0]) {
	const store = new SyncStore(transport, () => undefined);
	await store.setMeta("config", config);
	await store.load();
	await store.initialize([]);
	return store;
}

test("offline first activation journals edits and survives restart", async () => {
	const transport = async (): Promise<SyncReply> => {
		throw new Error("offline");
	};
	const store = await setup(transport);
	await store.record(value);
	await expect(store.sync()).rejects.toThrow("offline");
	const restarted = new SyncStore(transport, () => undefined);
	await restarted.load();
	await restarted.initialize([]);
	expect(await mockDB.syncEvents.where("pending").equals(1).count()).toBe(1);
	expect((await mockDB.dailyActivity.toArray())[0].changes[0].w).toBe(3);
});

test("lost response retries the same IDs and clears queue only on acknowledgment", async () => {
	const accepted = new Map<string, SyncEvent>();
	let lose = true;
	const store = await setup(async (_config, endpoint, raw) => {
		if (endpoint === "/v1/bootstrap") return empty();
		const body = raw as { events: SyncEvent[] };
		body.events.forEach((event) => accepted.set(event.id, event));
		if (lose) {
			lose = false;
			throw new Error("response lost");
		}
		return {
			...empty(),
			accepted: body.events.map((event) => event.id),
			events: [...accepted.values()].map((event, i) => ({
				seq: i + 1,
				event,
			})),
			cursor: accepted.size,
		};
	});
	await store.record(value);
	await expect(store.sync()).rejects.toThrow();
	expect(await mockDB.syncEvents.where("pending").equals(1).count()).toBe(1);
	await store.sync();
	expect(accepted.size).toBe(1);
	expect(await mockDB.syncEvents.where("pending").equals(1).count()).toBe(0);
	expect((await mockDB.dailyActivity.toArray())[0].changes[0].w).toBe(3);
});

test("editing during a network request remains pending and is included in projection", async () => {
	let release!: (value: SyncReply) => void;
	let sent!: SyncEvent[];
	const store = await setup(async (_config, endpoint, body) => {
		if (endpoint === "/v1/bootstrap") return empty();
		sent = (body as { events: SyncEvent[] }).events;
		return new Promise((resolve) => {
			release = resolve;
		});
	});
	await store.record(value);
	const syncing = store.sync();
	while (!release) await new Promise((resolve) => setTimeout(resolve, 1));
	await store.record({ ...value, w: 7, c: 14 });
	release({
		...empty(),
		accepted: sent.map((event) => event.id),
		events: sent.map((event, i) => ({ seq: i + 1, event })),
		cursor: sent.length,
	});
	await syncing;
	expect(await mockDB.syncEvents.where("pending").equals(1).count()).toBe(1);
	expect((await mockDB.dailyActivity.toArray())[0].changes[0].w).toBe(10);
});

test("failed join never replaces local history or activates server mode", async () => {
	await mockDB.dailyActivity.add({
		date: "2026-01-01",
		filePath: "local.md",
		wordCountStart: 1,
		charCountStart: 2,
		changes: [],
	});
	const store = new SyncStore(
		async () => {
			throw new Error("offline");
		},
		() => undefined,
	);
	await store.setMeta("config", { ...config, mode: "join" });
	await store.load();
	await expect(store.initialize([])).rejects.toThrow();
	expect(store.active).toBe(false);
	expect((await mockDB.dailyActivity.toArray())[0].filePath).toBe("local.md");
});

test("invalid manual dates and fractional counts never enter the durable queue", async () => {
	const store = await setup(async () => empty());
	await expect(
		store.record({ ...value, date: "2026-02-30" }),
	).rejects.toThrow();
	await expect(store.record({ ...value, w: 0.5 })).rejects.toThrow();
	expect(await mockDB.syncEvents.where("pending").equals(1).count()).toBe(0);
});

test("two independent device databases converge after offline writing, delete and rename", async () => {
	const ledger = new Map<string, { seq: number; event: SyncEvent }>();
	const network: ConstructorParameters<typeof SyncStore>[0] = async (
		_config,
		endpoint,
		raw,
	) => {
		const body = raw as {
			seed?: SyncEvent;
			events?: SyncEvent[];
			cursor: number;
		};
		if (endpoint === "/v1/bootstrap") {
			if (!ledger.has("seed"))
				ledger.set("seed", { seq: 1, event: body.seed! });
			return empty();
		}
		for (const event of body.events!)
			if (!ledger.has(event.id))
				ledger.set(event.id, { seq: ledger.size + 1, event });
		return {
			...empty(),
			accepted: body.events!.map((e) => e.id),
			events: [...ledger.values()].filter(
				(item) => item.seq > body.cursor,
			),
			cursor: ledger.size,
		};
	};
	const firstDB = mockDB;
	const first = await setup(network);
	await first.sync();
	const secondDB = new Dexie(
		`second-${crypto.randomUUID()}`,
	) as typeof mockDB;
	secondDB.version(1).stores({
		dailyActivity: "++id, date, filePath, [date+filePath]",
		syncEvents: "id,pending",
		syncMeta: "key",
	});
	await secondDB.open();
	try {
		mockDB = secondDB;
		const second = new SyncStore(network, () => undefined);
		await second.setMeta("config", { ...config, mode: "join" });
		await second.load();
		await second.initialize([]);
		await first.record({ ...value, w: 10 });
		await second.record({ ...value, w: 20 });
		await Promise.all([first.sync(), second.sync()]);
		await first.sync();
		await second.sync();
		for (const db of [firstDB, secondDB])
			expect((await db.dailyActivity.toArray())[0].changes[0].w).toBe(30);
		// Both delete exactly the same observed events, while first creates a
		// new event not yet visible on second. The new writing must survive.
		await first.remove(value.filePath, value.date);
		await first.record({ ...value, w: 7 });
		await second.remove(value.filePath, value.date);
		await first.sync();
		await second.sync();
		await first.sync();
		for (const db of [firstDB, secondDB])
			expect((await db.dailyActivity.toArray())[0].changes[0].w).toBe(7);
		await second.rename(value.filePath, "renamed.md");
		await second.sync();
		await first.sync();
		for (const db of [firstDB, secondDB])
			expect((await db.dailyActivity.toArray())[0].filePath).toBe(
				"renamed.md",
			);
	} finally {
		await secondDB.delete();
		mockDB = firstDB;
	}
});

test("incomplete connection drafts survive restart without activating or validating", async () => {
	const first = new SyncStore(
		async () => empty(),
		() => undefined,
	);
	await first.saveDraft({
		url: "http://unfinished",
		token: "short",
		vaultId: "my.vault",
	});
	const reopened = new SyncStore(
		async () => empty(),
		() => undefined,
	);
	await reopened.load();
	expect(reopened.draft).toEqual({
		url: "http://unfinished",
		token: "short",
		vaultId: "my.vault",
	});
	expect(reopened.active).toBe(false);
});
