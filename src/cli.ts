#!/usr/bin/env bun
import type { ProbeResult } from "./probe/index.ts";
import { ProbeError, probe, SafeHttpClient, SystemResolver } from "./probe/index.ts";

interface CliIo {
  stdout(message: string): void;
  stderr(message: string): void;
}

interface CliDependencies {
  probeUrl(url: string): Promise<ProbeResult>;
  io: CliIo;
}

function safeTerminalText(value: string): string {
  return [...value]
    .map((character) => {
      const codePoint = character.codePointAt(0) ?? 0;
      return codePoint < 32 || (codePoint >= 127 && codePoint <= 159) ? " " : character;
    })
    .join("");
}

function usage(): string {
  return `Usage:
  curio probe <url> [--json]
`;
}

export function formatHumanResult(result: ProbeResult): string {
  const lines = [`Probe: ${result.finalUrl}`];
  if (result.candidates.length === 0) lines.push("No subscription candidates found.");

  for (const candidate of result.candidates) {
    lines.push(
      safeTerminalText(`- [${candidate.format}] ${candidate.title ?? candidate.sourceUrl}`),
    );
    if (candidate.title) lines.push(safeTerminalText(`  ${candidate.sourceUrl}`));
  }
  for (const warning of result.warnings) {
    lines.push(
      safeTerminalText(`Warning: ${warning.url ? `${warning.url}: ` : ""}${warning.message}`),
    );
  }
  return lines.join("\n");
}

export async function runCli(args: string[], dependencies: CliDependencies): Promise<number> {
  if (args[0] !== "probe") {
    dependencies.io.stderr(usage());
    return 2;
  }

  const json = args.includes("--json");
  const positional = args.slice(1).filter((argument) => argument !== "--json");
  if (positional.length !== 1) {
    dependencies.io.stderr(usage());
    return 2;
  }

  try {
    const result = await dependencies.probeUrl(positional[0] as string);
    dependencies.io.stdout(json ? JSON.stringify(result) : formatHumanResult(result));
    return 0;
  } catch (error) {
    const code = error instanceof ProbeError ? error.code : "unexpected_error";
    const message = error instanceof Error ? error.message : String(error);
    dependencies.io.stderr(`${code}: ${message}`);
    return 1;
  }
}

if (import.meta.main) {
  const client = new SafeHttpClient(new SystemResolver());
  const exitCode = await runCli(process.argv.slice(2), {
    probeUrl: (url) => probe(url, client),
    io: {
      stdout: console.log,
      stderr: console.error,
    },
  });
  process.exit(exitCode);
}
