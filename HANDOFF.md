# HANDOFF — dsh-s1 (s1 DSH plugin)

> 本文件随目录一起移动，供新 agent / 新会话接手时阅读。读完即可继续，无需重跑本会话的历史推导。

## 1. 这是什么

s1 的 DeepSeek Harness（DSH）**原生工具插件**。它在 DSH 里注册一等工具
`ctx.tools`（与 `read`/`bash`/`subagent`/`workflow` 同级），工具名统一 `s1_*` 前缀，
进程内直调官方 SDK `@search1api/client`。

与另外两个产品的关系（三者都压在同一套 s1 API 上，是并列宿主，不是替代）：

| 仓库 | 形态 | 在 DSH 里的表现 |
|---|---|---|
| `mcp` → `search1api-mcp` | MCP server | 桥接工具 `mcp__search1api__*`（零代码，配 `dsh-mcp-client` 即可用） |
| `cli` → `search1api-cli` | 命令行 + skill | 模型 shell 出 `s1` 命令（skill 教的） |
| **本仓库** → `dsh-s1` | DSH 原生插件 | 一等工具 `s1_search` 等 |

## 2. 当前状态（已做完 / 已验证）

- [x] 骨架：Cordis bundle + 插件二合一（`dsh.bundle.patch` 自引用）
- [x] 5 个工具：`s1_search` / `s1_news` / `s1_crawl` / `s1_sitemap` / `s1_trending`
      （每个都可独立开关，见 Config），完整 schema + output + execute + 取消信号透传
- [x] bundled `s1` skill（`ctx.skills.register`，`inject: ["skills"]`），教模型选工具/调参
- [x] 单凭据变量 `S1_KEY`
- [x] `npm run typecheck` 零错误、`npm run build` 通过
- [x] E2E 真机跑通：headless agent 实际调用 `s1_search` / `s1_crawl` / `s1_trending` 返回真实结果
- [x] `scripts/e2e.sh` 一键回归脚本，实测 `PASS`

**尚未做**（见 §7 下一步）。

## 3. 关键决策（已拍板）

- 工具命名前缀 `s1_`（`s1_search`、将来 `s1_crawl`…）。
- **凭据只有一个环境变量**：`S1_KEY`（显式传给 SDK，绕开 SDK 自带的
  `SEARCH1API_API_KEY`）。插件里 `new Search1API({ apiKey: process.env.S1_KEY })`。
- **OAuth 暂不做**（roadmap）。原因：OAuth 流程（PKCE 登录 + token 存储 + 401 刷新）
  目前只存在于 `cli/src/auth.ts`；`@search1api/client` 没有 OAuth。终局方案是「下沉进
  SDK」或「插件复用 CLI 的 getAccessCredential」，已留待后续，不要在插件里重写。

## 4. 文件地图

```
dsh-plugin/
├── src/index.ts           # 唯一源码：Cordis 插件，注册 s1_search
├── package.json           # name=dsh-s1; dsh.bundle.patch; peer deps
├── cordis.patch.yml       # bundle patch: insert { id: s1-tools, name: 'dsh-s1' }
├── tsconfig.json          # NodeNext, outDir lib
├── README.md              # 架构 + 安装 + 鉴权 + OAuth roadmap
├── scripts/e2e.sh         # 一键回归（隔离 home，不碰 ~/.dsh）
├── HANDOFF.md             # 本文件
├── lib/                   # 构建产物（可再生成，勿提交）
├── node_modules/ .npm-cache/ .dsh-e2e/   # 可再生/含凭据副本，移动后应删除
```

## 5. DSH 插件机制要点（接手必读，避免重新推导）

- DSH = **Cordis**（`@deepseek-ai/cordis@4.0.1`）插件框架。一切皆插件。
- 插件导出约定（namespace export，无 default）：
  ```ts
  export const name = "tool-s1";
  export const inject = ["tools"];          // 依赖的 service
  export interface Config { search?: boolean }
  export function apply(ctx: Context, config?: Config): void {
    ctx.tools.register(defineTool({ ... }));
  }
  ```
- 一个包要成为 **bundle**，package.json 里声明 `"dsh": { "bundle": { "patch": "./cordis.patch.yml" } }`。
  `dsh plugin add` 装完会**自动 reconcile** 进 profile 的 `dsh.profile.bundles`。
- bundle patch 是 YAML，`insert` 行按 `id` 寻址、后写覆盖整行 config；**行顺序无加载语义**
  （激活由 service 可用性驱动）。
- `defineTool` 参数 schema DSL：`{ type, required?, enum?（用 `as const`）, description, default }`；
  output schema 是 `ValueSchemaSpec`，对象必须带 `additionalProperties`；
  `execute(args, exec)` 返回 canonical value，`exec.signal` 是 AbortSignal。
- **模块解析关键**：插件的 peer 依赖（`dsh-tools`/`cordis`/`dsh-llm`）不在 profile 的
  `node_modules` 里，但 DSH boot 时 `healProfilesModuleFallback` 会把 dsh 安装目录的整个
  依赖闭包软链到 `$DSH_HOME/profiles/node_modules`，Node 父目录向上查找即可命中——
  **无需让 pnpm 安装 peer**。

## 6. 依赖版本（RC，会变）

```jsonc
// dependencies
"@search1api/client": "^0.2.0"
// peerDependencies
"@deepseek-ai/cordis": "^4.0.1"
"@deepseek-ai/dsh-llm": "^0.1.0-rc.6"
"@deepseek-ai/dsh-skill": "^0.1.0-rc.6"   // 为 ctx.skills 的类型增强
"@deepseek-ai/dsh-tools": "^0.1.0-rc.6"
// devDependencies（typecheck/build 用）
"@types/node": "^20.19.43"   // 必须有：源码用了 process.env
"typescript": "^5.9.3"
```

注意：DSH 全系 `0.1.0-rc.6`（RC 期），`defineTool`/`ctx.tools` 的 API 签名可能随版本变动，
升级 DSH 前需重跑 typecheck。

## 7. 下一步 / 待办

1. **移动后收尾**：删除可再生目录、`git init`、建独立仓库（建议 `superagents-lab/dsh-s1`，
   与 README 里 repository 字段一致）、发布 npm。
2. **可选补 `s1_screenshot` / `s1_deepcrawl`**（SDK 都有对应方法）：
   - `s1_screenshot` 输出是二进制图，需接 DSH 的 attachment 服务（`ctx.attachments`）再出
     `image` block，不能只返回 base64；当前生产 adapter 仍 text-only，故暂缓。
   - `s1_deepcrawl` 是长轮询任务（默认 300s），SDK `deepcrawl()` 阻塞到完成；接 `exec.signal`
     + 设 `timeoutMs` 即可，但不在 MCP/CLI 面里，暂缓。
3. **OAuth**：走「下沉进 `@search1api/client`」或「插件复用 CLI 的 `getAccessCredential`」。
4. **小瑕疵**：SDK 缺 key 时错误文案是 `SEARCH1API_API_KEY`，会误导；可在插件 catch 后
   重写成 `S1_KEY`（或推进 SDK 统一 env 名）。
5. 可选：给插件加 `ctx.systemPrompt.section(...)` 提示（像 `tool-bash` 那样）教模型用好参数。

## 8. 已验证的坑（避免重踩）

- **web profile 端口**：用 `--port` 参数（`dsh --profile web --port 8080`），不是 `PORT` env；
  默认 3080 会与本机 DSH Web GUI 冲突。
- **`file:` 安装是快照复制**：改源码后要 `npm run build`，再在 profile 目录 `pnpm install`
  （或重跑 `dsh plugin add`）才刷新；活跃开发建议改用 `link:`（软链，即时生效）。
- **脚本变量命名**：不要用 `DSH_HOME` 当脚本自己的可覆盖变量（用户 shell 里通常已存在），
  已改用 `S1_E2E_HOME`。
- **macOS 无 GNU grep**：`grep -oP` 不可用，取 key 用 `sed -n 's/^S1_KEY=//p'`。
- **`@types/node` 必须显式进 devDependencies**：源码用 `process.env`，若依赖父级仓库的
  `node_modules/@types/node` 兜底，一旦移动到独立目录（如 ecosystem）就会
  `TS2580: Cannot find name 'process'`。已加入 devDependencies。
- **env 变量漂移**：`@search1api/client` 读 `SEARCH1API_API_KEY`，`search1api-mcp`/`cli`
  读 `SEARCH1API_KEY`，本插件读 `S1_KEY`（显式传给 SDK）。三者尚未对齐。

## 9. 快速上手（移动后在新目录跑）

```bash
cd /Volumes/More/Products/search1api/ecosystem/dsh-s1
rm -rf node_modules .npm-cache .dsh-e2e lib   # 清可再生物 + 凭据副本
npm install
npm run build
./scripts/e2e.sh                               # 一键回归（需 dsh 在 PATH + S1_KEY）
```

E2E 脚本的调参：`DSH_BIN`、`S1_E2E_HOME`、`DSH_PROFILE`、`S1_E2E_QUERY`、
`S1_E2E_COMPOSE_ONLY=1`（只验证到 compose，跳过 LLM 实调）。
