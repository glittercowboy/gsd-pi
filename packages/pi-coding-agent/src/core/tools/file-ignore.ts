/**
 * 内置文件忽略规则
 *
 * 在搜索操作中自动排除常见的噪声目录和文件，
 * 确保用户无需手动配置即可获得干净的搜索结果。
 *
 * 规则合并自 opencode 的 FileIgnore 和 IGNORE_PATTERNS，
 * 并补充了 gsd-2 特有的模式。
 */

export namespace FileIgnore {
  /** 始终排除的目录名（路径中任一段匹配即排除） */
  export const FOLDERS = new Set([
    // JavaScript/TypeScript
    "node_modules",
    "bower_components",
    ".pnpm-store",
    ".npm",
    // 构建输出
    "dist",
    "build",
    "out",
    ".next",
    ".output",
    ".turbo",
    // Java/JVM
    "target",
    "bin",
    "obj",
    ".gradle",
    // Python
    "__pycache__",
    ".pytest_cache",
    "mypy_cache",
    ".venv",
    "venv",
    "env",
    // Go/Rust/Zig
    "vendor",
    ".zig-cache",
    "zig-out",
    // 版本控制
    ".git",
    ".svn",
    ".hg",
    // IDE
    ".vscode",
    ".idea",
    // 缓存
    ".cache",
    "cache",
    ".webkit-cache",
    // 测试/覆盖率
    "coverage",
    ".coverage",
    ".nyc_output",
    // 临时/日志
    "tmp",
    "temp",
    "logs",
    // 其他
    ".sst",
    "desktop",
    ".history",
  ]);

  /** 始终排除的文件 glob 模式 */
  export const FILES = [
    "**/*.swp",
    "**/*.swo",
    "**/*.pyc",
    // OS 文件
    "**/.DS_Store",
    "**/Thumbs.db",
    // 日志
    "**/*.log",
  ];

  /**
   * 检查文件路径是否应被忽略
   * @param filepath 文件路径（相对或绝对）
   * @param opts.extra 额外的 glob 忽略模式
   * @param opts.whitelist 白名单模式（匹配则不忽略）
   */
  export function match(
    filepath: string,
    opts?: {
      extra?: string[];
      whitelist?: string[];
    },
  ): boolean {
    // 白名单优先
    for (const pattern of opts?.whitelist || []) {
      if (globMatch(pattern, filepath)) return false;
    }

    // 目录名匹配：分割路径为段，精确匹配 FOLDERS 中的目录名
    const parts = filepath.split(/[/\\]/);
    for (const part of parts) {
      if (FOLDERS.has(part)) return true;
    }

    // 文件模式匹配
    const extra = opts?.extra || [];
    for (const pattern of [...FILES, ...extra]) {
      if (globMatch(pattern, filepath)) return true;
    }

    return false;
  }

  /**
   * 导出用于 ripgrep 的负 glob 模式列表
   * 格式：!pattern（ripgrep --glob 参数）
   */
  export function ripgrepNegateGlobs(): string[] {
    const globs: string[] = [];
    for (const folder of FOLDERS) {
      globs.push(`!${folder}/`);
    }
    for (const filePattern of FILES) {
      globs.push(`!${filePattern}`);
    }
    return globs;
  }

  /**
   * 导出用于原生 glob 模块的忽略模式列表
   * 格式: double-star-slash-folder-slash-double-star (native glob ignore pattern)
   */
  export function nativeGlobPatterns(): string[] {
    const patterns: string[] = [];
    for (const folder of FOLDERS) {
      patterns.push(`**/${folder}/**`);
    }
    return patterns;
  }
}

/** Glob pattern matcher supporting double-star and single-star wildcards. */
function globMatch(pattern: string, path: string): boolean {
  const GLOBSTAR_SLASH = "\x00GSS\x00";
  const GLOBSTAR = "\x00GS\x00";
  const STAR = "\x00S\x00";
  let regex = pattern
    .replace(/\*\*\//g, GLOBSTAR_SLASH)   // **/ as a unit (includes the slash)
    .replace(/\*\*/g, GLOBSTAR)            // standalone **
    .replace(/\*/g, STAR);
  regex = regex.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  regex = regex
    .replace(new RegExp(GLOBSTAR_SLASH.replace(/\x00/g, "\\x00"), "g"), "(?:.*/)?")   // **/ => optional prefix dirs
    .replace(new RegExp(GLOBSTAR.replace(/\x00/g, "\\x00"), "g"), ".*")               // **  => match anything
    .replace(new RegExp(STAR.replace(/\x00/g, "\\x00"), "g"), "[^/]*");
  return new RegExp(`^${regex}$`).test(path);
}
