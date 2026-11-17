const CAPSULE_KEY = "nexus_offline_capsule_v1";

export const offlineStore = {
  saveCapsule(payload) {
    try {
      localStorage.setItem(CAPSULE_KEY, JSON.stringify(payload));
      return true;
    } catch {
      return false;
    }
  },

  loadCapsule() {
    try {
      const raw = localStorage.getItem(CAPSULE_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch {
      return null;
    }
  },

  searchOffline(query, category = "All") {
    const capsule = this.loadCapsule();
    if (!capsule || !Array.isArray(capsule.documents)) {
      return { query, total: 0, category_counts: {}, results: [], offline: true };
    }

    const terms = query
      .toLowerCase()
      .split(/\W+/)
      .filter((t) => t.length > 1);

    const category_counts = {};
    const matched = [];

    for (const doc of capsule.documents) {
      const hay = `${doc.title} ${doc.clean_text}`.toLowerCase();
      let hits = 0;
      for (const term of terms) {
        if (hay.includes(term)) hits += 1;
      }
      if (hits === 0) continue;

      category_counts[doc.category] = (category_counts[doc.category] || 0) + 1;
      if (category && category !== "All" && doc.category !== category) continue;

      const idx = hay.indexOf(terms[0] || "");
      const start = Math.max(0, idx - 60);
      const snippet = (start > 0 ? "..." : "") + doc.clean_text.slice(start, start + 220) + "...";

      matched.push({
        ...doc,
        snippet,
        relevance_score: Math.min(99, Math.round((hits / Math.max(1, terms.length)) * 100)),
      });
    }

    matched.sort((a, b) => b.relevance_score - a.relevance_score);
    return {
      query,
      total: matched.length,
      category_counts,
      results: matched,
      offline: true,
    };
  },

  getOfflineDocument(docId) {
    const capsule = this.loadCapsule();
    if (!capsule || !Array.isArray(capsule.documents)) return null;
    return capsule.documents.find((d) => Number(d.id) === Number(docId)) || null;
  },
};
