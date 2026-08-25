# Security Policy / 安全策略

## Reporting a Vulnerability / 报告漏洞

If you discover a security vulnerability in this plugin, please report it privately
before opening a public issue.

**Do not open a public issue for security vulnerabilities.** / 请勿为安全漏洞开公开 issue。

Please email the maintainer or open a [private vulnerability report](https://github.com/Seetraum/harness-session-delete/security/advisories/new)
on GitHub. Include:

- A description of the vulnerability.
- Steps to reproduce.
- Affected versions.
- Any suggested fix, if you have one.

## Scope / 范围

This plugin runs inside the DeepSeek Harness (DSH) web profile and:

- Registers HTTP routes under `/api/session-trash/*` on the local webserver.
- Non-GET requests require the `x-dsh-plugin: session-trash` custom header as a
  minimal CSRF defense (a custom header triggers a CORS preflight, which this
  server never answers).
- Permanently deletes session logs from the local disk on explicit user action.

## Supported Versions / 支持版本

| Version | Supported |
| ------- | --------- |
| 0.1.x   | ✅        |

## Reporting Process / 处理流程

- **Acknowledgment**: within 3 business days.
- **Update**: we will keep you informed of the fix progress.
- **Disclosure**: once a fix is released, the vulnerability may be disclosed publicly.
