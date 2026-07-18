# Third-party notices

Axiomux's original code and brand asset are distributed under the repository's MIT license. The following components remain subject to their own copyright, licenses and service terms.

## Oh My Pi

Axiomux interoperates with a separately installed Oh My Pi executable through its JSONL RPC protocol. Oh My Pi is MIT licensed; copyright belongs to its contributors.

Repository: <https://github.com/can1357/oh-my-pi>

The audited runtime contract is release `v17.0.4`, commit `3fdd85ab6c6bab6c0cdee80abbbec0981740a5c0`. `npm run omp:install` downloads the official platform asset into the project's private state; Axiomux verifies the published SHA-256 before installation and every OMP process spawn. The observed official Windows x64 binary is not Authenticode-signed.

OMP source is not vendored in this repository. Axiomux is not an OMP fork/mod, does not load OMP extensions, and does not relicense OMP, provider SDKs, model weights or authentication services. A managed executable installed under `.superai/` remains an unmodified third-party binary under OMP's license.

## Superpowers

The methodology skills in `skills/core/` are independently authored adaptations inspired by the MIT-licensed `obra/superpowers` project. The upstream notice is:

> MIT License
>
> Copyright (c) 2025 Jesse Vincent
>
> Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the "Software"), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions:
>
> The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.
>
> THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.

Repository: <https://github.com/obra/superpowers>

## Browser Use

The optional sidecar loads the MIT-licensed `browser-use` Python package, pinned to `0.13.6`. Exact transitive versions and artifact hashes are recorded in `adapters/browser-use/uv.lock`.

Repository: <https://github.com/browser-use/browser-use>

Browser Use is not part of the default Node runtime and is used only when the operator enables the adapter and supplies compatible credentials.

## Microsoft UFO

The optional JSON bridge can launch a separately installed Microsoft UFO checkout. UFO is MIT licensed and is neither vendored nor installed automatically by Axiomux.

Repository: <https://github.com/microsoft/UFO>

## YAML

The runtime uses `yaml` version `2.9.0` under the ISC license:

> Copyright Eemeli Aro <eemeli@gmail.com>
>
> Permission to use, copy, modify, and/or distribute this software for any purpose with or without fee is hereby granted, provided that the above copyright notice and this permission notice appear in all copies.
>
> THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES WITH REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR ANY SPECIAL, DIRECT, INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES WHATSOEVER RESULTING FROM LOSS OF USE, DATA OR PROFITS, WHETHER IN AN ACTION OF CONTRACT, NEGLIGENCE OR OTHER TORTIOUS ACTION, ARISING OUT OF OR IN CONNECTION WITH THE USE OR PERFORMANCE OF THIS SOFTWARE.

Repository: <https://github.com/eemeli/yaml>

## ipaddr.js

The runtime uses `ipaddr.js` version `2.4.0` under the MIT license:

> Copyright (C) 2011-2017 whitequark <whitequark@whitequark.org>
>
> Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the "Software"), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions:
>
> The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.
>
> THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.

Repository: <https://github.com/whitequark/ipaddr.js>

## Development toolchain

The npm development toolchain includes `@biomejs/biome` version `2.5.4` (`MIT OR Apache-2.0`), TypeScript (Apache-2.0), tsx (MIT), esbuild (MIT) and Node.js type definitions (MIT). Exact versions are recorded in `package-lock.json`. Biome is not a runtime dependency; its complete `LICENSE-MIT` and `LICENSE-APACHE` texts are distributed by the installed package.

## Services, providers and models

OpenAI, Anthropic, Google, Cursor, Perplexity, Neuralwatt and other providers may impose separate account, subscription, privacy, acceptable-use and model-license terms. Supporting a login flow does not make the service or model open source.

No source code from repositories classified as “inspiration”, “ideas only”, or “excluded” in [SOURCES.md](SOURCES.md) is distributed as part of their upstream implementations.
