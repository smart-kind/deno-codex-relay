// 日志级别
type LogLevel = "debug" | "info" | "warn" | "error";

// 日志配置
interface LogConfig {
  level: LogLevel;
  truncate_length: number;
}

// 全局日志配置（由 main.ts 初始化）
let logConfig: LogConfig = {
  level: "info",
  truncate_length: 200,
};

// 初始化日志配置
export function initLogger(config: Partial<LogConfig>): void {
  logConfig = {
    level: config.level || "info",
    truncate_length: config.truncate_length || 200,
  };
}

// 获取当前日志配置
export function getLogConfig(): LogConfig {
  return logConfig;
}

// 级别优先级映射
const levelPriority: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

// 判断是否应该输出日志
function shouldLog(level: LogLevel): boolean {
  return levelPriority[level] >= levelPriority[logConfig.level];
}

// 截断字符串
function truncate(str: string, maxLen: number): string {
  if (!str) return "";
  if (str.length <= maxLen) return str;
  return str.slice(0, maxLen) + "...";
}

// 截断对象（JSON 序列化后截断）
function truncateObj(obj: unknown, maxLen: number): string {
  const json = JSON.stringify(obj, null, 0);
  return truncate(json, maxLen);
}

// 格式化时间
function formatTime(): string {
  const now = new Date();
  return now.toISOString().replace("T", " ").slice(0, 19);
}

// 日志输出函数
function log(level: LogLevel, module: string, message: string, data?: unknown): void {
  if (!shouldLog(level)) return;

  const time = formatTime();
  const levelStr = level.toUpperCase().padEnd(5);

  let output = `[${time}] [${levelStr}] [${module}] ${message}`;

  if (data !== undefined) {
    const dataStr = typeof data === "string"
      ? truncate(data, logConfig.truncate_length)
      : truncateObj(data, logConfig.truncate_length);
    output += ` | ${dataStr}`;
  }

  // 根据级别选择输出方式
  if (level === "error") {
    console.error(output);
  } else if (level === "warn") {
    console.warn(output);
  } else {
    console.log(output);
  }
}

// 导出日志方法
export const logger = {
  debug: (module: string, message: string, data?: unknown) => log("debug", module, message, data),
  info: (module: string, message: string, data?: unknown) => log("info", module, message, data),
  warn: (module: string, message: string, data?: unknown) => log("warn", module, message, data),
  error: (module: string, message: string, data?: unknown) => log("error", module, message, data),
};

// 创建模块专用 logger
export function createModuleLogger(module: string) {
  return {
    debug: (message: string, data?: unknown) => logger.debug(module, message, data),
    info: (message: string, data?: unknown) => logger.info(module, message, data),
    warn: (message: string, data?: unknown) => logger.warn(module, message, data),
    error: (message: string, data?: unknown) => logger.error(module, message, data),
  };
}