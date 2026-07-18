# Audit of the previous local agent

The previous local agent was analyzed; its project name and the operator's personal path have been omitted from the public documentation and repository.

That project demonstrated the right intent—a recognizable personality, browser, memory, research, skills, and fallback—but combined identity, authentication, and privileged execution too permissively.

## Ideas preserved at an abstract level

- European Portuguese and an informal relationship with the operator;
- a direct voice, confidence, and dry humor subordinate to clarity;
- warnings before risky actions;
- multi-provider orchestration ambitions;
- memory, research, browser, and skills as coordinated capabilities;
- continuity when a provider fails.

Axiomux expresses these qualities through an original identity. It does not reuse the name, image, dialogue, catchphrases, lore, or other elements of the fictional character used by the previous agent.

## Problems found and architectural response

| Problem in the previous agent | Axiomux response |
|---|---|
| direct access to a private Codex access token | login belongs to the isolated OMP SQLite database under ACL protection; only Neuralwatt uses dedicated DPAPI storage |
| Codex fallback with a complete sandbox/approval bypass | explicit approval mode, tool allowlist, and fallback blocked after a consequential effect |
| generated skills able to execute TypeScript/commands through shell interpolation | governed candidates, quarantine, scanner, separate review, and no automatic arbitrary execution |
| patching, indexing, and web access outside a consistent effect boundary | host tools record an effect before execution; adapters use JSON stdin, no shell, and explicit approval |
| queues, effects, and approvals fragile across restarts | persistent RuntimeStore; workflows with hashes, pre-effect journals, and fail-closed unknown state |
| persona mixed with authority | IDENTITY/SOUL/USER separated from AGENTS/TOOLS/MEMORY_POLICY |

## Remaining limits

The reconstruction reduces the most obvious risks, but it does not make models, OMP, or adapters safe to treat as untrusted code. Browser/desktop automation still requires operating-system-level isolation, and SQLite state remains unencrypted as a whole.

The result is an original reconstruction guided by diagnosis of the previous project, not a copy or continuation of the former character.
