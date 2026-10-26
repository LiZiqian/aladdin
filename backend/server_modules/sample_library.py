from __future__ import annotations

from server_modules import sample_files, problem_records

import copy
import json
import sqlite3
import uuid
from dataclasses import dataclass
from typing import Callable

from server_modules import sample_assets, sample_queries, status_normalization


@dataclass(frozen=True)
class SampleLibraryContext:
    asset_context: sample_assets.AssetStorageContext
    now_iso: Callable[[], str]
    json_dumps: Callable[[object], str]
    json_obj: Callable


def sync_sample_library(ctx: SampleLibraryContext, conn: sqlite3.Connection, data: dict, *, allow_empty: bool = False) -> bool:
    library = data.get("sampleLibrary") or {}
    categories = library.get("categories") or []
    if library.get("externalized") and not categories and not allow_empty:
        return False

    ts = ctx.now_iso()
    active_category_ids: list[str] = []
    active_sample_ids: list[str] = []
    logs = list(library.get("logs") or [])

    for sort_order, category in enumerate(categories):
        if not isinstance(category, dict):
            continue
        category = status_normalization.normalize_sample_category_payload(category)
        cat_id = str(category.get("id") or f"cat_{uuid.uuid4().hex}")
        category["id"] = cat_id
        active_category_ids.append(cat_id)
        cat_json = copy.deepcopy(category)
        cat_json.pop("samples", None)
        conn.execute(
            """
            INSERT INTO sample_categories
            (id, name, description, sort_order, data_json, created_at, updated_at, deleted_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, NULL)
            ON CONFLICT(id) DO UPDATE SET
                name = excluded.name,
                description = excluded.description,
                sort_order = excluded.sort_order,
                data_json = excluded.data_json,
                updated_at = excluded.updated_at,
                deleted_at = NULL
            """,
            (
                cat_id,
                str(category.get("name") or "未命名样机池"),
                str(category.get("description") or ""),
                sort_order,
                ctx.json_dumps(cat_json),
                str(category.get("createdAt") or ts),
                str(category.get("updatedAt") or ts),
            ),
        )

        for sample in category.get("samples", []) or []:
            if not isinstance(sample, dict):
                continue
            sample = status_normalization.normalize_sample_payload(sample)
            sample_id = str(sample.get("id") or f"sample_{uuid.uuid4().hex}")
            sample["id"] = sample_id
            sample["categoryId"] = cat_id
            if sample.get("problemRecords"):
                previous = conn.execute("SELECT data_json FROM sample_records WHERE id=?", (sample_id,)).fetchone()
                if previous:
                    problem_records.preserve_created_at(sample["problemRecords"], ctx.json_obj(previous["data_json"], {}).get("problemRecords"))
            sample["photos"] = sample_assets.normalize_sample_photos(ctx.asset_context, conn, sample)
            sample_files.normalize_files(ctx.asset_context, conn, sample)
            active_sample_ids.append(sample_id)
            sample_json = copy.deepcopy(sample)
            sample_json.pop("photos", None)
            sample_json.pop("files", None)
            sample_json.pop("logs", None)
            sample_json.pop("testedItemNames", None)
            sample_json.pop("testHistoryCount", None)
            conn.execute(
                """
                INSERT INTO sample_records
                (id, category_id, sample_no, sn, imei, board_sn, is_reassembled, status, has_problem, effective_status, location, owner, borrower, data_json, created_at, updated_at, deleted_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)
                ON CONFLICT(id) DO UPDATE SET
                    category_id = excluded.category_id,
                    sample_no = excluded.sample_no,
                    sn = excluded.sn,
                    imei = excluded.imei,
                    board_sn = excluded.board_sn,
                    is_reassembled = excluded.is_reassembled,
                    status = excluded.status,
                    has_problem = excluded.has_problem,
                    effective_status = excluded.effective_status,
                    location = excluded.location,
                    owner = excluded.owner,
                    borrower = excluded.borrower,
                    data_json = excluded.data_json,
                    updated_at = excluded.updated_at,
                    deleted_at = NULL
                """,
                (
                    sample_id,
                    cat_id,
                    str(sample.get("sampleNo") or ""),
                    str(sample.get("sn") or ""),
                    str(sample.get("imei") or ""),
                    str(sample.get("boardSn") or ""),
                    1 if sample_queries.sample_is_reassembled(sample) else 0,
                    sample_queries.sample_effective_status(sample),
                    1 if sample_queries.sample_has_problem(sample) else 0,
                    sample_queries.sample_effective_status(sample),
                    str(sample.get("location") or ""),
                    str(sample.get("owner") or ""),
                    str(sample.get("borrower") or ""),
                    ctx.json_dumps(sample_json),
                    str(sample.get("createdAt") or ts),
                    str(sample.get("updatedAt") or ts),
                ),
            )
    if active_sample_ids:
        placeholders = ",".join("?" for _ in active_sample_ids)
        removed_rows = conn.execute(
            f"""
            SELECT id FROM sample_records WHERE id NOT IN ({placeholders})
            UNION
            SELECT sample_id AS id FROM sample_assets WHERE sample_id NOT IN ({placeholders})
            """,
            [*active_sample_ids, *active_sample_ids],
        ).fetchall()
        removed_sample_ids = [str(row["id"]) for row in removed_rows if row["id"]]
        sample_assets.cleanup_sample_asset_files(ctx.asset_context, conn, removed_sample_ids)
        conn.execute(f"DELETE FROM sample_assets WHERE sample_id NOT IN ({placeholders})", active_sample_ids)
        conn.execute(f"DELETE FROM sample_events WHERE sample_id NOT IN ({placeholders})", active_sample_ids)
        conn.execute(f"DELETE FROM sample_records WHERE id NOT IN ({placeholders})", active_sample_ids)
    else:
        removed_rows = conn.execute(
            """
            SELECT id FROM sample_records
            UNION
            SELECT sample_id AS id FROM sample_assets
            """
        ).fetchall()
        removed_sample_ids = [str(row["id"]) for row in removed_rows if row["id"]]
        sample_assets.cleanup_sample_asset_files(ctx.asset_context, conn, removed_sample_ids)
        conn.execute("DELETE FROM sample_assets")
        conn.execute("DELETE FROM sample_events")
        conn.execute("DELETE FROM sample_records")

    if active_category_ids:
        placeholders = ",".join("?" for _ in active_category_ids)
        conn.execute(f"DELETE FROM sample_categories WHERE id NOT IN ({placeholders})", active_category_ids)
    else:
        conn.execute("DELETE FROM sample_categories")

    preserve_existing_events = bool(library.get("eventsExternalized"))
    if not preserve_existing_events:
        conn.execute("DELETE FROM sample_events")
    seen_events = set()
    for log in logs:
        if not isinstance(log, dict):
            continue
        log = log
        event_id = str(log.get("id") or f"event_{uuid.uuid4().hex}")
        if event_id in seen_events:
            continue
        seen_events.add(event_id)
        conn.execute(
            """
            INSERT OR REPLACE INTO sample_events
            (id, sample_id, time, event_type, project_id, stage_id, task_id, test_item, user, data_json)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                event_id,
                str(log.get("sampleId") or ""),
                str(log.get("time") or ""),
                str(log.get("source") or log.get("eventType") or "sample_log"),
                str(log.get("projectId") or ""),
                str(log.get("stageId") or ""),
                str(log.get("taskId") or ""),
                str(log.get("testItem") or ""),
                str(log.get("user") or ""),
                ctx.json_dumps(log),
            ),
        )

    return True


def load_sample_photos(conn: sqlite3.Connection, sample_id: str) -> list[dict]:
    rows = conn.execute(
        """
        SELECT id, original_name, file_name, mime_type, size, relative_path, created_at
        FROM sample_assets
        WHERE sample_id = ? AND kind = 'photo' AND deleted_at IS NULL
        ORDER BY created_at, id
        """,
        (sample_id,),
    ).fetchall()
    photos: list[dict] = []
    for row in rows:
        meta = {
            "id": row["id"],
            "name": row["original_name"] or row["file_name"] or "外观照片",
            "type": row["mime_type"] or "application/octet-stream",
            "size": int(row["size"] or 0),
            "url": sample_assets.url_for_asset(sample_id, row["id"]),
            "relativePath": row["relative_path"],
            "uploadedAt": row["created_at"],
        }
        thumb_id = sample_assets.thumbnail_asset_id(row["id"])
        thumb = conn.execute(
            """
            SELECT id, mime_type, size, relative_path
            FROM sample_assets
            WHERE sample_id = ? AND id = ? AND kind = 'photo_thumb' AND deleted_at IS NULL
            """,
            (sample_id, thumb_id),
        ).fetchone()
        if thumb:
            meta.update({
                "thumbId": thumb["id"],
                "thumbUrl": sample_assets.url_for_asset(sample_id, thumb["id"]),
                "thumbRelativePath": thumb["relative_path"],
                "thumbType": thumb["mime_type"] or "image/jpeg",
                "thumbSize": int(thumb["size"] or 0),
            })
        photos.append(meta)
    return photos


def load_sample_photo_counts(conn: sqlite3.Connection) -> dict[str, int]:
    rows = conn.execute(
        """
        SELECT sample_id, COUNT(*) AS count
        FROM sample_assets
        WHERE kind = 'photo' AND deleted_at IS NULL
        GROUP BY sample_id
        """
    ).fetchall()
    return {str(row["sample_id"]): int(row["count"] or 0) for row in rows}


def load_sample_events(ctx: SampleLibraryContext, conn: sqlite3.Connection, sample_id: str) -> list[dict]:
    rows = conn.execute(
        """
        SELECT data_json
        FROM sample_events
        WHERE sample_id = ?
        ORDER BY julianday(time), id
        """,
        (sample_id,),
    ).fetchall()
    logs = []
    for row in rows:
        log = ctx.json_obj(row["data_json"], None)
        if isinstance(log, dict):
            logs.append(log)
    return logs


def load_sample_library(ctx: SampleLibraryContext, conn: sqlite3.Connection, *, include_photos: bool = True, include_logs: bool = True) -> dict:
    category_rows = conn.execute(
        """
        SELECT id, name, description, data_json
        FROM sample_categories
        WHERE deleted_at IS NULL
        ORDER BY sort_order, id
        """
    ).fetchall()
    categories: list[dict] = []
    category_map: dict[str, dict] = {}
    for row in category_rows:
        try:
            cat = json.loads(row["data_json"] or "{}")
        except Exception:
            cat = {}
        cat.update({
            "id": row["id"],
            "name": row["name"],
            "description": row["description"] or "",
            "samples": [],
        })
        categories.append(cat)
        category_map[row["id"]] = cat

    sample_rows = conn.execute(
        """
        SELECT id, category_id, sample_no, sn, imei, board_sn, is_reassembled, status, location, owner, borrower, data_json
        FROM sample_records
        WHERE deleted_at IS NULL
        ORDER BY created_at, id
        """
    ).fetchall()
    photo_counts = load_sample_photo_counts(conn) if not include_photos else {}
    for row in sample_rows:
        try:
            sample = json.loads(row["data_json"] or "{}")
        except Exception:
            sample = {}
        sample.update({
            "id": row["id"],
            "categoryId": row["category_id"],
            "sampleNo": row["sample_no"] or sample.get("sampleNo") or "",
            "sn": row["sn"] or sample.get("sn") or "",
            "imei": row["imei"] or sample.get("imei") or "",
            "boardSn": row["board_sn"] or sample.get("boardSn") or "",
            "isReassembled": bool(row["is_reassembled"]) if row["is_reassembled"] is not None else sample_queries.sample_is_reassembled(sample),
            "status": row["status"] or sample.get("status") or "",
            "location": row["location"] or sample.get("location") or "",
            "owner": row["owner"] or sample.get("owner") or "",
            "borrower": row["borrower"] or sample.get("borrower") or "",
        })
        if include_photos:
            sample["files"] = sample_files.load_files(conn, row["id"])
            sample["photos"] = load_sample_photos(conn, row["id"])
            sample["photoCount"] = len(sample["photos"])
            sample["photosLoaded"] = True
        else:
            sample["photos"] = []
            sample["photoCount"] = photo_counts.get(str(row["id"]), 0)
            sample["photosLoaded"] = False
        category_map.get(row["category_id"], {}).setdefault("samples", []).append(sample)

    logs = []
    if include_logs:
        event_rows = conn.execute("SELECT data_json FROM sample_events ORDER BY julianday(time), id").fetchall()
        for row in event_rows:
            log = ctx.json_obj(row["data_json"], None)
            if isinstance(log, dict):
                logs.append(log)
    return {
        "categories": categories,
        "logs": logs,
        "photosExternalized": not include_photos,
        "eventsExternalized": not include_logs,
    }
