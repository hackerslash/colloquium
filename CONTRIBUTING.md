# Contributing to Colloquium

Thanks for taking an interest. Bug reports, fixes, and focused features are all
welcome.

## Getting set up

See [Development](README.md#development) in the README for prerequisites and the
first build. In short:

```sh
pnpm install
pnpm tauri:dev
```

## What CI checks

Every push and pull request runs the following on **both macOS and Windows**, so
platform-specific breakage is caught before a release. Run them locally first:

```sh
pnpm typecheck                            # tsc --noEmit, both tsconfigs
pnpm test                                 # vitest
cargo test --manifest-path src-tauri/Cargo.toml
```

A pull request that fails any of these won't be merged.

## Conventions

**Commits** follow [Conventional Commits](https://www.conventionalcommits.org/):
`type(scope): imperative summary`, lowercase, no trailing period.

```
fix(voice): keep the play head in step with the audio
feat(files): show real progress while receiving an attachment
```

Use the body to explain *why* — what was broken, what the reader would otherwise
wonder. Skip it when the subject already says everything.

**Tests** go beside the code as `*.test.ts` and run under vitest. Non-trivial
logic — a parser, a state machine, anything with money or crypto in the path —
should leave behind the smallest check that fails if the logic breaks. Trivial
one-liners don't need one.

**UI** follows the locked design system in [`design.md`](design.md). Read it
before adding a surface; extend the file rather than improvising per screen.

**Changelog**: user-visible changes get an entry under `## Unreleased` in
[CHANGELOG.md](CHANGELOG.md). Write what changed and why it mattered, not the
commit subject — the release workflow publishes this section verbatim as the
GitHub Release notes.

## Pull requests

- One concern per PR. A refactor bundled with a behaviour change is hard to
  review and harder to revert.
- Say how you verified it. For UI, a screenshot or short clip; for calls and
  watch party, which platforms you actually exercised.
- Mention any platform you *couldn't* test. Colloquium ships on macOS and
  Windows, and plenty of media and permission behaviour differs between them.

## Reporting a security issue

Please don't open a public issue for a vulnerability. Report it privately via
[GitHub's security advisories](https://github.com/hackerslash/colloquium/security/advisories/new)
so it can be fixed before it's described publicly. Identity keys, the encrypted
local database, and peer authentication are the areas where this matters most.
