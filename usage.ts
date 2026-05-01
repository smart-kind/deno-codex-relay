import type { UserConfig } from "./config.ts";
import type { UsageRecord, UserUsage } from "./types.ts";
import { readUsageJson, updateUsageJson } from "./persist.ts";
import { createModuleLogger } from "./logger.ts";

const log = createModuleLogger("usage");

/// Usage store with in-memory cache for faster limit checks
export class UsageStore {
  private dataDir: string;
  private cache: Map<string, UserUsage> = new Map();

  constructor(dataDir: string) {
    this.dataDir = dataDir;
  }

  /// Record usage for a single request
  async recordUsage(record: UsageRecord): Promise<void> {
    const tokens = record.total_tokens;
    await updateUsageJson(this.dataDir, record.user, {
      tokens,
      requests: 1,
      link_type: record.link_type,
    });

    // Update cache
    const cached = this.cache.get(record.user) || {
      user: record.user,
      total_tokens: 0,
      total_requests: 0,
      primary_tokens: 0,
      fallback_tokens: 0,
      last_updated: new Date().toISOString(),
    };
    cached.total_tokens += tokens;
    cached.total_requests += 1;
    if (record.link_type === "primary") {
      cached.primary_tokens += tokens;
    } else {
      cached.fallback_tokens += tokens;
    }
    cached.last_updated = new Date().toISOString();
    this.cache.set(record.user, cached);

    log.info("用量已记录", {
      user: record.user,
      tokens,
      link_type: record.link_type,
      total: cached.total_tokens,
    });
  }

  /// Get user's cumulative usage
  async getUserUsage(username: string): Promise<UserUsage> {
    // Check cache first
    const cached = this.cache.get(username);
    if (cached) {
      log.debug("从缓存获取用量", { user: username, total_tokens: cached.total_tokens });
      return cached;
    }

    // Read from file
    const usage = await readUsageJson(this.dataDir, username);
    this.cache.set(username, usage);
    log.debug("从文件获取用量", { user: username, total_tokens: usage.total_tokens });
    return usage;
  }

  /// Check if user has exceeded their usage limit
  async checkLimit(user: UserConfig): Promise<{ exceeded: boolean; usage: UserUsage }> {
    const usage = await this.getUserUsage(user.name);

    if (!user.usage_limit) {
      log.debug("用户无用量限制", { user: user.name });
      return { exceeded: false, usage };
    }

    const exceeded = usage.total_tokens >= user.usage_limit;
    log.debug("用量限制检查", {
      user: user.name,
      total: usage.total_tokens,
      limit: user.usage_limit,
      exceeded,
    });

    return { exceeded, usage };
  }

  /// Refresh cache from files (useful for periodic sync)
  async refreshCache(username: string): Promise<void> {
    const usage = await readUsageJson(this.dataDir, username);
    this.cache.set(username, usage);
    log.debug("缓存已刷新", { user: username, total_tokens: usage.total_tokens });
  }
}