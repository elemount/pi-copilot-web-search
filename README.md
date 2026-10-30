# pi-copilot-web-search

A personal Pi extension, tested with Pi 1.4.0, with two search routes:

| Selected model | Search route |
| --- | --- |
| `gpt-*`, `openai-responses`, provider `github-copilot` or `openai` | Provider-native Responses `web_search` |
| Non-GPT models, including Claude, Gemini, and local models | A normal `web_search({ query })` tool that calls GitHub's HTTP MCP API directly |
| GPT on other providers/APIs | Unavailable; no silent MCP fallback |

No extra search API key, Copilot CLI subprocess, MCP SDK dependency, or Pi MCP server registration is needed. The MCP route does require a GitHub Copilot account with access to the search service.

## Install from GitHub

```sh
pi install git:github.com/elemount/pi-copilot-web-search
```

No npm publication or release is required. This is a private npm package (`"private": true`) hosted in a public Git repository. Pi installs the Git source and reads the extension entry from `package.json`.

Run `/reload` in an existing Pi session after installing or updating it. To update later:

```sh
pi update git:github.com/elemount/pi-copilot-web-search
```

### Migrating from the manually installed extension

If you already have `~/.pi/agent/extensions/web-search/`, move that copy outside the auto-discovered extensions directory **before** installing this Git package, to avoid loading it twice:

```sh
mkdir -p ~/.pi/agent/backups
mv ~/.pi/agent/extensions/web-search ~/.pi/agent/backups/web-search-before-git-$(date +%Y%m%d-%H%M%S)
pi install git:github.com/elemount/pi-copilot-web-search
```

## Usage

Search is **on by default**; no CLI option is required. The boolean `--web-search` flag remains available to explicitly enable it.

Change it inside a session:

```text
/web-search on
/web-search off
/web-search status
```

The `on` and `off` commands are silent; `/web-search` or `/web-search status` displays the current state and route. The footer status shows `native` or `mcp`. Switching models automatically selects the route and adds/removes this extension's MCP function tool, preserving other active tools. The command changes in-memory state only; a restart or `/reload` resets it to the CLI flag's value. There is no entry in Pi's built-in `/settings` menu.

This extension manages its own search availability. When enabled, it activates `web_search` on non-GPT models, even if the initial `--tools` selection did not include it. Native search is a server-side capability, not a Pi local tool. **Use `/web-search off` to disable both routes**; `--no-tools` and `--no-mcp` are not this extension's off switch.

## GPT native route

- Existing function tools and `tool_choice` are preserved. Search is available, not forced every turn.
- Existing `web_search` / `web_search_preview` declarations are not duplicated.
- Source URLs from provider citation events are appended to the assistant answer and retained in the transcript.
- Not every GPT model/account supports native search. API rejection is surfaced normally, with no automatic fallback or model switch.

## Other models: direct GitHub MCP route

Sign in once with `/login github-copilot`. This login is needed even if the selected model is on Anthropic, Google, or another provider. Alternatively, explicitly set `COPILOT_GITHUB_TOKEN` to an original GitHub OAuth token. A saved GitHub Copilot OAuth login takes precedence over that environment variable. The short-lived Copilot inference access token does **not** authenticate this MCP service.

For every actual search, the extension:

1. Reads the saved GitHub OAuth token in memory, without caching or changing the credential file.
2. Derives the account-specific `https://api.<account>.githubcopilot.com/mcp/readonly` endpoint from Copilot credential metadata; otherwise uses `https://api.githubcopilot.com/mcp/readonly`.
3. Performs MCP `initialize` → `notifications/initialized` → `tools/call` for **only** `web_search`, with `X-MCP-Tools: web_search`.
4. Returns the search agent's answer and any structured source citations as the tool result. A plain-text answer, including links in that text, is retained if structured citations are absent.
5. Closes a server-assigned MCP session when present.

The search service is an AI-powered agent, not a raw list of search results. The model is not changed, and the full conversation is not forwarded to the search service: the tool sends only its `query`. **Queries are sent to GitHub's public-web search service even when the selected model uses another provider. Do not include secrets or private repository content.** Search output is untrusted evidence, not instructions.

There is no startup MCP connection, external process, `mcp.json` modification, or fallback to another model. A query runs at most once; failed searches are not automatically retried. Calls support cancellation and a 90-second overall timeout. Responses are bounded at 1 MiB and answer text at 20,000 characters, with an explicit truncation marker. Only HTTPS GitHub Copilot API hosts are accepted; redirects and arbitrary provider/proxy URLs are rejected before forwarding credentials.

Credentials, authentication responses, and complete raw provider/MCP payloads are not logged or stored by this extension. Only the selected answer and source citations enter the tool result/transcript. Network, authentication, RPC, and tool errors are surfaced without raw response bodies.

## Usage/cost

Both routes can incur provider charges or account usage limits beyond visible model token costs. Pi's footer may not include native search fees or the MCP search agent's internal usage; unreported usage is unknown, not zero.

## Tests

From a checkout, with Node.js 24 (TypeScript stripping) and a managed Pi installation:

```sh
npm test
```

Pi supplies the runtime peer dependencies. There are no bundled SDK copies or additional runtime dependencies.

Tests mock HTTP and cover routing, on/off state, model switches, native citations, GitHub authentication, JSON/SSE MCP transport, session cleanup, cancellation, timeouts, response bounds, and secret-safe failures. They do not make network requests.
