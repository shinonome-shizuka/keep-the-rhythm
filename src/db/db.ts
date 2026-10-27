import Dexie from "dexie";
import type { StoredEvent } from "../sync/model";
import { state } from "@/core/pluginState";
import { DailyActivity } from "./types";
import { getVaultKey, hashString } from "@/utils/utils";

class KTRDatabase extends Dexie {
	dailyActivity!: Dexie.Table<DailyActivity, number>;
	syncEvents!: Dexie.Table<StoredEvent, string>;
	syncMeta!: Dexie.Table<{ key: string; value: unknown }, string>;

	// It's necessary to add an unique identifier to the vault
	// indexedDB is shared across the same electron app, otherwise different vaults
	// would share the db and explode!

	constructor(vaultKey: string) {
		super(`KTRDatabase-${hashString(vaultKey)}`);

		this.version(2).stores({
			dailyActivity:
				"++id, date, filePath, [date+filePath], [filePath+date]",
		});
		this.version(3).stores({
			dailyActivity:
				"++id, date, filePath, [date+filePath], [filePath+date]",
			syncEvents: "id, pending",
			syncMeta: "key",
		});
	}
}

let dbInstance: KTRDatabase | null = null;

// Need to init the database onload() so that the plugin instance already exists
export async function initDatabase() {
	if (!dbInstance) {
		dbInstance = new KTRDatabase(getVaultKey(state.plugin.app.vault));
	}
}

export function getDB(): KTRDatabase {
	if (!dbInstance) {
		throw new Error(
			"Database not initialized. Call initDatabase() in onload().",
		);
	}
	return dbInstance;
}

export function closeDB() {
	dbInstance?.close();
	dbInstance = null;
}
