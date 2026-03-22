/**
 * Veriphy — standalone local server
 *
 * Run locally:
 *   OLLAMA_API_KEY=sk-... npm start
 *
 * Or with Docker:
 *   docker build -t veriphy .
 *   docker run -e OLLAMA_API_KEY=sk-... -p 4000:4000 veriphy
 *
 * Endpoints:
 *   GET  /health
 *   GET  /agent.js             (drop-in browser widget)
 *   POST /api/mark-claims
 *   POST /api/shortlist-claims
 *   POST /api/find-citations
 */

import express from "express";
import cors    from "cors";
import path    from "path";
import { markClaims, shortlistClaims, findCitations } from "./core";

const app  = express();
const PORT = parseInt(process.env.PORT || "4000", 10);

app.use(cors());
app.use(express.json({ limit: "5mb" }));

/* ── Health check ───────────────────────────────────────────────────────── */
app.get("/health", (_req, res) => {
  res.json({ status: "ok", agent: "veriphy", version: "1.1.0" });
});

/* ── Serve drop-in browser widget ──────────────────────────────────────── */
app.get("/agent.js", (_req, res) => {
  res.sendFile(path.join(__dirname, "agent.js"));
});

/* ── Step 1: Mark Claims ────────────────────────────────────────────────── */
app.post("/api/mark-claims", async (req, res) => {
  try {
    const { responseText, domain, query } = req.body;
    if (!responseText) return res.status(400).json({ error: "responseText is required" });
    const marked = await markClaims(responseText, domain || "general", query);
    if (!marked.length) return res.json({ marked: [] });
    res.json({ marked });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

/* ── Step 2: Shortlist ──────────────────────────────────────────────────── */
app.post("/api/shortlist-claims", (req, res) => {
  try {
    const { marked, query } = req.body;
    if (!Array.isArray(marked)) return res.status(400).json({ error: "marked array is required" });
    res.json({ shortlisted: shortlistClaims(marked, 5, 0.55, query) });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

/* ── Step 3: Find Citations ─────────────────────────────────────────────── */
app.post("/api/find-citations", async (req, res) => {
  try {
    const { marked, domain, query } = req.body;
    if (!Array.isArray(marked)) return res.status(400).json({ error: "marked array is required" });
    const cited = await findCitations(marked, domain || "general", query);
    res.json({ cited });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

/* ── Start ──────────────────────────────────────────────────────────────── */
app.listen(PORT, "0.0.0.0", () => {
  console.log(`[Veriphy] running on http://localhost:${PORT}`);
  console.log(`[Veriphy] OLLAMA_API_KEY: ${process.env.OLLAMA_API_KEY ? "set" : "NOT SET — Step 1 will fail"}`);
});
