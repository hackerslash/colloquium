#!/usr/bin/env node
// Ensures the ffmpeg/ffprobe sidecars exist in src-tauri/binaries/ before Tauri
// bundles them. Runs from `predev`/`prebuild`, so `pnpm tauri dev` on a fresh
// clone just works with no manual step.
//
// This replaces what the old libmpv build.rs did, and fixes each way that broke:
//   * it is a normal script, not a build script, so a slow download can't be
//     killed halfway by cargo's file watcher and cached as "complete";
//   * every download is verified against a pinned sha256 BEFORE extraction, and
//     a mismatch deletes the file and fails loudly;
//   * it never invokes a system package manager (no `brew install`);
//   * it is idempotent — a warm run does no network I/O at all.
//
// Usage:
//   node scripts/fetch-ffmpeg.mjs                  host triple only (dev)
//   node scripts/fetch-ffmpeg.mjs --universal      macOS universal (release)
//   node scripts/fetch-ffmpeg.mjs --triple=<t>     an explicit triple
//   node scripts/fetch-ffmpeg.mjs --stub           placeholder files, CI only
//   node scripts/fetch-ffmpeg.mjs --require-published

import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT = path.join(ROOT, "src-tauri", "binaries");
const CACHE = path.join(OUT, ".cache");
const MANIFEST = JSON.parse(
  fs.readFileSync(path.join(ROOT, "scripts", "ffmpeg-manifest.json"), "utf8"),
);

const TOOLS = ["ffmpeg", "ffprobe"];

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

/** Which triples this invocation must produce. */
function requestedTriples(argv) {
  const explicit = argv.find((a) => a.startsWith("--triple="));
  if (explicit) return [explicit.slice("--triple=".length)];

  // Tauri sets this for beforeBuildCommand; honour it so a universal release
  // build doesn't silently produce host-only binaries.
  const envTriple = process.env.TAURI_ENV_TARGET_TRIPLE ?? "";
  const universal = argv.includes("--universal") || envTriple.includes("universal");
  if (universal) {
    return ["universal-apple-darwin", "aarch64-apple-darwin", "x86_64-apple-darwin"];
  }
  return [hostTriple()];
}

// A real ffmpeg is ~20 MB; the --stub placeholders are a few dozen bytes. The
// size floor is what stops a cached stub from ever being mistaken for a usable
// binary and shipped in an installer (release.yml caches this directory).
const MIN_REAL_SIZE = 1_000_000;

function present(triple) {
  return TOOLS.every((t) => {
    const p = path.join(OUT, `${t}-${triple}${exeSuffix(triple)}`);
    return fs.existsSync(p) && fs.statSync(p).size >= MIN_REAL_SIZE;
  });
}

function sha256(file) {
  return createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

async function download(url, dest) {
  process.stdout.write(`    fetching ${url}\n`);
  const res = await fetch(url, { redirect: "follow" });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} for ${url}`);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  // Write to a temp name and rename, so an interrupted run never leaves a
  // truncated file that looks finished on the next pass.
  const tmp = `${dest}.part`;
  fs.writeFileSync(tmp, Buffer.from(await res.arrayBuffer()));
  fs.renameSync(tmp, dest);
}

function extract(archive, into) {
  fs.mkdirSync(into, { recursive: true });
  const rel = path.relative(into, archive).split(path.sep).join("/");
  const r = spawnSync("tar", ["-xzf", rel], { cwd: into, stdio: "inherit" });
  if (r.status !== 0) throw new Error(`tar failed on ${archive}`);
}

async function fromRelease(triple, sha) {
  const { repo, tag } = MANIFEST.release;
  const name = `ffmpeg-sidecars-${triple}.tar.gz`;
  const url = `https://github.com/${repo}/releases/download/${tag}/${name}`;
  const archive = path.join(CACHE, `${tag}-${name}`);

  if (!fs.existsSync(archive) || sha256(archive) !== sha) {
    await download(url, archive);
    const got = sha256(archive);
    if (got !== sha) {
      fs.rmSync(archive, { force: true });
      throw new Error(
        `checksum mismatch for ${name}\n  expected ${sha}\n  got      ${got}\n` +
          `  Refusing to use it. If the release was rebuilt, update scripts/ffmpeg-manifest.json.`,
      );
    }
  }
  extract(archive, OUT);
}

function buildFromSource(triple) {
  const host = hostTriple();
  const canBuild =
    triple === host ||
    (triple === "universal-apple-darwin" && process.platform === "darwin");

  if (!canBuild) {
    throw new Error(
      `no published sidecars for ${triple}, and this machine (${host}) cannot build them.\n` +
        `  Run the "build-ffmpeg" GitHub workflow, then record the checksums in\n` +
        `  scripts/ffmpeg-manifest.json.`,
    );
  }
  if (triple === "universal-apple-darwin") {
    throw new Error(
      `universal macOS binaries are produced by lipo'ing two native builds, which\n` +
        `  needs both an arm64 and an x86_64 runner. Run the "build-ffmpeg" workflow\n` +
        `  and record the checksums in scripts/ffmpeg-manifest.json.`,
    );
  }

  console.log(
    `    no published build for ${triple} yet — compiling from source (one-time, ~10 min)`,
  );
  const script = path.join(ROOT, "scripts", "build-ffmpeg.sh");
  const r = spawnSync("bash", [script, OUT, triple], { stdio: "inherit" });
  if (r.status !== 0) throw new Error("scripts/build-ffmpeg.sh failed");
}

/**
 * Write placeholder sidecars. `tauri_build::build()` only checks that the
 * externalBin files exist, and the typecheck/vitest/`cargo test` jobs never
 * execute ffmpeg — so CI can skip provisioning entirely. Never use this for
 * anything that gets shipped or run.
 */
function writeStubs(triple) {
  console.log(`    ${triple}: writing stubs (--stub; not runnable)`);
  for (const t of TOOLS) {
    const p = path.join(OUT, `${t}-${triple}${exeSuffix(triple)}`);
    fs.writeFileSync(p, "#!/bin/sh\necho 'stub ffmpeg sidecar' >&2\nexit 127\n");
    if (!triple.includes("windows")) fs.chmodSync(p, 0o755);
  }
}

async function ensure(triple, { stub, requirePublished }) {
  if (stub) {
    if (present(triple)) console.log(`    ${triple}: real binaries present, leaving them`);
    else writeStubs(triple);
    return;
  }
  if (present(triple)) {
    console.log(`    ${triple}: already present`);
    return;
  }
  const entry = MANIFEST.artifacts[triple];
  if (entry?.sha256) {
    await fromRelease(triple, entry.sha256);
  } else if (requirePublished) {
    throw new Error(
      `no published sidecars for ${triple}, and --require-published forbids ` +
        `building them here.\n` +
        `  Run the "build-ffmpeg" workflow for ${MANIFEST.ffmpegRef}, then record the\n` +
        `  printed checksums in scripts/ffmpeg-manifest.json.`,
    );
  } else {
    buildFromSource(triple);
  }
  if (!present(triple)) {
    throw new Error(`${triple}: sidecars still missing after provisioning`);
  }
  // Tauri needs these executable; tar preserves the bit but a rebuilt archive
  // might not, and the failure mode (EACCES at spawn) is opaque.
  if (!triple.includes("windows")) {
    for (const t of TOOLS) fs.chmodSync(path.join(OUT, `${t}-${triple}`), 0o755);
  }
}

const argv = process.argv.slice(2);
console.log(`ffmpeg sidecars (${MANIFEST.ffmpegRef})`);
fs.mkdirSync(OUT, { recursive: true });

try {
  const opts = {
    stub: argv.includes("--stub"),
    requirePublished: argv.includes("--require-published"),
  };
  for (const triple of requestedTriples(argv)) await ensure(triple, opts);
} catch (err) {
  console.error(`\nfetch-ffmpeg: ${err.message}\n`);
  process.exit(1);
}
console.log(`    -> ${path.relative(ROOT, OUT)}${path.sep}`);
