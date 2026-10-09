# Contributing

Use Node.js 22 and npm. Run `npm ci` and `npm run check`. Before a public release, also run `npm run release:check`; it checks the manifest, required release files and basic source hygiene. Tests use synthetic data and do not require model credentials. Real provider evaluations require explicit `--live` and your own signed-in official CLI.

Read ARCHITECTURE.md and AGENTS.md before changing behavior. Keep UI → application → core dependency direction, request/source ownership and private JSON history and legacy Markdown compatibility. Never add user notes, local Obsidian configuration, CLI authentication, screenshots of private materials or generated evaluation reports to the repository.

For a bug report, include the plugin/Obsidian/OS version, selected backend and CLI version, minimal synthetic reproduction, expected behavior and the redacted error. For a pull request, describe the problem and verification. Avoid unrelated reformatting or dependency upgrades.

Use a separate test vault. Do not test migrations, deletion, overwrites or file renames against your only copy of personal notes. Automated tests and actual Obsidian interaction checks should be reported separately.
