import { readFileSync } from "node:fs";

const CURIO_MARK_SVG = readFileSync(
  new URL("./assets/curio-pull-mark.svg", import.meta.url),
  "utf8",
)
  .trim()
  .replace(/\s+/gu, " ");

export function curioMarkSvg(): string {
  return CURIO_MARK_SVG.replace("<svg ", '<svg aria-hidden="true" ');
}

export function curioFaviconHref(): string {
  return `data:image/svg+xml,${encodeURIComponent(CURIO_MARK_SVG)}`;
}
