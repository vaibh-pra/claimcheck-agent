# ClaimCheck Verification Agent

A standalone, three-step AI agent that post-processes any LLM chatbot response to identify domain-knowledge claims, shortlist the most verifiable ones, and find accurate published citations for each.

Built as part of the [Automorph](https://github.com/vaibh-pra/automorph-backend) project — an AI-powered graph automorphism analysis platform — but designed to work with **any** LLM chatbot.

---

## What It Does

LLM responses often mix two fundamentally different kinds of sentences:

- **Graph-structural observations** — orbit sizes, group order, generators, node IDs. These come from exact computation (Nauty) and need no verification.
- **Domain-knowledge claims** — assertions about how algorithms behave, what patterns mean in a field, established scientific findings. These *can* be wrong or hallucinated.

ClaimCheck separates the two and traces the second kind back to real sources.

---

## Three-Step Pipeline

```
Step 1  markClaims()       LLM reads every sentence and labels it as a
                           domain-knowledge claim or not. Graph-structural
                           observations are never marked.

Step 2  shortlistClaims()  Client-side (no LLM call). Picks the 3 most
                           specific-looking claims by sentence length and
                           de-marks the rest.

Step 3  findCitations()    LLM finds one real published source per shortlisted
                           claim. Claims with no verifiable source are
                           de-marked. Nothing is fabricated.
```

The final output is the original response with up to 3 sentences annotated with citations — every other sentence is left exactly as-is.

---

## Supported Domains

| Domain key | Context |
|---|---|
| `cybersecurity` | Botnet detection, MITRE ATT&CK, CVE, network security |
| `ppi_network` | Protein-protein interaction networks, bioinformatics, drug targets |
| `crystallography` | Space groups, X-ray diffraction, Metal-Organic Frameworks |
| `social_network` | Community detection, influence propagation, network centrality |
| `finance_research` | AML, wash trading, transaction network fraud, FATF typologies |
| `general` | Graph theory, network science, combinatorics |

---

## Repository Structure

```
claimcheck-agent/
  core.ts        All logic — three exported functions, no framework dependency
  server.ts      Standalone API server (port 4000)
  proxy.ts       Transparent LLM proxy (port 4001) — intercepts before terminal display
  cli.ts         CLI tool — calls any LLM and shows annotated output in terminal
  client.js      Drop-in frontend class for any chatbot page (zero dependencies)
  agent.json     Marketplace manifest — capabilities, schemas, env requirements
  package.json   npm package definition
  Dockerfile     Container definition
```

---

## Usage Modes

### Mode 1 — Proxy (transparent interception)

The proxy sits between you and Ollama or any cloud LLM. Every response is verified **before it reaches your terminal**. You do not change how you use your LLM — just redirect it to the proxy port.

```bash
# 1. Start the proxy in a background terminal
REAL_LLM_BASE_URL=http://localhost:11434 \
OLLAMA_API_KEY=your_key \
DEFAULT_DOMAIN=cybersecurity \
npm run proxy
# [ClaimCheck Proxy] listening on port 4001
# [ClaimCheck Proxy] forwarding to http://localhost:11434

# 2. Redirect your Ollama client to the proxy
export OLLAMA_HOST=http://localhost:4001

# 3. Use Ollama exactly as normal — responses are verified automatically
ollama run llama3 "Explain how botnets use graph topology"
```

Works with cloud LLMs too:

```bash
REAL_LLM_BASE_URL=https://api.openai.com \
OLLAMA_API_KEY=sk-... \
npm run proxy
# Then point your client's base URL to http://localhost:4001
```

To override the domain per request, pass a header:

```bash
curl -X POST http://localhost:4001/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "x-claimcheck-domain: finance_research" \
  -d '{"model":"llama3","messages":[{"role":"user","content":"Explain wash trading"}]}'
```

The proxy handles Ollama native endpoints (`/api/chat`, `/api/generate`) and the OpenAI-compatible endpoint (`/v1/chat/completions`). Everything else is forwarded unchanged.

---

### Mode 2 — CLI (direct terminal usage)

The CLI calls the LLM itself, buffers the full response, runs it through ClaimCheck, then prints the annotated result. The raw unverified response is never shown.

```bash
# Basic
npx tsx cli.ts "Explain how botnets work"

# With domain and model
npx tsx cli.ts --domain cybersecurity --model llama3:latest \
  "Explain botnet C2 topology"

# Cloud LLM
npx tsx cli.ts \
  --base-url https://api.openai.com \
  --key sk-... \
  --model gpt-4o \
  --domain finance_research \
  "Explain wash trading in financial networks"

# Pipe mode — works with any LLM that writes to stdout
ollama run llama3 "Explain botnets" | npx tsx cli.ts --domain cybersecurity

# Mark claims only, skip the citation step
npx tsx cli.ts --no-cite --domain ppi_network "How does PLK1 regulate mitosis?"
```

**Example terminal output:**

```
── Verified Response ──────────────────────────────────────────

Botnets often use star topologies for command and control communication. [1]
Compromised machines send beacons at randomised intervals to evade detection.
The Mirai botnet notably exploited default IoT credentials for rapid propagation. [2]

── Citations ───────────────────────────────────────────────────
[1] Gu et al., "BotSniffer: Detecting Botnet Command and Control Channels", NDSS, 2008
[2] Antonakakis et al., "Understanding the Mirai Botnet", USENIX Security, 2017
```

---

### Mode 3 — API server (for app integration)

```bash
npm start
# Running on http://localhost:4000
```

---

### Mode 4 — Drop-in frontend script (for web chatbots)

```html
<script src="https://your-agent-url/client.js"></script>
<script>
  const agent = new VerificationAgent({
    container: document.getElementById('chat-response'),
    apiBase:   'https://your-agent-url',
    domain:    'cybersecurity'
  });
  await agent.run(llmResponseText);
</script>
```

---

## Quick Start

```bash
git clone https://github.com/vaibh-pra/claimcheck-agent.git
cd claimcheck-agent
npm install
```

Then pick a mode above.

### Docker (proxy + API server)

```bash
docker build -t claimcheck-agent .
docker run \
  -e OLLAMA_API_KEY=your_key \
  -e REAL_LLM_BASE_URL=http://host.docker.internal:11434 \
  -e DEFAULT_DOMAIN=cybersecurity \
  -p 4000:4000 -p 4001:4001 \
  claimcheck-agent
```

---

## API Reference

### `GET /health`

```json
{ "status": "ok", "agent": "verification-agent", "version": "1.1.0" }
```

### `POST /api/mark-claims`

**Request**
```json
{ "responseText": "...", "domain": "cybersecurity" }
```
**Response**
```json
{
  "marked": [
    { "sentence": "Botnets often use star topologies for C2 communication.", "isClaim": true },
    { "sentence": "The graph has 12 nodes and group order 36.", "isClaim": false }
  ]
}
```

### `POST /api/shortlist-claims`

Picks the top 3 claims. No LLM call.

**Request:** `{ "marked": [...] }`
**Response:** `{ "shortlisted": [...] }`

### `POST /api/find-citations`

**Request:** `{ "marked": [...], "domain": "cybersecurity" }`
**Response:**
```json
{
  "cited": [
    {
      "sentence": "Botnets often use star topologies for C2 communication.",
      "isClaim": true,
      "citation": "Gu et al., \"BotSniffer: Detecting Botnet Command and Control Channels\", NDSS, 2008"
    }
  ]
}
```

---

## Embed in Your Own Node.js Server

```ts
import { markClaims, shortlistClaims, findCitations } from './core';

const marked      = await markClaims(responseText, 'finance_research');
const shortlisted = shortlistClaims(marked);
const cited       = await findCitations(shortlisted, 'finance_research');
```

---

## Environment Variables

| Variable | Required | Description |
|---|---|---|
| `OLLAMA_API_KEY` | Yes | API key for the Ollama cloud endpoint |
| `PORT` | No (default: 4000) | Port for the API server |
| `PROXY_PORT` | No (default: 4001) | Port for the proxy server |
| `REAL_LLM_BASE_URL` | Proxy only | Where to forward LLM requests (default: http://localhost:11434) |
| `DEFAULT_DOMAIN` | No (default: general) | Default domain for claim checking |

---

## Design Decisions

**Why shortlist only 3 claims?**
Finding citations is an LLM call and costs latency. Three is the sweet spot — enough to add value, few enough to stay fast.

**Why exclude graph-structural observations?**
They come from Nauty, an exact mathematical computation. They are already verified by definition. Marking them as claims would be misleading.

**Why de-mark claims with no source?**
A claim with a fabricated citation is worse than no citation at all. If the LLM cannot find a real specific source, the sentence silently reverts to plain text.

**Why buffer the response before display?**
ClaimCheck needs the complete response to identify which sentences are claims. Buffering gives a clean single-pass annotated result. The raw unverified text is never shown.

---

## License

MIT
