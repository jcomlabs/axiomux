# External control adapters

Adapters read one JSON object from stdin and return one JSON object on stdout. Axiomux starts them without a shell, with timeout/output limits and an allowlisted environment. Every browser/desktop call also crosses a user-approval boundary.

## Browser Use

`browser_use_worker.py` loads the separately distributed MIT-licensed Browser Use package. Default configuration uses the frozen `adapters/browser-use/uv.lock` with `browser-use==0.13.6`; `uv` and either `BROWSER_USE_API_KEY` or `OPENAI_API_KEY` are required. The locked package import was verified on this machine, but real browser execution still consumes an external model credential and must remain opt-in.

## Computer Use

The public Codex interfaces expose app-server/MCP agent surfaces, but the bundled Codex Desktop `computer-use` plugin has no documented standalone embedding protocol. Axiomux does not scrape Codex auth or call private endpoints.

`ufo_worker.py` is the open-source Windows alternative. It launches a separately installed/reviewed Microsoft UFO checkout (MIT) using `SUPERAI_UFO_DIR` and, optionally, `SUPERAI_UFO_PYTHON`. It passes the task via UFO's documented `--request` option and returns bounded process output as JSON. Keep it disabled until the external runtime is configured and tested in a VM or disposable Windows profile.
