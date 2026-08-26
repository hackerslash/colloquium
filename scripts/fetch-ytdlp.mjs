#!/usr/bin/env node
// Ensures the yt-dlp sidecar exists in src-tauri/binaries/ before Tauri bundles
// it. Runs from `predev`/`prebuild` alongside fetch-ffmpeg.mjs, and follows the
// same rules: pinned sha256 verified BEFORE the file is put in place, a warm
// run does no network I/O, and a mismatch fails loudly instead of shipping
// whatever arrived.
//
// Upstream publishes one self-contained binary per platform, so there is no
// archive to extract and nothing to build from source.
//
// Usage:
//   node scripts/fetch-ytdlp.mjs                host triple only (dev)
//   node scripts/fetch-ytdlp.mjs --universal    macOS universal (release)
//   node scripts/fetch-ytdlp.mjs --triple=<t>   an explicit triple
//   node scripts/fetch-ytdlp.mjs --stub         placeholder file, CI only

import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT = path.join(ROOT, "src-tauri", "binaries");
const CACHE = path.join(OUT, ".cache");
const MANIFEST = JSON.parse(
  fs.readFileSync(path.join(ROOT, "scripts", "ytdlp-manifest.json"), "utf8"),
);

const TOOL = "yt-dlp";
// The real binary is ~30 MB; --stub placeholders are a few dozen bytes. The
// floor is what stops a cached stub being mistaken for a usable binary.
const MIN_REAL_SIZE = 1_000_000;

function hostTriple() {
  const arch = process.arch;
  switch (process.platform) {
    case "darwin":
      return arch === "arm64" ? "aarch64-apple-darwin" : "x86_64-apple-darwin";
    case "win32":
      return "x86_64-pc-windows-msvc";
    case "linux":
      return arch === "arm64" ? "aarch64-unknown-linux-gnu" : "x86_64-unknown-linux-gnu";
    default:
      throw new Error(`unsupported platform ${process.platform}`);
  }
}

function exeSuffix(triple) {
  return triple.includes("windows") ? ".exe" : "";
}

function dest(triple) {
  return path.join(OUT, `${TOOL}-${triple}${exeSuffix(triple)}`);
}

/** Which triples this invocation must produce. Mirrors fetch-ffmpeg.mjs. */
function requestedTriples(argv) {
  const explicit = argv.find((a) => a.startsWith("--triple="));
  if (explicit) return [explicit.slice("--triple=".length)];

  const envTriple = process.env.TAURI_ENV_TARGET_TRIPLE ?? "";
  const universal = argv.includes("--universal") || envTriple.includes("universal");
  if (universal) {
    return ["universal-apple-darwin", "aarch64-apple-darwin", "x86_64-apple-darwin"];
  }
  return [hostTriple()];
}

const STAMP = MANIFEST.release.tag;

function stampFile(triple) {
  return path.join(OUT, `.stamp-ytdlp-${triple}`);
}

function stamped(triple) {
  try {
    return fs.readFileSync(stampFile(triple), "utf8").trim() === STAMP;
  } catch {
    return false;
  }
}

function present(triple) {
  const p = dest(triple);
  return fs.existsSync(p) && fs.statSync(p).size >= MIN_REAL_SIZE;
}

function sha256(file) {
  return createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

async function download(url, file) {
  process.stdout.write(`    fetching ${url}\n`);
  const res = await fetch(url, { redirect: "follow" });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} for ${url}`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  // Write to a temp name and rename, so an interrupted run never leaves a
  // truncated file that looks finished on the next pass.
  const tmp = `${file}.part`;
  fs.writeFileSync(tmp, Buffer.from(await res.arrayBuffer()));
  fs.renameSync(tmp, file);
}

async function fetchAsset(triple, asset) {
  const { repo, tag } = MANIFEST.release;
  const url = `https://github.com/${repo}/releases/download/${tag}/${asset.name}`;
  const cached = path.join(CACHE, `${tag}-${asset.name}`);

  if (!fs.existsSync(cached) || sha256(cached) !== asset.sha256) {
    await download(url, cached);
    const got = sha256(cached);
    if (got !== asset.sha256) {
      fs.rmSync(cached, { force: true });
      throw new Error(
        `checksum mismatch for ${asset.name}\n  expected ${asset.sha256}\n  got      ${got}\n` +
          `  Refusing to use it. If the release was rebuilt, update scripts/ytdlp-manifest.json.`,
      );
    }
  }
  fs.copyFileSync(cached, dest(triple));
}

/**
 * Write a placeholder sidecar. `tauri_build::build()` only checks that the
 * externalBin files exist, and no CI job resolves a link — so CI can skip
 * provisioning. Never use this for anything that gets shipped or run.
 */
function writeStub(triple) {
  console.log(`    ${triple}: writing stub (--stub; not runnable)`);
  fs.writeFileSync(dest(triple), "#!/bin/sh\necho 'stub yt-dlp sidecar' >&2\nexit 127\n");
  if (!triple.includes("windows")) fs.chmodSync(dest(triple), 0o755);
}

async function ensure(triple, { stub }) {
  if (stub) {
    if (present(triple)) console.log(`    ${triple}: real binary present, leaving it`);
    else writeStub(triple);
    return;
  }
  if (present(triple) && stamped(triple)) {
    console.log(`    ${triple}: already present`);
    return;
  }
  const asset = MANIFEST.assets[triple];
  if (!asset) {
    throw new Error(
      `no yt-dlp asset pinned for ${triple}.\n` +
        `  Add one to scripts/ytdlp-manifest.json from the release's SHA2-256SUMS.`,
    );
  }
  await fetchAsset(triple, asset);
  if (!present(triple)) throw new Error(`${triple}: sidecar still missing after provisioning`);
  fs.writeFileSync(stampFile(triple), `${STAMP}\n`);
  // Tauri needs this executable; the release asset arrives without the bit and
  // the failure mode (EACCES at spawn) is opaque.
  if (!triple.includes("windows")) fs.chmodSync(dest(triple), 0o755);
}

const argv = process.argv.slice(2);
console.log(`yt-dlp sidecar (${MANIFEST.release.tag})`);
fs.mkdirSync(OUT, { recursive: true });

try {
  const stub = argv.includes("--stub");
  for (const triple of requestedTriples(argv)) await ensure(triple, { stub });
} catch (err) {
  console.error(`\nfetch-ytdlp: ${err.message}\n`);
  process.exit(1);
}
console.log(`    -> ${path.relative(ROOT, OUT)}${path.sep}`);
