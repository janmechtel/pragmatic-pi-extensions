import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { complete, getModel, type Message } from "@earendil-works/pi-ai";
import { getAgentDir, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";

type TextBlock = { type?: string; text?: string };
type MessageLike = { role?: string; content?: unknown };

const TITLE_PREFIX = "π - ";
const DEFAULT_TITLE = "π";
const WORKING_TITLE = `${TITLE_PREFIX}Working`;
const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const CONFIG_PATH = join(getAgentDir(), "smart-titlebar.json");
const DEFAULT_CONFIG = {
  provider: "openai-codex",
  model: "gpt-5.5",
  thinking: "off",
} as const;
const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh"] as const;

type ThinkingLevel = (typeof THINKING_LEVELS)[number];
type SmartTitlebarConfig = {
  provider: string;
  model: string;
  thinking: ThinkingLevel;
};

type RawSmartTitlebarConfig = {
  provider?: unknown;
  model?: unknown;
  modelId?: unknown;
  thinking?: unknown;
  thinkingLevel?: unknown;
};

const SYSTEM_PROMPT = [
  "You name coding-agent terminal threads.",
  "Given the user's first prompt and the assistant's first result, write a short, specific title.",
  "Rules:",
  "- 3 to 7 words",
  "- Title Case or concise sentence case",
  "- No quotes, emoji, punctuation, prefixes, or explanations",
  "- Prefer the user's actual task over generic words like Help or Chat",
].join("\n");

function textFromContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";

  return content
    .map((part) => {
      if (!part || typeof part !== "object") return "";
      const block = part as TextBlock;
      return block.type === "text" && typeof block.text === "string" ? block.text : "";
    })
    .filter(Boolean)
    .join("\n");
}

function clip(text: string, max = 4000): string {
  const trimmed = text.trim();
  return trimmed.length > max ? `${trimmed.slice(0, max)}…` : trimmed;
}

function cleanTitle(raw: string): string {
  let title = raw
    .split("\n")
    .map((line) => line.trim())
    .find(Boolean) ?? "";

  title = title
    .replace(/^#+\s*/, "")
    .replace(/^title\s*:\s*/i, "")
    .replace(/["'`*_]/g, "")
    .replace(/[.!?;:,-]+$/g, "")
    .replace(/\s+/g, " ")
    .trim();

  const words = title.split(" ").filter(Boolean);
  if (words.length > 8) title = words.slice(0, 8).join(" ");
  if (title.length > 72) title = `${title.slice(0, 69).trim()}…`;

  return title;
}

function userMessageCount(ctx: ExtensionContext): number {
  return ctx.sessionManager
    .getBranch()
    .filter((entry) => entry.type === "message" && entry.message.role === "user").length;
}

function asTrimmedString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function parseThinking(value: unknown): ThinkingLevel {
  const candidate = asTrimmedString(value);
  return THINKING_LEVELS.includes(candidate as ThinkingLevel) ? (candidate as ThinkingLevel) : DEFAULT_CONFIG.thinking;
}

function defaultConfigText(): string {
  return `${JSON.stringify(DEFAULT_CONFIG, null, 2)}\n`;
}

function loadConfig(): SmartTitlebarConfig {
  let rawText: string;
  try {
    rawText = readFileSync(CONFIG_PATH, "utf8");
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && (error as { code?: unknown }).code === "ENOENT") {
      rawText = defaultConfigText();
      try {
        writeFileSync(CONFIG_PATH, rawText, { encoding: "utf8", flag: "wx" });
      } catch {
        // Best-effort default config creation.
      }
    } else {
      throw error;
    }
  }

  const parsed = JSON.parse(rawText) as RawSmartTitlebarConfig;
  return {
    provider: asTrimmedString(parsed.provider) ?? DEFAULT_CONFIG.provider,
    model: asTrimmedString(parsed.model) ?? asTrimmedString(parsed.modelId) ?? DEFAULT_CONFIG.model,
    thinking: parseThinking(parsed.thinking ?? parsed.thinkingLevel),
  };
}

async function generateTitle(ctx: ExtensionContext, userPrompt: string, assistantResult: string): Promise<string | undefined> {
  const config = loadConfig();
  const model = getModel(config.provider, config.model);
  if (!model) return undefined;

  const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
  if (!auth.ok || !auth.apiKey) return undefined;

  const message: Message = {
    role: "user",
    content: [
      {
        type: "text",
        text: [
          "Create the title for this terminal thread.",
          "",
          "<user_prompt>",
          clip(userPrompt),
          "</user_prompt>",
          "",
          "<assistant_result>",
          clip(assistantResult),
          "</assistant_result>",
        ].join("\n"),
      },
    ],
    timestamp: Date.now(),
  };

  const response = await complete(
    model,
    { systemPrompt: SYSTEM_PROMPT, messages: [message] },
    {
      apiKey: auth.apiKey,
      headers: auth.headers,
      signal: ctx.signal,
      ...(config.thinking === "off" ? {} : { reasoning: config.thinking }),
    },
  );

  if (response.stopReason === "aborted") return undefined;

  const rawTitle = response.content
    .filter((part): part is { type: "text"; text: string } => part.type === "text")
    .map((part) => part.text)
    .join("\n");

  return cleanTitle(rawTitle) || undefined;
}

export default function smartTitlebarExtension(pi: ExtensionAPI) {
  let pendingFirstPrompt: string | undefined;
  let titleInFlight = false;
  let spinnerTimer: ReturnType<typeof setInterval> | undefined;
  let spinnerFrame = 0;

  function getBaseTitle(): string {
    return pi.getSessionName() || DEFAULT_TITLE;
  }

  function stopTitleAnimation(ctx: ExtensionContext) {
    if (spinnerTimer) {
      clearInterval(spinnerTimer);
      spinnerTimer = undefined;
    }
    spinnerFrame = 0;
    if (ctx.hasUI) ctx.ui.setTitle(getBaseTitle());
  }

  function startTitleAnimation(ctx: ExtensionContext) {
    stopTitleAnimation(ctx);
    if (!ctx.hasUI) return;

    const tick = () => {
      const frame = SPINNER_FRAMES[spinnerFrame % SPINNER_FRAMES.length];
      ctx.ui.setTitle(`${frame} ${getBaseTitle()}`);
      spinnerFrame += 1;
    };

    tick();
    spinnerTimer = setInterval(tick, 80);
  }

  pi.on("session_start", async (_event, ctx) => {
    const name = pi.getSessionName();
    if (name && ctx.hasUI) ctx.ui.setTitle(name);
    pendingFirstPrompt = undefined;
    titleInFlight = false;
    if (spinnerTimer) {
      clearInterval(spinnerTimer);
      spinnerTimer = undefined;
    }
    spinnerFrame = 0;
  });

  pi.on("before_agent_start", async (event, ctx) => {
    // At this point the submitted user message is already in the branch. Only
    // title brand-new threads, and never overwrite a manually/generated name.
    if (pi.getSessionName() || userMessageCount(ctx) > 1) {
      pendingFirstPrompt = undefined;
      return;
    }

    pendingFirstPrompt = event.prompt;
  });

  pi.on("agent_start", async (_event, ctx) => {
    startTitleAnimation(ctx);
  });

  pi.on("agent_end", async (event, ctx) => {
    stopTitleAnimation(ctx);

    if (!pendingFirstPrompt || pi.getSessionName() || titleInFlight) return;

    const firstPrompt = pendingFirstPrompt;
    pendingFirstPrompt = undefined;

    const assistantResult = event.messages
      .filter((message: MessageLike) => message.role === "assistant")
      .map((message: MessageLike) => textFromContent(message.content))
      .filter(Boolean)
      .join("\n\n");

    if (!assistantResult.trim()) return;

    titleInFlight = true;
    try {
      const title = await generateTitle(ctx, firstPrompt, assistantResult);
      if (!title || pi.getSessionName()) return;

      const prefixedTitle = `${TITLE_PREFIX}${title}`;
      pi.setSessionName(prefixedTitle);
      if (ctx.hasUI) ctx.ui.setTitle(prefixedTitle);
    } catch (error) {
      console.error("smart-titlebar: failed to generate terminal title", error);
    } finally {
      titleInFlight = false;
    }
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    stopTitleAnimation(ctx);
  });
}
