import io
from datetime import datetime, timezone
from typing import Optional
import httpx
from bs4 import BeautifulSoup
from fastapi import APIRouter, Depends, HTTPException, UploadFile, File, Query
from pydantic import BaseModel
from pypdf import PdfReader
from sqlalchemy.orm import Session
from app.core.database import get_db
from app.models.search_models import IndexedDocument, CrawlJob
from app.services.indexer import upsert_document, search_documents
from app.services.crawler import run_crawl, extract_clean_article

router = APIRouter()

MAX_PDF_BYTES = 20 * 1024 * 1024  # 20 MB PRD limit

class CrawlRequest(BaseModel):
    seed_url: str
    max_pages: int = 8
    same_domain_only: bool = True

@router.get("/health")
def health_check(db: Session = Depends(get_db)):
    total_docs = db.query(IndexedDocument).count()
    broken_docs = db.query(IndexedDocument).filter(IndexedDocument.is_broken == True).count()
    return {
        "status": "ok",
        "total_indexed": total_docs,
        "broken_links": broken_docs
    }

@router.get("/search")
def search_endpoint(
    q: str = Query(..., min_length=1),
    category: Optional[str] = Query(default=""),
    limit: int = Query(default=30, ge=1, le=100),
    db: Session = Depends(get_db)
):
    return search_documents(db=db, query=q, category=category or "", limit=limit)

@router.get("/suggestions")
def search_suggestions(q: str = Query(default=""), db: Session = Depends(get_db)):
    term = q.strip()
    if len(term) < 1:
        docs = db.query(IndexedDocument).order_by(IndexedDocument.created_at.desc()).limit(6).all()
    else:
        docs = (
            db.query(IndexedDocument)
            .filter(IndexedDocument.title.ilike(f"%{term}%"))
            .limit(6)
            .all()
        )
    return {"suggestions": [{"id": d.id, "title": d.title, "category": d.category} for d in docs]}

@router.get("/documents")
def list_documents(
    q: Optional[str] = Query(default=""),
    source_type: Optional[str] = Query(default=""),
    db: Session = Depends(get_db)
):
    query = db.query(IndexedDocument)
    if source_type and source_type != "all":
        query = query.filter(IndexedDocument.source_type == source_type)
    if q and q.strip():
        like_str = f"%{q.strip()}%"
        query = query.filter(
            (IndexedDocument.title.ilike(like_str)) | (IndexedDocument.source_url.ilike(like_str))
        )
    docs = query.order_by(IndexedDocument.created_at.desc()).all()
    return {
        "total": len(docs),
        "documents": [
            {
                "id": d.id,
                "title": d.title,
                "source_url": d.source_url,
                "source_type": d.source_type,
                "category": d.category,
                "word_count": d.word_count,
                "reading_time_min": d.reading_time_min,
                "http_status": d.http_status,
                "is_broken": d.is_broken,
                "is_cached": d.is_cached,
                "created_at": d.created_at.isoformat() if d.created_at else None,
            }
            for d in docs
        ]
    }

@router.get("/documents/{doc_id}")
def get_document_reader(doc_id: int, db: Session = Depends(get_db)):
    doc = db.query(IndexedDocument).filter(IndexedDocument.id == doc_id).first()
    if not doc:
        raise HTTPException(status_code=404, detail="Indexed document not found.")
    return {
        "id": doc.id,
        "title": doc.title,
        "source_url": doc.source_url,
        "source_type": doc.source_type,
        "category": doc.category,
        "clean_text": doc.clean_text,
        "word_count": doc.word_count,
        "reading_time_min": doc.reading_time_min,
        "http_status": doc.http_status,
        "is_broken": doc.is_broken,
        "is_cached": doc.is_cached,
        "created_at": doc.created_at.isoformat() if doc.created_at else None,
    }

@router.post("/crawl")
def trigger_crawl(payload: CrawlRequest, db: Session = Depends(get_db)):
    try:
        return run_crawl(
            db=db,
            seed_url=payload.seed_url.strip(),
            max_pages=payload.max_pages,
            same_domain_only=payload.same_domain_only
        )
    except ValueError as ve:
        raise HTTPException(status_code=400, detail=str(ve))
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Crawl failed: {str(exc)}")

@router.get("/crawl/history")
def crawl_history(db: Session = Depends(get_db)):
    jobs = db.query(CrawlJob).order_by(CrawlJob.created_at.desc()).limit(15).all()
    return {
        "jobs": [
            {
                "id": j.id,
                "seed_url": j.seed_url,
                "max_pages": j.max_pages,
                "same_domain_only": j.same_domain_only,
                "status": j.status,
                "pages_discovered": j.pages_discovered,
                "pages_indexed": j.pages_indexed,
                "pages_unchanged": j.pages_unchanged,
                "error_message": j.error_message,
                "created_at": j.created_at.isoformat() if j.created_at else None,
            }
            for j in jobs
        ]
    }

@router.post("/memory/upload-pdf")
async def upload_pdf_memory(file: UploadFile = File(...), db: Session = Depends(get_db)):
    if not file.filename or not file.filename.lower().endswith(".pdf"):
        raise HTTPException(status_code=400, detail="Only .pdf files are supported.")

    raw_bytes = await file.read()
    if len(raw_bytes) > MAX_PDF_BYTES:
        raise HTTPException(status_code=413, detail="PDF exceeds maximum 20 MB size limit.")
    if len(raw_bytes) == 0:
        raise HTTPException(status_code=400, detail="Uploaded PDF file is empty.")

    try:
        reader = PdfReader(io.BytesIO(raw_bytes))
        pages_text = []
        for idx, page in enumerate(reader.pages):
            txt = page.extract_text() or ""
            if txt.strip():
                pages_text.append(f"## Page {idx + 1}\n{txt.strip()}")
        full_text = "\n\n".join(pages_text)
    except Exception as exc:
        raise HTTPException(status_code=400, detail=f"Unable to parse PDF text: {str(exc)}")

    if len(full_text.strip()) < 20:
        raise HTTPException(status_code=422, detail="No extractable text found in PDF (scanned image PDFs without text layer are unsupported).")

    title = file.filename.rsplit(".", 1)[0].replace("_", " ").replace("-", " ")
    doc, op_status = upsert_document(
        db=db,
        title=title,
        source_url=f"local-pdf://{file.filename}",
        clean_text=full_text,
        source_type="pdf",
        http_status=200
    )
    return {
        "status": op_status,
        "document": {
            "id": doc.id,
            "title": doc.title,
            "source_url": doc.source_url,
            "source_type": doc.source_type,
            "category": doc.category,
            "word_count": doc.word_count,
            "reading_time_min": doc.reading_time_min,
        }
    }

@router.post("/memory/import-bookmarks")
async def import_bookmarks_html(file: UploadFile = File(...), db: Session = Depends(get_db)):
    if not file.filename or not file.filename.lower().endswith((".html", ".htm")):
        raise HTTPException(status_code=400, detail="Upload an exported browser bookmarks .html file.")

    raw_html = (await file.read()).decode("utf-8", errors="ignore")
    soup = BeautifulSoup(raw_html, "html.parser")
    links = soup.find_all("a", href=True)
    if not links:
        raise HTTPException(status_code=400, detail="No bookmark links found in the uploaded HTML file.")

    imported = 0
    broken = 0
    headers = {"User-Agent": "NexusPrivateSearchBot/1.0"}

    with httpx.Client(timeout=8.0, follow_redirects=True, headers=headers) as client:
        for a in links[:25]:
            href = a["href"].strip()
            if not href.startswith(("http://", "https://")):
                continue
            b_title = a.get_text(" ", strip=True) or href
            try:
                resp = client.get(href)
                if resp.status_code >= 400:
                    upsert_document(
                        db=db,
                        title=b_title,
                        source_url=href,
                        clean_text=f"Bookmarked URL: {b_title} ({href}). HTTP status {resp.status_code} recorded during bookmark import.",
                        source_type="bookmark",
                        http_status=resp.status_code
                    )
                    broken += 1
                else:
                    title, clean_text = extract_clean_article(resp.text, b_title)
                    upsert_document(
                        db=db,
                        title=title or b_title,
                        source_url=href,
                        clean_text=clean_text if len(clean_text) > 40 else f"{b_title} — {href}",
                        source_type="bookmark",
                        http_status=resp.status_code
                    )
                imported += 1
            except Exception:
                upsert_document(
                    db=db,
                    title=b_title,
                    source_url=href,
                    clean_text=f"Bookmarked reference: {b_title} ({href}). Live fetch unreachable at import time.",
                    source_type="bookmark",
                    http_status=503
                )
                broken += 1
                imported += 1

    return {
        "total_links_found": len(links),
        "processed_count": imported,
        "broken_count": broken
    }

@router.post("/documents/verify-links")
def verify_dead_links(db: Session = Depends(get_db)):
    web_docs = db.query(IndexedDocument).filter(IndexedDocument.source_type.in_(["web", "bookmark"])).all()
    checked = 0
    broken_found = 0
    headers = {"User-Agent": "NexusPrivateSearchBot/1.0"}

    with httpx.Client(timeout=7.0, follow_redirects=True, headers=headers) as client:
        for doc in web_docs:
            if not doc.source_url.startswith(("http://", "https://")):
                continue
            checked += 1
            try:
                resp = client.head(doc.source_url)
                if resp.status_code == 405:
                    resp = client.get(doc.source_url)
                doc.http_status = resp.status_code
                doc.is_broken = resp.status_code >= 400
            except Exception:
                doc.http_status = 503
                doc.is_broken = True
            doc.last_checked_at = datetime.now(timezone.utc)
            if doc.is_broken:
                broken_found += 1
        db.commit()

    return {"checked": checked, "broken_found": broken_found}

@router.get("/offline-capsule")
def export_offline_capsule(db: Session = Depends(get_db)):
    docs = db.query(IndexedDocument).order_by(IndexedDocument.created_at.desc()).limit(100).all()
    return {
        "exported_at": datetime.now(timezone.utc).isoformat(),
        "count": len(docs),
        "documents": [
            {
                "id": d.id,
                "title": d.title,
                "source_url": d.source_url,
                "source_type": d.source_type,
                "category": d.category,
                "clean_text": d.clean_text,
                "word_count": d.word_count,
                "reading_time_min": d.reading_time_min,
                "is_broken": d.is_broken,
                "is_cached": True,
            }
            for d in docs
        ]
    }
