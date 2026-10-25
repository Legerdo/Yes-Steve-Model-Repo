#!/usr/bin/env node
// Browser-only compatibility fix for the pinned YSMViewer revision.
// Its AddPlatformLogging() registers the threaded ConsoleLoggerProvider.
// Microsoft.Extensions.Logging.Console is marked unsupported on browser;
// creating its worker throws PlatformNotSupportedException before the UI starts.
// Keep the .NET logging factory but avoid the incompatible provider on WASM.
import { readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ORIGINAL = 'services.AddPlatformLogging();';
const REPLACEMENT = 'services.AddLogging(builder => builder.SetMinimumLevel(LogLevel.Warning));';

export function patchBrowserSource(source) {
  const occurrences = source.split(ORIGINAL).length - 1;
  if (occurrences !== 1) throw new Error(
    'Pinned YSMViewer browser logging call changed (' + occurrences + ' matches), review upstream before upgrading'
  );
  if (!source.includes('using Microsoft.Extensions.Logging;')) {
    throw new Error('Expected upstream Microsoft.Extensions.Logging namespace is missing');
  }
  return source.replace(ORIGINAL, REPLACEMENT);
}

async function main() {
  if (process.argv.length !== 3) throw new Error('Usage: node scripts/patch-browser-logging.mjs <upstream-dir>');
  const file = join(resolve(process.argv[2]), 'YSMViewer.Browser', 'Program.cs');
  const original = await readFile(file, 'utf8');
  await writeFile(file, patchBrowserSource(original), 'utf8');
  console.log('Patched pinned YSMViewer browser-only logging provider');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(e => { console.error(e); process.exitCode = 1; });
}
