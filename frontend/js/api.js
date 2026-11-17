const API_BASE = "/api";

async function request(path, options = {}) {
  const response = await fetch(`${API_BASE}${path}`, options);
  const contentType = response.headers.get("content-type") || "";
  const data = contentType.includes("application/json")
    ? await response.json()
    : await response.text();

  if (!response.ok) {
    const message = (data && data.detail) ? data.detail : `Request failed (${response.status})`;
    throw new Error(message);
  }
  return data;
}

export const api = {
  getHealth: () => request("/health"),

  search: (query, category = "") => {
    const params = new URLSearchParams({ q: query });
    if (category && category !== "All") params.set("category", category);
    return request(`/search?${params.toString()}`);
  },

  getSuggestions: (query = "") => {
    const params = new URLSearchParams({ q: query });
    return request(`/suggestions?${params.toString()}`);
  },

  listDocuments: (query = "", sourceType = "all") => {
    const params = new URLSearchParams();
    if (query) params.set("q", query);
    if (sourceType && sourceType !== "all") params.set("source_type", sourceType);
    return request(`/documents?${params.toString()}`);
  },

  getDocument: (docId) => request(`/documents/${docId}`),

  startCrawl: (payload) =>
    request("/crawl", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    }),

  getCrawlHistory: () => request("/crawl/history"),

  uploadPdf: (file) => {
    const formData = new FormData();
    formData.append("file", file);
    return request("/memory/upload-pdf", {
      method: "POST",
      body: formData,
    });
  },

  importBookmarks: (file) => {
    const formData = new FormData();
    formData.append("file", file);
    return request("/memory/import-bookmarks", {
      method: "POST",
      body: formData,
    });
  },

  verifyLinks: () =>
    request("/documents/verify-links", {
      method: "POST",
    }),

  getOfflineCapsule: () => request("/offline-capsule"),
};
