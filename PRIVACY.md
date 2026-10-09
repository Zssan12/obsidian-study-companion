# Privacy and data use

Study Companion is a desktop-only Obsidian plugin. It requires a separately installed, signed-in official Claude Code or Codex CLI and a compatible account. Provider usage limits or charges can apply. It is not affiliated with Anthropic, OpenAI or Obsidian.

## Data sent to model providers

Submitting a question sends the question, selected text, nearby context, explicit attachments and the conversation context needed to answer. PDF workflows may send extracted pages, summaries and selected page images. Related-note retrieval may send filenames within the selected scope and bounded excerpts from matching Markdown notes. Note retrieval defaults to the current source; users can disable it or expand the scope to the source folder or vault in settings. An unbound chat does not scan the vault.

Web search is automatically available when the question needs external or current information. When used, an isolated provider request receives a search query or URL and returns a source-linked summary. The query may contain terms derived from the question or selected material. Web search providers and destination websites may process those requests. Full local notes and conversation history are not directly appended to the isolated web request.

Provider requests use the official CLI's existing authentication. Codex App Server also uses the CLI's configured provider/gateway; submitted material is sent to that configured service. Effective configuration is read transiently through the CLI to disable inherited MCP entries; the response is not logged or stored. The plugin does not collect or store credentials and does not add an API-key setting. Provider data handling and retention are governed by the selected provider and account terms.

## Offline selection dictionary

Selecting a short English word or expression in a PDF text layer, Markdown or an answer automatically looks it up in the bundled ECDICT English–Chinese dictionary. This lookup is local and requires no model login or network connection. Selected words are not saved to a lookup history or sent to providers. Decompressed dictionary blocks are cached in memory. Quick Ask remains a separate explicit action with the provider behavior described above.

## Local storage

The explicit “突击” action reads the PDF files selected in its dialog and sends their extracted pages to the chosen backend in bounded batches. Textless pages also send page images; the optional full-image mode sends every page image. It does not include existing chat history, search the vault, or enable web/native tools. Generated explanations and an index are saved under a new `Study Companion 突击/` subfolder; stopping or closing preserves completed files/batches with their completion status. Input PDFs remain in their original locations and are not copied automatically. Selecting files without starting does not read their contents or call a model.

- Complete questions, answers, source snapshots, tool excerpts, collection metadata and usage statistics are saved in `history.json` inside the plugin directory (normally `.obsidian/plugins/study-companion/`). Ordinary conversations do not create visible Markdown notes. Explicit note organization/saving still writes Markdown.
- Extracted PDF pages and derived summaries are cached under `Study Companion Cache/`.
- Plugin settings, conversation identifiers and unsent composer drafts are saved in the plugin's `data.json`. Existing Markdown records under `Study Companion/` remain readable and editable in place; this update does not move or delete them.
- Official CLIs may retain their own session history. Removing a plugin record or uninstalling the plugin does not delete provider/CLI history.
- Codex uses isolated temporary working directories that can contain prompt-related images and model catalogs. These are not automatically recursively deleted.

Vault sync and backup products may synchronize these files. Keep this in mind when storing sensitive source materials. Include the plugin directory when backing up or migrating chat history. Uninstalling the plugin may remove its internal history and settings; exported notes, legacy Markdown records and vault caches remain separate.

## Network and side effects

There is no plugin analytics, telemetry endpoint, background model job or automatic model retry. Model requests begin through user actions. Native filesystem, shell, third-party MCP and inherited plugin/hook tools are disabled. Related-file reads are application-controlled. Note changes require explicit user actions and review where applicable; models cannot execute arbitrary writes.

This document describes the plugin, not the official CLIs' independent behavior. Consult their privacy policies separately.
