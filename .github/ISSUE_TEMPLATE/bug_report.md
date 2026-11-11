---
name: Bug report
about: pacer-http parses or paces something incorrectly
title: ""
labels: bug
assignees: ""
---

**What happened?**

A clear description of what the limiter did vs. what you expected
(e.g. "request was dispatched immediately although remaining was 0",
"parser returned null for valid headers").

**The response headers** (minimal reproducible set — redact tokens):

```
HTTP/1.1 200 OK
x-ratelimit-limit: 60
x-ratelimit-remaining: 0
x-ratelimit-reset: 1794398460
```

If the bug is about `Retry-After`, include its exact value
(delta-seconds like `120` or an HTTP-date).

**How you used pacer-http**

```ts
import { pacer } from "pacer-http";
const fetch = pacer(globalThis.fetch, {/* options */});
```

**Environment**

- pacer-http version:
- Node version:
- The server/API you were talking to (GitHub, OpenAI, …):

**Additional context**

Console output, timing traces, `onStateChange` log — anything that shows the
limiter's view of the state.
