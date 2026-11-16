# Changelog

## 0.2.1 - 2026-11-16

- Support DSH 0.2.x: declare `engines.dsh` and widen the DSH peer ranges to `>=0.1.0-rc.6 <0.3.0-0`, so DSH 0.2.2 no longer flags the plugin as incompatible.

## 0.2.0 - 2026-10-12

- Add the default query-only Ask tool (Agentic Search in n8n), with a 5-credit cost disclosure.
- Add Bing China, Yandex, and Grokipedia and remove Sogou. Support `week` in search/news and native search pagination.
- Preserve nested engine metadata, zero counters, and optional top-level publication dates; preserve Ask routing, source, relevance, and errors.
