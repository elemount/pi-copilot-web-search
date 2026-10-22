// Pi resolves extension dependencies from its own installation. Give plain Node tests the same TypeBox.
import { registerHooks } from "node:module";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

try { import.meta.resolve("typebox"); }
catch {
	const root = process.env.PI_MANAGED_INSTALL_ROOT ?? join(homedir(), ".pi/agent/install");
	const version = readFileSync(join(root, "current-version"), "utf8").trim();
	const typebox = pathToFileURL(join(root, "releases", version, "node_modules/typebox/build/index.mjs")).href;
	registerHooks({ resolve(specifier, context, nextResolve) {
		return nextResolve(specifier === "typebox" ? typebox : specifier, context);
	} });
}
