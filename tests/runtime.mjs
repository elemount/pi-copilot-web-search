// Pi resolves extension dependencies from its own installation. Give plain Node tests the same modules.
import { registerHooks } from "node:module";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

for (const [name, entry] of [
	["typebox", "typebox/build/index.mjs"],
	["@earendil-works/pi-tui", "@earendil-works/pi-tui/dist/index.js"],
]) {
	try { import.meta.resolve(name); }
	catch {
		const root = process.env.PI_MANAGED_INSTALL_ROOT ?? join(homedir(), ".pi/agent/install");
		const version = readFileSync(join(root, "current-version"), "utf8").trim();
		const url = pathToFileURL(join(root, "releases", version, "node_modules", entry)).href;
		registerHooks({ resolve(specifier, context, nextResolve) {
			return nextResolve(specifier === name ? url : specifier, context);
		} });
	}
}
