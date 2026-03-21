/**
 * Veriphy — core logic (self-contained, no local imports)
 *
 * Exports three functions used by /api/mark-claims and /api/find-citations.
 * The canonical standalone package lives at: github.com/vaibh-pra/veriphy-agent
 *
 * Step 1 (markClaims) uses fast rule-based detection — no LLM required.
 * Step 2 (shortlistClaims) deduplicates via Jaccard similarity.
 * Step 3 (findCitations) queries the arXiv API for real paper citations.
 */

export interface MarkedSentence { sentence: string; isClaim: boolean; }
export interface CitedSentence  { sentence: string; isClaim: boolean; citation: string | null; }

// ── Step 1: Rule-based claim detection ──────────────────────────────────────

const FILLER_PREFIX = /^(here\b|let me\b|now\b|next\b|first\b|second\b|third\b|finally\b|in summary\b|to summarize\b|note that\b|keep in mind\b|sure\b|certainly\b|of course\b|absolutely\b|in conclusion\b|as (a result|mentioned|noted|shown|you can see)\b)/i;
const SUBJECTIVE    = /\b(i think|i believe|i feel|i would|in my opinion|personally|perhaps|maybe|might want|it seems|seems like|feel free)\b/i;

const CLAIM_PATTERNS: RegExp[] = [
  /\d+(\.\d+)?\s*(%|percent|x\b|times\b|ms\b|ns\b|gb\b|mb\b|tb\b|kb\b|hz\b|khz\b|mhz\b|ghz\b|km\b|kg\b|nm\b|db\b|bits?\b|bytes?\b|tokens?\b|parameters?\b)/i,
  /\bin\s+(1[5-9]\d{2}|20\d{2})\b/,
  /\b(since|by|until|before|after)\s+(1[5-9]\d{2}|20\d{2})\b/i,
  /\b(showed?|demonstrates?|demonstrated|proved?|discovered|found\s+that|published|proposed|introduced|reported|achieved|established|confirmed|verified|revealed)\b/i,
  /\b(outperforms?|faster\s+than|better\s+than|more\s+(accurate|efficient|robust|effective|reliable|stable|scalable)|fewer\s+than|higher\s+than|lower\s+than|reduces?|improves?|increases?|decreases?|boosts?)\b/i,
  /\b(because|therefore|thus|hence|consequently|as\s+a\s+result|due\s+to|leads?\s+to|causes?|results?\s+in|enables?|allows?|prevents?)\b/i,
  /\b(according\s+to|research\s+(shows?|suggests?|indicates?)|studies?\s+(show|suggest|indicate|found)|evidence\s+(suggests?|shows?|indicates?)|literature\s+(shows?|suggests?))\b/i,
  /\b[A-Z]{2,}\b/,
  /\b[A-Z][a-z]{1,15}(?:\s+[A-Z][a-z]{1,15}){1,3}\s+(is|are|was|were|has|have|can|will|does|provides?|enables?|uses?|relies?)\b/,
  /\b(algorithm|neural|quantum|protein|gene|molecule|entropy|frequency|wavelength|voltage|current|photon|electron|neuron|synapse|receptor|enzyme|chromosome|genome|membrane|catalyst|polymer|semiconductor|transistor|bandwidth|latency|throughput|accuracy|precision|recall|gradient|eigenvalue|Hamiltonian|Lagrangian|topology|manifold|tensor|Fourier|Bayesian|Markov)\b/i,
];

function splitIntoSentences(text: string): string[] {
  const abbrevs = /\b(Mr|Mrs|Ms|Dr|Prof|Sr|Jr|vs|etc|e\.g|i\.e|Fig|Eq|Ref|Sec|Vol|No|Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sep|Oct|Nov|Dec|approx|est|max|min|avg)\./gi;
  const safe = text.replace(abbrevs, m => m.slice(0, -1) + "\x00");
  const parts = safe.split(/(?<=[.!?])\s+(?=[A-Z0-9"'\(\[])/);
  return parts
    .map(s => s.replace(/\x00/g, ".").trim())
    .filter(s => s.length > 20);
}

function isClaimRuleBased(sentence: string): boolean {
  const s = sentence.trim();
  if (s.length < 25)             return false;
  if (s.endsWith("?"))           return false;
  if (FILLER_PREFIX.test(s))     return false;
  if (SUBJECTIVE.test(s))        return false;
  return CLAIM_PATTERNS.some(p => p.test(s));
}

export function markClaims(responseText: string, _domain?: string): MarkedSentence[] {
  const sentences = splitIntoSentences(responseText);
  if (process.env.DEBUG === "1")
    console.log(`[Veriphy] Step 1: rule-based claim detection over ${sentences.length} sentences`);
  return sentences.map(sentence => ({ sentence, isClaim: isClaimRuleBased(sentence) }));
}

// ── Step 2: Shortlist diverse claims (Jaccard deduplication) ─────────────────

function jaccardSimilarity(a: string, b: string): number {
  const wordsA = new Set((a.toLowerCase().match(/\w+/g) || []));
  const wordsB = new Set((b.toLowerCase().match(/\w+/g) || []));
  let intersection = 0;
  for (const w of wordsA) if (wordsB.has(w)) intersection++;
  const union = new Set([...wordsA, ...wordsB]).size;
  return union === 0 ? 0 : intersection / union;
}

export function shortlistClaims(marked: MarkedSentence[], maxClaims = 5, similarityThreshold = 0.55): MarkedSentence[] {
  const candidates = [...marked.filter(m => m.isClaim)]
    .sort((a, b) => b.sentence.length - a.sentence.length);

  const selected: string[] = [];
  for (const candidate of candidates) {
    if (selected.length >= maxClaims) break;
    const tooSimilar = selected.some(s => jaccardSimilarity(s, candidate.sentence) > similarityThreshold);
    if (!tooSimilar) selected.push(candidate.sentence);
  }

  const selectedSet = new Set(selected);
  return marked.map(m => ({ sentence: m.sentence, isClaim: m.isClaim && selectedSet.has(m.sentence) }));
}

// ── Step 3: arXiv citation lookup ────────────────────────────────────────────

const ARXIV_STOP_WORDS = new Set([
  "a","an","the","is","are","was","were","be","been","being","have","has","had",
  "do","does","did","will","would","could","should","may","might","must","can",
  "this","that","these","those","of","in","to","for","on","at","by","with",
  "from","and","or","but","not","as","it","its","also","which","than","more",
  "most","such","each","both","they","their","thus","hence","via","per","when",
  "where","how","all","any","some","one","two","three","often","very","well",
]);

async function searchArxiv(claim: string): Promise<string | null> {
  const terms = (claim.toLowerCase().match(/\b[a-z][a-z0-9\-]{2,}\b/g) || [])
    .filter(w => !ARXIV_STOP_WORDS.has(w));
  const query = terms.slice(0, 10).join(" ");
  if (!query) return null;

  try {
    const url = `https://export.arxiv.org/api/query?search_query=all:${encodeURIComponent(query)}&max_results=1&sortBy=relevance`;
    if (process.env.DEBUG === "1") console.log("[arXiv] query:", query);
    const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) return null;
    const xml = await res.text();

    if (!xml.includes("<entry>")) return null;

    const titleMatch     = xml.match(/<entry>[\s\S]*?<title>([\s\S]*?)<\/title>/);
    const firstNameMatch = xml.match(/<author>\s*<name>([\s\S]*?)<\/name>/);
    const publishedMatch = xml.match(/<published>([\s\S]*?)<\/published>/);
    const idMatch        = xml.match(/<id>\s*https?:\/\/arxiv\.org\/abs\/([^\s<]+)\s*<\/id>/);

    if (!titleMatch || !idMatch) return null;

    const title    = titleMatch[1].trim().replace(/\s+/g, " ");
    const year     = publishedMatch?.[1]?.slice(0, 4) ?? "";
    const arxivId  = idMatch[1].trim();
    const rawName  = firstNameMatch?.[1]?.trim() ?? "";
    const lastName = rawName ? rawName.split(/\s+/).pop()! : "Unknown";
    const author   = rawName.includes(" ") ? `${lastName} et al.` : rawName;

    if (process.env.DEBUG === "1") console.log(`[arXiv] found: ${author} (${year}) arXiv:${arxivId}`);
    return `${author}, "${title}", arXiv:${arxivId}${year ? `, ${year}` : ""}`;
  } catch {
    return null;
  }
}

export async function findCitations(marked: MarkedSentence[], _domain?: string): Promise<CitedSentence[]> {
  const claims = marked.filter(m => m.isClaim);
  if (!claims.length) return marked.map(m => ({ ...m, citation: null }));

  const results = await Promise.all(claims.map(m => searchArxiv(m.sentence)));

  let idx = 0;
  return marked.map(m => {
    if (!m.isClaim) return { ...m, citation: null };
    const citation = results[idx++] ?? null;
    return { sentence: m.sentence, isClaim: citation !== null, citation };
  });
}
