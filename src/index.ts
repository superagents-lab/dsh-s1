/**
 * Native s1 tools for the DeepSeek Harness.
 *
 * This is a Cordis plugin (namespace export: `name` / `inject` / `apply`),
 * loaded by the DSH loader through the `s1-tools` row in `cordis.patch.yml`.
 * It registers `s1_search`, `s1_news`, `s1_crawl`, `s1_sitemap`, and
 * `s1_trending`, and `s1_ask` as first-class tools on `ctx.tools`, in the same layer as
 * `read`, `bash`, `subagent`, and the other built-in DSH tools.
 *
 * The heavy lifting is delegated to the official `@search1api/client` SDK in
 * process — no shelling out to the `s1` CLI and no MCP bridge.
 *
 * @module dsh-s1
 */
import type { Context } from "@deepseek-ai/cordis";
import type { ContentBlock } from "@deepseek-ai/dsh-llm";
import { defineTool, type JsonValue } from "@deepseek-ai/dsh-tools";
// Pull in the `ctx.skills` service type augmentation.
import type {} from "@deepseek-ai/dsh-skill";
import { Search1API } from "@search1api/client";

/** Cordis plugin name used by loader diagnostics. */
export const name = "tool-s1";

/** Services required by this plugin. */
export const inject = ["tools", "skills"];

/** Plugin configuration; set through the `s1-tools` row's `config` in a patch layer. */
export interface Config {
  /** Register `s1_search`. Defaults to true. */
  search?: boolean;
  /** Register `s1_news`. Defaults to true. */
  news?: boolean;
  /** Register `s1_ask`. Defaults to true. */
  ask?: boolean;
  /** Register `s1_crawl`. Defaults to true. */
  crawl?: boolean;
  /** Register `s1_sitemap`. Defaults to true. */
  sitemap?: boolean;
  /** Register `s1_trending`. Defaults to true. */
  trending?: boolean;
  /** Register the bundled `s1` skill. Defaults to true. */
  skill?: boolean;
}

const SEARCH_ENGINES = [
  "google",
  "bing",
  "bingcn",
  "duckduckgo",
  "yahoo",
  "yandex",
  "youtube",
  "x",
  "reddit",
  "github",
  "arxiv",
  "wechat",
  "bilibili",
  "imdb",
  "wikipedia",
  "grokipedia",
  "baidu",
  "360",
  "quark",
] as const;

const NEWS_ENGINES = [
  "google",
  "bing",
  "duckduckgo",
  "yahoo",
  "hackernews",
  "reuters",
] as const;

const TIME_RANGES = ["day", "week", "month", "year"] as const;

const TRENDING_SERVICES = ["github", "hackernews"] as const;

/** Bundled `s1` skill: teaches the model how to use the s1_* tools well. */
const S1_SKILL_NAME = "s1";
const S1_SKILL_DESCRIPTION =
  "Live web search, agentic search, news, page retrieval, sitemap discovery, and trending topics through the native s1_* tools.";
const S1_SKILL_WHEN_TO_USE =
  "Use when the user wants to search the web, look something up, research a topic, read or summarize a URL, check current news, explore a site's links, or see trending topics.";
const S1_SKILL_CONTENT = `# s1

Live web research through the native s1_* tools.

## Tools

- s1_search — search the web. Engines: google, bing, bingcn, duckduckgo, yahoo, yandex, youtube, x, reddit, github, arxiv, wechat, bilibili, imdb, wikipedia, grokipedia, baidu, 360, quark.
- s1_news — current news. Engines: google, bing, duckduckgo, yahoo, hackernews, reuters.
- s1_ask — describe what to find; the server chooses engines and time window and ranks results. Query only; costs 5 credits.
- s1_crawl — extract the readable title and full text from a URL.
- s1_sitemap — discover links on a page or domain.
- s1_trending — trending repos or stories from github or hackernews.

## When to use which tool

- Wants automatic routing across sources or a natural-language research request → s1_ask.
- Wants to search the web → s1_search.
- Wants the full page behind a result, or a URL the user shared → s1_crawl.
- Wants current news or recent coverage → s1_news.
- Wants to explore a site's structure or links → s1_sitemap.
- Wants what's popular now → s1_trending.

## Tuning

Adapt parameters to intent — don't just use defaults:

- Quick lookup ("search for X") → maxResults: 5, no crawl.
- Deep research ("research X thoroughly") → maxResults: 15, then s1_crawl the top 3–5 result URLs.
- User names a count ("find 10") → match it with maxResults.
- Recency ("latest", "this week") → timeRange: "day", "week", or "month".
- Source-specific ("on Reddit", "GitHub repos") → searchService: "reddit" or "github".
- Site-scoped ("only from arxiv.org") → includeSites: ["arxiv.org"]; to avoid a domain use excludeSites.
- Chinese queries → searchService: "google", "bing", "wechat", or "bilibili".

## Notes

- Search/news results keep optional published_date and engine-specific metadata (kind, stars, language, points, num_comments, story_url).
- Results are citable: keep the returned title and url when citing sources.
- s1_crawl needs a public HTTP(S) URL; set enableFallback: true when the primary crawler fails.
- These tools are already connected and authenticated — don't install anything or switch transports.
`;

/** Shared output schema for the citable `results` array of search and news. */
const RESULTS_OUTPUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    results: {
      type: "array",
      required: true,
      items: {
        type: "object",
        additionalProperties: true,
        properties: {
          title: { type: "string", required: true },
          url: { type: "string", required: true },
          snippet: { type: "string" },
          content: { type: "string" },
          published_date: { type: "string" },
          metadata: { type: "object", additionalProperties: true },
          source: { type: "string" },
          relevance: { type: "number" },
        },
      },
    },
  },
} as const;

function jsonObject(value: object): Record<string, JsonValue> {
  return JSON.parse(JSON.stringify(value)) as Record<string, JsonValue>;
}

/** Keep dates, metadata and Ask scores while mapping API links to citable URLs. */
function mapResults(
  results: Array<{
    title: string;
    link: string;
    snippet: string;
    content?: string;
    published_date?: string;
    metadata?: Record<string, unknown>;
    source?: string;
    relevance?: number;
  }>
) {
  return results.map((item) => ({
    title: item.title,
    url: item.link,
    snippet: item.snippet,
    ...(item.content ? { content: item.content } : {}),
    ...(item.published_date ? { published_date: item.published_date } : {}),
    ...(item.metadata ? { metadata: jsonObject(item.metadata) } : {}),
    ...(item.source !== undefined ? { source: item.source } : {}),
    ...(item.relevance !== undefined ? { relevance: item.relevance } : {}),
  }));
}

function textContent(value: unknown): ContentBlock[] {
  return [{ type: "text", text: JSON.stringify(value, null, 2) }];
}

export function apply(ctx: Context, config: Config = {}): void {
  const log = ctx.logger("s1");

  // Lazy construction: a missing key surfaces as a structured tool error at
  // execution time rather than failing plugin activation (the web-tool pattern).
  // Single credential source: S1_KEY — deliberately NOT falling back to the
  // SDK's SEARCH1API_API_KEY. OAuth reuses the CLI's stored credential — see README.
  let client: Search1API | undefined;
  const getClient = (): Search1API => {
    if (!client) {
      const apiKey = process.env.S1_KEY;
      if (!apiKey) {
        throw new Error(
          "Missing S1_KEY. Set the S1_KEY environment variable to your Search1API API key (https://s1.dev) before using the s1_* tools."
        );
      }
      client = new Search1API({ apiKey });
    }
    return client;
  };

  if (config.skill !== false) {
    log.info("registering s1 skill");
    ctx.skills.register({
      name: S1_SKILL_NAME,
      description: S1_SKILL_DESCRIPTION,
      whenToUse: S1_SKILL_WHEN_TO_USE,
      source: "runtime",
      content: S1_SKILL_CONTENT,
    });
  }

  if (config.search !== false) {
    log.info("registering s1_search");
    ctx.tools.register(
      defineTool({
        name: "s1_search",
        description:
          "Search the live public web via s1. Returns citable results with title, URL, snippet, and optional extracted full text. Pass a result URL to s1_crawl when you need the full page.",
        parameters: {
          query: { type: "string", required: true, description: "Short, focused search query." },
          maxResults: { type: "number", description: "Maximum number of results to return." },
          searchService: {
            type: "string",
            enum: SEARCH_ENGINES,
            description: "Search engine to use; choose one only when it matches the user's source intent.",
          },
          page: { type: "number", description: "Optional native results page (1-100)." },
          timeRange: { type: "string", enum: TIME_RANGES, description: "Optional recency window for time-sensitive searches." },
          includeSites: { type: "array", items: { type: "string" }, description: "Domains to include when the user explicitly scopes the search." },
          excludeSites: { type: "array", items: { type: "string" }, description: "Domains to exclude from the search." },
        },
        output: {
          schema: RESULTS_OUTPUT_SCHEMA,
          render: (_args, value): ContentBlock[] => textContent(value),
        },
        async execute(args, exec) {
          const response = await getClient().search(
            args.query,
            {
              maxResults: args.maxResults,
              searchService: args.searchService,
              page: args.page,
              timeRange: args.timeRange,
              includeSites: args.includeSites,
              excludeSites: args.excludeSites,
            },
            { signal: exec.signal }
          );
          return { results: mapResults(response.results) };
        },
      })
    );
  }

  if (config.ask !== false) {
    ctx.tools.register(
      defineTool({
        name: "s1_ask",
        timeoutMs: 45_000,
        description:
          "Describe what to find in natural language. Search1API chooses engines and a time window and returns results ranked by relevance. Query only; costs 5 credits.",
        parameters: {
          query: { type: "string", required: true, description: "Natural-language search request." },
        },
        output: {
          schema: {
            ...RESULTS_OUTPUT_SCHEMA,
            properties: {
              ...RESULTS_OUTPUT_SCHEMA.properties,
              query: { type: "string", required: true },
              intent: { type: "object", additionalProperties: true, required: true },
              errors: { type: "array", items: { type: "object", additionalProperties: true } },
            },
          },
          render: (_args, value): ContentBlock[] => textContent(value),
        },
        async execute(args, exec) {
          const response = await getClient().ask(args.query, { signal: exec.signal });
          return {
            query: response.query,
            intent: jsonObject(response.intent),
            results: mapResults(response.results),
            errors: response.errors,
          };
        },
      })
    );
  }

  if (config.news !== false) {
    log.info("registering s1_news");
    ctx.tools.register(
      defineTool({
        name: "s1_news",
        description:
          "Search current news via s1 when the user asks about recent events, announcements, or coverage. Returns citable article results with title, URL, snippet, and optional extracted text.",
        parameters: {
          query: { type: "string", required: true, description: "Short, focused news query." },
          maxResults: { type: "number", description: "Maximum number of articles to return." },
          searchService: {
            type: "string",
            enum: NEWS_ENGINES,
            description: "News search engine to use.",
          },
          timeRange: { type: "string", enum: TIME_RANGES, description: "Optional recency window; use day for breaking news." },
          includeSites: { type: "array", items: { type: "string" }, description: "News domains to include." },
          excludeSites: { type: "array", items: { type: "string" }, description: "News domains to exclude." },
        },
        output: {
          schema: RESULTS_OUTPUT_SCHEMA,
          render: (_args, value): ContentBlock[] => textContent(value),
        },
        async execute(args, exec) {
          const response = await getClient().news(
            args.query,
            {
              maxResults: args.maxResults,
              searchService: args.searchService,
              timeRange: args.timeRange,
              includeSites: args.includeSites,
              excludeSites: args.excludeSites,
            },
            { signal: exec.signal }
          );
          return { results: mapResults(response.results) };
        },
      })
    );
  }

  if (config.crawl !== false) {
    log.info("registering s1_crawl");
    ctx.tools.register(
      defineTool({
        name: "s1_crawl",
        description:
          "Extract the readable title and full text from a public URL via s1. Use it to read a page behind a search result or a URL the user shares.",
        parameters: {
          url: { type: "string", required: true, description: "Public HTTP or HTTPS URL to retrieve." },
          enableFallback: { type: "boolean", description: "Allow a fallback crawler when the primary one fails." },
        },
        output: {
          schema: {
            type: "object",
            additionalProperties: false,
            properties: {
              result: {
                type: "object",
                required: true,
                additionalProperties: true,
                properties: {
                  title: { type: "string", required: true },
                  url: { type: "string", required: true },
                  content: { type: "string", required: true },
                },
              },
            },
          },
          render: (_args, value): ContentBlock[] => textContent(value),
        },
        async execute(args, exec) {
          const response = await getClient().crawl(
            args.url,
            { enableFallback: args.enableFallback },
            { signal: exec.signal }
          );
          return {
            result: {
              title: response.results.title,
              url: response.results.link,
              content: response.results.content,
            },
          };
        },
      })
    );
  }

  if (config.sitemap !== false) {
    log.info("registering s1_sitemap");
    ctx.tools.register(
      defineTool({
        name: "s1_sitemap",
        description:
          "Discover related public links from a page or domain via s1 when the user wants to explore a site's structure or available pages.",
        parameters: {
          url: { type: "string", required: true, description: "Public page or domain URL whose links should be discovered." },
          type: { type: "string", enum: ["sitemap", "all"], description: "Discovery mode: sitemap or all links." },
        },
        output: {
          schema: {
            type: "object",
            additionalProperties: false,
            properties: {
              links: { type: "array", required: true, items: { type: "string" } },
            },
          },
          render: (_args, value): ContentBlock[] => textContent(value),
        },
        async execute(args, exec) {
          const response = await getClient().sitemap(
            args.url,
            { type: args.type },
            { signal: exec.signal }
          );
          return { links: response.links };
        },
      })
    );
  }

  if (config.trending !== false) {
    log.info("registering s1_trending");
    ctx.tools.register(
      defineTool({
        name: "s1_trending",
        description:
          "List currently trending repositories or stories from GitHub or Hacker News via s1 when the user asks what is popular now.",
        parameters: {
          service: {
            type: "string",
            enum: TRENDING_SERVICES,
            required: true,
            description: "Platform whose trending items should be returned.",
          },
          maxResults: { type: "number", description: "Maximum number of trending items to return." },
        },
        output: {
          schema: {
            type: "object",
            additionalProperties: false,
            properties: {
              results: {
                type: "array",
                required: true,
                items: {
                  type: "object",
                  additionalProperties: true,
                  properties: {
                    title: { type: "string", required: true },
                    url: { type: "string", required: true },
                    description: { type: "string" },
                  },
                },
              },
            },
          },
          render: (_args, value): ContentBlock[] => textContent(value),
        },
        async execute(args, exec) {
          const response = await getClient().trending(
            args.service,
            { maxResults: args.maxResults },
            { signal: exec.signal }
          );
          return {
            results: response.results.map((item) => ({
              title: item.title,
              url: item.url,
              ...(item.description ? { description: item.description } : {}),
            })),
          };
        },
      })
    );
  }
}
