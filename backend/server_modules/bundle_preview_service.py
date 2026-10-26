from __future__ import annotations

import copy
import hashlib
import shutil
import tempfile
import time
import uuid
import zipfile
from contextlib import closing
from dataclasses import dataclass
from pathlib import Path
from typing import Callable

from server_modules import chamber_package, import_diff, import_preview_cache, json_validation, migration_scope, status_normalization, zip_security, sample_history


@dataclass(frozen=True)
class BundlePreviewContext:
    app_version: str
    server_version: str
    data_dir: Path
    export_dir: Path
    import_preview_dir: Path
    import_previews: dict
    import_preview_ttl_seconds: int
    import_preview_max_entries: int
    import_preview_max_state_bytes: int
    import_preview_max_cached_bytes: int
    get_state: Callable[..., tuple[dict, int, str]]
    connect_db: Callable
    list_sample_history_page: Callable
    load_deployment_id: Callable[[], str]
    now_iso: Callable[[], str]
    json_dumps: Callable[..., str]
    path_inside_data: Callable[[str], Path]
    ensure_dirs: Callable[[], None]
    parse_multipart: Callable


def preview_id() -> str:
    return import_preview_cache.preview_id()


def cleanup_expired_previews(ctx: BundlePreviewContext) -> None:
    import_preview_cache.cleanup_expired_previews(
        ctx.import_previews,
        ttl_seconds=ctx.import_preview_ttl_seconds,
        max_entries=ctx.import_preview_max_entries,
        max_cached_bytes=ctx.import_preview_max_cached_bytes,
    )


def cleanup_preview_temp(ctx: BundlePreviewContext, preview_id_value: str) -> None:
    import_preview_cache.cleanup_preview_temp(ctx.import_previews, preview_id_value)


def store_import_preview_payload(ctx: BundlePreviewContext, tmp_path: Path, incoming: dict, result: dict) -> Path:
    return import_preview_cache.store_payload(tmp_path, incoming, result, ctx.json_dumps)


def load_import_preview_payload(entry: dict) -> tuple[dict, dict]:
    return import_preview_cache.load_payload(entry)


def text_sha256(text: str) -> str:
    import hashlib

    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def _scope_label(selection: dict | None, fallback: str = "all") -> str:
    if migration_scope.selection_is_empty(selection):
        return fallback
    selected = migration_scope.normalize_selection(selection)
    if selected["projects"] or selected["stages"] or selected["tasks"]:
        return "selected-projects"
    if selected["sampleCategories"]:
        return "selected-sample-categories"
    if selected["samples"]:
        return "selected-samples"
    return fallback


def _find_sample(state: dict, sample_id: str) -> tuple[dict | None, dict | None]:
    for category in (state.get("sampleLibrary") or {}).get("categories") or []:
        for sample in category.get("samples") or []:
            if str(sample.get("id") or "") == str(sample_id or ""):
                return category, sample
    return None, None


def _filename_segment(value: object, fallback: str = "-") -> str:
    text = str(value or "").strip() or fallback
    for char in '<>:"/\\|?*\r\n\t':
        text = text.replace(char, "-")
    text = "-".join(part for part in text.split() if part)
    text = text.strip(" .-_") or fallback
    return text[:80]


def _sample_archive_display_code(sample: dict) -> str:
    sn = str(sample.get("sn") or "").strip()
    imei = str(sample.get("imei") or "").strip()
    board_sn = str(sample.get("boardSn") or "").strip()
    sample_no = str(sample.get("sampleNo") or "").strip()
    if sn:
        return f"SN-{sn[-8:]}"
    if imei:
        return f"IMEI-{imei[-8:]}"
    if board_sn:
        return f"主板SN-{board_sn[-8:]}"
    return sample_no or "未录入身份"


def _sample_archive_filename(category: dict | None, sample: dict, sample_id: str, exported_at: str) -> str:
    category_name = _filename_segment((category or {}).get("name"), "未命名样机池")
    display_code = _filename_segment(_sample_archive_display_code(sample), "未录入身份")
    stable_id = _filename_segment(sample.get("id") or sample_id, "sample-id")
    ts = exported_at.replace("-", "").replace(":", "")[:15]
    return f"{category_name}-{display_code}-{stable_id}-{ts}.zip"


def _sample_archive_history(ctx: BundlePreviewContext, sample_id: str) -> list[dict]:
    history: list[dict] = []
    with closing(ctx.connect_db()) as conn:
        started = not conn.in_transaction
        if started:
            conn.execute("BEGIN")
        try:
            page = 1
            while True:
                result = ctx.list_sample_history_page(conn, sample_id, {"page": [str(page)], "pageSize": ["50"]})
                items = result.get("items") or []
                history.extend(items)
                if page >= int(result.get("totalPages") or 1):
                    break
                page += 1
        finally:
            if started:
                conn.commit()
    return history


def _mark_archive_device_references(record: dict, deployment_id: str) -> None:
    """Sample archives carry equipment identity as history, never live ownership.

    Preserve the first source across repeated archive hops. A destination may
    have a different device with the same ID, so navigation must use snapshots.
    """
    for ids_key, snapshots_key in (("deviceIds", "deviceSnapshots"), ("previousDeviceIds", "previousDeviceSnapshots")):
        if ids_key not in record and snapshots_key not in record:
            continue
        snapshots = record.get(snapshots_key) if isinstance(record.get(snapshots_key), dict) else {}
        ids = record.get(ids_key) if isinstance(record.get(ids_key), list) else list(snapshots)
        ids = list(dict.fromkeys(value for value in ids if isinstance(value, str) and value))
        marked = {}
        for device_id in ids:
            snapshot = copy.deepcopy(snapshots[device_id]) if isinstance(snapshots.get(device_id), dict) else {"id": device_id}
            snapshot["external"] = True
            snapshot.setdefault("sourceDeviceId", snapshot.get("id") or device_id)
            if not snapshot.get("sourceDeploymentId"):
                snapshot["sourceDeploymentId"] = record.get("sourceDeploymentId") or deployment_id
            marked[device_id] = snapshot
        record[ids_key] = ids
        record[snapshots_key] = marked
        record["deviceReferencesHistorical"] = True


def _external_history_events(sample_id: str, history: list[dict], *, deployment_id: str, exported_at: str, source_revision: int = 0) -> list[dict]:
    events: list[dict] = []
    for idx, row in enumerate(history, start=1):
        task = row.get("task")
        if not isinstance(task, dict):
            # Log-only history is already carried in sample/events.json. A
            # second synthetic event would duplicate it at every archive hop.
            continue
        key = str(row.get("key") or idx)
        event_id = f"external_history_{sample_id}_{chamber_package.sha256_bytes(key.encode('utf-8'))[:16]}"
        problems = row.get("problems") if isinstance(row.get("problems"), list) else []
        event = {
            "id": event_id,
            "sampleId": sample_id,
            "time": str(row.get("date") or exported_at),
            "type": "external_history",
            "eventType": "external_history",
            "sourceDeploymentId": deployment_id,
            "sourceRevision": source_revision,
            "sourceSampleId": sample_id,
            "sourceTaskId": str(task.get("id") or key),
            "sourceProjectId": str(task.get("projectId") or ""),
            "sourceStageId": str(task.get("stageId") or ""),
            "projectName": str(row.get("projectName") or ""),
            "stageName": str(row.get("stageName") or ""),
            "testItem": str(row.get("testItem") or ""),
            "taskStatus": str(row.get("status") or ""),
            "taskSampleCount": int(row.get("taskSampleCount") or 0),
            "result": str(row.get("result") or ""),
            "faultMarked": bool(row.get("faultMarked")),
            "problemDescription": "；".join(str(item) for item in problems if str(item or "").strip()),
            "resultPhotos": row.get("resultPhotos") or [],
            "externalHistory": True,
            **sample_history.history_device_references(row if any(key in row for key in ("deviceIds", "deviceSnapshots")) else task),
        }
        _mark_archive_device_references(event, deployment_id)
        events.append(event)
    return events


def _sample_archive_payloads(sample: dict, photos: list, events: list, history: list, *, manifest: dict) -> dict[str, object]:
    info = dict(sample)
    info.pop("photos", None)
    return {
        "dossier.json": {
            "packageKind": "sample-archive",
            "sourceDeploymentId": manifest.get("sourceDeploymentId", ""),
            "sourceSampleId": sample.get("id", ""),
            "exportedAt": manifest.get("exportedAt", ""),
            "info": info,
            "photos": photos,
            "events": events,
            "history": history,
        },
        "sample/info.json": info,
        "sample/photos.json": photos,
        "sample/events.json": events,
        "sample/history.json": history,
    }


def prepare_export_bundle_parts(
    ctx: BundlePreviewContext,
    *,
    selection: dict | None = None,
    package_kind: str = "full",
    scope: str | None = None,
    extra_payloads: dict[str, object] | None = None,
) -> tuple[dict, dict, dict[str, str], dict, str]:
    """Build ChamberData v2 export payloads shared by byte/file exports."""
    data, revision, _ = ctx.get_state()
    export_data = import_diff.strip_view_state(data)
    if selection:
        export_data = migration_scope.filter_state_by_selection(export_data, selection)
    deployment_id = ctx.load_deployment_id()
    exported_at = ctx.now_iso()
    export_id = f"exp_{exported_at.replace('-','').replace(':','').replace('T','_')[:15]}_{uuid.uuid4().hex[:6]}"
    resolved_scope = scope or _scope_label(selection)

    package = chamber_package.build_export_package(
        export_data,
        data_dir=ctx.data_dir,
        app_version=ctx.app_version,
        server_version=ctx.server_version,
        exported_at=exported_at,
        export_id=export_id,
        deployment_id=deployment_id,
        revision=revision,
        package_kind=package_kind,
        scope=resolved_scope,
    )
    missing_assets = [asset for asset in package["assetIndex"]["assets"] if not asset.get("exists")]
    if missing_assets:
        # Preserve genuinely missing historical files, but do not describe a
        # concurrently deleted photo as a missing asset in an otherwise valid ZIP.
        with closing(ctx.connect_db()) as conn:
            for asset in missing_assets:
                active = conn.execute(
                    "SELECT 1 FROM sample_assets WHERE sample_id = ? AND relative_path = ? AND deleted_at IS NULL LIMIT 1",
                    (str(asset.get("entityId") or ""), str(asset.get("sourceRelativePath") or "")),
                ).fetchone()
                if not active:
                    raise ValueError("导出期间照片文件已变化或无法读取，请重试导出")
    chamber_package.validate_domain_documents(package["manifest"], package["domains"], package["assetIndex"])
    payloads = chamber_package.package_payloads(package, pretty=True, extra_payloads=extra_payloads)
    checksums = {path: text_sha256(text) for path, text in payloads.items()}
    payloads["checksums.json"] = ctx.json_dumps(checksums, pretty=True)

    ts = exported_at.replace("-", "").replace(":", "")[:15]
    filename = f"sample_archive_{ts}.zip" if package_kind == "sample-archive" else f"chamberdata_export_{ts}.zip"
    return export_data, package, payloads, checksums, filename


def write_export_bundle_zip(ctx: BundlePreviewContext, zf: zipfile.ZipFile, export_data: dict, package: dict, payloads: dict[str, str]) -> None:
    for path, text in payloads.items():
        zf.writestr(path, text)

    for asset in (package.get("assetIndex") or {}).get("assets") or []:
        if not asset.get("exists"):
            print(f"[EXPORT] 资产缺失，已记录但未写入: {asset.get('sourceRelativePath')}")
            continue
        rel = str(asset.get("sourceRelativePath") or "")
        zip_path = str(asset.get("zipPath") or "")
        if not rel or not zip_path:
            raise ValueError("导出照片路径无效，请重新导出")
        try:
            source_path = ctx.path_inside_data(rel)
            digest = hashlib.sha256()
            size = 0
            with source_path.open("rb") as source, zf.open(zip_path, "w", force_zip64=True) as target:
                while chunk := source.read(1024 * 1024):
                    target.write(chunk)
                    digest.update(chunk)
                    size += len(chunk)
            if size != asset.get("bytes") or digest.hexdigest() != asset.get("sha256"):
                raise ValueError("照片内容与导出快照不一致")
        except (ValueError, OSError, RuntimeError) as e:
            raise ValueError("导出期间照片文件已变化或无法读取，请重试导出") from e


def build_export_bundle_file(ctx: BundlePreviewContext, *, selection: dict | None = None) -> tuple[Path, str]:
    """生成完整导出包到临时文件，HTTP 下载路径用它避免整包 bytes 常驻内存。"""
    ctx.ensure_dirs()
    export_data, package, payloads, _checksums, filename = prepare_export_bundle_parts(ctx, selection=selection)
    tmp = tempfile.NamedTemporaryFile(prefix="tcv7_export_", suffix=".zip", dir=ctx.export_dir, delete=False)
    tmp_path = Path(tmp.name)
    tmp.close()
    try:
        with zipfile.ZipFile(tmp_path, "w", zipfile.ZIP_DEFLATED) as zf:
            write_export_bundle_zip(ctx, zf, export_data, package, payloads)
        return tmp_path, filename
    except Exception:
        tmp_path.unlink(missing_ok=True)
        raise


def build_sample_archive_file(ctx: BundlePreviewContext, sample_id: str) -> tuple[Path, str]:
    data, _revision, _ = ctx.get_state()
    export_data = import_diff.strip_view_state(data)
    category, sample = _find_sample(export_data, sample_id)
    if not sample:
        raise KeyError("样机不存在")
    selection = {"sampleIds": [sample_id]}
    history = _sample_archive_history(ctx, sample_id)
    # State and paged history each use a read snapshot. Reject a write between
    # those snapshots instead of labeling newer history with an older revision.
    with closing(ctx.connect_db()) as conn:
        revision_row = conn.execute("SELECT revision FROM app_state WHERE id = 1").fetchone()
    if revision_row is None or int(revision_row["revision"]) != _revision:
        raise ValueError("导出期间平台数据已变化，请重试导出样机档案")
    deployment_id = ctx.load_deployment_id()
    exported_at = ctx.now_iso()
    filtered = migration_scope.filter_state_by_selection(export_data, selection)
    # A single-sample archive does not import a foreign equipment warehouse.
    # All linked device identity is carried by immutable history snapshots.
    filtered.pop("deviceWarehouse", None)
    sample_events = _external_history_events(sample_id, history, deployment_id=deployment_id, exported_at=exported_at, source_revision=_revision)
    existing_event_ids = {
        str(log.get("id") or "")
        for log in (filtered.get("sampleLibrary") or {}).get("logs") or []
        if isinstance(log, dict)
    }
    for event in sample_events:
        if event["id"] not in existing_event_ids:
            filtered.setdefault("sampleLibrary", {}).setdefault("logs", []).append(event)
            existing_event_ids.add(event["id"])
    _, filtered_sample = _find_sample(filtered, sample_id)
    photos = list((filtered_sample or {}).get("photos") or [])
    events = [
        log for log in (filtered.get("sampleLibrary") or {}).get("logs") or []
        if isinstance(log, dict) and str(log.get("sampleId") or "") == str(sample_id)
    ]
    for event in events:
        _mark_archive_device_references(event, deployment_id)
    for row in history:
        _mark_archive_device_references(row, deployment_id)
        if isinstance(row.get("task"), dict):
            _mark_archive_device_references(row["task"], deployment_id)
        for log in row.get("logs") or []:
            if isinstance(log, dict):
                _mark_archive_device_references(log, deployment_id)
    # Reuse the standard export path by temporarily providing the filtered state
    # through a tiny context shim.
    def _filtered_state(*_args, **_kwargs):
        return copy.deepcopy(filtered), _revision, exported_at

    shim = BundlePreviewContext(**{**ctx.__dict__, "get_state": _filtered_state})
    extra_payloads = _sample_archive_payloads(
        filtered_sample or sample,
        photos,
        events,
        history,
        manifest={"sourceDeploymentId": deployment_id, "exportedAt": exported_at},
    )
    ctx.ensure_dirs()
    export_data, package, payloads, _checksums, filename = prepare_export_bundle_parts(
        shim,
        selection=None,
        package_kind="sample-archive",
        scope="selected-samples",
        extra_payloads=extra_payloads,
    )
    tmp = tempfile.NamedTemporaryFile(prefix="tcv7_sample_archive_", suffix=".zip", dir=ctx.export_dir, delete=False)
    tmp_path = Path(tmp.name)
    tmp.close()
    try:
        with zipfile.ZipFile(tmp_path, "w", zipfile.ZIP_DEFLATED) as zf:
            write_export_bundle_zip(ctx, zf, export_data, package, payloads)
        archive_name = _sample_archive_filename(category, sample, sample_id, exported_at)
        return tmp_path, archive_name
    except Exception:
        tmp_path.unlink(missing_ok=True)
        raise


def _target_archive_category(current_data: dict, target_category_id: str) -> dict:
    categories = (current_data.get("sampleLibrary") or {}).get("categories") or []
    for category in categories:
        if str(category.get("id") or "") == str(target_category_id or ""):
            return {
                "id": str(category.get("id") or ""),
                "name": str(category.get("name") or "外部导入样机"),
                "description": str(category.get("description") or ""),
            }
    if target_category_id:
        raise ValueError("目标样机池已不存在，请刷新后重新选择导入位置")
    return {
        "id": "cat_external_imported_samples",
        "name": "外部导入样机",
        "description": "从单台样机档案包导入的外部样机。",
    }


def _prepare_sample_archive_import_state(incoming_state: dict, current_data: dict, target_category_id: str, *, source_deployment_id: str = "") -> dict:
    prepared = copy.deepcopy(incoming_state)
    prepared.pop("deviceWarehouse", None)
    target = _target_archive_category(current_data, target_category_id)
    samples = []
    for category in (prepared.get("sampleLibrary") or {}).get("categories") or []:
        for sample in category.get("samples") or []:
            if isinstance(sample, dict):
                source_fields = {
                    "currentProjectId": "sourceProjectId",
                    "currentStageId": "sourceStageId",
                    "currentTaskId": "sourceTaskId",
                    "currentTestItem": "sourceTestItem",
                }
                for current_field, source_field in source_fields.items():
                    current_value = sample.get(current_field)
                    if current_value not in (None, "") and sample.get(source_field) in (None, ""):
                        sample[source_field] = current_value
                sample["currentProjectId"] = None
                sample["currentStageId"] = None
                sample["currentTaskId"] = None
                sample["currentTestItem"] = ""
                if status_normalization.normalize_sample_usage_status(sample.get("status")) in ("测试中", "在位等待"):
                    sample["status"] = "闲置"
                    sample["borrower"] = ""
                    sample["borrowDate"] = ""
                samples.append(sample)
    prepared["projects"] = []
    prepared.setdefault("sampleLibrary", {})["categories"] = [{
        **target,
        "samples": samples,
    }]
    prepared_logs = []
    for log in (prepared.get("sampleLibrary") or {}).get("logs") or []:
        if not isinstance(log, dict):
            continue
        if not log.get("sourceDeploymentId"):
            log["sourceDeploymentId"] = source_deployment_id
        _mark_archive_device_references(log, source_deployment_id)
        source_fields = {
            "projectId": "sourceProjectId",
            "stageId": "sourceStageId",
            "taskId": "sourceTaskId",
        }
        for current_field, source_field in source_fields.items():
            current_value = log.get(current_field)
            if current_value not in (None, "") and log.get(source_field) in (None, ""):
                log[source_field] = current_value
            log[current_field] = ""
        prepared_logs.append(log)
    prepared["sampleLibrary"]["logs"] = prepared_logs
    return prepared


def analyze_import_bundle(ctx: BundlePreviewContext, headers, raw_body: bytes) -> dict:
    """解压导入包，与主库对比生成 preview 分析结果"""
    cleanup_expired_previews(ctx)

    fields, files = ctx.parse_multipart(headers, raw_body)
    zip_raw = None
    for f in files:
        if f.get("filename", "").endswith(".zip"):
            zip_raw = f.get("content", b"")
            break
    if not zip_raw:
        for f in files:
            zip_raw = f.get("content", b"")
            break

    if not zip_raw or len(zip_raw) < 4:
        raise ValueError("未找到有效的 zip 文件内容")
    zip_bytes = len(zip_raw)

    ctx.ensure_dirs()
    tmp_dir = tempfile.mkdtemp(prefix="tcv7_import_", dir=ctx.import_preview_dir)
    try:
        zip_path = Path(tmp_dir) / "bundle.zip"
        zip_path.write_bytes(zip_raw)
        zip_raw = None
        for item in files:
            item["content"] = b""

        try:
            with zipfile.ZipFile(zip_path, "r") as zf:
                zip_security.safe_extract_zip(zf, tmp_dir)
                extracted_bytes = sum(entry.file_size for entry in zf.infolist() if not entry.is_dir())
        except zipfile.BadZipFile as error:
            raise ValueError("文件不是有效的数据包或已损坏，请重新导出并选择有效的 ZIP 数据包。") from error

        tmp_path = Path(tmp_dir)

        manifest_path = tmp_path / "manifest.json"
        if not manifest_path.is_file():
            raise ValueError("导入包缺少 manifest.json")
        manifest = json_validation.loads(manifest_path.read_text(encoding="utf-8"))
        chamber_package.validate_manifest(manifest)

        checksums = None
        checksums_path = tmp_path / chamber_package.CHECKSUMS_PATH
        if checksums_path.is_file():
            if checksums_path.stat().st_size > ctx.import_preview_max_state_bytes:
                raise ValueError(f"导入包 {chamber_package.CHECKSUMS_PATH} 过大，超过 {ctx.import_preview_max_state_bytes} bytes 上限")
            checksums = json_validation.loads(checksums_path.read_text(encoding="utf-8"))
        chamber_package.verify_checksums(tmp_path, checksums)

        def _read_package_json(rel_path: str):
            path = tmp_path / rel_path
            if not path.is_file():
                raise ValueError(f"导入包缺少 {rel_path}")
            if path.stat().st_size > ctx.import_preview_max_state_bytes:
                raise ValueError(f"导入包 {rel_path} 过大，超过 {ctx.import_preview_max_state_bytes} bytes 上限")
            return json_validation.loads(path.read_text(encoding="utf-8"))

        domains = chamber_package.read_domain_documents(_read_package_json)
        asset_index = chamber_package.read_asset_index(_read_package_json)
        chamber_package.validate_domain_documents(manifest, domains, asset_index)
        incoming_state = chamber_package.state_from_domain_documents(manifest, domains)
        state_bytes = sum((tmp_path / rel).stat().st_size for rel in chamber_package.DOMAIN_PATHS.values())
        state_bytes += (tmp_path / chamber_package.ASSET_INDEX_PATH).stat().st_size
        if checksums_path.is_file():
            state_bytes += checksums_path.stat().st_size
        incoming_state = status_normalization.normalize_state_payload(incoming_state)
        chamber_package.validate_state_structure(incoming_state)

        current_data, current_revision, _ = ctx.get_state(compact=True)
        package_kind = str(manifest.get("packageKind") or "full")
        target_category_id = str(fields.get("targetCategoryId") or "")
        if package_kind == "sample-archive":
            incoming_state = _prepare_sample_archive_import_state(incoming_state, current_data, target_category_id,
                source_deployment_id=str(manifest.get("sourceDeploymentId") or ""))

        result = import_diff.diff_import_bundle(current_data, incoming_state, manifest, tmp_path, asset_index=asset_index)
        result["selectionTree"] = migration_scope.build_selection_tree(incoming_state)
        result["packageKind"] = package_kind
        result["scope"] = str(manifest.get("scope") or "")
        if package_kind == "sample-archive":
            result["targetCategory"] = _target_archive_category(current_data, target_category_id)
        preview_id_value = preview_id()
        result["previewId"] = preview_id_value
        payload_path = store_import_preview_payload(ctx, tmp_path, incoming_state, result)
        payload_bytes = payload_path.stat().st_size
        import_preview_cache.put_entry(ctx.import_previews, preview_id_value, {
            "_ts": time.time(),
            "_tmp_dir": str(tmp_path),
            "_payload_path": str(payload_path),
            "_revision": current_revision,
            "_zip_bytes": zip_bytes,
            "_state_bytes": state_bytes,
            "_payload_bytes": payload_bytes,
            "_extracted_bytes": extracted_bytes,
            "_cache_bytes": zip_bytes + extracted_bytes + payload_bytes,
        })
        cleanup_expired_previews(ctx)
        if preview_id_value not in ctx.import_previews:
            raise ValueError("导入预览缓存已超过服务器上限，请稍后重试")
        return result
    except Exception:
        shutil.rmtree(tmp_dir, ignore_errors=True)
        raise
