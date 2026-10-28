from __future__ import annotations

import mimetypes
import os
import re
import sqlite3
import sys
import uuid
from contextlib import contextmanager
from contextvars import ContextVar
from dataclasses import dataclass
from pathlib import Path
from typing import Callable
from urllib.parse import quote


@dataclass(frozen=True)
class AssetStorageContext:
    data_dir: Path
    sample_data_dir: Path
    now_iso: Callable[[], str]


# File effects belong to the current explicit SQLite write scope. A token reset
# prevents a failed request from leaving a journal attached to the worker thread.
_FILE_TRANSACTION: ContextVar[dict | None] = next((
    module._FILE_TRANSACTION for name in ("server_modules.sample_assets", "backend.server_modules.sample_assets")
    if (module := sys.modules.get(name)) is not None and hasattr(module, "_FILE_TRANSACTION")
), ContextVar("sample_asset_files", default=None))


def has_asset_file_transaction(conn: sqlite3.Connection) -> bool:
    active = _FILE_TRANSACTION.get()
    return active is not None and active["conn"] is conn


@contextmanager
def asset_file_transaction(conn: sqlite3.Connection, *, owns_transaction: bool = True):
    active = _FILE_TRANSACTION.get()
    if active is not None and active["conn"] is conn:
        yield
        return
    journal = {"conn": conn, "created": {}, "removed": {}, "owns_transaction": owns_transaction}
    token = _FILE_TRANSACTION.set(journal)
    try:
        yield
    finally:
        _FILE_TRANSACTION.reset(token)
        # The caller must settle SQLite first. Never delete while an enclosing
        # transaction can still roll back, or after an unknown connection error.
        if journal["created"] or journal["removed"]:
            try:
                if not conn.in_transaction:
                    # Serialize the reference check with other writers so a
                    # revived asset cannot acquire its path just before unlink.
                    with conn:
                        conn.execute("BEGIN IMMEDIATE")
                        for ctx, relative_path in {**journal["created"], **journal["removed"]}.values():
                            target = path_inside_data(ctx, relative_path)
                            # Legacy rows may contain ./, ../ or backslashes.
                            # The filename index limits canonical path checks to
                            # candidate aliases instead of scanning every asset.
                            candidates = conn.execute(
                                "SELECT relative_path FROM sample_assets WHERE deleted_at IS NULL AND "
                                "(relative_path = ? COLLATE NOCASE OR file_name = ? COLLATE NOCASE)",
                                (relative_path, target.name),
                            ).fetchall()
                            referenced = any(
                                str(path_inside_data(ctx, str(row["relative_path"]))).casefold() == str(target).casefold()
                                for row in candidates
                            )
                            if not referenced:
                                _unlink_asset_relative_paths(ctx, [relative_path])
            except Exception as exc:
                print(f"[WARN] 清理事务照片文件失败：{exc}")


def _journal_file(ctx: AssetStorageContext, relative_path: str, operation: str) -> bool:
    journal = _FILE_TRANSACTION.get()
    if journal is None:
        return False
    _require_file_transaction_owner(allow_settled_delete=operation == "removed")
    target = path_inside_data(ctx, relative_path)
    journal[operation][str(target).casefold()] = (ctx, relative_path)
    return True


def _require_file_transaction_owner(*, allow_settled_delete: bool = False) -> None:
    journal = _FILE_TRANSACTION.get()
    if journal is not None and not journal["owns_transaction"] and (not allow_settled_delete or journal["conn"].in_transaction):
        raise RuntimeError("文件写入或删除需要由外层 asset_file_transaction 管理数据库提交")


def safe_segment(value: object, fallback: str = "item") -> str:
    text = str(value or "").strip()
    text = re.sub(r"[^A-Za-z0-9_.-]+", "_", text)
    text = text.strip("._-")
    return (text or fallback)[:96]


def url_for_asset(sample_id: str, asset_id: str) -> str:
    return f"/api/samples/{quote(str(sample_id), safe='')}/photos/{quote(str(asset_id), safe='')}"


def thumbnail_asset_id(photo_id: str) -> str:
    return f"{photo_id}__thumb"


def file_ext(original_name: str, mime_type: str) -> str:
    suffix = Path(original_name or "").suffix.lower()
    if suffix and re.fullmatch(r"\.[a-z0-9]{1,8}", suffix):
        return suffix
    guessed = mimetypes.guess_extension(mime_type or "") or ".bin"
    if guessed == ".jpe":
        guessed = ".jpg"
    return guessed


def path_inside_data(ctx: AssetStorageContext, relative_path: str) -> Path:
    data_dir = ctx.data_dir.resolve()
    target = (ctx.data_dir / relative_path).resolve()
    if data_dir not in target.parents and target != data_dir:
        raise ValueError("非法文件路径")
    return target


def normalize_photo_meta(ctx: AssetStorageContext, sample_id: str, photo: dict) -> dict:
    photo_id = str(photo.get("id") or f"photo_{uuid.uuid4().hex}")
    thumb_id = str(photo.get("thumbId") or "")
    name = str(photo.get("name") or photo.get("originalName") or "外观照片")
    mime_type = str(photo.get("type") or photo.get("mimeType") or mimetypes.guess_type(name)[0] or "application/octet-stream")
    relative_path = str(photo.get("relativePath") or "")
    size = int(photo.get("size") or 0)
    uploaded_at = str(photo.get("uploadedAt") or photo.get("createdAt") or ctx.now_iso())
    meta = {
        "id": photo_id,
        "name": name,
        "type": mime_type,
        "size": size,
        "url": str(photo.get("url") or url_for_asset(sample_id, photo_id)),
        "relativePath": relative_path,
        "uploadedAt": uploaded_at,
    }
    thumb_url = str(photo.get("thumbUrl") or "")
    thumb_relative_path = str(photo.get("thumbRelativePath") or "")
    if thumb_id or thumb_url or thumb_relative_path:
        thumb_id = thumb_id or thumbnail_asset_id(photo_id)
        meta.update({
            "thumbId": thumb_id,
            "thumbUrl": thumb_url or url_for_asset(sample_id, thumb_id),
            "thumbRelativePath": thumb_relative_path,
        })
    return meta


def attach_thumbnail_meta(photo_meta: dict, thumb_meta: dict | None) -> dict:
    if not thumb_meta:
        return photo_meta
    photo_meta["thumbId"] = thumb_meta["id"]
    photo_meta["thumbUrl"] = thumb_meta["url"]
    photo_meta["thumbRelativePath"] = thumb_meta.get("relativePath", "")
    photo_meta["thumbType"] = thumb_meta.get("type", "")
    photo_meta["thumbSize"] = thumb_meta.get("size", 0)
    return photo_meta


def write_sample_asset_file(
    ctx: AssetStorageContext,
    sample_id: str,
    asset_id: str,
    content: bytes | Path,
    original_name: str,
    mime_type: str,
    *,
    uploaded_at: str | None = None,
    file_prefix: str = "photo",
) -> dict:
    """Write bytes or atomically publish a staged attachment on the data volume."""
    _require_file_transaction_owner()
    size = content.stat().st_size if isinstance(content, Path) else len(content)
    ext = file_ext(original_name, mime_type)
    file_name = f"{safe_segment(asset_id, file_prefix)}{ext}"
    target_dir = ctx.sample_data_dir / safe_segment(sample_id, "sample") / ("files" if file_prefix == "file" else "photos")
    target_dir.mkdir(parents=True, exist_ok=True)
    target = target_dir / file_name
    while True:
        try:
            with target.open("xb") as stream:
                try:
                    if isinstance(content, Path):
                        # Reserve the destination without overwriting any existing
                        # asset, then move the validated upload on the same volume.
                        stream.close()
                        os.replace(content, target)
                    else:
                        stream.write(content)
                except BaseException:
                    stream.close()
                    target.unlink(missing_ok=True)
                    raise
            break
        except FileExistsError:
            target = target_dir / f"{safe_segment(asset_id, file_prefix)}_{uuid.uuid4().hex}{ext}"
    relative_path = target.relative_to(ctx.data_dir).as_posix()
    _journal_file(ctx, relative_path, "created")
    created_at = uploaded_at or ctx.now_iso()
    return {
        "id": asset_id,
        "name": original_name or file_name,
        "type": mime_type or mimetypes.guess_type(file_name)[0] or "application/octet-stream",
        "size": size,
        "url": url_for_asset(sample_id, asset_id),
        "relativePath": relative_path,
        "uploadedAt": created_at,
    }


def upsert_sample_asset_meta(
    ctx: AssetStorageContext,
    conn: sqlite3.Connection,
    sample_id: str,
    meta: dict,
    kind: str,
    *,
    uploaded_by: str = "",
) -> None:
    asset_id = str(meta.get("id") or "")
    relative_path = str(meta.get("relativePath") or "")
    validate_asset_reference(ctx, conn, sample_id, asset_id, kind, relative_path)
    file_name = Path(relative_path).name if relative_path else safe_segment(asset_id, "asset")
    conn.execute(
        """
        INSERT INTO sample_assets
        (id, sample_id, kind, original_name, file_name, relative_path, mime_type, size, created_at, created_by, deleted_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)
        ON CONFLICT(id) DO UPDATE SET
            sample_id = excluded.sample_id,
            kind = excluded.kind,
            original_name = excluded.original_name,
            file_name = excluded.file_name,
            relative_path = excluded.relative_path,
            mime_type = excluded.mime_type,
            size = excluded.size,
            created_at = excluded.created_at,
            created_by = excluded.created_by,
            deleted_at = NULL
        """,
        (
            asset_id,
            sample_id,
            kind,
            str(meta.get("name") or file_name),
            file_name,
            relative_path,
            str(meta.get("type") or mimetypes.guess_type(file_name)[0] or "application/octet-stream"),
            int(meta.get("size") or 0),
            str(meta.get("uploadedAt") or ctx.now_iso()),
            uploaded_by,
        ),
    )


def validate_asset_reference(ctx, conn, sample_id, asset_id, kind, relative_path=""):
    if not asset_id or not sample_id:
        raise ValueError("照片编号和样机编号不能为空")
    existing = conn.execute("SELECT * FROM sample_assets WHERE id = ?", (asset_id,)).fetchone()
    if existing and (str(existing["sample_id"]) != str(sample_id) or existing["kind"] != kind):
        raise ValueError("照片编号已被其他样机或资产类型使用，不能修改归属")
    if relative_path:
        target = path_inside_data(ctx, relative_path)
        if ctx.sample_data_dir.resolve() not in target.parents:
            raise ValueError("照片路径必须位于样机资产目录")
        canonical = target.relative_to(ctx.data_dir.resolve()).as_posix()
        if relative_path != canonical:
            raise ValueError("照片路径必须使用规范的相对路径")
        claimed = conn.execute(
            "SELECT id FROM sample_assets WHERE relative_path = ? COLLATE NOCASE AND id <> ? LIMIT 1",
            (relative_path, asset_id),
        ).fetchone()
        if claimed:
            raise ValueError("照片路径已被其他资产使用")
        if existing and existing["relative_path"] and str(existing["relative_path"]).casefold() != relative_path.casefold():
            raise ValueError("已有照片编号不能改用其他文件路径")
    return existing


def store_asset_bytes(
    ctx: AssetStorageContext,
    conn: sqlite3.Connection,
    sample_id: str,
    content: bytes,
    original_name: str,
    mime_type: str,
    *,
    photo_id: str | None = None,
    uploaded_at: str | None = None,
    uploaded_by: str = "",
) -> dict:
    asset_id = photo_id or f"photo_{uuid.uuid4().hex}"
    existing = validate_asset_reference(ctx, conn, sample_id, asset_id, "photo")
    if existing:
        return normalize_photo_meta(ctx, sample_id, {
            "id": asset_id, "name": existing["original_name"], "type": existing["mime_type"],
            "size": existing["size"], "relativePath": existing["relative_path"], "uploadedAt": existing["created_at"],
        })
    meta = write_sample_asset_file(
        ctx,
        sample_id,
        asset_id,
        content,
        original_name,
        mime_type,
        uploaded_at=uploaded_at,
        file_prefix="photo",
    )
    try:
        upsert_sample_asset_meta(ctx, conn, sample_id, meta, "photo", uploaded_by=uploaded_by)
    except Exception:
        _unlink_asset_relative_paths(ctx, [meta["relativePath"]])
        raise
    return meta


def store_thumbnail_bytes(
    ctx: AssetStorageContext,
    conn: sqlite3.Connection,
    sample_id: str,
    photo_id: str,
    content: bytes,
    original_name: str,
    mime_type: str,
    *,
    uploaded_at: str | None = None,
    uploaded_by: str = "",
) -> dict:
    asset_id = thumbnail_asset_id(photo_id)
    existing = validate_asset_reference(ctx, conn, sample_id, asset_id, "photo_thumb")
    if existing:
        return normalize_photo_meta(ctx, sample_id, {
            "id": asset_id, "name": existing["original_name"], "type": existing["mime_type"],
            "size": existing["size"], "relativePath": existing["relative_path"], "uploadedAt": existing["created_at"],
        })
    meta = write_sample_asset_file(
        ctx,
        sample_id,
        asset_id,
        content,
        original_name,
        mime_type,
        uploaded_at=uploaded_at,
        file_prefix="thumb",
    )
    try:
        upsert_sample_asset_meta(ctx, conn, sample_id, meta, "photo_thumb", uploaded_by=uploaded_by)
    except Exception:
        _unlink_asset_relative_paths(ctx, [meta["relativePath"]])
        raise
    return meta


def upsert_existing_photo_asset(ctx: AssetStorageContext, conn: sqlite3.Connection, sample_id: str, photo: dict) -> dict:
    meta = normalize_photo_meta(ctx, sample_id, photo)
    relative_path = meta.get("relativePath") or ""
    existing = validate_asset_reference(ctx, conn, sample_id, meta["id"], "photo", relative_path)
    if not relative_path:
        raise ValueError("照片缺少 relativePath；请使用当前资产元数据。")
    file_name = Path(relative_path).name if relative_path else safe_segment(meta["id"], "photo")
    conn.execute(
        """
        INSERT INTO sample_assets
        (id, sample_id, kind, original_name, file_name, relative_path, mime_type, size, created_at, created_by, deleted_at)
        VALUES (?, ?, 'photo', ?, ?, ?, ?, ?, ?, '', NULL)
        ON CONFLICT(id) DO UPDATE SET
            sample_id = excluded.sample_id,
            kind = excluded.kind,
            original_name = excluded.original_name,
            file_name = excluded.file_name,
            relative_path = excluded.relative_path,
            mime_type = excluded.mime_type,
            size = excluded.size,
            created_at = excluded.created_at,
            deleted_at = NULL
        """,
        (
            meta["id"],
            sample_id,
            meta["name"],
            file_name,
            relative_path,
            meta["type"],
            meta["size"],
            meta["uploadedAt"],
        ),
    )
    thumb_relative_path = meta.get("thumbRelativePath") or ""
    if thumb_relative_path:
        thumb_id = meta.get("thumbId") or thumbnail_asset_id(meta["id"])
        validate_asset_reference(ctx, conn, sample_id, thumb_id, "photo_thumb", thumb_relative_path)
        thumb_file_name = Path(thumb_relative_path).name
        conn.execute(
            """
            INSERT INTO sample_assets
            (id, sample_id, kind, original_name, file_name, relative_path, mime_type, size, created_at, created_by, deleted_at)
            VALUES (?, ?, 'photo_thumb', ?, ?, ?, ?, ?, ?, '', NULL)
            ON CONFLICT(id) DO UPDATE SET
                sample_id = excluded.sample_id,
                kind = excluded.kind,
                original_name = excluded.original_name,
                file_name = excluded.file_name,
                relative_path = excluded.relative_path,
                mime_type = excluded.mime_type,
                size = excluded.size,
                created_at = excluded.created_at,
                deleted_at = NULL
            """,
            (
                thumb_id,
                sample_id,
                str(photo.get("thumbName") or f"{meta['name']} 缩略图"),
                thumb_file_name,
                thumb_relative_path,
                str(photo.get("thumbType") or "image/jpeg"),
                int(photo.get("thumbSize") or 0),
                meta["uploadedAt"],
            ),
        )
    return meta


def normalize_sample_photos(ctx: AssetStorageContext, conn: sqlite3.Connection, sample: dict) -> list[dict]:
    sample_id = str(sample.get("id") or f"sample_{uuid.uuid4().hex}")
    sample["id"] = sample_id
    normalized: list[dict] = []
    for raw_photo in sample.get("photos", []) or []:
        if not isinstance(raw_photo, dict):
            continue
        if "dataUrl" in raw_photo:
            raise ValueError("不支持内嵌照片；请使用照片上传接口或 V2 资产索引。")
        if raw_photo.get("url") or raw_photo.get("relativePath"):
            normalized.append(upsert_existing_photo_asset(ctx, conn, sample_id, raw_photo))
    return normalized


def remove_empty_dirs_up_to(path: Path, stop_dir: Path) -> None:
    stop_dir = stop_dir.resolve()
    cur = path.resolve()
    while cur != stop_dir and stop_dir in cur.parents:
        try:
            cur.rmdir()
        except OSError:
            break
        cur = cur.parent


def unlink_asset_relative_paths(ctx: AssetStorageContext, relative_paths: list[str], *, warn_label: str = "删除资产文件") -> None:
    immediate = [path for path in relative_paths if path and not _journal_file(ctx, path, "removed")]
    _unlink_asset_relative_paths(ctx, immediate, warn_label=warn_label)


def _unlink_asset_relative_paths(ctx: AssetStorageContext, relative_paths: list[str], *, warn_label: str = "删除资产文件") -> None:
    for relative_path in relative_paths:
        try:
            target = path_inside_data(ctx, relative_path)
            if ctx.sample_data_dir.resolve() not in target.parents:
                raise ValueError("照片路径必须位于样机资产目录")
            if target.is_file():
                target.unlink()
                remove_empty_dirs_up_to(target.parent, ctx.sample_data_dir)
        except Exception as e:
            print(f"[WARN] {warn_label}失败：{e}")


def sample_asset_relative_paths(conn: sqlite3.Connection, sample_ids: list[str]) -> list[str]:
    if not sample_ids:
        return []
    placeholders = ",".join("?" for _ in sample_ids)
    rows = conn.execute(
        f"SELECT relative_path FROM sample_assets WHERE sample_id IN ({placeholders})",
        sample_ids,
    ).fetchall()
    return [str(row["relative_path"] or "") for row in rows if row["relative_path"]]


def cleanup_sample_asset_files(ctx: AssetStorageContext, conn: sqlite3.Connection, sample_ids: list[str]) -> None:
    unlink_asset_relative_paths(ctx, sample_asset_relative_paths(conn, sample_ids), warn_label="删除样机资产文件")
