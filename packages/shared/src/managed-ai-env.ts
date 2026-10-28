/**
 * The provider auth and routing environment keys a managed AI connection takes
 * over for a run.
 *
 * A managed connection supplies the credential itself, so none of these keys may
 * reach a child with a value the host happened to be carrying. The server writes
 * every key in this list as an explicit empty string when it prepares a managed
 * runtime, because an empty assignment is the only neutralization that survives
 * a merge onto an environment the host does not own (a remote shell, a sandbox
 * launcher). Absence would simply let that environment's own value through.
 *
 * This is the one list. The server reads it to write the neutralization, and the
 * adapter engine reads it to recognize one, so a key added here is neutralized
 * and materialized consistently.
 */
export const MANAGED_AI_NEUTRALIZED_ENV_KEYS = [
  "COPILOT_GITHUB_TOKEN",
  "PAPERCLIP_AI_PROVIDER_KEY", "PAPERCLIP_AI_PROVIDER_URL", "PAPERCLIP_CODEX_PROVIDERS",
  "GEMINI_API_KEY", "GOOGLE_API_KEY", "GOOGLE_GEMINI_BASE_URL", "GOOGLE_GENAI_USE_VERTEXAI",
  "HERMES_HOME", "AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_SESSION_TOKEN", "AWS_BEARER_TOKEN_BEDROCK", "AWS_PROFILE", "AWS_DEFAULT_PROFILE", "AWS_SHARED_CREDENTIALS_FILE", "AWS_CONFIG_FILE", "AWS_WEB_IDENTITY_TOKEN_FILE", "AWS_ROLE_ARN", "AWS_CONTAINER_CREDENTIALS_RELATIVE_URI", "AWS_CONTAINER_CREDENTIALS_FULL_URI",
  "ANTHROPIC_BEDROCK_BASE_URL", "ANTHROPIC_MODEL", "ANTHROPIC_DEFAULT_OPUS_MODEL", "ANTHROPIC_DEFAULT_SONNET_MODEL", "ANTHROPIC_DEFAULT_HAIKU_MODEL", "CLAUDE_CODE_SUBAGENT_MODEL",

  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "CLAUDE_CODE_OAUTH_TOKEN",
  "OPENAI_API_KEY",
  "CODEX_API_KEY",
  "OPENROUTER_API_KEY",
  "XAI_API_KEY",
  "GROK_API_KEY",
  "CODEX_HOME",
  "GROK_HOME",
  "CLAUDE_CONFIG_DIR",
  "OPENCODE_AUTH_JSON",
  "OPENCODE_CONFIG_CONTENT",
  "OPENCODE_CONFIG",
  "OPENCODE_CONFIG_DIR",
  "PAPERCLIP_OPENCODE_PROVIDERS",
  "PAPERCLIP_PI_PROVIDERS",
  "ANTHROPIC_BASE_URL",
  "OPENAI_BASE_URL",
  "XAI_BASE_URL",
  "CLAUDE_CODE_USE_BEDROCK",
  "CLAUDE_CODE_USE_VERTEX",
  "CLAUDE_CODE_USE_FOUNDRY",
] as const;

const NEUTRALIZED_KEY_SET: ReadonlySet<string> = new Set(
  MANAGED_AI_NEUTRALIZED_ENV_KEYS,
);

/**
 * Resolve a neutralized managed-AI key to absence in an environment the caller
 * constructs in full.
 *
 * An empty assignment and an absent key are not interchangeable downstream. A
 * provider SDK that validates its configuration at module load rejects an empty
 * string where it would have defaulted on an absent key — `@ai-sdk/anthropic`
 * and `@ai-sdk/openai` both build a provider on import and throw
 * `baseURL must be a non-empty string`. The empty value therefore breaks every
 * descendant process that imports such an SDK, not just the agent binary, and
 * it does so whether or not the run uses that provider.
 *
 * Call this only where the result *is* the child environment, so the key's
 * absence is the complete answer. Removing a key from an environment that will
 * later be merged onto one the host does not own would re-admit that
 * environment's value, which is the whole reason the empty assignment exists.
 *
 * A key the caller set to a real value is kept as-is: a managed runtime
 * overwrites some of these keys (`CLAUDE_CONFIG_DIR`, the selected credential)
 * after it writes the neutralization, and those are the values the child needs.
 * An empty value under any other key is left alone; this function speaks only
 * for the managed-AI neutralization.
 */
export function resolveNeutralizedManagedAiEnv(
  env: Record<string, string>,
): Record<string, string> {
  const resolved: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (value === "" && NEUTRALIZED_KEY_SET.has(key.toUpperCase())) continue;
    resolved[key] = value;
  }
  return resolved;
}
