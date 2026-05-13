/**
 * MIK API Client
 * Handles communication between the frontend and the Cloudflare Worker API.
 */

const MIK_API = (() => {
  // === CONFIG ===
  // When developing locally, Worker runs on localhost:8787
  // In production, set this to your Worker URL (e.g., https://mik-worker.yourname.workers.dev)
  const API_BASE = window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1'
    ? 'http://localhost:8888'
    : 'https://mik-worker.isg11882.workers.dev'; // Update with your actual Worker URL

  // === STATE ===
  let isLoading = false;
  let currentOffset = 0;
  const PAGE_SIZE = 30;

  // === CORE FETCH ===
  async function apiFetch(endpoint, options = {}) {
    const url = `${API_BASE}${endpoint}`;
    try {
      const response = await fetch(url, {
        ...options,
        headers: {
          'Content-Type': 'application/json',
          ...options.headers,
        },
      });

      if (!response.ok) {
        throw new Error(`API ${response.status}: ${response.statusText}`);
      }

      return await response.json();
    } catch (err) {
      console.error(`[MIK API] Error fetching ${endpoint}:`, err);
      throw err;
    }
  }

  // === PUBLIC METHODS ===

  /**
   * Fetch articles with optional filters.
   */
  async function getArticles({ source, category, search, sort, limit, offset } = {}) {
    const params = new URLSearchParams();
    if (source && source !== 'all') params.set('source', source);
    if (category && category !== 'all') params.set('category', category);
    if (search) params.set('search', search);
    if (sort) params.set('sort', sort);
    if (limit) params.set('limit', limit);
    if (offset !== undefined) params.set('offset', offset);

    const queryString = params.toString();
    return apiFetch(`/api/articles${queryString ? '?' + queryString : ''}`);
  }

  /**
   * Fetch a single article by ID.
   */
  async function getArticleById(id) {
    return apiFetch(`/api/articles/${id}`);
  }

  /**
   * Fetch source statistics.
   */
  async function getSources() {
    return apiFetch('/api/sources');
  }

  /**
   * Fetch today's highlights.
   */
  async function getHighlights() {
    return apiFetch('/api/highlights');
  }

  /**
   * Trigger manual crawl.
   */
  async function triggerCrawl() {
    return apiFetch('/api/crawl', { method: 'POST' });
  }

  /**
   * Health check.
   */
  async function healthCheck() {
    try {
      const response = await fetch(`${API_BASE}/health`);
      return response.ok;
    } catch {
      return false;
    }
  }

  return {
    getArticles,
    getArticleById,
    getSources,
    getHighlights,
    triggerCrawl,
    healthCheck,
    get apiBase() { return API_BASE; },
    PAGE_SIZE,
  };
})();
