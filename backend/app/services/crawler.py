from collections import deque
from urllib.parse import urljoin, urlparse
import httpx
from bs4 import BeautifulSoup
from sqlalchemy.orm import Session
from app.models.search_models import CrawlJob, IndexedDocument
from app.services.indexer import upsert_document

BLOCKED_EXTENSIONS = (".jpg", ".jpeg", ".png", ".gif", ".svg", ".webp", ".css", ".js", ".zip", ".mp4", ".mp3", ".ico")

def extract_clean_article(html: str, fallback_title: str) -> tuple[str, str]:
    soup = BeautifulSoup(html, "html.parser")
    for tag in soup(["script", "style", "nav", "footer", "header", "aside", "noscript", "iframe", "form"]):
        tag.decompose()

    title = fallback_title
    if soup.title and soup.title.string:
        title = soup.title.string.strip()
    elif soup.find("h1"):
        title = soup.find("h1").get_text(" ", strip=True)

    main_container = soup.find("article") or soup.find("main") or soup.body or soup
    blocks = []
    for el in main_container.find_all(["h1", "h2", "h3", "p", "li", "pre"]):
        txt = el.get_text(" ", strip=True)
        if len(txt) < 25 and el.name not in ("h1", "h2", "h3"):
            continue
        if el.name in ("h1", "h2", "h3"):
            blocks.append(f"## {txt}")
        else:
            blocks.append(txt)

    clean_text = "\n\n".join(blocks)
    if len(clean_text) < 120:
        clean_text = main_container.get_text("\n", strip=True)
    return title, clean_text

def run_crawl(db: Session, seed_url: str, max_pages: int = 8, same_domain_only: bool = True) -> dict:
    parsed_seed = urlparse(seed_url)
    if parsed_seed.scheme not in ("http", "https") or not parsed_seed.netloc:
        raise ValueError("Invalid URL. Provide a valid http:// or https:// URL.")

    max_pages = max(1, min(int(max_pages), 25))
    seed_domain = parsed_seed.netloc.lower()

    visited = set()
    queue = deque([seed_url])
    discovered = 1
    indexed_count = 0
    unchanged_count = 0
    crawled_pages = []
    errors = []

    headers = {"User-Agent": "NexusPrivateSearchBot/1.0 (+Zero-Budget-Personal-Indexer)"}

    with httpx.Client(timeout=10.0, follow_redirects=True, headers=headers) as client:
        while queue and len(visited) < max_pages:
            current_url = queue.popleft()
            if current_url in visited:
                continue
            visited.add(current_url)

            try:
                resp = client.get(current_url)
                if resp.status_code >= 400:
                    existing = db.query(IndexedDocument).filter(IndexedDocument.source_url == current_url).first()
                    if existing:
                        existing.http_status = resp.status_code
                        existing.is_broken = True
                        db.commit()
                    errors.append(f"{current_url} returned HTTP {resp.status_code}")
                    continue

                ctype = resp.headers.get("content-type", "").lower()
                if "text/html" not in ctype:
                    continue

                title, clean_text = extract_clean_article(resp.text, current_url)
                if len(clean_text.strip()) < 60:
                    continue

                doc, op_status = upsert_document(
                    db=db,
                    title=title,
                    source_url=current_url,
                    clean_text=clean_text,
                    source_type="web",
                    http_status=resp.status_code
                )
                if op_status == "unchanged":
                    unchanged_count += 1
                else:
                    indexed_count += 1

                crawled_pages.append({
                    "id": doc.id,
                    "title": doc.title,
                    "url": doc.source_url,
                    "category": doc.category,
                    "status": op_status
                })

                soup = BeautifulSoup(resp.text, "html.parser")
                for a in soup.find_all("a", href=True):
                    href = a["href"].split("#")[0].strip()
                    if not href or href.startswith(("mailto:", "javascript:", "tel:")):
                        continue
                    abs_url = urljoin(current_url, href)
                    p = urlparse(abs_url)
                    if p.scheme not in ("http", "https"):
                        continue
                    if any(p.path.lower().endswith(ext) for ext in BLOCKED_EXTENSIONS):
                        continue
                    if same_domain_only and p.netloc.lower() != seed_domain:
                        continue
                    if abs_url not in visited and abs_url not in queue:
                        queue.append(abs_url)
                        discovered += 1
            except Exception as exc:
                errors.append(f"{current_url}: {str(exc)[:120]}")

    job = CrawlJob(
        seed_url=seed_url,
        max_pages=max_pages,
        same_domain_only=same_domain_only,
        status="completed" if indexed_count > 0 or unchanged_count > 0 else "failed",
        pages_discovered=discovered,
        pages_indexed=indexed_count,
        pages_unchanged=unchanged_count,
        error_message="; ".join(errors[:3]) if errors else None
    )
    db.add(job)
    db.commit()
    db.refresh(job)

    return {
        "job_id": job.id,
        "seed_url": seed_url,
        "status": job.status,
        "pages_discovered": discovered,
        "pages_indexed": indexed_count,
        "pages_unchanged": unchanged_count,
        "crawled_pages": crawled_pages,
        "errors": errors[:5]
    }
