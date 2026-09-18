# Releasing

Versioning follows [SemVer](https://semver.org/); `CHANGELOG.md` follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/). The changelog entry
for each release is generated from [Conventional Commits](https://www.conventionalcommits.org/)
(`feat:`, `fix:`, `perf:`, `refactor:`, optionally scoped as `fix(scope):`)
since the previous tag — so write commit subjects accordingly; anything else
(`docs:`, `chore:`, `test:`, unscoped one-offs) is left out of the changelog
on purpose.

## Cutting a release

1. Make sure `master` is clean and has everything you want to ship.
2. Run:
   ```bash
   npm run release -- patch   # or: minor | major | --version X.Y.Z
   ```
   Add `--dry-run` first if you want to preview the generated changelog
   section without touching any files.
3. This bumps `package.json`, regenerates `package-lock.json`, prepends a
   new section to `CHANGELOG.md`, commits as `chore(release): vX.Y.Z`, and
   creates an annotated tag `vX.Y.Z`. Nothing is pushed yet — review it:
   ```bash
   git show HEAD
   git show vX.Y.Z
   ```
4. Push both the commit and the tag:
   ```bash
   git push && git push origin vX.Y.Z
   ```
   Pushing the tag triggers `.github/workflows/release.yml`, which reads the
   matching `CHANGELOG.md` section and publishes a GitHub Release from it.

`meet --version` always reflects `package.json`'s `version` field (see
`src/version.ts`) — no separate place to update.
