import { api } from "./api.js";
import { offlineStore } from "./offline.js";

const state = {
  activeView: "search",
  lastQuery: "",
  activeCategory: "All",
  lastSearchResponse: null,
  isOnline: navigator.onLine,
};

const $ = (id) => document.getElementById(id);

function escapeHtml(str) {
  return String(str ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function highlightKeywords(text, query) {
  let safe = escapeHtml(text);
  const terms = [...new Set(query.split(/\W+/).filter((t) => t.length > 1))];
  for (const term of terms) {
    const re = new RegExp(`(${term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")})`, "gi");
    safe = safe.replace(re, "<mark>$1</mark>");
  }
  return safe;
}

function updateNetworkStatus() {
  state.isOnline = navigator.onLine;
  const dot = $("netDot");
  const label = $("netLabel");
  if (state.isOnline) {
    dot.className = "dot-online";
    label.textContent = "Index Online";
  } else {
    dot.className = "dot-offline";
    label.textContent = "Offline Capsule Mode";
  }
}

/* Navigation */
function switchView(viewName) {
  state.activeView = viewName;
  document.querySelectorAll(".nav-item").forEach((btn) => {
    btn.setAttribute("aria-current", btn.dataset.view === viewName ? "page" : "false");
  });
  document.querySelectorAll(".view-section").forEach((sec) => {
    sec.classList.toggle("hidden", sec.id !== `view-${viewName}`);
  });

  if (viewName === "memory") loadMemoryDocuments();
  if (viewName === "crawler") loadCrawlHistory();
  if (viewName === "library") loadLibraryDocuments();
}

/* Health & Offline Capsule Sync */
async function syncHealthAndCapsule() {
  try {
    const health = await api.getHealth();
    $("indexedCountStat").textContent = `${health.total_indexed} docs`;
    const capsule = await api.getOfflineCapsule();
    offlineStore.saveCapsule(capsule);
  } catch {
    const cached = offlineStore.loadCapsule();
    if (cached) {
      $("indexedCountStat").textContent = `${cached.count} cached`;
    }
  }
}

/* Search Studio */
async function executeSearch(query, category = state.activeCategory) {
  const cleanQuery = query.trim();
  if (!cleanQuery) return;

  state.lastQuery = cleanQuery;
  state.activeCategory = category;
  $("suggestionsBox").classList.add("hidden");

  const resultsContainer = $("searchResultsArea");
  resultsContainer.innerHTML = `<div class="empty-state"><h3>Searching inverted index...</h3><p>Evaluating BM25 term frequencies across indexed sources.</p></div>`;

  try {
    let data;
    if (navigator.onLine) {
      data = await api.search(cleanQuery, category);
    } else {
      data = offlineStore.searchOffline(cleanQuery, category);
    }
    state.lastSearchResponse = data;
    renderClusterTabs(data.category_counts || {});
    renderSearchResults(data);
  } catch (err) {
    const fallback = offlineStore.searchOffline(cleanQuery, category);
    if (fallback.total > 0) {
      state.lastSearchResponse = fallback;
      renderClusterTabs(fallback.category_counts || {});
      renderSearchResults(fallback);
    } else {
      resultsContainer.innerHTML = `<div class="feedback-banner error">${escapeHtml(err.message)}</div>`;
    }
  }
}

function renderClusterTabs(counts) {
  const categories = ["All", "Tutorials & Guides", "Code & Docs", "PDFs & Notes", "Articles"];
  const bar = $("clusterTabs");
  bar.innerHTML = categories
    .map((cat) => {
      const count = cat === "All"
        ? Object.values(counts).reduce((a, b) => a + b, 0)
        : counts[cat];
      const countBadge = typeof count === "number" && count > 0 ? ` (${count})` : "";
      const pressed = state.activeCategory === cat ? "true" : "false";
      return `<button type="button" class="cluster-tab" data-category="${escapeHtml(cat)}" aria-pressed="${pressed}">${escapeHtml(cat)}${countBadge}</button>`;
    })
    .join("");

  bar.querySelectorAll(".cluster-tab").forEach((btn) => {
    btn.addEventListener("click", () => {
      if (state.lastQuery) {
        executeSearch(state.lastQuery, btn.dataset.category);
      }
    });
  });
}

function renderSearchResults(data) {
  const meta = $("resultMetaBar");
  const container = $("searchResultsArea");

  if (!data.results || data.results.length === 0) {
    meta.textContent = `0 matching documents for "${data.query}"`;
    container.innerHTML = `
      <div class="empty-state">
        <h3>No matching documents found</h3>
        <p>No indexed pages or local files matched <strong>${escapeHtml(data.query)}</strong>. Try crawling a website or importing PDFs/bookmarks.</p>
      </div>`;
    return;
  }

  const modeNote = data.offline ? " · Served from Offline Capsule" : "";
  meta.textContent = `Showing ${data.total} ranked result${data.total === 1 ? "" : "s"} for "${data.query}"${modeNote}`;

  container.innerHTML = data.results
    .map((item) => {
      const brokenBadge = item.is_broken
        ? `<span class="tag tag-broken">Dead Link · Cached Fallback</span>`
        : `<span class="tag">Cached Snapshot</span>`;
      const scoreBadge = typeof item.relevance_score === "number"
        ? `<span class="tag tag-peach">Relevance ${item.relevance_score}%</span>`
        : "";
      return `
        <article class="result-entry">
          <div class="result-source-line">
            <span>${escapeHtml(item.source_type.toUpperCase())}</span>
            <span>·</span>
            <span>${escapeHtml(item.source_url)}</span>
          </div>
          <h3 class="result-title" data-doc-id="${item.id}" tabindex="0">${escapeHtml(item.title)}</h3>
          <p class="result-snippet">${highlightKeywords(item.snippet, data.query)}</p>
          <div class="result-footer">
            <div class="badge-group">
              <span class="tag">${escapeHtml(item.category)}</span>
              ${scoreBadge}
              ${brokenBadge}
              <span class="tag">${item.reading_time_min} min read · ${item.word_count} words</span>
            </div>
            <button type="button" class="btn btn-sm btn-outline open-reader-btn" data-doc-id="${item.id}">
              Clean Reader
            </button>
          </div>
        </article>`;
    })
    .join("");

  container.querySelectorAll("[data-doc-id]").forEach((el) => {
    el.addEventListener("click", () => openCleanReader(el.dataset.docId));
    el.addEventListener("keydown", (e) => {
      if (e.key === "Enter") openCleanReader(el.dataset.docId);
    });
  });
}

/* Search Suggestions */
let suggestTimer = null;
function handleSearchInput(val) {
  clearTimeout(suggestTimer);
  const box = $("suggestionsBox");
  if (!val.trim() || !navigator.onLine) {
    box.classList.add("hidden");
    return;
  }
  suggestTimer = setTimeout(async () => {
    try {
      const res = await api.getSuggestions(val.trim());
      if (!res.suggestions || res.suggestions.length === 0) {
        box.classList.add("hidden");
        return;
      }
      box.innerHTML = res.suggestions
        .map(
          (s) => `
          <button type="button" class="suggestion-item" data-title="${escapeHtml(s.title)}">
            <span>${escapeHtml(s.title)}</span>
            <span class="tag">${escapeHtml(s.category)}</span>
          </button>`
        )
        .join("");
      box.classList.remove("hidden");

      box.querySelectorAll(".suggestion-item").forEach((btn) => {
        btn.addEventListener("click", () => {
          $("mainSearchInput").value = btn.dataset.title;
          box.classList.add("hidden");
          executeSearch(btn.dataset.title);
        });
      });
    } catch {
      box.classList.add("hidden");
    }
  }, 180);
}

/* Clean Reader Slide-Over Drawer */
async function openCleanReader(docId) {
  const backdrop = $("readerBackdrop");
  const articleEl = $("readerArticle");
  backdrop.classList.remove("hidden");
  articleEl.innerHTML = `<p>Loading cached clean article...</p>`;

  try {
    let doc;
    if (navigator.onLine) {
      doc = await api.getDocument(docId);
    } else {
      doc = offlineStore.getOfflineDocument(docId);
      if (!doc) throw new Error("Document is not available in the local offline capsule.");
    }

    const paragraphs = doc.clean_text
      .split(/\n\n+/)
      .map((block) => {
        const trimmed = block.trim();
        if (!trimmed) return "";
        if (trimmed.startsWith("## ")) {
          return `<h2>${escapeHtml(trimmed.slice(3))}</h2>`;
        }
        return `<p>${escapeHtml(trimmed)}</p>`;
      })
      .join("");

    const statusTag = doc.is_broken
      ? `<span class="tag tag-broken">Source Unreachable · Reading Cached Snapshot</span>`
      : `<span class="tag tag-peach">Offline Cached Snapshot Ready</span>`;

    articleEl.innerHTML = `
      <div class="badge-group">
        <span class="tag">${escapeHtml(doc.category)}</span>
        <span class="tag">${doc.reading_time_min} min read (${doc.word_count} words)</span>
        ${statusTag}
      </div>
      <h1 class="reader-article-title">${escapeHtml(doc.title)}</h1>
      <div class="reader-article-url">${escapeHtml(doc.source_url)}</div>
      <div class="reader-content">${paragraphs}</div>
    `;
  } catch (err) {
    articleEl.innerHTML = `<div class="feedback-banner error">${escapeHtml(err.message)}</div>`;
  }
}

function closeCleanReader() {
  $("readerBackdrop").classList.add("hidden");
}

/* My Personal Digital Memory */
async function handlePdfUpload(file) {
  const feedback = $("pdfFeedback");
  if (!file) return;
  if (!file.name.toLowerCase().endsWith(".pdf")) {
    feedback.className = "feedback-banner error";
    feedback.textContent = "Invalid file format. Please select a .pdf document.";
    feedback.classList.remove("hidden");
    return;
  }
  if (file.size > 20 * 1024 * 1024) {
    feedback.className = "feedback-banner error";
    feedback.textContent = "File exceeds the 20 MB maximum upload limit.";
    feedback.classList.remove("hidden");
    return;
  }

  feedback.className = "feedback-banner";
  feedback.textContent = `Extracting text and indexing "${file.name}"...`;
  feedback.classList.remove("hidden");

  try {
    const res = await api.uploadPdf(file);
    feedback.textContent = `Indexed "${res.document.title}" (${res.document.word_count} words · ${res.document.reading_time_min} min read).`;
    await syncHealthAndCapsule();
    await loadMemoryDocuments();
  } catch (err) {
    feedback.className = "feedback-banner error";
    feedback.textContent = err.message;
  }
}

async function handleBookmarkImport(file) {
  const feedback = $("bookmarkFeedback");
  if (!file) return;

  feedback.className = "feedback-banner";
  feedback.textContent = `Parsing bookmarks and crawling reachable URLs from "${file.name}"...`;
  feedback.classList.remove("hidden");

  try {
    const res = await api.importBookmarks(file);
    feedback.textContent = `Processed ${res.processed_count} of ${res.total_links_found} bookmarks (${res.broken_count} unreachable/flagged).`;
    await syncHealthAndCapsule();
    await loadMemoryDocuments();
  } catch (err) {
    feedback.className = "feedback-banner error";
    feedback.textContent = err.message;
  }
}

async function loadMemoryDocuments() {
  const listEl = $("memoryDocsList");
  try {
    const data = await api.listDocuments();
    const personal = data.documents.filter((d) => d.source_type === "pdf" || d.source_type === "bookmark");
    if (personal.length === 0) {
      listEl.innerHTML = `<div class="empty-state"><h3>No personal files or bookmarks indexed yet</h3><p>Upload a PDF (up to 20 MB) or import a browser bookmarks HTML file above.</p></div>`;
      return;
    }
    listEl.innerHTML = renderDocumentTable(personal);
    bindTableReaderButtons(listEl);
  } catch (err) {
    listEl.innerHTML = `<div class="feedback-banner error">${escapeHtml(err.message)}</div>`;
  }
}

/* Web Crawler */
async function handleCrawlSubmit(e) {
  e.preventDefault();
  const seedUrl = $("seedUrlInput").value.trim();
  const maxPages = Number($("maxPagesInput").value) || 8;
  const sameDomainOnly = $("sameDomainCheck").checked;
  const feedback = $("crawlFeedback");
  const btn = $("startCrawlBtn");

  btn.disabled = true;
  feedback.className = "feedback-banner";
  feedback.textContent = `Crawling ${seedUrl} (up to ${maxPages} pages)...`;
  feedback.classList.remove("hidden");

  try {
    const res = await api.startCrawl({
      seed_url: seedUrl,
      max_pages: maxPages,
      same_domain_only: sameDomainOnly,
    });
    feedback.textContent = `Crawl completed: ${res.pages_discovered} discovered, ${res.pages_indexed} newly indexed, ${res.pages_unchanged} unchanged.`;
    await syncHealthAndCapsule();
    await loadCrawlHistory();
  } catch (err) {
    feedback.className = "feedback-banner error";
    feedback.textContent = err.message;
  } finally {
    btn.disabled = false;
  }
}

async function loadCrawlHistory() {
  const container = $("crawlHistoryArea");
  try {
    const data = await api.getCrawlHistory();
    if (!data.jobs || data.jobs.length === 0) {
      container.innerHTML = `<div class="empty-state"><h3>No crawl sessions recorded</h3><p>Submit a seed URL above to begin crawling and building your private index.</p></div>`;
      return;
    }
    container.innerHTML = `
      <div class="table-container">
        <table class="doc-table">
          <thead>
            <tr>
              <th>Seed URL</th>
              <th>Status</th>
              <th>Discovered</th>
              <th>Indexed</th>
              <th>Unchanged</th>
            </tr>
          </thead>
          <tbody>
            ${data.jobs
              .map(
                (j) => `
              <tr>
                <td style="font-family:var(--font-mono);font-size:12.5px">${escapeHtml(j.seed_url)}</td>
                <td><span class="tag ${j.status === "completed" ? "tag-peach" : "tag-broken"}">${escapeHtml(j.status)}</span></td>
                <td>${j.pages_discovered}</td>
                <td>${j.pages_indexed}</td>
                <td>${j.pages_unchanged}</td>
              </tr>`
              )
              .join("")}
          </tbody>
        </table>
      </div>`;
  } catch (err) {
    container.innerHTML = `<div class="feedback-banner error">${escapeHtml(err.message)}</div>`;
  }
}

/* Indexed Content Library */
async function loadLibraryDocuments() {
  const filterQ = $("libraryFilterInput").value.trim();
  const sourceType = $("libraryTypeSelect").value;
  const container = $("libraryTableArea");

  try {
    const data = await api.listDocuments(filterQ, sourceType);
    if (!data.documents || data.documents.length === 0) {
      container.innerHTML = `<div class="empty-state"><h3>No indexed resources found</h3><p>Adjust your filter or add content via Web Crawler or My Digital Memory.</p></div>`;
      return;
    }
    container.innerHTML = renderDocumentTable(data.documents);
    bindTableReaderButtons(container);
  } catch (err) {
    container.innerHTML = `<div class="feedback-banner error">${escapeHtml(err.message)}</div>`;
  }
}

function renderDocumentTable(docs) {
  return `
    <div class="table-container">
      <table class="doc-table">
        <thead>
          <tr>
            <th>Title &amp; Source</th>
            <th>Type</th>
            <th>Category</th>
            <th>Health &amp; Cache</th>
            <th>Action</th>
          </tr>
        </thead>
        <tbody>
          ${docs
            .map(
              (d) => `
            <tr>
              <td>
                <div style="font-weight:600;color:var(--dark-teal)">${escapeHtml(d.title)}</div>
                <div style="font-family:var(--font-mono);font-size:12px;color:var(--ink-secondary)">${escapeHtml(d.source_url)}</div>
              </td>
              <td><span class="tag">${escapeHtml(d.source_type.toUpperCase())}</span></td>
              <td><span class="tag">${escapeHtml(d.category)}</span></td>
              <td>
                ${
                  d.is_broken
                    ? `<span class="tag tag-broken">Broken (${d.http_status}) · Cached</span>`
                    : `<span class="tag tag-peach">Healthy · Cached</span>`
                }
              </td>
              <td>
                <button type="button" class="btn btn-sm btn-outline open-reader-btn" data-doc-id="${d.id}">
                  Read
                </button>
              </td>
            </tr>`
            )
            .join("")}
        </tbody>
      </table>
    </div>`;
}

function bindTableReaderButtons(root) {
  root.querySelectorAll(".open-reader-btn").forEach((btn) => {
    btn.addEventListener("click", () => openCleanReader(btn.dataset.docId));
  });
}

async function handleVerifyLinks() {
  const btn = $("verifyLinksBtn");
  const feedback = $("libraryFeedback");
  btn.disabled = true;
  feedback.className = "feedback-banner";
  feedback.textContent = "Verifying live HTTP status for indexed web and bookmark URLs...";
  feedback.classList.remove("hidden");

  try {
    const res = await api.verifyLinks();
    feedback.textContent = `Checked ${res.checked} URLs. Flagged ${res.broken_found} broken link(s) with cached snapshots preserved.`;
    await loadLibraryDocuments();
  } catch (err) {
    feedback.className = "feedback-banner error";
    feedback.textContent = err.message;
  } finally {
    btn.disabled = false;
  }
}

/* Initialization */
document.addEventListener("DOMContentLoaded", () => {
  updateNetworkStatus();
  window.addEventListener("online", updateNetworkStatus);
  window.addEventListener("offline", updateNetworkStatus);

  document.querySelectorAll(".nav-item").forEach((btn) => {
    btn.addEventListener("click", () => switchView(btn.dataset.view));
  });

  $("searchForm").addEventListener("submit", (e) => {
    e.preventDefault();
    executeSearch($("mainSearchInput").value, state.activeCategory);
  });

  $("mainSearchInput").addEventListener("input", (e) => handleSearchInput(e.target.value));

  document.addEventListener("click", (e) => {
    if (!e.target.closest(".search-form-wrap")) {
      $("suggestionsBox").classList.add("hidden");
    }
  });

  $("closeReaderBtn").addEventListener("click", closeCleanReader);
  $("readerBackdrop").addEventListener("click", (e) => {
    if (e.target === $("readerBackdrop")) closeCleanReader();
  });

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") closeCleanReader();
  });

  // PDF Dropzone & File Input
  const pdfDrop = $("pdfDropzone");
  const pdfInput = $("pdfFileInput");
  pdfDrop.addEventListener("click", () => pdfInput.click());
  pdfInput.addEventListener("change", () => handlePdfUpload(pdfInput.files[0]));
  pdfDrop.addEventListener("dragover", (e) => {
    e.preventDefault();
    pdfDrop.classList.add("dragover");
  });
  pdfDrop.addEventListener("dragleave", () => pdfDrop.classList.remove("dragover"));
  pdfDrop.addEventListener("drop", (e) => {
    e.preventDefault();
    pdfDrop.classList.remove("dragover");
    if (e.dataTransfer.files[0]) handlePdfUpload(e.dataTransfer.files[0]);
  });

  // Bookmarks Dropzone & File Input
  const bmDrop = $("bookmarkDropzone");
  const bmInput = $("bookmarkFileInput");
  bmDrop.addEventListener("click", () => bmInput.click());
  bmInput.addEventListener("change", () => handleBookmarkImport(bmInput.files[0]));
  bmDrop.addEventListener("dragover", (e) => {
    e.preventDefault();
    bmDrop.classList.add("dragover");
  });
  bmDrop.addEventListener("dragleave", () => bmDrop.classList.remove("dragover"));
  bmDrop.addEventListener("drop", (e) => {
    e.preventDefault();
    bmDrop.classList.remove("dragover");
    if (e.dataTransfer.files[0]) handleBookmarkImport(e.dataTransfer.files[0]);
  });

  $("crawlForm").addEventListener("submit", handleCrawlSubmit);
  $("libraryFilterInput").addEventListener("input", loadLibraryDocuments);
  $("libraryTypeSelect").addEventListener("change", loadLibraryDocuments);
  $("verifyLinksBtn").addEventListener("click", handleVerifyLinks);

  $("syncOfflineBtn").addEventListener("click", async () => {
    await syncHealthAndCapsule();
    $("syncOfflineBtn").textContent = "Capsule Synced";
    setTimeout(() => {
      $("syncOfflineBtn").textContent = "Sync Offline Capsule";
    }, 2000);
  });

  syncHealthAndCapsule();
});
