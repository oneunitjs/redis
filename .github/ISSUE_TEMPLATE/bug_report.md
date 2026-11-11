---
name: Bug Report
about: Create a report to help improve @oneunit/redis
title: "[BUG] "
labels: ["bug", "triage"]
assignees: ""
---

## 🐛 Bug Description

A clear and concise description of what the bug is.

## 🔄 Steps to Reproduce

1. Go to '...'
2. Call '....'
3. Pass '....'
4. See error

## 📦 Minimal Reproducible Example

```typescript
// Paste a minimal, runnable example that reproduces the issue.
// Include only the code needed to demonstrate the bug.
import { createClient } from "@oneunit/redis";

const redis = createClient({ url: process.env.REDIS_URL });
// ...
```

## ✅ Expected Behavior

A clear and concise description of what you expected to happen.

## ❌ Actual Behavior

A clear and concise description of what actually happened. Include error messages, stack traces, or screenshots if applicable.

## 📋 Environment

| Component | Version |
|---|---|
| `@oneunit/redis` | e.g. `1.1.0-beta` |
| Node.js | e.g. `20.x` |
| ioredis | e.g. `5.x` |
| BullMQ | e.g. `5.x` |
| Redis server | e.g. `7.x` (standalone / cluster / sentinel) |
| OS | e.g. `Ubuntu 22.04` |

## 🔧 Configuration

Share the relevant `createClient` options (redact any credentials):

```typescript
createClient({
  url: "redis://...",
  lazyConnect: true,
  maxRetriesPerRequest: null,
  resilience: { ... },
  jobAtLeastOnce: { ... },
});
```

## 📝 Additional Context

Add any other context about the problem here (e.g., whether it occurs in cluster/sentinel mode, specific BullMQ features used, etc.).

## ✅ Checklist

- [ ] I have searched existing issues to avoid duplicates
- [ ] I have reproduced the issue with the latest version of `@oneunit/redis`
- [ ] I have included a minimal reproducible example
- [ ] I have redacted any credentials/secrets from my example
