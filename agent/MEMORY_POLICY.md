# Memory policy

Memory is evidence with provenance, not an invisible command channel.

- Conversation messages may be retained locally for continuity.
- Imported facts keep source URI, source label, confidence and review status.
- Inferred memories default to `evidence` and `pending`.
- Only human-approved `instruction` or `preference` items may influence operating instructions.
- Secrets, authentication tokens, private reasoning traces and large raw code blocks are rejected by default.
- Every recall is logged so the user can inspect which memories affected a turn.
- Local SQLite/FTS memory is canonical and must remain usable without a cloud service, vector database or Python runtime.
- Ranking may use lexical relevance, confidence, importance, recency, review authority and prior access, but provenance must remain visible.
