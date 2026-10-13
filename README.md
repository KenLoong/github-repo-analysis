# GitHub Repo Report

Paste a GitHub repository URL to get per-author statistics for commits, issues, pull requests and comments, with optional DeepSeek-powered analysis of bug types and whether each commit is meaningful.

## Features

- Author summary: commit, issue, PR and comment counts per author
- Detail tabs for Commits / Issues / Pull Requests / Comments, filterable by author
- Bug-fix PR list
- Optional AI analysis (DeepSeek): bug type classification and commit value assessment; turn it off to get statistics only

## Quick start

Requirements: Python 3 (standard library only, nothing to install).

```bash
./start.sh          # default port 8000
./start.sh 9000     # custom port
```

On first run the script creates `config.json` from `config.example.json`. Fill in your keys, run it again, then open <http://127.0.0.1:8000>.

## Configuration

`config.json` (git-ignored, never commit it):

| Field | Description | Default |
| --- | --- | --- |
| `github_token` | GitHub personal access token; raises API rate limits and allows reading private repos | empty |
| `deepseek_api_key` | DeepSeek API key, kept server-side only | empty |
| `deepseek_model` | DeepSeek model to use | `deepseek-chat` |
| `default_repo` | Repository pre-filled in the form | empty |
| `max_commits` | Maximum commits to fetch | 300 |
| `max_items` | Maximum issues and PRs to fetch (each) | 300 |
| `max_comment_pages` | Maximum comment pages to fetch (100 per page) | 20 |

## Project structure

```text
├── index.html            Page markup
├── app.js                Frontend: calls the GitHub API, aggregates stats, renders the report
├── style.css             Styles
├── server.py             Local server: static files + /api/config + /api/llm (DeepSeek proxy)
├── start.sh              Launch script
└── config.example.json   Configuration template
```

## Security notes

- The server binds to `127.0.0.1` only, so it is reachable from your machine alone.
- `config.json` is never served as a static file. `/api/config` strips `deepseek_api_key` before responding, and AI requests are proxied through `server.py`.
- `github_token` is sent to the browser so the frontend can call the GitHub API directly. Use a minimal, read-only token.
- Never commit `config.json` or any secret to the repository.
