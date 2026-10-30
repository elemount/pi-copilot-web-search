import assert from "node:assert/strict";
import test from "node:test";
import "./runtime.mjs";
import { addSearch, SearchCollector, searchRoute, supportsSearch } from "../core.ts";
import { McpSearchError } from "../mcp.ts";
const { default: extension } = await import("../index.ts");

const gpt = { provider: "github-copilot", id: "gpt-6.1-sol", api: "openai-responses" };
const claude = { provider: "github-copilot", id: "claude-sonnet-5.5", api: "anthropic-messages" };

function harness(flag = undefined, model = gpt, search = async () => ({ text: "Search answer", sources: [] })) {
	const handlers = new Map();
	const commands = new Map();
	const flags = new Map();
	const notifications = [];
	const statuses = new Map();
	const statusCalls = [];
	const tools = new Map();
	let activeTools = ["read", "bash"];
	const pi = {
		registerFlag: (name, options) => flags.set(name, options),
		getFlag: name => flag ?? flags.get(name)?.default,
		registerCommand: (name, command) => commands.set(name, command),
		on: (name, handler) => handlers.set(name, handler),
		registerTool: tool => tools.set(tool.name, tool),
		getActiveTools: () => [...activeTools],
		setActiveTools: names => { activeTools = [...names]; },
	};
	const ctx = { model, ui: {
		setStatus: (name, value) => { statusCalls.push([name, value]); statuses.set(name, value); },
		notify: (...args) => notifications.push(args),
	} };
	extension(pi, search);
	const emit = (name, event = {}) => handlers.get(name)?.(event, ctx);
	emit("session_start");
	return { emit, ctx, flags, statuses, statusCalls, notifications, tools, activeTools: () => [...activeTools],
		command: args => commands.get("web-search").handler(args, ctx),
		search: (query, signal) => tools.get("web_search").execute("test-call", { query }, signal, undefined, ctx),
	};
}

function stream(h, data, model = gpt) {
	return h.emit("provider_stream_event", { provider: model.provider, model: model.id, api: model.api, data });
}
function finish(h, overrides = {}) {
	return h.emit("message_end", { message: {
		role: "assistant", provider: gpt.provider, model: gpt.id, api: gpt.api,
		content: [{ type: "text", text: "Answer" }], stopReason: "stop", ...overrides,
	} });
}
function citations(h) {
	stream(h, { type: "response.output_item.done", item: { type: "web_search_call", status: "completed" } });
	stream(h, { type: "response.output_text.annotation.added", annotation: {
		type: "url_citation", url: "https://docs.github.com/en/copilot", title: "GitHub docs",
	} });
}

test("default on and a boolean CLI option, without startup notifications", () => {
	const h = harness();
	assert.deepEqual(h.flags.get("web-search"), {
		type: "boolean", default: true,
		description: "Enable web search: GPT native Responses; other models via GitHub MCP",
	});
	assert.ok(h.emit("before_provider_request", { payload: { model: gpt.id } }));
	assert.deepEqual(h.notifications, []);
	const mcp = harness(undefined, claude);
	assert.deepEqual(mcp.activeTools(), ["read", "bash", "web_search"]);
	assert.deepEqual(mcp.notifications, []);
});

test("explicit false disables native search and the MCP tool", () => {
	for (const model of [gpt, claude]) {
		const h = harness(false, model);
		assert.equal(h.emit("before_provider_request", { payload: { model: model.id } }), undefined);
		assert.deepEqual(h.activeTools(), ["read", "bash"]);
		assert.equal(h.statuses.get("web-search"), undefined);
	}
});

test("flag enables search without mutating tools or forcing search", () => {
	const h = harness(true);
	const payload = { model: gpt.id, input: [], tools: [{ type: "function", name: "read" }], tool_choice: "auto" };
	const original = structuredClone(payload);
	const next = h.emit("before_provider_request", { payload });
	assert.deepEqual(payload, original);
	assert.deepEqual(next.tools, [...original.tools, { type: "web_search" }]);
	assert.equal(next.tool_choice, "auto");
});

test("non-GPT payloads have no native injection, but expose the MCP function tool", () => {
	for (const model of [claude, { ...claude, provider: "anthropic" }, { ...claude, api: "openai-responses" }]) {
		const h = harness(true, model);
		const payload = { model: model.id, messages: [], tools: [{ name: "read" }] };
		const original = structuredClone(payload);
		assert.equal(h.emit("before_provider_request", { payload }), undefined);
		assert.deepEqual(payload, original);
		assert.deepEqual(h.statusCalls, []);
		assert.deepEqual(h.activeTools(), ["read", "bash", "web_search"]);
	}
});

test("only GPT Responses on verified providers, no cross-model requests", () => {
	assert.equal(supportsSearch({ ...gpt, provider: "openai" }), true);
	assert.equal(supportsSearch({ ...gpt, api: "openai-completions" }), false);
	assert.equal(supportsSearch({ ...gpt, provider: "custom-proxy" }), false);
	assert.equal(supportsSearch(undefined), false);
	assert.equal(addSearch({ model: claude.id }, gpt), undefined);
});

test("existing web search tools are not duplicated or reconfigured", () => {
	for (const type of ["web_search", "web_search_preview"]) {
		assert.equal(addSearch({ model: gpt.id, tools: [{ type }] }, gpt), undefined);
	}
	assert.deepEqual(addSearch({ model: gpt.id }, gpt).tools, [{ type: "web_search" }]);
});

test("session commands silently turn on/off; status and invalid arguments still notify", async () => {
	for (const model of [gpt, claude, { ...gpt, provider: "custom" }]) {
		const h = harness(undefined, model);
		for (const action of ["on", "off", "off", "on", "on", "off"]) {
			await h.command(action);
			assert.deepEqual(h.notifications, []);
			const route = searchRoute(model);
			assert.deepEqual(h.statusCalls, []);
			assert.equal(h.activeTools().includes("web_search"), action === "on" && route === "mcp");
			assert.equal(Boolean(h.emit("before_provider_request", { payload: { model: model.id } })), action === "on" && route === "native");
		}
		await h.command("invalid");
		assert.equal(h.notifications.at(-1)[1], "warning");
		assert.equal(h.emit("before_provider_request", { payload: { model: model.id } }), undefined);
		for (const action of ["status", ""]) {
			await h.command(action);
			assert.match(h.notifications.at(-1)[0], /off/);
			assert.equal(h.notifications.at(-1)[1], "info");
		}
		assert.equal(h.notifications.length, 3);
	}
});

test("startup, commands, model switches and searches never touch the footer status", async () => {
	for (const flag of [undefined, true, false]) {
		for (const model of [gpt, claude, { ...gpt, provider: "custom" }]) {
			const h = harness(flag, model);
			assert.deepEqual(h.statusCalls, []);
			for (const action of ["off", "on", "status"]) await h.command(action);
			h.emit("model_select");
			h.emit("before_provider_request", { payload: { model: model.id } });
			stream(h, { type: "response.web_search_call.searching" }, model);
			stream(h, { type: "response.web_search_call.completed" }, model);
			if (searchRoute(model) === "native") {
				citations(h);
				assert.match(finish(h).message.content.at(-1).text, /Web search sources/);
			} else if (searchRoute(model) === "mcp") {
				await h.search("A public question");
			}
			h.emit("agent_end");
			h.emit("session_start");
			assert.deepEqual(h.statusCalls, []);
		}
	}
});

test("citations are persisted in the answer, unrelated stream events ignored", () => {
	const h = harness(true);
	h.emit("before_provider_request", { payload: { model: gpt.id } });
	citations(h);
	stream(h, { type: "response.output_text.annotation.added", annotation: { url: "https://unrelated.example" } }, claude);
	const result = finish(h);
	assert.match(result.message.content.at(-1).text, /Web search sources/);
	assert.match(result.message.content.at(-1).text, /https:\/\/docs.github.com\/en\/copilot/);
	assert.doesNotMatch(result.message.content.at(-1).text, /unrelated/);
	assert.equal(finish(h), undefined);
});

test("no answer rewriting without actual completed searches, or on errors", () => {
	const h = harness(true);
	h.emit("before_provider_request", { payload: { model: gpt.id } });
	assert.equal(finish(h), undefined);
	h.emit("before_provider_request", { payload: { model: gpt.id } });
	citations(h);
	assert.equal(finish(h, { stopReason: "error" }), undefined);
});

test("retry resets previous citations; GPT to Claude switch does not leak them", () => {
	const h = harness(true);
	h.emit("before_provider_request", { payload: { model: gpt.id } });
	citations(h);
	h.emit("before_provider_request", { payload: { model: gpt.id } });
	assert.equal(finish(h), undefined);
	h.emit("before_provider_request", { payload: { model: gpt.id } });
	citations(h);
	h.ctx.model = claude;
	h.emit("model_select");
	assert.equal(finish(h, { model: claude.id }), undefined);
	assert.equal(h.emit("before_provider_request", { payload: { model: claude.id } }), undefined);
});

test("collector deduplicates, filters non-http URLs, captures message annotations", () => {
	const collector = new SearchCollector();
	collector.consume({ type: "response.output_text.annotation.added", annotation: { url: "https://example.com", title: "Example" } });
	collector.consume({ type: "response.output_item.done", item: { type: "message", content: [{ annotations: [
		{ type: "url_citation", url: "https://example.com" },
		{ url: "javascript:alert(1)" }, { url: "not a URL" },
	] }] } });
	assert.deepEqual(collector.getSources(), [{ url: "https://example.com", title: "Example" }]);
});

test("routing selects native GPT or MCP for all other models, never a silent GPT fallback", () => {
	assert.equal(searchRoute(gpt), "native");
	assert.equal(searchRoute({ ...gpt, provider: "openai" }), "native");
	assert.equal(searchRoute(claude), "mcp");
	assert.equal(searchRoute({ ...claude, provider: "anthropic" }), "mcp");
	assert.equal(searchRoute({ id: "gemini-3.8-flash", api: "openai-completions", provider: "github-copilot" }), "mcp");
	assert.equal(searchRoute({ id: "qwen-local", api: "openai-completions", provider: "local" }), "mcp");
	assert.equal(searchRoute({ ...gpt, provider: "custom" }), undefined);
	assert.equal(searchRoute({ ...gpt, api: "openai-completions" }), undefined);
	assert.equal(searchRoute(undefined), undefined);
});

test("MCP tool stays inactive with an explicit off flag and is enabled only on non-GPT models", async () => {
	let calls = 0;
	const h = harness(false, claude, async () => { calls++; return { text: "Answer", sources: [] }; });
	assert.equal(h.tools.get("web_search").defaultActive, false);
	assert.equal(h.tools.get("web_search").exposure, "model-only");
	assert.deepEqual(h.activeTools(), ["read", "bash"]);
	await assert.rejects(h.search("test"), /Web search is off/);
	await h.command("on");
	assert.deepEqual(h.activeTools(), ["read", "bash", "web_search"]);
	await h.search("test");
	assert.equal(calls, 1);
	await h.command("off");
	assert.deepEqual(h.activeTools(), ["read", "bash"]);
	await assert.rejects(h.search("test"), /Web search is off/);
	assert.equal(calls, 1);
});

test("model switching adds/removes only the MCP tool and keeps the search toggle", async () => {
	const h = harness(true);
	assert.deepEqual(h.activeTools(), ["read", "bash"]);
	assert.deepEqual(h.statusCalls, []);
	h.ctx.model = claude;
	h.emit("model_select");
	assert.deepEqual(h.activeTools(), ["read", "bash", "web_search"]);
	h.emit("model_select");
	assert.equal(h.activeTools().filter(name => name === "web_search").length, 1);
	h.ctx.model = gpt;
	h.emit("model_select");
	assert.deepEqual(h.activeTools(), ["read", "bash"]);
	await assert.rejects(h.search("test"), /unavailable for this model/);
	h.ctx.model = { ...gpt, provider: "custom" };
	h.emit("model_select");
	assert.deepEqual(h.activeTools(), ["read", "bash"]);
	assert.equal(h.statuses.get("web-search"), undefined);
});

test("MCP tool forwards only query and cancellation, preserving source URLs in its result", async () => {
	const controller = new AbortController();
	const calls = [];
	const h = harness(true, claude, async (...args) => {
		calls.push(args);
		return { text: "Verified answer", sources: [{ title: "Official docs", url: "https://example.com/docs" }] };
	});
	const result = await h.search("A public question", controller.signal);
	assert.deepEqual(calls, [["A public question", controller.signal]]);
	assert.match(result.content[0].text, /Verified answer/);
	assert.match(result.content[0].text, /Web search sources/);
	assert.match(result.content[0].text, /https:\/\/example.com\/docs/);
	assert.deepEqual(result.details, { route: "mcp", sources: [{ title: "Official docs", url: "https://example.com/docs" }] });
});

test("no MCP request from GPT native payload hooks, and tool failures are sanitized", async () => {
	let calls = 0;
	const h = harness(true, gpt, async () => { calls++; throw new Error("secret-token"); });
	h.emit("before_provider_request", { payload: { model: gpt.id } });
	assert.equal(calls, 0);
	h.ctx.model = claude;
	h.emit("model_select");
	await assert.rejects(h.search("test"), error => /GitHub MCP search failed/.test(error.message) && !error.message.includes("secret-token"));
	assert.equal(calls, 1);
	const safe = harness(true, claude, async () => { throw new McpSearchError("Sign in again."); });
	await assert.rejects(safe.search("test"), /Sign in again/);
});

test("off clears pending native citations and session_start restores the CLI default", async () => {
	const h = harness();
	h.emit("before_provider_request", { payload: { model: gpt.id } });
	citations(h);
	await h.command("off");
	assert.equal(finish(h), undefined);
	h.emit("session_start");
	assert.ok(h.emit("before_provider_request", { payload: { model: gpt.id } }));
	const off = harness(false, claude);
	await off.command("on");
	off.emit("session_start");
	assert.deepEqual(off.activeTools(), ["read", "bash"]);
});
