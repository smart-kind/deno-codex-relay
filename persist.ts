import type { ChatLogEntry, SystemErrorEntry, UserUsage } from "./types.ts";
import { createModuleLogger } from "./logger.ts";

const log = createModuleLogger("persist");

/// Ensure user directory exists
export async function ensureUserDir(dataDir: string, username: string): Promise<string> {
  const userDir = `${dataDir}/${username}`;
  try {
    await Deno.mkdir(userDir, { recursive: true });
    log.debug("用户目录已创建/确认", { userDir });
  } catch (e) {
    log.error("创建用户目录失败", { userDir, error: String(e) });
    throw e;
  }
  return userDir;
}

/// Ensure system directory exists
export async function ensureSystemDir(dataDir: string): Promise<string> {
  const systemDir = `${dataDir}/system`;
  try {
    await Deno.mkdir(systemDir, { recursive: true });
    log.debug("系统目录已创建/确认", { systemDir });
  } catch (e) {
    log.error("创建系统目录失败", { systemDir, error: String(e) });
    throw e;
  }
  return systemDir;
}

/// Append a chat log entry to user's chat-log.jsonl
export async function appendChatLog(
  dataDir: string,
  username: string,
  entry: ChatLogEntry
): Promise<void> {
  const userDir = await ensureUserDir(dataDir, username);
  const filePath = `${userDir}/chat-log.jsonl`;
  const line = JSON.stringify(entry) + "\n";

  try {
    await Deno.writeTextFile(filePath, line, { append: true });
    log.debug("聊天日志已追加", { filePath, request_id: entry.request_id });
  } catch (e) {
    log.error("写入聊天日志失败", { filePath, error: String(e) });
    throw e;
  }
}

/// Update user's usage.json file
export async function updateUsageJson(
  dataDir: string,
  username: string,
  increment: { tokens: number; requests: number; link_type: "primary" | "fallback" }
): Promise<void> {
  const userDir = await ensureUserDir(dataDir, username);
  const filePath = `${userDir}/usage.json`;

  let usage: UserUsage = {
    user: username,
    total_tokens: 0,
    total_requests: 0,
    primary_tokens: 0,
    fallback_tokens: 0,
    last_updated: new Date().toISOString(),
  };

  // Read existing usage if file exists
  try {
    const content = await Deno.readTextFile(filePath);
    usage = JSON.parse(content);
    log.debug("读取现有用量", { filePath, total_tokens: usage.total_tokens });
  } catch {
    // File doesn't exist, use default
    log.debug("用量文件不存在，使用默认值", { filePath });
  }

  // Update values
  usage.total_tokens += increment.tokens;
  usage.total_requests += increment.requests;
  if (increment.link_type === "primary") {
    usage.primary_tokens += increment.tokens;
  } else {
    usage.fallback_tokens += increment.tokens;
  }
  usage.last_updated = new Date().toISOString();

  // Write back
  try {
    await Deno.writeTextFile(filePath, JSON.stringify(usage, null, 2));
    log.debug("用量已更新", { filePath, total_tokens: usage.total_tokens, link_type: increment.link_type });
  } catch (e) {
    log.error("写入用量文件失败", { filePath, error: String(e) });
    throw e;
  }
}

/// Read user's usage.json file
export async function readUsageJson(dataDir: string, username: string): Promise<UserUsage> {
  const filePath = `${dataDir}/${username}/usage.json`;

  try {
    const content = await Deno.readTextFile(filePath);
    return JSON.parse(content);
  } catch {
    // File doesn't exist, return default
    return {
      user: username,
      total_tokens: 0,
      total_requests: 0,
      primary_tokens: 0,
      fallback_tokens: 0,
      last_updated: new Date().toISOString(),
    };
  }
}

/// Append a system error entry to system/errors.jsonl
export async function appendSystemError(
  dataDir: string,
  entry: SystemErrorEntry
): Promise<void> {
  const systemDir = await ensureSystemDir(dataDir);
  const filePath = `${systemDir}/errors.jsonl`;
  const line = JSON.stringify(entry) + "\n";

  try {
    await Deno.writeTextFile(filePath, line, { append: true });
    log.warn("系统错误已记录", { filePath, type: entry.type, error: entry.error });
  } catch (e) {
    log.error("写入系统错误日志失败", { filePath, error: String(e) });
    throw e;
  }
}