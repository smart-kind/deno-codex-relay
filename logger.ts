// 日志级别
type LogLevel = "debug" | "info" | "warn" | "error";

// 日志配置
interface LogConfig {
  level: LogLevel;
  truncate_length: number;
  logFile?: string;
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
    logFile: config.logFile,
  };
}

// 获取当前日志配置
export function getLogConfig(): LogConfig {
  return logConfig;
}

// 设置日志文件路径
export function setLogFile(path: string | undefined): void {
  logConfig.logFile = path;
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
async function log(level: LogLevel, module: string, message: string, data?: unknown): Promise<void> {
  const time = formatTime();
  const levelStr = level.toUpperCase().padEnd(5);

  // 文件写入：始终记录，不截断，不受 logLevel 限制
  const dataStrFull = data !== undefined
    ? (typeof data === "string" ? data : JSON.stringify(data))
    : "";
  const fileLine = dataStrFull
    ? `[${time}] [${levelStr}] [${module}] ${message} | ${dataStrFull}`
    : `[${time}] [${levelStr}] [${module}] ${message}`;

  if (logConfig.logFile) {
    try {
      await Deno.writeTextFile(logConfig.logFile, fileLine + "\n", { append: true, create: true });
    } catch {
      // 静默忽略文件写入错误，避免影响请求
    }
  }

  // 控制台输出：受 logLevel 限制
  if (!shouldLog(level)) return;

  // 控制台始终截断
  let consoleOutput: string;
  if (data !== undefined) {
    const dataStr = logConfig.level === "debug"
      ? dataStrFull
      : (typeof data === "string"
        ? truncate(data, logConfig.truncate_length)
        : truncateObj(data, logConfig.truncate_length));
    consoleOutput = `[${time}] [${levelStr}] [${module}] ${message} | ${dataStr}`;
  } else {
    consoleOutput = fileLine;
  }

  if (level === "error") {
    console.error(consoleOutput);
  } else if (level === "warn") {
    console.warn(consoleOutput);
  } else {
    console.log(consoleOutput);
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
