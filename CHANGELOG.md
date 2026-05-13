# Changelog

All notable changes to this plugin are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]
### Added
- ESLint with `eslint-plugin-obsidianmd` recommended config. Wired into the release workflow alongside tests.
- `curly: ["error", "all"]` ESLint rule — single-statement `if`/`else`/`for`/`while` without braces is now a lint error.

### Changed
- Settings UI text uses sentence case per Obsidian's UI guidelines ("Hide wrapped hashtags in search").
- `_clearAllHideClasses` now uses `app.workspace.getLeavesOfType("search")` instead of `document.querySelectorAll`, per the Obsidian guideline against recovering the search leaf from `document.body`.
- Animation-frame calls use `window.requestAnimationFrame` / `window.cancelAnimationFrame` for explicit window binding.
- Removed unnecessary defensive `try`/`catch` blocks around `IntersectionObserver.disconnect()`, `MutationObserver.disconnect()`, and `IntersectionObserver.observe()` calls (none throw per spec).

## [1.1.0] - 2026-05-13
### Added
- Test suite (vitest + happy-dom): 27 tests covering tag-detection acceptance, rejection, cross-text-node merging, and DOM wrapping.
- GitHub Actions release workflow: auto-publishes a release on push to main when the manifest version is new. Runs tests, attaches build-provenance attestations, and uploads only `main.js`, `manifest.json`, and `styles.css`.
- Install section in README linking to the in-app Community plugins flow and the public listing on community.obsidian.md.

### Changed
- Tightened tag detection to match Obsidian's parser more closely:
  - First character after `#` must be a letter, digit, or underscore. Rejects `#-foo`, `#/foo`, `#---abc`.
  - Tag body must contain at least one non-digit character. Rejects `#123` and other pure-digit "tags".
- `onunload` now flushes the debounced settings save before teardown, preventing loss of a last-second settings change when the plugin is disabled.

### Fixed
- `manifest.json` `authorUrl` placeholder replaced with the real URL.
- `data.json` is now gitignored so it can never be accidentally included in a release.

## [1.0.0] - 2025-09-19
### Added
- Initial release: wraps hashtags in search results with a configurable CSS class.
- Toggle to hide wrapped tags in the Search pane.
- Advanced setting for IntersectionObserver root-margin (wrap-ahead pixels).
