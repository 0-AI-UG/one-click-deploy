export type WebhookPathConfig = {
  /** null means the manifest omitted paths, so every push selects the app. */
  paths: string[] | null;
  pathsIgnore: string[];
};

export type WebhookPathDecision = {
  selected: boolean;
  reason: string;
  matchingPaths: string[];
  matchedPatterns: string[];
};

/** Normalize repository-root-relative webhook patterns without changing case. */
export function normalizeWebhookPattern(pattern: string): string {
  return pattern.trim().replace(/^\.\//, "").replace(/^\/+/, "").replace(/\/+$/, "");
}

/** Legacy webhook.path was a directory prefix, now represented as one glob. */
export function legacyWebhookPathToPatterns(path: string | null | undefined): string[] | null {
  const normalized = normalizeWebhookPattern(path || "");
  return normalized ? [`${normalized}/**`] : null;
}

export function parseStoredWebhookPaths(
  pathsJson: string | null | undefined,
  legacyPath: string | null | undefined,
): string[] | null {
  if (pathsJson != null && pathsJson !== "") {
    try {
      const parsed = JSON.parse(pathsJson);
      if (Array.isArray(parsed)) {
        const paths = parsed.filter((value): value is string => typeof value === "string");
        if (paths.length > 0) return paths;
      }
    } catch { /* malformed state fails safe through legacy/unfiltered behavior */ }
  }
  return legacyWebhookPathToPatterns(legacyPath);
}

export function parseStoredWebhookPathsIgnore(pathsJson: string | null | undefined): string[] {
  if (!pathsJson) return [];
  try {
    const parsed = JSON.parse(pathsJson);
    return Array.isArray(parsed)
      ? parsed.filter((value): value is string => typeof value === "string")
      : [];
  } catch {
    return [];
  }
}

function escapeRegex(char: string): string {
  return /[\\^$.*+?()[\]{}|]/.test(char) ? `\\${char}` : char;
}

/**
 * Compile the documented star, globstar, and question-mark dialect. A
 * globstar followed by a slash matches zero or more directories, so a recursive markdown glob also matches a file
 * directly inside its prefix directory.
 */
export function webhookGlobToRegExp(pattern: string): RegExp {
  let source = "^";
  for (let i = 0; i < pattern.length; i++) {
    const char = pattern[i];
    if (char === "*") {
      if (pattern[i + 1] === "*") {
        i++;
        if (pattern[i + 1] === "/") {
          i++;
          source += "(?:.*/)?";
        } else {
          source += ".*";
        }
      } else {
        source += "[^/]*";
      }
    } else if (char === "?") {
      source += "[^/]";
    } else {
      source += escapeRegex(char);
    }
  }
  return new RegExp(`${source}$`);
}

export function webhookPathMatches(path: string, pattern: string): boolean {
  return webhookGlobToRegExp(pattern).test(path);
}

export function evaluateWebhookPaths(
  changedPaths: string[],
  config: WebhookPathConfig,
  implicitPaths: Array<string | null | undefined> = [],
): WebhookPathDecision {
  const implicit = implicitPaths.filter((path): path is string => !!path);
  const controlMatches = changedPaths.filter((path) => implicit.includes(path));
  if (controlMatches.length > 0) {
    return {
      selected: true,
      reason: `OCD control file changed: ${controlMatches[0]}`,
      matchingPaths: controlMatches,
      matchedPatterns: controlMatches,
    };
  }

  const remaining = changedPaths.filter((path) =>
    !config.pathsIgnore.some((pattern) => webhookPathMatches(path, pattern))
  );
  if (config.paths === null) {
    return {
      selected: true,
      reason: "webhook.paths omitted",
      matchingPaths: remaining,
      matchedPatterns: [],
    };
  }

  const matchingPaths: string[] = [];
  const matchedPatterns = new Set<string>();
  for (const path of remaining) {
    for (const pattern of config.paths) {
      if (!webhookPathMatches(path, pattern)) continue;
      matchingPaths.push(path);
      matchedPatterns.add(pattern);
      break;
    }
  }
  return matchingPaths.length > 0
    ? {
        selected: true,
        reason: `matched ${[...matchedPatterns].join(", ")}`,
        matchingPaths,
        matchedPatterns: [...matchedPatterns],
      }
    : {
        selected: false,
        reason: "no matching changes",
        matchingPaths: [],
        matchedPatterns: [],
      };
}
