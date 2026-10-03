import { createHash } from "node:crypto";

/** sha256 of lines A..B (1-based, inclusive), each followed by "\n"
 * (equals `sed -n 'A,Bp' FILE | sha256sum` when the last cited line ends with a newline). */
export function spanHash(fileText: string, lines?: [number, number]): string | null {
  const digest = (text: string) => `sha256:${createHash("sha256").update(text, "utf8").digest("hex")}`;
  if (!lines) return digest(fileText);
  const [start, end] = lines;
  const all = fileText.endsWith("\n") ? fileText.slice(0, -1).split("\n") : fileText.split("\n");
  if (start < 1 || end < start || end > all.length) return null;
  return digest(
    all
      .slice(start - 1, end)
      .map((line) => `${line}\n`)
      .join(""),
  );
}
