/**
 * `.wardby/services.yaml`: the services a repository asks wardby to start next
 * to its coding runs (docs/coding-services.md), read from the base branch at
 * dispatch.
 *
 * Repository content is untrusted, so this is a deliberately tiny YAML subset
 * rather than a general loader: comments, blank lines, one top-level
 * `services:` mapping, and under it one `name: version` pair per line with the
 * version bare, "double-quoted" or 'single-quoted'. Anything else — anchors,
 * tags, flow collections, document markers, tabs, nested values, other keys —
 * is refused, and every version stays a string (a general loader reads
 * `mysql: 8.0` as the number 8). A refusal's reason names only a line number
 * and fixed text, plus a service name once it has passed validation.
 */
import {
  byteLength,
  CODING_SERVICE_NAME,
  CODING_SERVICE_VERSION,
  INVALID_SINGLE_LINE_CONTROL,
  MAX_CODING_SERVICES,
} from "../protocol.js";

export const SERVICE_DECLARATION_PATH = ".wardby/services.yaml";
export const MAX_SERVICE_DECLARATION_BYTES = 8 * 1024;

export interface DeclaredService {
  name: string;
  version: string;
}

export class ServiceDeclarationError extends Error {
  constructor(readonly reason: string) {
    super(`service_declaration_invalid: ${reason}`);
    this.name = "ServiceDeclarationError";
  }
}

const BARE_VERSION = /^[0-9A-Za-z][0-9A-Za-z._-]*$/;

/** The line without a trailing `# comment` (a `#` at the start, or after a space, outside quotes). */
function stripComment(line: string): string {
  let quote: string | null = null;
  for (let index = 0; index < line.length; index += 1) {
    const character = line[index];
    if (quote) {
      if (character === quote) quote = null;
      continue;
    }
    if (character === '"' || character === "'") quote = character;
    else if (character === "#" && (index === 0 || line[index - 1] === " ")) return line.slice(0, index);
  }
  return line;
}

/** A version written bare, "double-quoted" or 'single-quoted'; null for anything else. */
function scalar(raw: string): string | null {
  const double = /^"([^"\\]*)"$/.exec(raw);
  if (double) return double[1];
  const single = /^'([^']*)'$/.exec(raw);
  if (single) return single[1];
  return BARE_VERSION.test(raw) ? raw : null;
}

export function parseServiceDeclaration(text: string): DeclaredService[] {
  if (byteLength(text) > MAX_SERVICE_DECLARATION_BYTES) {
    throw new ServiceDeclarationError(`it is larger than ${MAX_SERVICE_DECLARATION_BYTES} bytes`);
  }
  const lines = text.replace(/^\uFEFF/, "").split(/\r?\n/);
  const services: DeclaredService[] = [];
  const seen = new Set<string>();
  let sawServices = false;
  let emptyFlow = false;
  let indent: number | undefined;
  for (const [index, raw] of lines.entries()) {
    const line = index + 1;
    if (raw.includes("\t")) throw new ServiceDeclarationError(`line ${line}: use spaces, not tabs`);
    if (INVALID_SINGLE_LINE_CONTROL.test(raw)) {
      throw new ServiceDeclarationError(`line ${line}: control characters are not allowed`);
    }
    const content = stripComment(raw).trimEnd();
    if (content.trim() === "") continue;
    const leading = content.length - content.trimStart().length;
    if (leading === 0) {
      const top = /^services:(?:\s+\{\s*\})?$/.exec(content);
      if (sawServices || !top) {
        throw new ServiceDeclarationError(`line ${line}: the only top-level key allowed is \`services\``);
      }
      sawServices = true;
      emptyFlow = content !== "services:";
      continue;
    }
    if (!sawServices || emptyFlow) {
      throw new ServiceDeclarationError(`line ${line}: entries must sit under \`services:\``);
    }
    if (indent === undefined) indent = leading;
    else if (leading !== indent) {
      throw new ServiceDeclarationError(`line ${line}: every service must use the same indentation`);
    }
    const entry = /^([^:\s]+):[ ]+(\S.*)$/.exec(content.trim());
    if (!entry) throw new ServiceDeclarationError(`line ${line}: expected \`name: version\`, like \`postgres: "16"\``);
    const [, name, rawVersion] = entry;
    if (!CODING_SERVICE_NAME.test(name)) {
      throw new ServiceDeclarationError(
        `line ${line}: a service name must be lowercase letters, digits and hyphens, starting with a letter`,
      );
    }
    const version = scalar(rawVersion.trim());
    if (version === null || !CODING_SERVICE_VERSION.test(version)) {
      throw new ServiceDeclarationError(`line ${line}: the version for \`${name}\` must be a short string like "16"`);
    }
    if (seen.has(name)) throw new ServiceDeclarationError(`line ${line}: \`${name}\` is listed twice`);
    seen.add(name);
    services.push({ name, version });
    if (services.length > MAX_CODING_SERVICES) {
      throw new ServiceDeclarationError(`it lists more than ${MAX_CODING_SERVICES} services`);
    }
  }
  if (!sawServices) throw new ServiceDeclarationError("it has no `services:` key");
  return services;
}
