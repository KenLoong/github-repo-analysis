# GitHub Repo 报告

输入一个 GitHub 仓库链接，按作者统计 commit / issue / PR / 评论，并可调用 DeepSeek 判断 bug 类型以及 commit 是否有意义。

## 功能

- 作者汇总：每位作者的 commit、issue、PR、评论数量
- Commits / Issues / Pull Requests / 评论 明细，可按作者筛选
- Bug-fix PR 列表
- 可选 AI 分析（DeepSeek）：bug 类型分类、commit 价值判断；关闭后只输出统计数字

## 快速开始

依赖：Python 3（仅标准库，无需安装包）。

```bash
./start.sh          # 默认端口 8000
./start.sh 9000     # 指定端口
```

首次运行会从 `config.example.json` 生成 `config.json`，填入密钥后再次运行，然后访问 http://127.0.0.1:8000 。

## 配置

`config.json`（已被 git 忽略，请勿提交）：

| 字段 | 说明 | 默认 |
| --- | --- | --- |
| `github_token` | GitHub Personal Access Token，用于提高 API 限额、读取私有仓库 | 空 |
| `deepseek_api_key` | DeepSeek API Key，仅保存在服务端 | 空 |
| `deepseek_model` | 使用的 DeepSeek 模型 | `deepseek-chat` |
| `default_repo` | 页面默认填充的仓库 | 空 |
| `max_commits` | 最多抓取的 commit 数 | 300 |
| `max_items` | issue / PR 各自最多抓取数 | 300 |
| `max_comment_pages` | 评论最多抓取页数（每页 100 条） | 20 |

## 项目结构

```
├── index.html            页面
├── app.js                前端逻辑：调用 GitHub API、聚合统计、渲染报告
├── style.css             样式
├── server.py             本地服务：静态文件 + /api/config + /api/llm（DeepSeek 代理）
├── start.sh              启动脚本
└── config.example.json   配置模板
```

## 安全说明

- 服务只监听 `127.0.0.1`，仅限本机访问。
- `config.json` 不会作为静态文件对外提供；`/api/config` 返回给浏览器时会去掉 `deepseek_api_key`，AI 请求由 `server.py` 代理转发。
- `github_token` 会下发到浏览器，用于前端直接请求 GitHub API，请使用最小权限（只读）的 token。
- 切勿将 `config.json` 或任何密钥提交到仓库。
