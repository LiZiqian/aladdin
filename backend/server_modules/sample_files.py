"""CT and point-cloud archives, separate from problem photographs."""
from __future__ import annotations

import re
import uuid
from contextlib import closing
from pathlib import Path
from urllib.parse import quote, unquote

KINDS = ("ct_model", "ct_video", "point_cloud")
MAX_FILE_BYTES = 75 * 1024 * 1024
POINT_CLOUD_EXTENSIONS = frozenset({".ply", ".pcd", ".xyz", ".pts", ".txt"})
VIDEO_TYPES = {".mp4": "video/mp4", ".webm": "video/webm", ".mov": "video/quicktime",
               ".m4v": "video/mp4", ".avi": "video/x-msvideo", ".mkv": "video/x-matroska"}


def file_type(name, category):
    ext = Path(str(name)).suffix.lower()
    if category == "pointcloud" and ext in POINT_CLOUD_EXTENSIONS:
        return "point_cloud", "application/octet-stream"
    if category == "ct":
        if ext == ".stl":
            return "ct_model", "application/octet-stream"
        if ext in VIDEO_TYPES:
            return "ct_video", VIDEO_TYPES[ext]
    raise ValueError("点云支持 .ply、.pcd、.xyz、.pts、.txt；CT 支持 .stl、.mp4、.webm、.mov、.m4v、.avi、.mkv")


def file_url(sample_id, asset_id):
    return f"/api/samples/{quote(sample_id, safe='')}/files/{quote(asset_id, safe='')}"


def route(path):
    parts = path.strip("/").split("/")
    if len(parts) in (4, 5) and parts[:2] == ["api", "samples"] and parts[3] == "files":
        return unquote(parts[2]), unquote(parts[4]) if len(parts) == 5 else None
    return None


def load_files(conn, sample_id):
    rows = conn.execute("SELECT * FROM sample_assets WHERE sample_id = ? AND kind IN (?, ?, ?) "
                        "AND deleted_at IS NULL ORDER BY created_at, id", (sample_id, *KINDS))
    return [{"id": row["id"], "kind": row["kind"], "name": row["original_name"],
             "type": row["mime_type"], "size": row["size"], "relativePath": row["relative_path"],
             "uploadedAt": row["created_at"], "url": file_url(sample_id, row["id"])} for row in rows]


def normalize_files(asset_ctx, conn, sample):
    from server_modules import sample_assets
    for meta in sample.get("files") or []:
        category = "pointcloud" if meta.get("kind") == "point_cloud" else "ct"
        kind, mime = file_type(meta.get("name"), category)
        if kind != meta.get("kind") or not meta.get("relativePath"):
            raise ValueError("样机文件类型或路径不正确")
        sample_assets.upsert_sample_asset_meta(asset_ctx, conn, sample["id"], {**meta, "type": mime}, kind)


def send_file(handler, target, meta, *, download=False):
    """Stream a single byte range so CT videos can seek without reading all bytes."""
    size = target.stat().st_size
    start, end, partial = 0, size - 1, False
    requested = handler.headers.get("Range", "")
    if requested:
        match = re.fullmatch(r"bytes=(\d*)-(\d*)", requested)
        valid = bool(match and any(match.groups()) and size)
        if valid:
            first, last = match.groups()
            if first:
                start = int(first)
                end = min(int(last), size - 1) if last else size - 1
            else:
                start = max(0, size - int(last))
            valid = start <= end and start < size
        if not valid:
            handler.send_response(416)
            handler.send_header("Content-Range", f"bytes */{size}")
            handler.send_header("Content-Length", "0")
            handler.end_headers()
            return
        partial = True
    category = "pointcloud" if meta["kind"] == "point_cloud" else "ct"
    _, mime = file_type(meta["original_name"], category)
    with target.open("rb") as stream:
        handler.send_response(206 if partial else 200)
        handler.send_header("Content-Type", mime)
        handler.send_header("X-Content-Type-Options", "nosniff")
        handler.send_header("Accept-Ranges", "bytes")
        handler.send_header("Cache-Control", "private, no-cache")
        handler.send_header("Content-Length", str(end - start + 1))
        if partial:
            handler.send_header("Content-Range", f"bytes {start}-{end}/{size}")
        disposition = "attachment" if download or meta["kind"] != "ct_video" else "inline"
        handler.send_header("Content-Disposition", f"{disposition}; filename*=UTF-8''{quote(meta['original_name'], safe='')}")
        handler.end_headers()
        stream.seek(start)
        remaining = end - start + 1
        while remaining:
            chunk = stream.read(min(1024 * 1024, remaining))
            if not chunk:
                break
            handler.wfile.write(chunk)
            remaining -= len(chunk)


def handle(handler, ctx, method, path, query=None):
    parsed = route(path)
    if not parsed:
        return False
    sample_id, file_id = parsed
    try:
        if method == "GET":
            with closing(ctx.connect_db()) as conn:
                if not conn.execute("SELECT 1 FROM sample_records WHERE id = ? AND deleted_at IS NULL", (sample_id,)).fetchone():
                    raise KeyError("样机不存在")
                if file_id is None:
                    handler._send_json({"ok": True, "files": load_files(conn, sample_id)})
                    return True
                meta = conn.execute("SELECT * FROM sample_assets WHERE sample_id = ? AND id = ? "
                                    "AND kind IN (?, ?, ?) AND deleted_at IS NULL", (sample_id, file_id, *KINDS)).fetchone()
            if not meta:
                raise KeyError("文件不存在")
            target = ctx.path_inside_data(meta["relative_path"])
            if not target.is_file():
                raise KeyError("文件不存在")
            send_file(handler, target, meta, download=(query or {}).get("download") == ["1"])
        elif method == "POST" and file_id is None:
            fields, uploads = ctx.parse_multipart(handler.headers, handler._read_body())
            uploads = [item for item in uploads if item["field"] == "files"]
            if not uploads:
                raise ValueError("请选择文件")
            checked = [(item, *file_type(item["filename"], fields.get("category"))) for item in uploads]
            if any(not item["content"] for item, _, _ in checked):
                raise ValueError("不能上传空文件")
            if any(len(item["content"]) > MAX_FILE_BYTES for item, _, _ in checked):
                raise ValueError("每个文件不能超过 75 MB")
            with ctx.write_db_connection() as conn:
                if not conn.execute("SELECT 1 FROM sample_records WHERE id = ? AND deleted_at IS NULL", (sample_id,)).fetchone():
                    raise KeyError("样机不存在")
                for item, kind, mime in checked:
                    meta = ctx.write_sample_asset_file(sample_id, f"file_{uuid.uuid4().hex}", item["content"],
                                                       item["filename"], mime, file_prefix="file")
                    ctx.upsert_sample_asset_meta(conn, sample_id, meta, kind, uploaded_by=handler.client_address[0])
                files = load_files(conn, sample_id)
                result = ctx.commit_sample_asset_mutation(conn, sample_id, "upload_sample_files", "添加样机 CT / 点云文件", handler.client_address[0])
            handler._send_json({"ok": True, **result, "files": files})
        elif method == "DELETE" and file_id:
            with ctx.write_db_connection() as conn:
                meta = conn.execute("SELECT relative_path FROM sample_assets WHERE sample_id = ? AND id = ? "
                                    "AND kind IN (?, ?, ?) AND deleted_at IS NULL", (sample_id, file_id, *KINDS)).fetchone()
                if not meta:
                    raise KeyError("文件不存在")
                conn.execute("UPDATE sample_assets SET deleted_at = ? WHERE id = ?", (ctx.now_iso(), file_id))
                ctx.unlink_asset_relative_paths([meta["relative_path"]], warn_label="删除样机文件")
                files = load_files(conn, sample_id)
                result = ctx.commit_sample_asset_mutation(conn, sample_id, "delete_sample_file", "删除样机 CT / 点云文件", handler.client_address[0])
            handler._send_json({"ok": True, **result, "files": files})
        else:
            handler._send_json({"ok": False, "error": "Not Found"}, 404)
    except (BrokenPipeError, ConnectionResetError):
        pass  # Browsers cancel a video range request when seeking.
    except (KeyError, ValueError) as error:
        handler._send_json({"ok": False, "error": str(error)}, 404 if isinstance(error, KeyError) else 400)
    except Exception as error:
        handler._send_json({"ok": False, "error": str(error)}, 500)
    return True
