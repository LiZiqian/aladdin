from __future__ import annotations

import json
import sqlite3
import copy
from datetime import datetime, timezone

from server_modules import sample_assets, status_normalization, task_queries, problem_photos


def json_obj(text: str | None, fallback: object | None = None):
    try:
        return json.loads(text or "")
    except Exception:
        return fallback


def history_sort_time(value: str) -> datetime:
    """Compare instants across ISO offsets; undated history remains oldest."""
    try:
        parsed = datetime.fromisoformat(str(value or "").replace("Z", "+00:00"))
        # Match SQLite julianday: date-only and zone-free values are UTC.
        return (parsed if parsed.tzinfo else parsed.replace(tzinfo=timezone.utc)).astimezone(timezone.utc)
    except (ValueError, OverflowError):
        return datetime.min.replace(tzinfo=timezone.utc)


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


def sample_task_result_photos(task: dict, sample_id: str, photos_by_id: dict[str, dict]) -> list[dict]:
    photos: list[dict] = []
    for upload in task.get("resultUploads") or []:
        if not isinstance(upload, dict):
            continue
        for item in upload.get("samples") or []:
            if not isinstance(item, dict) or str(item.get("sampleId") or item.get("sid") or "") != str(sample_id):
                continue
            refs = list(item.get("photos") or [])
            existing_ids = {ref.get("id") for ref in refs if isinstance(ref, dict)}
            refs.extend({"id": pid} for pid in sorted(problem_photos.problem_photo_ids(item.get("problemRecords"))) if pid not in existing_ids)
            for ref in refs:
                if not isinstance(ref, dict) or not ref.get("id"):
                    continue
                full = photos_by_id.get(str(ref.get("id") or ""), {})
                photos.append({
                    "id": str(ref.get("id") or ""),
                    "name": str(ref.get("name") or full.get("name") or "结果图片"),
                    "url": str(ref.get("url") or full.get("url") or ""),
                    "thumbUrl": str(ref.get("thumbUrl") or full.get("thumbUrl") or ""),
                    "uploadedAt": str(ref.get("uploadedAt") or full.get("uploadedAt") or upload.get("time") or ""),
                    "result": status_normalization.normalize_task_result_value(upload.get("result")) or str(upload.get("result") or ""),
                    "user": str(upload.get("user") or ""),
                    "uploadTime": str(upload.get("time") or ""),
                })
    seen: set[str] = set()
    unique: list[dict] = []
    for photo in photos:
        key = f"{photo.get('uploadTime') or ''}_{photo.get('id') or ''}"
        if key in seen:
            continue
        seen.add(key)
        unique.append(photo)
    return unique


def history_device_references(record: dict | None) -> dict:
    """Keep recorded identity, including a deliberate empty assignment."""
    if not isinstance(record, dict) or not any(key in record for key in ("deviceIds", "deviceSnapshots")):
        return {}
    snapshots = record.get("deviceSnapshots") if isinstance(record.get("deviceSnapshots"), dict) else {}
    ids = record.get("deviceIds") if isinstance(record.get("deviceIds"), list) else list(snapshots)
    ids = list(dict.fromkeys(value for value in ids if isinstance(value, str) and value))
    result = {"deviceIds": ids, "deviceSnapshots": {
        device_id: copy.deepcopy(snapshots[device_id]) for device_id in ids
        if isinstance(snapshots.get(device_id), dict)
    }}
    if record.get("deviceReferencesHistorical") is True:
        result["deviceReferencesHistorical"] = True
    return result


def sample_history_row_for(sample_id: str, item: dict, photos_by_id: dict[str, dict]) -> dict:
    task = item.get("task") if isinstance(item.get("task"), dict) else None
    logs = item.get("logs") if isinstance(item.get("logs"), list) else []
    project_name = str(item.get("projectName") or "")
    stage_name = str(item.get("stageName") or "")
    test_item = str(item.get("testItem") or "")
    device_source = next((log for log in reversed(logs)
                          if isinstance(log, dict) and any(key in log for key in ("deviceIds", "deviceSnapshots"))), None)
    if task:
        if any(key in task for key in ("deviceIds", "deviceSnapshots")):
            device_source = task
        test_item = str(task.get("testItem") or test_item or "-")
        result = status_normalization.normalize_task_result_value(task.get("latestResult") or task.get("result")) or "-"
        date = str(task.get("resultDate") or task.get("completedAt") or task.get("planDate") or (logs[-1].get("time") if logs else "") or "-")
        sample_ids = {str(x) for x in task.get("sampleIds") or [] if str(x or "")}
        sample_ids.update(str(x.get("sampleId") or "") for x in task.get("removedSampleRecords") or [] if isinstance(x, dict) and x.get("sampleId"))
        task_sample_count = len(sample_ids)
        sample_fault_records = [x for x in task.get("sampleFaultRecords") or [] if isinstance(x, dict) and str(x.get("sampleId") or "") == str(sample_id)]
        # Drafts promote new problems into problemRecords before finishing.
        # Read explicit task provenance, never guess from a name or count
        # pre-existing problems belonging to another task in this history.
        recorded_problems = [record.get("description")
            for upload in task.get("resultUploads") or [] if isinstance(upload, dict)
            for sample in upload.get("samples") or [] if isinstance(sample, dict)
            and str(sample.get("sampleId") or sample.get("sid") or "") == str(sample_id)
            for record in sample.get("problemRecords") or [] if isinstance(record, dict)
            and record.get("taskId") == task.get("id") and str(record.get("description") or "").strip()]
        # flowStatus records usage (e.g. 闲置); quality has its own faultMarked field.
        fault_marked = any(log.get("faultMarked") for log in logs)
        fault_marked = fault_marked or bool((task.get("sampleFaults") or {}).get(sample_id, {}).get("fault"))
        fault_marked = fault_marked or any(x.get("fault") or x.get("problem") for x in sample_fault_records)
        fault_marked = fault_marked or bool(recorded_problems)
        problems = []
        for value in [
            *[log.get("problemDescription") for log in logs],
            (task.get("sampleFaults") or {}).get(sample_id, {}).get("problem"),
            *[x.get("problem") for x in sample_fault_records],
            *recorded_problems,
        ]:
            text = str(value or "").strip()
            if text and text not in problems:
                problems.append(text)
        result_photos = sample_task_result_photos(task, sample_id, photos_by_id)
        status = task_queries.task_flow_status(task)
    else:
        # A native task's current fields outrank its old events. Its archive
        # summary preserves that authority even when a date-only result date
        # sorts before a timestamped event from the same day.
        summaries = [log for log in reversed(logs) if log.get("externalHistory") is True
                     and (log.get("type") == "external_history" or log.get("eventType") == "external_history")]
        # Imported updates have collision-safe event IDs, whose lexical order
        # does not indicate freshness. Source revisions remain stable over hops.
        summary = max(summaries, key=lambda log: log["sourceRevision"]
                      if type(log.get("sourceRevision")) is int else -1, default=None)
        result = "-"
        for log in reversed(logs):
            raw_result = log.get("result")
            # Archive summaries use '-' when a task has no result yet. It is a
            # display placeholder, not a mutation status to canonicalize.
            result = "-" if raw_result == "-" and log.get("externalHistory") is True else status_normalization.normalize_task_result_value(raw_result) or str(raw_result or result or "-")
            if result and result != "-":
                break
        date = str((logs[-1].get("time") if logs else "") or "-")
        task_sample_count = next((int(log["taskSampleCount"]) for log in reversed(logs)
                                  if type(log.get("taskSampleCount")) is int and log["taskSampleCount"] >= 0), 0)
        fault_marked = any(log.get("faultMarked") for log in logs)
        problems = []
        for log in logs:
            text = str(log.get("problemDescription") or "").strip()
            if text and text not in problems:
                problems.append(text)
        result_photos = []
        result_photos = [
            photo for log in logs
            for photo in (log.get("resultPhotos") or [])
            if isinstance(photo, dict)
        ]
        status = next((str(log["taskStatus"]) for log in reversed(logs) if log.get("taskStatus")), "历史记录")
        if summary is not None:
            if any(key in summary for key in ("deviceIds", "deviceSnapshots")):
                device_source = summary
            # Archive summaries are display values and may use '-' for no result.
            # They are not task mutation payloads and must not be translated.
            result = str(summary.get("result") or "-")
            date = str(summary.get("time") or "-")
            status = str(summary.get("taskStatus") or status)
            if type(summary.get("taskSampleCount")) is int and summary["taskSampleCount"] >= 0:
                task_sample_count = summary["taskSampleCount"]

    return {
        "key": str(item.get("key") or (task or {}).get("id") or ""),
        "task": task,
        **history_device_references(device_source),
        "projectName": project_name or "-",
        "stageName": stage_name or "-",
        "testItem": test_item or "-",
        "logs": logs,
        "status": status,
        "result": result,
        "date": date,
        "taskSampleCount": task_sample_count,
        "faultMarked": bool(fault_marked),
        "problems": problems,
        "resultPhotos": result_photos,
        "sortTime": str((task or {}).get("completedAt") or (task or {}).get("resultDate") or (task or {}).get("startDate") or (logs[-1].get("time") if logs else "") or ""),
    }


def sample_history_event_key(row, log: dict) -> str:
    task_id = str(row["task_id"] or log.get("taskId") or "")
    if task_id:
        return task_id
    if log.get("sourceDeploymentId") and log.get("sourceTaskId"):
        return "external_" + json.dumps([str(log["sourceDeploymentId"]), str(log["sourceTaskId"])], ensure_ascii=False)
    return f"log_{row['id']}"


def attach_sample_history_counts(conn: sqlite3.Connection, samples: list[dict]) -> None:
    """Count the same groups as the history page, in batches without photos/tasks payloads."""
    ids = list(dict.fromkeys(str(sample["id"]) for sample in samples if sample.get("id")))
    keys = {sid: set() for sid in ids}
    for offset in range(0, len(ids), 400):
        batch = ids[offset:offset + 400]
        placeholders = ",".join("?" for _ in batch)
        for row in conn.execute(
            f"SELECT sample_id, id, task_id, data_json FROM sample_events WHERE sample_id IN ({placeholders})", batch
        ):
            log = json_obj(row["data_json"], None)
            if isinstance(log, dict):
                keys[row["sample_id"]].add(sample_history_event_key(row, log))
        for row in conn.execute(
            f"""SELECT links.sample_id, links.task_id FROM project_task_samples links
                JOIN project_tasks tasks ON tasks.id = links.task_id
                WHERE links.sample_id IN ({placeholders})""", batch
        ):
            if row["task_id"]:
                keys[row["sample_id"]].add(str(row["task_id"]))
    for sample in samples:
        sample["testHistoryCount"] = len(keys.get(str(sample.get("id") or ""), ()))


def list_sample_history_page(conn: sqlite3.Connection, sample_id: str, query: dict[str, list[str]]) -> dict:
    sample_id = str(sample_id or "")
    if not sample_id:
        raise KeyError("缺少样机 ID")
    sample_row = conn.execute(
        "SELECT id FROM sample_records WHERE id = ? AND deleted_at IS NULL",
        (sample_id,),
    ).fetchone()
    if not sample_row:
        raise KeyError("样机不存在")

    page, page_size = task_queries.parse_page_params(query, default_size=20, max_size=50)
    event_rows = conn.execute(
        """
        SELECT id, time, task_id, project_id, stage_id, test_item, data_json
        FROM sample_events
        WHERE sample_id = ?
        ORDER BY julianday(time), id
        """,
        (sample_id,),
    ).fetchall()
    rows_by_key: dict[str, dict] = {}
    task_ids: set[str] = set()
    for row in event_rows:
        log = json_obj(row["data_json"], None)
        if not isinstance(log, dict):
            continue
        task_id = str(row["task_id"] or log.get("taskId") or "")
        key = sample_history_event_key(row, log)
        if task_id:
            task_ids.add(task_id)
        item = rows_by_key.setdefault(key, {
            "key": key,
            "task": None,
            "projectName": str(log.get("projectName") or ""),
            "stageName": str(log.get("stageName") or ""),
            "testItem": str(row["test_item"] or log.get("testItem") or "-"),
            "logs": [],
        })
        item["logs"].append(log)
        item["projectName"] = item["projectName"] or str(log.get("projectName") or "")
        item["stageName"] = item["stageName"] or str(log.get("stageName") or "")

    link_rows = conn.execute(
        "SELECT DISTINCT task_id FROM project_task_samples WHERE sample_id = ?",
        (sample_id,),
    ).fetchall()
    for row in link_rows:
        tid = str(row["task_id"] or "")
        if tid:
            task_ids.add(tid)

    if task_ids:
        placeholders = ",".join("?" for _ in task_ids)
        task_rows = conn.execute(
            f"""
            SELECT t.id, t.project_id, t.stage_id, t.progress_id, t.category, t.test_item, t.sku_index,
                   t.status, t.flow_status, t.owner, t.sample_ids_json, t.data_json,
                   t.created_at, t.updated_at, t.completed_at, t.deleted_at,
                   p.name AS project_name, s.name AS stage_name
            FROM project_tasks t
            LEFT JOIN project_records p ON p.id = t.project_id
            LEFT JOIN project_stages s ON s.id = t.stage_id
            WHERE t.id IN ({placeholders})
            """,
            list(task_ids),
        ).fetchall()
        for row in task_rows:
            task = task_queries.task_from_db_row(row)
            key = str(task.get("id") or "")
            item = rows_by_key.setdefault(key, {
                "key": key,
                "task": None,
                "projectName": "",
                "stageName": "",
                "testItem": "",
                "logs": [],
            })
            item["task"] = task
            item["projectName"] = str(row["project_name"] or item.get("projectName") or "")
            item["stageName"] = str(row["stage_name"] or item.get("stageName") or "")
            item["testItem"] = str(task.get("testItem") or item.get("testItem") or "-")
        task_queries.attach_task_sample_snapshots(
            conn,
            [item["task"] for item in rows_by_key.values() if isinstance(item.get("task"), dict)],
        )

    photos_by_id = {str(photo.get("id") or ""): photo for photo in load_sample_photos(conn, sample_id)}
    history_rows = [sample_history_row_for(sample_id, item, photos_by_id) for item in rows_by_key.values()]
    history_rows.sort(key=lambda item: history_sort_time(item.get("sortTime")), reverse=True)
    total = len(history_rows)
    total_pages = max(1, (total + page_size - 1) // page_size)
    page = min(max(1, page), total_pages)
    offset = (page - 1) * page_size
    page_items = history_rows[offset:offset + page_size]
    for item in page_items:
        item.pop("sortTime", None)
    return {
        "sampleId": sample_id,
        "page": page,
        "pageSize": page_size,
        "total": total,
        "totalPages": total_pages,
        "items": page_items,
    }
