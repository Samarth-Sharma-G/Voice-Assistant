// services/rag-service.js
// -------------------------------------------------------------
// Thin wrapper around the FastAPI RAG micro-service.
// Now returns BOTH the retrieved context and an escalation flag
// -------------------------------------------------------------
require('dotenv').config();
const fetch = require('node-fetch');

class RagService {
  constructor(
    url  = process.env.RAG_URL  || 'http://localhost:8001/context',
    topK = process.env.RAG_TOP_K || 4
  ) {
    this.url  = url;
    this.topK = Number(topK);
  }

  /**
   * Query the RAG micro-service.
   *
   * @param {string} question – Latest caller utterance
   * @param {string} history  – JSON-stringified userContext
   * @param {object} [extra]  – Optional extra fields (e.g., caller_number, escalated_to)
   * @returns {Promise<{context: string, isEscalation: boolean}>}
   */
  async getContext(question, history, extra = {}) {
    const body = {
      question,
      history,
      k: this.topK,
      ...extra,
    };
    const res = await fetch(this.url, {
      method : 'POST',
      headers: { 'Content-Type': 'application/json' },
      body   : JSON.stringify(body),
    });

    if (!res.ok) {
      const msg = await res.text().catch(() => res.statusText);
      throw new Error(`RAG service error (${res.status}): ${msg}`);
    }

    const { context = '', is_escalation = false } = await res.json();
    // Convert snake_case → camelCase for downstream JS callers
    return { context, isEscalation: Boolean(is_escalation) };
  }
}

module.exports = { RagService };
