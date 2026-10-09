# Study Companion repository guide

This is an independent desktop Obsidian learning plugin. Read ARCHITECTURE.md before changing module boundaries.

For local AI takeover, read [docs/HANDOFF.md](docs/HANDOFF.md) after this file and ARCHITECTURE.md. It records current user constraints, recent fixes, and unfinished native acceptance. This machine-specific handoff is intentionally ignored by Git; if absent in another checkout, ask for current task context rather than assuming its validation state.

- `core` contains framework-free contracts. `application` depends only on core. UI depends on core/application and Obsidian. Adapters implement core ports; only main.ts assembles concrete implementations.
- Each request is bound to its original study unit, conversation, and request ID. Active-file changes never retarget an in-flight request.
- Quick Ask uses its own session and never resumes a main session. No automatic merges, retries, or model-initiated filesystem/shell tools.
- New conversations persist in plugin-private history.json; Markdown notes require an explicit save/organize action. Existing Study Companion Markdown records remain readable and editable in place. Never recreate a user-removed record from cached application state.
- Do not access/store tokens. Only use the official locally installed CLI and its existing authentication. Codex App Server may load the official CLI's existing connection/model configuration. Override study instructions and tool policy; disable every effective MCP entry before starting/resuming a thread, plus shell/file tools, hooks and plugins. Never persist or log configuration responses. Verify native streaming and isolation when changing this transport.
- No unrelated refactoring. No bulk or recursive file deletion, no directory deletion, no sudo, and no wildcard deletion. Before any single-file deletion explain its absolute path and confirm it is a regular file.
- Validate with npm run typecheck, npm run lint, npm test, npm run build. Live SDK usage and Obsidian checks must be distinguished from mocked tests.
- User permits only GPT-5.6 Sol or GPT-6 Astra for subagents. Delegate only when authorized. Include this project's absolute path and explicit file boundaries in every assignment; verify results belong to Study Companion, not the neighboring KnowledgeOps project.
