#!/usr/bin/env npx tsx
/**
 * ClaimCheck CLI
 *
 * Intercepts any LLM response before it reaches your terminal,
 * runs it through the three-step verification pipeline, then
 * prints the annotated result with inline citations.
 *
 * Usage:
 *   npx tsx cli.ts [options] "your prompt"
 *
 * Options:
 *   --model    <name>   Model to use (default: llama3:latest)
 *   --domain   <key>    Domain context: cybersecurity | ppi_network |
 *                       crystallography | social_network |
 *                       finance_research | general  (default: general)
 *   --base-url <url>    LLM base URL (default: http://localhost:11434)
 *   --key      <key>    API key for cloud endpoints (optional)
 *   --no-cite           Skip citation step (mark claims only)
 *   --raw               Also print the raw unprocessed response first
 *
 * Examples:
 *   npx tsx cli.ts --domain cybersecurity "Explain how botnets use graph topology"
 *   npx tsx cli.ts --model mistral:latest "How do protein interaction networks work?"
 *   npx tsx cli.ts --base-url https://ollama.com/v1 --key sk-... "Explain wash trading"
 */

import { markClaims, shortlistClaims, findCitations, Domain } from "./core";

const RESET  = "\x1b[0m";
const BOLD   = "\x1b[1m";
const DIM    = "\x1b[2m";
const YELLOW = "\x1b[33m";
const CYAN   = "\x1b[36m";
const GREEN  = "\x1b[32m";
const GREY   = "\x1b[90m";
const BLUE   = "\x1b[34m";

function parseArgs() {
  const args = process.argv.slice(2);
  const opts: Record<string, string | boolean> = {
    model:    "llama3:latest",
    domain:   "general",
    baseUrl:  process.env.OLLAMA_HOST ?? "http://localhost:11434",
    key:      process.env.OLLAMA_API_KEY ?? "",
    noCite:   false,
    raw:      false,
  };
  const positional: string[] = [];
  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case "--model":    opts.model   = args[++i]; break;
      case "--domain":   opts.domain  = args[++i]; break;
      case "--base-url": opts.baseUrl = args[++i]; break;
      case "--key":      opts.key     = args[++i]; break;
      case "--no-cite":  opts.noCite  = true;      break;
      case "--raw":      opts.raw     = true;       break;
      default: positional.push(args[i]);
    }
  }
  return { opts, prompt: positional.join(" ") };
}

function spin(msg: string): () => void {
  const frames = ["⠋","⠙","⠹","⠸","⠼","⠴","⠦","⠧","⠇","⠏"];
  let i = 0;
  process.stdout.write("\n");
  const id = setInterval(() => {
    process.stdout.write(`\r${CYAN}${frames[i++ % frames.length]}${RESET} ${DIM}${msg}${RESET}`);
  }, 80);
  return () => {
    clearInterval(id);
    process.stdout.write(`\r${" ".repeat(msg.length + 4)}\r`);
  };
}

function printAnnotated(cited: Awaited<ReturnType<typeof findCitations>>) {
  const citations: string[] = [];
  let citIdx = 0;

  process.stdout.write("\n");
  process.stdout.write(`${BOLD}${BLUE}── Verified Response ──────────────────────────────────────────${RESET}\n\n`);

  for (const s of cited) {
    if (s.isClaim && s.citation) {
      citIdx++;
      citations.push(s.citation);
      process.stdout.write(`${s.sentence} ${YELLOW}[${citIdx}]${RESET}\n`);
    } else {
      process.stdout.write(`${s.sentence}\n`);
    }
  }

  if (citations.length) {
    process.stdout.write(`\n${BOLD}${GREEN}── Citations ───────────────────────────────────────────────────${RESET}\n`);
    citations.forEach((c, i) => {
      process.stdout.write(`${YELLOW}[${i + 1}]${RESET} ${GREY}${c}${RESET}\n`);
    });
  } else {
    process.stdout.write(`\n${GREY}No verifiable domain-knowledge claims found in this response.${RESET}\n`);
  }

  process.stdout.write("\n");
}

function printMarked(marked: Awaited<ReturnType<typeof markClaims>>) {
  process.stdout.write("\n");
  process.stdout.write(`${BOLD}${BLUE}── Claim-Marked Response ───────────────────────────────────────${RESET}\n\n`);
  for (const s of marked) {
    if (s.isClaim) {
      process.stdout.write(`${YELLOW}[CLAIM] ${s.sentence}${RESET}\n`);
    } else {
      process.stdout.write(`${s.sentence}\n`);
    }
  }
  process.stdout.write("\n");
}

async function callLLM(baseUrl: string, model: string, key: string, prompt: string): Promise<string> {
  const url = baseUrl.replace(/\/$/, "") + "/v1/chat/completions";
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (key) headers["Authorization"] = `Bearer ${key}`;

  const res = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify({
      model,
      messages: [{ role: "user", content: prompt }],
      stream: false,
    }),
  });

  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`LLM error ${res.status}: ${txt.slice(0, 200)}`);
  }

  const data = await res.json() as any;
  return data.choices?.[0]?.message?.content ?? "";
}

async function readStdin(): Promise<string> {
  return new Promise(resolve => {
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", chunk => data += chunk);
    process.stdin.on("end", () => resolve(data.trim()));
  });
}

(async () => {
  const { opts, prompt: argPrompt } = parseArgs();

  let responseText = "";

  const stdinIsPipe = !process.stdin.isTTY;

  if (stdinIsPipe) {
    // Pipe mode: claimcheck receives LLM output via stdin
    // e.g.  ollama run llama3 "prompt" | npx tsx cli.ts --domain cybersecurity
    process.stdout.write(`${DIM}Reading from stdin...${RESET}\n`);
    responseText = await readStdin();
    if (opts.raw) {
      process.stdout.write(`${BOLD}── Raw Response ────────────────────────────────────────────────${RESET}\n`);
      process.stdout.write(responseText + "\n");
    }
  } else {
    // Direct mode: claimcheck calls the LLM itself
    if (!argPrompt) {
      process.stderr.write(`${BOLD}Usage:${RESET} npx tsx cli.ts [--model <name>] [--domain <key>] "your prompt"\n`);
      process.stderr.write(`       echo "llm output" | npx tsx cli.ts [--domain <key>]\n`);
      process.exit(1);
    }

    process.stdout.write(`${DIM}Model: ${opts.model}  Domain: ${opts.domain}  Base: ${opts.baseUrl}${RESET}\n`);

    const stopFetch = spin("Calling LLM…");
    try {
      responseText = await callLLM(
        opts.baseUrl as string,
        opts.model as string,
        opts.key as string,
        argPrompt
      );
    } finally { stopFetch(); }

    if (opts.raw) {
      process.stdout.write(`\n${BOLD}── Raw Response ────────────────────────────────────────────────${RESET}\n\n`);
      process.stdout.write(responseText + "\n");
    }
  }

  if (!responseText) {
    process.stderr.write("No response received.\n");
    process.exit(1);
  }

  // Step 1: mark claims
  const stopMark = spin("Step 1/3 — Identifying claims…");
  let marked: Awaited<ReturnType<typeof markClaims>>;
  try {
    marked = await markClaims(responseText, opts.domain as Domain);
  } finally { stopMark(); }

  if (opts.noCite) {
    printMarked(marked);
    process.exit(0);
  }

  // Step 2: shortlist
  const shortlisted = shortlistClaims(marked);

  // Step 3: find citations
  const stopCite = spin("Step 3/3 — Finding citations…");
  let cited: Awaited<ReturnType<typeof findCitations>>;
  try {
    cited = await findCitations(shortlisted, opts.domain as Domain);
  } finally { stopCite(); }

  printAnnotated(cited);
})();
