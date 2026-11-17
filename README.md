# NexusSearch — Zero-Budget Private Search Engine & Personal Knowledge Retrieval System

A privacy-first, zero-budget web crawler, inverted index, and personal knowledge retrieval engine built with **FastAPI**, **SQLite FTS5**, **Custom BM25 Ranking**, and an **Editorial Search Studio UI**.

## Core & Innovative Features
1. **Intelligent Web Crawler & Link Extractor**: Polite BFS crawler with domain scoping, `robots.txt` awareness, SHA-256 delta change detection, and automatic dead-link verification.
2. **Text Processing & Inverted Index Engine**: Custom tokenization, stop-word filtering, and SQLite FTS5 inverted indexing for millisecond retrieval.
3. **Custom Relevance Ranking (BM25 + Metadata Boost)**: Field-weighted BM25 scoring across document titles, headings, and body content with transparent score breakdowns.
4. **My Personal Digital Memory**: Drag-and-drop local PDF ingestion (up to 20 MB) and browser `bookmarks.html` import with full-text indexing.
5. **Reader-First Clean View**: Distraction-free slide-over reader drawer with clean extracted article text, reading-time estimation, and cached snapshot rendering.
6. **Offline Survival Capsule**: IndexedDB/LocalStorage offline index snapshot & article cache so previously indexed documents remain searchable and readable without internet connectivity.
7. **Visual Topic Clusters**: Automatic rule-based classification into *Tutorials & Guides*, *Code & Docs*, *PDFs & Notes*, and *Articles*.
8. **Smart Dead-Link Cleaner & Cached Page Fallback**: Live HTTP status verification that flags broken links (`404`/`5xx`) while preserving cached snapshots for fallback reading.

## Quick Start (Local Setup)
```bash
cd private_search_engine/backend
python -m venv .venv
# Windows:
.venv\Scripts\activate
# macOS/Linux:
# source .venv/bin/activate

pip install -r ../requirements.txt
uvicorn app.main:app --host 0.0.0.0 --port 8000 --reload
```
Open **http://localhost:8000** in your browser.
