# pragmatic-pi-extensions

A pragmatic collection of Pi extensions for session references, Pi-backed subagents, smart terminal titles, and a completion bell.

## Install

### From GitHub

```bash
pi install git:github.com/msharran/pragmatic-pi-extensions
```

### Try without installing

```bash
pi -e git:github.com/msharran/pragmatic-pi-extensions
```

## Included extensions

### 1. `sessions.ts`

Browse recent Pi sessions, insert `@S-...` references, and resolve them with a `read_session` tool.

**Recent build context**
- Added in the last week with session mention support for browsing recent sessions, inserting `@S` references, and forcing referenced sessions to be read before answering.
- Tuned to avoid startup session scans until the feature is actually used.

**What it does**
- `/mention` command to insert a session reference
- `@` picker UI in the TUI editor
- `read_session` tool to summarize a referenced session via a separate Pi process
- input transform that reminds the agent to resolve `@S-...` references first

**Config file**
- Path: `~/.pi/agent/sessions.json`
- Example:

```json
{
  "summary": {
    "provider": "openai-codex",
    "model": "gpt-5.5",
    "thinking": "off"
  }
}
```

See also: [`examples/sessions.json`](./examples/sessions.json)

---

### 2. `pi-as-subagent.ts`

Adds configurable Pi subagents with `@#name` autocomplete and an `ask_pi_subagent` tool.

**Recent build context**
- Added in the last week as a Pi-backed subagent extension with default Oracle config.
- Hardened with stdin task passing, temp-file system prompts, timeout/output/abort safeguards.
- Refined the status line formatting and tightened autocomplete display spacing.

**What it does**
- `@#oracle`-style autocomplete
- `ask_pi_subagent` tool for second opinions and review flows
- first-run default config generation
- per-subagent provider/model/thinking/timeout settings

**Config file**
- Path: `~/.pi/agent/pi-as-subagent.json`
- Example:

```json
{
  "oracle": {
    "description": "Read-only second opinion for debugging, code review, and architecture questions.",
    "system_prompt": "You are Oracle, a read-only second-opinion subagent. Help debug, review code, and reason about architecture when explicitly asked. Truth-seek: report only evidence-backed findings in concise Markdown, cite file paths, commands, logs, or links where relevant, distinguish facts from hypotheses, and state uncertainty. Do not modify files, run destructive actions, hallucinate, or fabricate information.",
    "model": "gpt-5.5",
    "provider": "openai-codex",
    "thinking": "medium",
    "timeout_seconds": 300
  }
}
```

See also: [`examples/pi-as-subagent.json`](./examples/pi-as-subagent.json)

---

### 3. `smart-titlebar.ts`

Generates short session titles and animates the terminal title while Pi is working.

**Recent build context**
- Renamed in the last week from an older title extension to better reflect both generated titles and the titlebar spinner.
- Updated with a neutral `π` fallback instead of leaving `π - Working` behind after activity.
- Added configurable low-cost title generation defaults.

**What it does**
- animated terminal title spinner during active agent work
- auto-generated session name from the first user prompt and first assistant result
- neutral fallback title when no title has been set yet

**Config file**
- Path: `~/.pi/agent/smart-titlebar.json`
- Example:

```json
{
  "provider": "openai-codex",
  "model": "gpt-5.5",
  "thinking": "off"
}
```

See also: [`examples/smart-titlebar.json`](./examples/smart-titlebar.json)

---

### 4. `zed-bell.ts`

Rings the terminal bell when Pi finishes a turn.

**Recent build context**
- Present in the current extension set as a tiny completion notifier.

**What it does**
- emits `\x07` on `agent_end`
- useful for long-running prompts when Pi is in another tab or split

**Config file**
- No config file required.

## Package layout

```text
extensions/
  sessions.ts
  pi-as-subagent.ts
  smart-titlebar.ts
  zed-bell.ts
examples/
  sessions.json
  pi-as-subagent.json
  smart-titlebar.json
```

## License

This project uses the MIT License.

Why MIT:
- very easy to fork
- easy to contribute to
- easy to redistribute
- widely understood and accepted for OSS utility packages

## Safety review before public release

I only included:
- the 4 extension source files
- generic example config files derived from extension defaults
- package metadata and docs

I did **not** include:
- your dotfiles repo history
- private settings
- session files
- logs
- work-specific docs
- local absolute paths in README examples

That said, review the extension code before making the repo public because the code still reflects your personal workflows and extension behavior. The examples themselves look safe.
