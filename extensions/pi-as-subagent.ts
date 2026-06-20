import { spawn } from "node:child_process";
import {
  appendFileSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type {
  AutocompleteItem,
  AutocompleteProvider,
  AutocompleteSuggestions,
} from "@earendil-works/pi-tui";
import { fuzzyFilter } from "@earendil-works/pi-tui";

const EXTENSION_KEY = "pi-as-subagent";
const CONFIG_PATH = join(getAgentDir(), "pi-as-subagent.json");
const LOG_PATH = join(getAgentDir(), "pi-as-subagent.log");
const DEFAULT_PROVIDER = "openai-codex";
const DEFAULT_MODEL = "gpt-5.5";
const DEFAULT_THINKING = "off";
const DEFAULT_TIMEOUT_SECONDS = 120;
const MAX_TIMEOUT_SECONDS = 1_800;
const MAX_STDOUT_CHARS = 200_000;
const MAX_STDERR_CHARS = 50_000;
const CONFIG_CACHE_TTL_MS = 5_000;
const AGENT_NAME_RE = /^[A-Za-z][A-Za-z0-9_-]*$/;
const THINKING_LEVELS = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
] as const;
const DEFAULT_CONFIG = {
  oracle: {
    description:
      "Read-only second opinion for debugging, code review, and architecture questions.",
    system_prompt:
      "You are Oracle, a read-only second-opinion subagent. Help debug, review code, and reason about architecture when explicitly asked. Truth-seek: report only evidence-backed findings in concise Markdown, cite file paths, commands, logs, or links where relevant, distinguish facts from hypotheses, and state uncertainty. Do not modify files, run destructive actions, hallucinate, or fabricate information.",
    model: "gpt-5.5",
    provider: "openai-codex",
    thinking: "medium",
    timeout_seconds: 300,
  },
};

type ThinkingLevel = (typeof THINKING_LEVELS)[number];

type RawSubagentConfig = {
  description?: unknown;
  system_prompt?: unknown;
  provider?: unknown;
  model?: unknown;
  thinking?: unknown;
  timeout_seconds?: unknown;
};

type SubagentConfig = {
  name: string;
  description?: string;
  systemPrompt: string;
  provider: string;
  model: string;
  thinking: ThinkingLevel;
  timeoutSeconds: number;
};

type ConfigCache = {
  loadedAt: number;
  config: Map<string, SubagentConfig>;
};

type SpawnResult = {
  stdout: string;
  stderr: string;
  code: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
  outputExceeded?: "stdout" | "stderr";
};

let configCache: ConfigCache | undefined;

function writeLog(event: string, details: string): void {
  try {
    appendFileSync(
      LOG_PATH,
      `[${new Date().toISOString()}] ${event}: ${details}\n`,
      "utf8",
    );
  } catch {
    // Logging must never break the extension.
  }
}

function asTrimmedString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : undefined;
}

function parseThinking(value: unknown): ThinkingLevel {
  const candidate = asTrimmedString(value);
  return THINKING_LEVELS.includes(candidate as ThinkingLevel)
    ? (candidate as ThinkingLevel)
    : DEFAULT_THINKING;
}

function parseTimeoutSeconds(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0)
    return DEFAULT_TIMEOUT_SECONDS;
  return Math.min(MAX_TIMEOUT_SECONDS, Math.max(1, Math.round(value)));
}

function isNodeErrorWithCode(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === code
  );
}

function defaultConfigText(): string {
  return `${JSON.stringify(DEFAULT_CONFIG, null, 2)}\n`;
}

function parseSubagentConfig(name: string, raw: unknown): SubagentConfig {
  if (!AGENT_NAME_RE.test(name)) {
    throw new Error(
      `Invalid subagent name ${JSON.stringify(name)}; expected ${AGENT_NAME_RE.source}`,
    );
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error(`Subagent ${name} must be an object`);
  }

  const block = raw as RawSubagentConfig;
  const systemPrompt = asTrimmedString(block.system_prompt);
  if (!systemPrompt) {
    throw new Error(`Subagent ${name} requires a non-empty system_prompt`);
  }

  return {
    name,
    description: asTrimmedString(block.description),
    systemPrompt,
    provider: asTrimmedString(block.provider) ?? DEFAULT_PROVIDER,
    model: asTrimmedString(block.model) ?? DEFAULT_MODEL,
    thinking: parseThinking(block.thinking),
    timeoutSeconds: parseTimeoutSeconds(block.timeout_seconds),
  };
}

function loadConfig(force = false): Map<string, SubagentConfig> {
  if (
    !force &&
    configCache &&
    Date.now() - configCache.loadedAt < CONFIG_CACHE_TTL_MS
  ) {
    return configCache.config;
  }

  let rawText: string;
  try {
    rawText = readFileSync(CONFIG_PATH, "utf8");
  } catch (error) {
    if (!isNodeErrorWithCode(error, "ENOENT")) throw error;
    rawText = defaultConfigText();
    try {
      writeFileSync(CONFIG_PATH, rawText, { encoding: "utf8", flag: "wx" });
      writeLog("config:created_default", `path=${CONFIG_PATH}`);
    } catch (writeError) {
      if (!isNodeErrorWithCode(writeError, "EEXIST")) {
        writeLog(
          "config:create_default_failed",
          writeError instanceof Error ? writeError.message : String(writeError),
        );
      }
    }
  }
  const parsed = JSON.parse(rawText) as Record<string, unknown>;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${CONFIG_PATH} must contain a JSON object`);
  }

  const config = new Map<string, SubagentConfig>();
  for (const [name, raw] of Object.entries(parsed)) {
    const agent = parseSubagentConfig(name, raw);
    config.set(name, agent);
  }

  configCache = { loadedAt: Date.now(), config };
  writeLog(
    "config:loaded",
    `path=${CONFIG_PATH} agents=${[...config.keys()].join(",") || "<none>"}`,
  );
  return config;
}

function loadConfigSafe(): Map<string, SubagentConfig> {
  try {
    return loadConfig();
  } catch (error) {
    writeLog(
      "config:failed",
      error instanceof Error ? error.message : String(error),
    );
    return new Map();
  }
}

function formatAgentDescription(agent: SubagentConfig): string {
  const parts = [
    agent.description,
    `${agent.provider}/${agent.model}`,
    agent.thinking !== "off" ? `thinking=${agent.thinking}` : undefined,
  ]
    .filter(Boolean)
    .join(" · ");
  return parts || `${agent.provider}/${agent.model}`;
}

function agentAutocompleteItems(
  config: Map<string, SubagentConfig>,
  query: string,
): AutocompleteItem[] {
  const agents = [...config.values()];
  const matched = query.trim()
    ? fuzzyFilter(
        agents,
        query,
        (agent) =>
          `${agent.name} ${agent.description ?? ""} ${agent.provider} ${agent.model}`,
      )
    : agents;
  return matched.slice(0, 50).map((agent) => ({
    value: `@#${agent.name}`,
    label: `@#${agent.name}  ${formatAgentDescription(agent)}`,
  }));
}

function createSubagentAutocompleteProvider(
  current: AutocompleteProvider,
): AutocompleteProvider {
  return {
    triggerCharacters: ["#"],
    async getSuggestions(
      lines,
      cursorLine,
      cursorCol,
      options,
    ): Promise<AutocompleteSuggestions | null> {
      const line = lines[cursorLine] ?? "";
      const beforeCursor = line.slice(0, cursorCol);
      const match = beforeCursor.match(/(?:^|[ \t])@#([^\s@#]*)$/);
      if (!match)
        return current.getSuggestions(lines, cursorLine, cursorCol, options);

      const config = loadConfigSafe();
      if (options.signal.aborted || config.size === 0)
        return current.getSuggestions(lines, cursorLine, cursorCol, options);

      const query = match[1] ?? "";
      return {
        items: agentAutocompleteItems(config, query),
        prefix: `@#${query}`,
      };
    },

    applyCompletion(lines, cursorLine, cursorCol, item, prefix) {
      return current.applyCompletion(
        lines,
        cursorLine,
        cursorCol,
        item,
        prefix,
      );
    },

    shouldTriggerFileCompletion(lines, cursorLine, cursorCol) {
      return (
        current.shouldTriggerFileCompletion?.(lines, cursorLine, cursorCol) ??
        true
      );
    },
  };
}

function extractMentionedAgents(
  text: string,
  config: Map<string, SubagentConfig>,
): string[] {
  const mentions = new Set<string>();
  for (const match of text.matchAll(/@#([A-Za-z][A-Za-z0-9_-]*)\b/g)) {
    const name = match[1]!;
    if (config.has(name)) mentions.add(name);
  }
  return [...mentions];
}

function formatSubagentStatus(
  agent: SubagentConfig,
  startedAt: number,
  options: { spinner?: boolean } = {},
): string {
  const elapsedSeconds = Math.max(
    0,
    Math.floor((Date.now() - startedAt) / 1000),
  );
  const totalSeconds = Math.max(1, agent.timeoutSeconds);
  const ratio = Math.min(1, elapsedSeconds / totalSeconds);
  const width = 20;
  const partialBlocks = ["", "▏", "▎", "▍", "▌", "▋", "▊", "▉"];
  const filledUnits = Math.min(width * 8, Math.floor(ratio * width * 8));
  const fullBlocks = Math.floor(filledUnits / 8);
  const partial = partialBlocks[filledUnits % 8] ?? "";
  const emptyBlocks = Math.max(0, width - fullBlocks - (partial ? 1 : 0));
  const bar = `${"█".repeat(fullBlocks)}${partial}${"░".repeat(emptyBlocks)}`;
  const remainingSeconds = Math.max(0, totalSeconds - elapsedSeconds);
  const spinner = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"][
    elapsedSeconds % 10
  ];
  const prefix = options.spinner === false ? "" : `${spinner} `;
  const thinkingText =
    agent.thinking === "off" ? "thinking off" : agent.thinking;
  return `${prefix}using @#${agent.name} · ${agent.model} • ${thinkingText} [${bar}] ${remainingSeconds}s left`;
}

function buildSubagentPrompt(
  agent: SubagentConfig,
  prompt: string,
  context?: string,
): string {
  return [
    `You are the configured Pi subagent "${agent.name}".`,
    "Return a concise Markdown summary/advisory response for the calling agent.",
    "Cite concrete evidence such as file paths, command output, logs, or links when relevant.",
    "If information is uncertain or unavailable, say so explicitly.",
    "",
    "## Task",
    prompt.trim(),
    context?.trim()
      ? ["", "## Context from the calling agent", context.trim()].join("\n")
      : "",
  ]
    .filter(Boolean)
    .join("\n");
}

function spawnPiSubagent(
  agent: SubagentConfig,
  promptText: string,
  cwd: string,
  signal: AbortSignal | undefined,
): Promise<SpawnResult> {
  return new Promise((resolve, reject) => {
    const tmpPromptDir = mkdtempSync(join(tmpdir(), "pi-subagent-"));
    const tmpPromptPath = join(tmpPromptDir, `${agent.name}-system-prompt.txt`);
    writeFileSync(tmpPromptPath, agent.systemPrompt, "utf8");
    const args = [
      "--provider",
      agent.provider,
      "--model",
      agent.model,
      "--thinking",
      agent.thinking,
      "--append-system-prompt",
      tmpPromptPath,
      "-p",
      "--no-session",
      "--no-extensions",
      "--no-skills",
      "--no-prompt-templates",
      "--no-context-files",
      "Answer the task provided on stdin.",
    ];
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;
    let outputExceeded: SpawnResult["outputExceeded"];
    let timer: ReturnType<typeof setTimeout> | undefined;
    let killTimer: ReturnType<typeof setTimeout> | undefined;

    const child = spawn("pi", args, {
      cwd,
      env: process.env,
      stdio: ["pipe", "pipe", "pipe"],
    });

    const cleanup = () => {
      if (timer) clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      signal?.removeEventListener("abort", abortHandler);
      try {
        rmSync(tmpPromptDir, { recursive: true, force: true });
      } catch {
        // Best-effort temp file cleanup.
      }
    };
    const terminate = () => {
      child.kill("SIGTERM");
      killTimer = setTimeout(() => {
        if (!settled) child.kill("SIGKILL");
      }, 2_000);
      killTimer.unref();
    };
    const abortHandler = () => terminate();
    const appendLimited = (target: "stdout" | "stderr", chunk: string) => {
      const limit = target === "stdout" ? MAX_STDOUT_CHARS : MAX_STDERR_CHARS;
      const current = target === "stdout" ? stdout : stderr;
      if (current.length + chunk.length <= limit) {
        if (target === "stdout") stdout += chunk;
        else stderr += chunk;
        return;
      }
      const remaining = Math.max(0, limit - current.length);
      if (remaining > 0) {
        if (target === "stdout") stdout += chunk.slice(0, remaining);
        else stderr += chunk.slice(0, remaining);
      }
      outputExceeded = target;
      terminate();
    };

    if (signal?.aborted) terminate();
    else signal?.addEventListener("abort", abortHandler, { once: true });

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => appendLimited("stdout", chunk));
    child.stderr.on("data", (chunk: string) => appendLimited("stderr", chunk));
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    });
    child.on("close", (code, procSignal) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve({
        stdout,
        stderr,
        code,
        signal: procSignal,
        timedOut,
        outputExceeded,
      });
    });

    timer = setTimeout(() => {
      timedOut = true;
      terminate();
    }, agent.timeoutSeconds * 1000);
    timer.unref();
    child.stdin.end(promptText);
  });
}

export default function piAsSubagentExtension(pi: ExtensionAPI) {
  pi.registerTool({
    name: "ask_pi_subagent",
    label: "Ask Subagent",
    description:
      "Ask a configured Pi subagent, return its summary, and take follow-up actions based on the user's prompt.",
    promptSnippet: "Ask a configured Pi subagent such as @#oracle",
    promptGuidelines: [
      "Use ask_pi_subagent when the user explicitly asks to consult, ask, review with, or use a configured @#name Pi subagent.",
      "Include concrete files, diffs, logs, commands, and findings already known to the main agent in ask_pi_subagent prompt or context.",
      "Treat ask_pi_subagent output as advisory; verify it, then take follow-up actions according to the user's prompt.",
    ],
    parameters: Type.Object({
      agent: Type.String({
        description: "Configured subagent name, e.g. oracle",
      }),
      prompt: Type.String({
        description: "The exact task/question for the subagent",
      }),
      context: Type.Optional(
        Type.String({
          description:
            "Optional extra context already gathered by the main agent",
        }),
      ),
    }),
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      let config: Map<string, SubagentConfig>;
      try {
        config = loadConfig(true);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        writeLog("tool:config_error", message);
        return {
          content: [
            { type: "text", text: `ask_pi_subagent config error: ${message}` },
          ],
          isError: true,
        };
      }

      const name =
        typeof params.agent === "string"
          ? params.agent.replace(/^@#?/, "").trim()
          : "";
      const prompt =
        typeof params.prompt === "string" ? params.prompt.trim() : "";
      const context =
        typeof params.context === "string" ? params.context.trim() : undefined;
      const agent = config.get(name);
      if (!agent) {
        const known =
          [...config.keys()].map((item) => `@#${item}`).join(", ") || "<none>";
        writeLog(
          "tool:unknown_agent",
          `agent=${name || "<empty>"} known=${known}`,
        );
        return {
          content: [
            {
              type: "text",
              text: `Unknown Pi subagent: ${params.agent}. Known agents: ${known}`,
            },
          ],
          isError: true,
        };
      }
      if (!prompt) {
        return {
          content: [
            {
              type: "text",
              text: "ask_pi_subagent requires a non-empty prompt.",
            },
          ],
          isError: true,
        };
      }

      const fullPrompt = buildSubagentPrompt(agent, prompt, context);
      const commandPreview = `pi --provider ${agent.provider} --model ${agent.model} --thinking ${agent.thinking} --append-system-prompt <${agent.name}.system_prompt> -p --no-session --no-extensions --no-skills --no-prompt-templates --no-context-files <stdin>`;
      writeLog(
        "tool:start",
        `agent=${agent.name} cwd=${ctx.cwd} timeout=${agent.timeoutSeconds}s cmd=${commandPreview} promptChars=${fullPrompt.length}`,
      );
      const startedAt = Date.now();
      let statusTimer: ReturnType<typeof setInterval> | undefined;
      const updateStatus = () => {
        const statusText = formatSubagentStatus(agent, startedAt, {
          spinner: false,
        });
        ctx.ui.setWorkingVisible(true);
        ctx.ui.setWorkingMessage(statusText);
      };
      updateStatus();
      statusTimer = setInterval(updateStatus, 1_000);

      try {
        const result = await spawnPiSubagent(
          agent,
          fullPrompt,
          ctx.cwd,
          signal,
        );
        const output = result.stdout.trim();
        const stderr = result.stderr.trim();
        if (result.timedOut) {
          writeLog(
            "tool:timeout",
            `agent=${agent.name} stderr=${stderr || "<none>"}`,
          );
          return {
            content: [
              {
                type: "text",
                text: `ask_pi_subagent timed out after ${agent.timeoutSeconds}s.`,
              },
            ],
            isError: true,
            details: { stderr },
          };
        }
        if (result.outputExceeded) {
          const limit =
            result.outputExceeded === "stdout"
              ? MAX_STDOUT_CHARS
              : MAX_STDERR_CHARS;
          writeLog(
            "tool:output_exceeded",
            `agent=${agent.name} stream=${result.outputExceeded} limit=${limit}`,
          );
          return {
            content: [
              {
                type: "text",
                text: `ask_pi_subagent ${result.outputExceeded} exceeded ${limit} characters for @#${agent.name}.`,
              },
            ],
            isError: true,
            details: {
              stdout: result.stdout,
              stderr,
              outputExceeded: result.outputExceeded,
              limit,
            },
          };
        }
        if (result.code !== 0) {
          writeLog(
            "tool:exit_nonzero",
            `agent=${agent.name} code=${result.code} signal=${result.signal ?? "<none>"} stderr=${stderr || "<none>"}`,
          );
          return {
            content: [
              {
                type: "text",
                text: `ask_pi_subagent failed for @#${agent.name}: ${stderr || `exit code ${result.code}`}`,
              },
            ],
            isError: true,
            details: { code: result.code, signal: result.signal, stderr },
          };
        }
        if (!output) {
          writeLog(
            "tool:empty",
            `agent=${agent.name} stderr=${stderr || "<none>"}`,
          );
          return {
            content: [
              {
                type: "text",
                text: `ask_pi_subagent returned empty output for @#${agent.name}.`,
              },
            ],
            isError: true,
            details: { stderr },
          };
        }
        writeLog("tool:ok", `agent=${agent.name} outputChars=${output.length}`);
        return {
          content: [{ type: "text", text: output }],
          details: { agent: agent.name, stderr: stderr || undefined },
        };
      } catch (error) {
        if (signal?.aborted) {
          writeLog("tool:aborted", `agent=${agent.name}`);
          return {
            content: [
              {
                type: "text",
                text: `ask_pi_subagent aborted for @#${agent.name}.`,
              },
            ],
            isError: true,
          };
        }
        const message = error instanceof Error ? error.message : String(error);
        writeLog("tool:spawn_error", `agent=${agent.name} message=${message}`);
        return {
          content: [
            {
              type: "text",
              text: `ask_pi_subagent spawn failed for @#${agent.name}: ${message}`,
            },
          ],
          isError: true,
        };
      } finally {
        if (statusTimer) clearInterval(statusTimer);
        ctx.ui.setWorkingMessage();
        ctx.ui.setWorkingVisible(true);
      }
    },
  });

  pi.on("input", async (event) => {
    if (event.source === "extension") return { action: "continue" };
    const config = loadConfigSafe();
    if (config.size === 0) return { action: "continue" };

    const agents = extractMentionedAgents(event.text, config);
    if (agents.length === 0) return { action: "continue" };

    const refs = agents.map((name) => `@#${name}`).join(", ");
    const directive = [
      `The user referenced Pi subagent(s): ${refs}.`,
      "If the user explicitly asks to consult, ask, review with, or use one of them, call ask_pi_subagent with the matching subagent name and the exact question/task.",
      "Do not call a subagent just because it is mentioned without a request.",
    ].join(" ");

    return {
      action: "transform",
      text: `${event.text}\n\n${directive}`,
    };
  });

  pi.on("session_start", async (_event, ctx: ExtensionContext) => {
    configCache = undefined;
    if (!ctx.hasUI) return;
    ctx.ui.addAutocompleteProvider((current) =>
      createSubagentAutocompleteProvider(current),
    );
    try {
      const config = loadConfig(true);
      ctx.ui.notify(
        `pi-as-subagent loaded ${config.size} subagent${config.size === 1 ? "" : "s"}.`,
        "info",
      );
    } catch (error) {
      ctx.ui.notify(
        `pi-as-subagent config error: ${error instanceof Error ? error.message : String(error)}`,
        "warning",
      );
    }
  });
}
