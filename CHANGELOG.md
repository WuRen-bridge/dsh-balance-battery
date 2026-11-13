# Changelog

All notable changes to `dsh-balance-battery` are documented here.
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [1.2.0] - 2026-11-13

First open-source release.

### Added

- A battery gauge in the composer's left tool row: DeepSeek account, DeepSeek API key and Kimi balances at a glance.
- Manual source switching — click the battery to cycle, or pick a source in the hover readout; the choice is remembered in `localStorage`.
- Host routes `/dsh-balance-battery/{deepseek,kimi}` with a 20 s cache, single-flight, and a `?fresh=1` bypass.
- Bilingual dictionaries (zh / en) and an English README (`README.md`; Chinese in `README.zh.md`).
- GitHub Actions CI running both smoke suites on Node 22 and 24.

### Security

- The balance routes **fail closed**: without the connection service (Host/Origin fence) they answer `403` instead of leaking balances.

### Fixed

- An empty or unparseable wallet list now shows "No balance" instead of `¥0.00`.
- A `429` response is reported as `rate-limited` instead of a generic HTTP error.
- The readout uses `role="dialog"` (it holds buttons and links, so a `tooltip` role was wrong).
- USD balances are scaled and labelled in `$` instead of dividing by the CNY scale and printing `¥`.

### Changed

- `README.md` is now English (the Chinese one moved to `README.zh.md`); install/self-check commands no longer hard-code the author's paths.
- Kimi falls back to `api.moonshot.ai` when `api.moonshot.cn` rejects the key or is unreachable; `MOONSHOTAI_API_KEY` is recognised as an alias.
- The plugin is Windows-first by design; the install commands assume Windows PowerShell.

## [1.1.0]

Internal version before open source (manual source switching, the readout chips, the 20 s cache).
