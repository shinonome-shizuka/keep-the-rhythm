import { normalizeServerUrl } from "./model";
import type { SyncConfig } from "./model";

export interface ConnectionFields {
	url: string;
	token: string;
	vaultId: string;
}
export interface PortableSettings {
	version: 1;
	connection: ConnectionFields | null;
	draft: ConnectionFields | null;
}
interface FileAdapter {
	exists(path: string): Promise<boolean>;
	read(path: string): Promise<string>;
	write(path: string, content: string): Promise<void>;
}
function fields(value: unknown): ConnectionFields | null {
	if (value === null || value === undefined) return null;
	if (typeof value !== "object") throw new Error("Invalid VPS settings file");
	const input = value as Record<string, unknown>;
	if (
		![input.url, input.token, input.vaultId].every(
			(value) => typeof value === "string",
		)
	)
		throw new Error("Invalid VPS settings fields");
	return {
		url: input.url as string,
		token: input.token as string,
		vaultId: input.vaultId as string,
	};
}
export function portableSettings(
	config: SyncConfig | null,
	draft: ConnectionFields | null,
): PortableSettings {
	return { version: 1, connection: fields(config), draft: fields(draft) };
}
export function parsePortableSettings(raw: string): PortableSettings {
	const value = JSON.parse(raw) as Partial<PortableSettings>;
	if (!value || value.version !== 1)
		throw new Error("Unsupported VPS settings file");
	const connection = fields(value.connection);
	if (connection) {
		connection.url = normalizeServerUrl(connection.url);
		if (
			connection.token.length < 32 ||
			!/^[A-Za-z0-9_-]{1,100}$/.test(connection.vaultId)
		)
			throw new Error("Invalid VPS connection in settings file");
	}
	return { version: 1, connection, draft: fields(value.draft) };
}

// Never copy a device's import mode, active flag, cursor or pending queue.
// A fresh device always joins server history; an existing one keeps its journal.
export function configForDevice(
	connection: ConnectionFields,
	local: SyncConfig | null,
): SyncConfig {
	if (local?.active && local.vaultId !== connection.vaultId)
		throw new Error(
			"VPS settings belong to another vault. Existing local connection was kept.",
		);
	return local?.active && local.vaultId === connection.vaultId
		? { ...local, ...connection }
		: { ...connection, mode: "join", active: false };
}

export class VpsSettingsFile {
	private writes: Promise<void> = Promise.resolve();
	constructor(
		private adapter: FileAdapter,
		readonly path: string,
	) {}
	async read(): Promise<PortableSettings | null> {
		return (await this.adapter.exists(this.path))
			? parsePortableSettings(await this.adapter.read(this.path))
			: null;
	}
	write(settings: PortableSettings): Promise<void> {
		const content = JSON.stringify(settings, null, 2) + "\n";
		const result = this.writes.then(async () => {
			if (
				(await this.adapter.exists(this.path)) &&
				(await this.adapter.read(this.path)) === content
			)
				return;
			await this.adapter.write(this.path, content);
		});
		this.writes = result.catch(() => undefined);
		return result;
	}
	async flush() {
		await this.writes;
	}
}
