from datetime import datetime, timezone
from sqlalchemy import Column, Integer, String, Text, Boolean, DateTime
from app.core.database import Base

class IndexedDocument(Base):
    __tablename__ = "indexed_documents"

    id = Column(Integer, primary_key=True, index=True)
    title = Column(String(512), nullable=False)
    source_url = Column(String(1024), unique=True, index=True, nullable=False)
    source_type = Column(String(50), nullable=False, default="web")  # web, pdf, bookmark
    category = Column(String(100), nullable=False, default="Articles")  # Tutorials & Guides, Code & Docs, PDFs & Notes, Articles
    clean_text = Column(Text, nullable=False)
    word_count = Column(Integer, default=0)
    reading_time_min = Column(Integer, default=1)
    content_hash = Column(String(64), index=True)
    http_status = Column(Integer, default=200)
    is_broken = Column(Boolean, default=False)
    is_cached = Column(Boolean, default=True)
    last_checked_at = Column(DateTime, default=lambda: datetime.now(timezone.utc))
    created_at = Column(DateTime, default=lambda: datetime.now(timezone.utc))

class CrawlJob(Base):
    __tablename__ = "crawl_jobs"

    id = Column(Integer, primary_key=True, index=True)
    seed_url = Column(String(1024), nullable=False)
    max_pages = Column(Integer, default=10)
    same_domain_only = Column(Boolean, default=True)
    status = Column(String(50), default="completed")
    pages_discovered = Column(Integer, default=0)
    pages_indexed = Column(Integer, default=0)
    pages_unchanged = Column(Integer, default=0)
    error_message = Column(Text, nullable=True)
    created_at = Column(DateTime, default=lambda: datetime.now(timezone.utc))
