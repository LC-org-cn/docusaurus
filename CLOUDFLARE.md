# Cloudflare 部署说明

这个 fork 的站点会自动发布到 Cloudflare。**你只需要改仓库内容并 push，剩下的构建和部署由 GitHub Actions 完成。**

## 线上地址

| 项目 | 地址 | 内容 |
| --- | --- | --- |
| Worker | https://docusaurus-docs.3572653147.workers.dev | 全站入口，静态站（en / fr / zh-CN）+ `/api` |
| Pages | https://docusaurus-pages-8v2.pages.dev | pt-BR / ko 两个语言，由 Worker 透传，一般不用直接访问 |

为什么拆成两个项目：Cloudflare 免费版对**每个项目**单独限制 20,000 个静态文件，而 5 种语言全量构建是 27,553 个文件。拆开后 Worker 16,533、Pages 11,022，两边都在额度内。Worker 会把 `/pt-BR/*`、`/ko/*` 的请求转发给 Pages，所以对外仍然只有一个网址。

## 改内容

改完直接 `git commit && git push`，Actions 会自动重建并部署（约 20-30 分钟）。想先本地看效果：

```bash
pnpm install          # 只需一次，会顺带构建 29 个 packages
pnpm start:website    # 本地开发服务器，热更新
```

| 想改什么 | 改哪里 |
| --- | --- |
| 当前版本文档正文 | `website/docs/**`（`.md` / `.mdx`） |
| 历史版本文档 | `website/versioned_docs/version-<版本>/**` |
| 博客文章 | `website/blog/**` |
| 独立页面（首页等） | `website/src/pages/**` |
| 导航栏 / 页脚 / 站点信息 | `website/docusaurus.config.ts` |
| 文档侧边栏结构 | `website/sidebars.ts` |
| 图片等静态资源 | `website/static/**`（会原样复制到站点根目录） |
| 界面英文文案 | `website/i18n/en/**`（由 `pnpm docusaurus write-translations` 生成） |

新加一个文档版本（在 `website/` 目录下执行）：

```bash
pnpm docusaurus docs:version 3.11.0
```

## 改部署配置

日常基本不用动，真要调就改这几个地方：

| 想改什么 | 改哪里 |
| --- | --- |
| 发布哪些语言 | `.github/workflows/deploy-cloudflare.yml` 里的 `DOCUSAURUS_LOCALES` |
| 哪些语言放 Pages | 同一文件的 `PAGES_LOCALES`（必须是 `DOCUSAURUS_LOCALES` 的子集） |
| Worker 名称 / 绑定 | `wrangler.jsonc` |
| Pages 项目地址 | `wrangler.jsonc` 里的 `PAGES_ORIGIN` |
| 产物拆分与限额校验 | `cloudflare/prepare-assets.mjs` |
| `/api` 接口逻辑 | `cloudflare/worker.mjs` |
| D1 表结构 | `cloudflare/schema.sql` |

注意：改了 `DOCUSAURUS_LOCALES` 之后，如果语言变多，两边都可能重新逼近 20,000 上限——`prepare-assets.mjs` 会在超限时直接让构建失败并告诉你超了多少，不会默默发一个坏站点。要突破该上限只能升级 Workers Paid（100,000/项目）。

## 中文为什么"汉化不完整"

不是配置问题：**这个仓库里根本没有翻译文本**。Docusaurus 上游把各语言翻译放在 Crowdin（项目 ID `428890`），构建时用 `crowdin download` 下载到 `website/i18n/<语言>/`，而该目录被 `.gitignore` 排除（`git ls-files website/i18n` 是 0 个文件）。没有 token 时，`zh-CN` 只能回退成英文正文——只有界面文案是中文，因为这些字符串随 `@docusaurus/theme-translations` 包发布。

补齐办法（一次性）：

1. 注册/登录 [crowdin.com](https://crowdin.com)，加入 [docusaurus-v2 项目](https://crowdin.com/project/docusaurus-v2)（开源项目，免费加入）；
2. 头像 → **Account Settings → API → New Token**，勾选 `Projects`（只读即可）；
3. 把 token 加到你的 fork：`Settings → Secrets and variables → Actions → New repository secret`，名字必须是 **`CROWDIN_PERSONAL_TOKEN`**；
4. 下次 push（或在 Actions 页面手动 `Run workflow`）就会自动下载翻译再构建。

配套效果：翻译下载步骤在没配 token 时会自动跳过，所以现在不配也不会让部署失败。

## Cloudflare 资源

| 类型 | 名称                | 用途                                    |
| ---- | ------------------- | --------------------------------------- |
| D1   | `docusaurus-db`     | `/api/feedback` 的页面反馈表            |
| KV   | `docusaurus-kv`     | 计数缓存（派生数据，可丢）              |
| R2   | `docusaurus-assets` | 预留大文件存储，预算 1 GiB，目前 0 字节 |

接口：

- `GET /api/health` — 检查 D1 / KV / R2 三个绑定
- `GET /api/storage` — 查看 R2 用量与预算
- `GET /api/feedback?path=/docs/x` — 读取某页反馈统计
- `POST /api/feedback` — 提交反馈，body `{"path": "/docs/x", "helpful": true}`

GitHub 仓库里需要两个 secret：`CLOUDFLARE_API_TOKEN`、`CLOUDFLARE_ACCOUNT_ID`（已配置）。

## 排查

| 现象 | 说明 |
| --- | --- |
| 构建报文件数超限 | 调 `PAGES_LOCALES` 重新分配，或减少 `DOCUSAURUS_LOCALES` |
| `error code: 1101` | Cloudflare 侧 Worker 执行异常。本仓库已确认是账号级问题：新建的 hello-world Worker、纯静态 Worker，以及账号里原有的 `ai` Worker 都返回 1101，而 `/cdn-cgi/trace` 正常；同一份代码本地 `wrangler dev` 首页 200、三个绑定全 ok |
| 部署很久 | 全量 5 语言构建约 15-20 分钟，加上依赖安装和上传，CI 一轮 25-35 分钟属正常 |

## 手动重跑

- Actions 页面 → **Deploy to Cloudflare** → **Run workflow**
- 或本地：`pnpm build:website && node cloudflare/prepare-assets.mjs` 后依次 `wrangler pages deploy website/build-pages --project-name docusaurus-pages --branch main` 与 `wrangler deploy`
