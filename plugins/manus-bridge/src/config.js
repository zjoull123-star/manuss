const DEFAULT_API_BASE_URL = "http://127.0.0.1:3000";
const DEFAULT_POLL_INTERVAL_MS = 5000;

const normalizeBaseUrl = (value) => value.replace(/\/+$/, "");

export function resolvePluginConfig(pluginConfig) {
  const cfg = pluginConfig && typeof pluginConfig === "object" ? pluginConfig : {};
  const envBaseUrl =
    typeof process.env.OPENCLAW_MANUS_API_BASE_URL === "string" &&
    process.env.OPENCLAW_MANUS_API_BASE_URL.trim()
      ? process.env.OPENCLAW_MANUS_API_BASE_URL.trim()
      : undefined;

  return {
    apiBaseUrl: normalizeBaseUrl(
      typeof cfg.apiBaseUrl === "string" && cfg.apiBaseUrl.trim()
        ? cfg.apiBaseUrl.trim()
        : envBaseUrl ?? DEFAULT_API_BASE_URL
    ),
    pollIntervalMs:
      typeof cfg.pollIntervalMs === "number" && cfg.pollIntervalMs > 0
        ? Math.floor(cfg.pollIntervalMs)
        : DEFAULT_POLL_INTERVAL_MS,
    autoReplyOnCompletion: cfg.autoReplyOnCompletion !== false,
    enableCommands: cfg.enableCommands !== false
  };
}
