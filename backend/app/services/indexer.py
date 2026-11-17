import hashlib
import math
import re
import sqlite3
from datetime import datetime, timezone
from sqlalchemy.orm import Session
from app.core.database import DB_PATH
from app.models.search_models import IndexedDocument

STOP_WORDS = {
    "the", "is", "in", "at", "of", "on", "and", "a", "to", "for", "with",
    "as", "by", "this", "that", "from", "or", "an", "be", "are", "was", "were", "it"
}

def classify_document(title: str, url: str, text: str, source_type: str) -> str:
    if source_type == "pdf":
        return "PDFs & Notes"
    combined = f"{title} {url} {text[:800]}".lower()
    if any(k in combined for k in ["github.com", "/docs", "documentation", "api reference", "sdk", "def ", "function(", "class ", "repository"]):
        return "Code & Docs"
    if any(k in combined for k in ["tutorial", "how to", "step-by-step", "guide", "walkthrough", "getting started", "course", "learn"]):
        return "Tutorials & Guides"
    return "Articles"

def compute_reading_time(text: str) -> tuple[int, int]:
    words = re.findall(r"\w+", text)
    count = len(words)
    minutes = max(1, math.ceil(count / 200))
    return count, minutes

def upsert_document(
    db: Session,
    title: str,
    source_url: str,
    clean_text: str,
    source_type: str = "web",
    http_status: int = 200
) -> tuple[IndexedDocument, str]:
    clean_text = re.sub(r"\n{3,}", "\n\n", clean_text.strip())
    title = (title or source_url).strip()[:500]
    content_hash = hashlib.sha256(clean_text.encode("utf-8", errors="ignore")).hexdigest()
    word_count, reading_time = compute_reading_time(clean_text)
    category = classify_document(title, source_url, clean_text, source_type)

    existing = db.query(IndexedDocument).filter(IndexedDocument.source_url == source_url).first()
    if existing:
        if existing.content_hash == content_hash:
            existing.http_status = http_status
            existing.is_broken = http_status >= 400
            existing.last_checked_at = datetime.now(timezone.utc)
            db.commit()
            db.refresh(existing)
            return existing, "unchanged"
        existing.title = title
        existing.clean_text = clean_text
        existing.word_count = word_count
        existing.reading_time_min = reading_time
        existing.category = category
        existing.content_hash = content_hash
        existing.http_status = http_status
        existing.is_broken = http_status >= 400
        existing.is_cached = True
        existing.last_checked_at = datetime.now(timezone.utc)
        db.commit()
        db.refresh(existing)
        doc = existing
        status = "updated"
    else:
        doc = IndexedDocument(
            title=title,
            source_url=source_url,
            source_type=source_type,
            category=category,
            clean_text=clean_text,
            word_count=word_count,
            reading_time_min=reading_time,
            content_hash=content_hash,
            http_status=http_status,
            is_broken=http_status >= 400,
            is_cached=True,
        )
        db.add(doc)
        db.commit()
        db.refresh(doc)
        status = "indexed"

    conn = sqlite3.connect(DB_PATH)
    try:
        conn.execute("DELETE FROM documents_fts WHERE doc_id = ?", (str(doc.id),))
        conn.execute(
            "INSERT INTO documents_fts (doc_id, title, content, category) VALUES (?, ?, ?, ?)",
            (str(doc.id), doc.title, doc.clean_text, doc.category)
        )
        conn.commit()
    finally:
        conn.close()

    return doc, status

def build_fts_query(raw_query: str) -> str:
    tokens = [t.lower() for t in re.findall(r"[a-zA-Z0-9_]+", raw_query) if len(t) > 1]
    filtered = [t for t in tokens if t not in STOP_WORDS] or tokens
    if not filtered:
        return ""
    return " OR ".join(f'"{t}"*' for t in filtered[:12])

def build_snippet(text: str, query: str, max_len: int = 240) -> str:
    tokens = [t.lower() for t in re.findall(r"[a-zA-Z0-9_]+", query) if len(t) > 1]
    lower_text = text.lower()
    pos = 0
    for tok in tokens:
        idx = lower_text.find(tok)
        if idx != -1:
            pos = max(0, idx - 70)
            break
    snippet = text[pos:pos + max_len].replace("\n", " ").strip()
    if pos > 0:
        snippet = "..." + snippet
    if pos + max_len < len(text):
        snippet = snippet + "..."
    return snippet

def search_documents(db: Session, query: str, category: str = "", limit: int = 30) -> dict:
    fts_q = build_fts_query(query)
    if not fts_q:
        return {"query": query, "total": 0, "category_counts": {}, "results": []}

    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    try:
        rows = conn.execute(
            '''
            SELECT doc_id, bm25(documents_fts, 2.5, 1.0, 0.5) AS raw_rank
            FROM documents_fts
            WHERE documents_fts MATCH ?
            ORDER BY raw_rank ASC
            LIMIT ?
            ''',
            (fts_q, limit * 3)
        ).fetchall()
    except sqlite3.OperationalError:
        rows = []
    finally:
        conn.close()

    if not rows:
        return {"query": query, "total": 0, "category_counts": {}, "results": []}

    rank_map = {int(r["doc_id"]): abs(float(r["raw_rank"])) for r in rows}
    docs = db.query(IndexedDocument).filter(IndexedDocument.id.in_(list(rank_map.keys()))).all()
    doc_by_id = {d.id: d for d in docs}

    category_counts = {}
    ordered_results = []
    for r in rows:
        did = int(r["doc_id"])
        doc = doc_by_id.get(did)
        if not doc:
            continue
        category_counts[doc.category] = category_counts.get(doc.category, 0) + 1
        if category and category != "All" and doc.category != category:
            continue
        raw_bm25 = rank_map[did]
        relevance_score = round(min(99.9, (raw_bm25 / (raw_bm25 + 1.5)) * 100), 1)
        ordered_results.append({
            "id": doc.id,
            "title": doc.title,
            "source_url": doc.source_url,
            "source_type": doc.source_type,
            "category": doc.category,
            "snippet": build_snippet(doc.clean_text, query),
            "word_count": doc.word_count,
            "reading_time_min": doc.reading_time_min,
            "relevance_score": relevance_score,
            "bm25_raw": round(raw_bm25, 3),
            "is_cached": doc.is_cached,
            "is_broken": doc.is_broken,
            "created_at": doc.created_at.isoformat() if doc.created_at else None,
        })
        if len(ordered_results) >= limit:
            break

    return {
        "query": query,
        "total": len(ordered_results),
        "category_counts": category_counts,
        "results": ordered_results,
    }
