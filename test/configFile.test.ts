import { expect, test } from "@jest/globals";
import {
	VpsSettingsFile,
	configForDevice,
	parsePortableSettings,
	portableSettings,
} from "../src/sync/configFile";
const fields = {
	url: "https://ktr.example.com",
	token: "t".repeat(32),
	vaultId: "writing",
};

test("portable settings exclude device state and a fresh device joins", () => {
	const settings = portableSettings(
		{ ...fields, active: true, mode: "create" },
		fields,
	);
	const copy = parsePortableSettings(JSON.stringify(settings));
	expect(copy.connection).toEqual(fields);
	expect(JSON.stringify(copy)).not.toMatch(/active|mode|cursor|pending|seed/);
	expect(configForDevice(copy.connection!, null)).toEqual({
		...fields,
		active: false,
		mode: "join",
	});
});
test("existing device keeps journal identity and import state when token changes", () => {
	const local = { ...fields, mode: "create" as const, active: true };
	expect(
		configForDevice({ ...fields, token: "n".repeat(32) }, local),
	).toEqual({ ...local, token: "n".repeat(32) });
	expect(() =>
		configForDevice({ ...fields, vaultId: "other" }, local),
	).toThrow();
});
test("incomplete drafts survive file transfer but cannot create a connection", () => {
	const draft = { url: "htt", token: "short", vaultId: "" };
	const copied = parsePortableSettings(
		JSON.stringify(portableSettings(null, draft)),
	);
	expect(copied.draft).toEqual(draft);
	expect(copied.connection).toBeNull();
	expect(() =>
		parsePortableSettings(
			'{"version":1,"connection":{"url":"https://example.com","token":"short","vaultId":"writing"}}',
		),
	).toThrow();
});
test("rapid edits persist in order, without rewriting unchanged files", async () => {
	let content: string | null = null;
	let writes = 0;
	const file = new VpsSettingsFile(
		{
			exists: async () => content !== null,
			read: async () => content!,
			write: async (_path, value) => {
				writes++;
				content = value;
			},
		},
		"vps-settings.json",
	);
	await Promise.all([
		file.write(portableSettings(null, { ...fields, url: "h" })),
		file.write(portableSettings(null, fields)),
	]);
	expect((await file.read())?.draft).toEqual(fields);
	await file.write(portableSettings(null, fields));
	expect(writes).toBe(2);
});

test("a device with an unfinished import must join shared history instead of bootstrapping again", () => {
	expect(
		configForDevice(fields, { ...fields, active: false, mode: "create" }),
	).toEqual({ ...fields, active: false, mode: "join" });
});
