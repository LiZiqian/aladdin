from __future__ import annotations

import copy
import json
import shutil
import uuid
from dataclasses import dataclass
from contextlib import closing, contextmanager
from pathlib import Path
from typing import Callable

from server_modules import sample_files, chamber_package, device_tasks, equipment_import, import_commit, import_diff, import_preview_cache, migration_scope, mutation_summary as mutation_summary_module, record_writers, sample_assets, task_reservations


@dataclass(frozen=True)
class ImportBundleCommitContext:
    app_version: str
    sample_data_dir: Path
    import_previews: dict
    cleanup_expired_previews: Callable[[], None]
    cleanup_preview_temp: Callable[[str], None]
    load_import_preview_payload: Callable[[dict], tuple[dict, dict]]
    get_state_metadata: Callable[[], tuple[int, str]]
    get_state: Callable[..., tuple[dict, int, str]]
    detect_sample_occupancy_conflicts: Callable[[dict], list[dict]]
    write_db_connection: Callable
    now_iso: Callable[[], str]
    sync_project_library: Callable
    sync_sample_library: Callable
    split_state_for_storage: Callable[[dict], dict]
    json_dumps: Callable[[object], str]
    connect_db: Callable
    begin_read_snapshot: Callable
    load_sample_photos: Callable
    url_for_asset: Callable[[str, str], str]
    thumbnail_asset_id: Callable[[str], str]


@contextmanager
def staged_import_assets(ctx, data, photo_sources, source_for, asset_lookup):
    """Publish new asset files with collision-safe names, undoing failed commits."""
    created = []
    created_dirs = set()
    outcome = {"committed": False, "photoCount": 0}
    try:
        for category in (data.get("sampleLibrary") or {}).get("categories") or []:
            for sample in category.get("samples") or []:
                sid = str(sample.get("id") or "")
                for photo in [*(sample.get("photos") or []), *(sample.get("files") or [])]:
                    pid = str(photo.get("id") or "")
                    incoming_sid = photo_sources.get((sid, pid))
                    if incoming_sid is None:
                        continue
                    for role, path_field, url_field in (("original", "relativePath", "url"),
                                                         ("thumbnail", "thumbRelativePath", "thumbUrl")):
                        asset = asset_lookup.get((incoming_sid, pid, role))
                        relative_path = photo.get(path_field) or ""
                        if not relative_path and not asset:
                            photo[path_field] = photo[url_field] = ""
                            continue
                        source, filename = source_for(incoming_sid, photo, role, relative_path)
                        if source is None or not source.is_file() or not filename:
                            raise ValueError(f"导入照片资源已缺失，请重新选择文件: {pid}")
                        folder = "files" if photo.get("kind") in sample_files.KINDS else "photos"
                        dest = chamber_package.safe_package_member_path(ctx.sample_data_dir, f"{sid}/{folder}/{filename}")
                        if dest is None:
                            raise ValueError(f"导入照片目标路径不安全: {pid}")
                        if not dest.parent.exists():
                            created_dirs.add(dest.parent)
                            dest.parent.mkdir(parents=True, exist_ok=True)
                        while True:
                            try:
                                output = dest.open("xb")
                                break
                            except FileExistsError:
                                dest = dest.with_name(f"{Path(filename).stem}_{uuid.uuid4().hex[:12]}{Path(filename).suffix}")
                        created.append(dest)
                        with output, source.open("rb") as input_file:
                            shutil.copyfileobj(input_file, output)
                        if asset and asset.get("sha256") and chamber_package.sha256_file(dest) != asset["sha256"]:
                            raise ValueError(f"导入照片资源校验失败: {pid}")
                        photo[path_field] = f"samples/{sid}/{folder}/{dest.name}"
                        photo[url_field] = sample_files.file_url(sid, pid) if folder == "files" else ctx.url_for_asset(sid, pid if role == "original" else ctx.thumbnail_asset_id(pid))
                        if role == "thumbnail":
                            photo["thumbId"] = ctx.thumbnail_asset_id(pid)
                        if role == "original":
                            outcome["photoCount"] += 1
        yield outcome
    finally:
        if not outcome["committed"]:
            if created:
                asset_ctx = sample_assets.AssetStorageContext(
                    data_dir=ctx.sample_data_dir.parent, sample_data_dir=ctx.sample_data_dir, now_iso=ctx.now_iso)
                try:
                    # A failure after SQLite committed must not erase files
                    # already referenced by durable asset rows. The journal
                    # checks references under its short cleanup write scope.
                    with ctx.write_db_connection():
                        sample_assets.unlink_asset_relative_paths(asset_ctx, [
                            path.relative_to(asset_ctx.data_dir).as_posix() for path in created
                        ], warn_label="清理导入临时照片")
                except Exception as exc:
                    print(f"[WARN] 清理导入临时照片失败，保留文件等待恢复：{exc}")
            for directory in created_dirs:
                try:
                    directory.rmdir()
                    directory.parent.rmdir()
                except OSError:
                    pass

def commit_merged_import_state(
    ctx: ImportBundleCommitContext,
    merged_data: dict,
    expected_revision: int | None,
    client_ip: str,
    remark: str,
    user: str,
    imported_sample_ids: set[str] | None = None,
) -> tuple[bool, dict]:
    """Persist an already-merged import state without composing full current state again."""
    detect_sample_occupancy_conflicts = ctx.detect_sample_occupancy_conflicts
    write_db_connection = ctx.write_db_connection
    now_iso = ctx.now_iso
    sync_project_library = ctx.sync_project_library
    sync_sample_library = ctx.sync_sample_library
    split_state_for_storage = ctx.split_state_for_storage
    json_dumps = ctx.json_dumps
    APP_VERSION = ctx.app_version
    conflict = detect_sample_occupancy_conflicts(merged_data)
    if conflict:
        return False, {
            "status": 409,
            "error_code": "SAMPLE_OCCUPANCY_CONFLICT",
            "error": "样机预约时间重叠，或存在多个执行中/阻塞中的任务，已拒绝保存。",
            "conflicts": conflict,
        }

    with write_db_connection() as conn:
        row = conn.execute("SELECT revision FROM app_state WHERE id = 1").fetchone()
        current_revision = int(row["revision"]) if row else 1
        if expected_revision is not None and int(expected_revision) != current_revision:
            return False, {
                "status": 409,
                "error": "revision 冲突，服务器数据已被其他客户端更新",
                "error_code": "IMPORT_REVISION_CONFLICT",
                "server_revision": current_revision,
            }

        identity_conflicts = import_commit.detect_import_identity_conflicts(merged_data, imported_sample_ids)
        if identity_conflicts:
            return False, {
                "status": 409, "error_code": "SAMPLE_IDENTITY_CONFLICT",
                "error": "导入样机的 SN/IMEI/主板SN 重复，请修改标识或合并到已有样机。",
                "conflicts": identity_conflicts,
            }

        equipment_failure = device_tasks.validate_state_device_assignments(merged_data)
        if equipment_failure:
            return False, equipment_failure

        new_revision = current_revision + 1
        updated_at = now_iso()
        merged_data["version"] = APP_VERSION
        task_reservations.reconcile_state_reservations(merged_data)
        events_added = import_commit.preserve_existing_import_events(conn, merged_data)
        sync_project_library(conn, merged_data, allow_empty=True)
        sync_sample_library(conn, merged_data, allow_empty=True)
        record_writers.prune_orphan_operational_logs(conn)
        stored_data = split_state_for_storage(merged_data)
        conn.execute(
            "UPDATE app_state SET data_json = ?, revision = ?, updated_at = ? WHERE id = 1",
            (json_dumps(stored_data), new_revision, updated_at),
        )
        conn.execute(
            """
            INSERT INTO audit_log
            (time, user, action, remark, revision_before, revision_after, client_ip)
            VALUES (?, ?, ?, ?, ?, ?, ?)
            """,
            (updated_at, user, "import_bundle_commit", remark, current_revision, new_revision, client_ip),
        )
        record_writers.clear_audit_log_when_platform_empty(conn)
        conn.commit()

    return True, {"revision": new_revision, "updated_at": updated_at, "sampleEventsAdded": events_added}


def _commit_with_preview_claim(ctx: ImportBundleCommitContext, payload: dict, commit: Callable) -> dict:
    if not isinstance(payload, dict) or not isinstance(payload.get("previewId"), str):
        return {"ok": False, "error": "导入参数或 previewId 格式不正确", "status": 400}
    ctx.cleanup_expired_previews()
    try:
        with import_preview_cache.claim_preview(ctx.import_previews, payload["previewId"]):
            return commit(ctx, payload)
    except import_preview_cache.PreviewBusyError as exc:
        return {"ok": False, "error": str(exc), "status": 409, "error_code": "IMPORT_PREVIEW_BUSY"}
    except (OSError, ValueError) as exc:
        return {"ok": False, "error": str(exc), "status": 400}


def commit_import_bundle(ctx: ImportBundleCommitContext, payload: dict) -> dict:
    return _commit_with_preview_claim(ctx, payload, _commit_import_bundle)


def _commit_import_bundle(ctx: ImportBundleCommitContext, payload: dict) -> dict:
    """执行导入写入"""
    if not isinstance(payload, dict):
        return {"ok": False, "error": "导入参数必须是 JSON 对象", "status": 400}
    _cleanup_expired_previews = ctx.cleanup_expired_previews
    _IMPORT_PREVIEWS = ctx.import_previews
    _load_import_preview_payload = ctx.load_import_preview_payload
    _cleanup_preview_temp = ctx.cleanup_preview_temp
    get_state_metadata = ctx.get_state_metadata
    get_state = ctx.get_state
    SAMPLE_DATA_DIR = ctx.sample_data_dir
    url_for_asset = ctx.url_for_asset
    thumbnail_asset_id = ctx.thumbnail_asset_id
    _register_imported_project_tree = import_commit.register_imported_project_tree
    _register_imported_stage_tree = import_commit.register_imported_stage_tree
    _find_incoming_stage = import_commit.find_incoming_stage
    _find_incoming_task = import_commit.find_incoming_task
    _merge_project_sub_data = import_commit.merge_project_sub_data
    _content_hash = import_commit.content_hash
    _sample_index_by_id = import_commit.sample_index_by_id
    _merge_import_sample_subrecords = import_commit.merge_import_sample_subrecords
    _apply_id_maps = import_commit.apply_id_maps
    _merge_import_sample_events = import_commit.merge_import_sample_events
    _validate_import_commit_state = import_commit.validate_import_commit_state
    _build_import_mutation_summary = mutation_summary_module.build_import_mutation_summary

    def hydrate_import_target_photos(current_data: dict, incoming: dict, sample_id_map: dict[str, str], existing_sample_ids: set[str]) -> None:
        import_commit.hydrate_import_target_photos(
            current_data,
            incoming,
            sample_id_map,
            existing_sample_ids,
            connect_db=ctx.connect_db,
            begin_read_snapshot=ctx.begin_read_snapshot,
            load_sample_photos=ctx.load_sample_photos,
        )
    preview_id = payload.get("previewId", "")
    decisions = payload.get("decisions") or {}
    if not isinstance(preview_id, str) or not isinstance(decisions, dict):
        return {"ok": False, "error": "导入预览或决策格式不正确", "status": 400}

    _cleanup_expired_previews()
    entry = _IMPORT_PREVIEWS.get(preview_id)
    if not entry:
        return {"ok": False, "error": "previewId 无效或已过期", "status": 400}

    incoming_payload, result = _load_import_preview_payload(entry)
    if not result:
        _cleanup_preview_temp(preview_id)
        import_preview_cache.remove_entry(_IMPORT_PREVIEWS, preview_id)
        return {"ok": False, "error": "导入预览缓存损坏，请重新选择文件导入", "status": 400}

    # ── Revision 校验：commit 时主库 revision 必须与 preview 时一致 ──
    preview_revision = entry.get("_revision")
    if preview_revision is not None:
        current_revision_check, _ = get_state_metadata()
        if current_revision_check != preview_revision:
            return {"ok": False,
                    "error": "服务器数据在预览后被其他用户修改，请重新选择文件导入。",
                    "error_code": "IMPORT_REVISION_CONFLICT",
                    "server_revision": current_revision_check,
                    "status": 409}

    tmp_dir = Path(entry["_tmp_dir"])
    asset_index = {"assets": []}
    asset_index_path = tmp_dir / chamber_package.ASSET_INDEX_PATH
    if asset_index_path.is_file():
        try:
            loaded_asset_index = json.loads(asset_index_path.read_text(encoding="utf-8"))
            if isinstance(loaded_asset_index, dict):
                asset_index = loaded_asset_index
        except (OSError, json.JSONDecodeError):
            asset_index = {"assets": []}

    current_data = None
    selection = payload.get("selection")
    if selection is not None and migration_scope.selection_is_empty(selection):
        return {"ok": False, "error": "请至少选择一项导入数据", "status": 400}
    if not migration_scope.selection_is_empty(selection):
        current_data, _, _ = get_state(compact=True)
        incoming_payload = migration_scope.filter_state_by_selection(incoming_payload, selection)
        manifest = {}
        manifest_path = tmp_dir / "manifest.json"
        if manifest_path.is_file():
            try:
                loaded_manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
                if isinstance(loaded_manifest, dict):
                    manifest = loaded_manifest
            except (OSError, json.JSONDecodeError):
                manifest = {}
        selected_result = import_diff.diff_import_bundle(current_data, incoming_payload, manifest, tmp_dir, asset_index=asset_index)
        try:
            import_diff.retain_preview_conflict_ids(selected_result, result)
        except ValueError as exc:
            return {"ok": False, "error": str(exc), "status": 409, "error_code": "IMPORT_PREVIEW_CONFLICT"}
        result = selected_result

    blockers = result.get("blockers") or []
    if blockers:
        return {"ok": False, "error": "存在阻断项（如缺失照片），无法提交导入", "blockers": blockers, "status": 400}

    # 验证所有 conflict 都有 decision
    for c in result.get("conflicts") or []:
        cid = c.get("conflictId")
        if cid not in decisions:
            return {"ok": False, "error": f"冲突 {cid} 尚未处理", "status": 400}
        d = decisions[cid]
        if not isinstance(d, dict):
            return {"ok": False, "error": f"冲突 {cid} 的决策格式不正确", "status": 400}
        action = d.get("action", "")
        supported_actions = {
            "field_conflict": ("apply_field_choices",),
            "project_name_conflict": ("merge_into_existing", "rename_import"),
            "stage_name_conflict": ("merge_into_existing", "rename_import"),
            "task_name_conflict": ("merge_into_existing", "rename_import"),
            "sample_identity_conflict": ("merge_into_existing", "import_as_new_with_identity_edit"),
            "task_occupancy_conflict": ("skip_occupancy", "import_no_occupy"),
        }
        if not isinstance(action, str) or action not in {*supported_actions.get(c.get("type"), ()), "skip"}:
            return {"ok": False, "error": f"冲突 {cid} 的处理方式无效", "status": 400}
        if d.get("targetId") is not None and not isinstance(d["targetId"], str):
            return {"ok": False, "error": f"冲突 {cid} 的目标 ID 格式不正确", "status": 400}
        if "fieldChoices" in d and (not isinstance(d["fieldChoices"], dict) or any(
            value not in ("current", "incoming") for value in d["fieldChoices"].values()
        )):
            return {"ok": False, "error": f"冲突 {cid} 的字段选择格式不正确", "status": 400}
        if action == "rename_import":
            # 项目/阶段/任务改名导入：必须有 newName
            if not isinstance(d.get("newName"), str) or not d["newName"].strip():
                return {"ok": False, "error": f"冲突 {cid} 选择改名导入但未提供新名称", "status": 400}
        elif action == "import_as_new_with_identity_edit":
            if any(not isinstance(d.get(key, ""), str) for key in ("newSN", "newIMEI", "newBoardSn", "newSampleNo")):
                return {"ok": False, "error": f"冲突 {cid} 的样机标识格式不正确", "status": 400}
            # 样机标识编辑导入：必须有至少一个新标识字段
            new_sn = (d.get("newSN") or "").strip()
            new_imei = (d.get("newIMEI") or "").strip()
            new_board_sn = (d.get("newBoardSn") or "").strip()
            new_sample_no = (d.get("newSampleNo") or "").strip()
            if not new_sn and not new_imei and not new_board_sn and not new_sample_no:
                return {"ok": False, "error": f"冲突 {cid} 选择编辑标识导入但未提供新 SN/IMEI/主板SN/编号", "status": 400}
        elif action == "apply_field_choices":
            if not isinstance(d.get("fieldChoices") or {}, dict):
                return {"ok": False, "error": f"冲突 {cid} 的字段选择格式不正确", "status": 400}

    # Commit merge does not need full photo/event arrays for the whole library.
    # Existing photos for touched samples are loaded selectively before photo merge.
    if current_data is None:
        current_data, _, _ = get_state(compact=True)
    existing_sample_ids_before_import = set(_sample_index_by_id(current_data).keys())
    existing_task_samples = {
        (str(task.get("id") or ""), str(sid))
        for project in current_data.get("projects") or []
        for stage in project.get("stages") or []
        for task in stage.get("tasks") or []
        for sid in task.get("sampleIds") or []
    }

    incoming = copy.deepcopy(incoming_payload)
    source_manifest = (result.get("source") or {})
    asset_lookup = chamber_package.sample_photo_asset_lookup(asset_index)

    def import_asset_source(incoming_sample_id: str, photo: dict, role: str, fallback_relative_path: str) -> tuple[Path | None, str]:
        photo_id = str(photo.get("id") or "")
        asset = asset_lookup.get((str(incoming_sample_id), photo_id, role))
        if asset:
            zip_path = str(asset.get("zipPath") or "")
            source_path = chamber_package.safe_package_member_path(tmp_dir, zip_path)
            filename = Path(str(asset.get("fileName") or Path(zip_path).name or Path(fallback_relative_path).name)).name
            return source_path, filename
        return None, ""

    # 构建决策索引
    decision_map: dict[str, dict] = {}
    for c in result.get("conflicts") or []:
        cid = c.get("conflictId", "")
        if cid in decisions:
            decision_map[cid] = decisions[cid]

    # ── 处理项目 ──
    curr_projects = {p["id"]: p for p in (current_data.setdefault("projects", []))}
    incoming_projects_by_id = {p["id"]: p for p in (incoming.get("projects") or [])}

    stats = {"projectsAdded": 0, "projectsMerged": 0, "stagesAdded": 0, "stagesMerged": 0,
             "tasksAdded": 0, "tasksMerged": 0, "samplesAdded": 0, "samplesMerged": 0,
             "photosAdded": 0, "sampleEventsAdded": 0, "skipped": 0}

    # ── ID 映射表（incoming → target），所有写入必须经此重映射 ──
    project_id_map: dict[str, str] = {}  # incomingPID → targetPID
    stage_id_map: dict[str, str] = {}    # incomingSID → targetSID
    task_id_map: dict[str, str] = {}     # incomingTID → targetTID
    sample_id_map: dict[str, str] = {}   # incomingSampleID → targetSampleID
    sample_category_id_map: dict[str, str] = {}
    skipped_sample_ids: set[str] = set()
    fully_imported_project_ids: set[str] = set()
    fully_imported_stage_ids: set[str] = set()
    touched_structure_project_ids: set[str] = set()
    skipped_reservations: set[tuple[str, str]] = set()
    conditional_occupancy_targets: dict[tuple[str, str], str] = {}

    for auto in result.get("autoApply") or []:
        atype = auto["type"]
        if atype == "new_project":
            pid = auto["id"]
            if pid not in curr_projects and pid in incoming_projects_by_id:
                project = copy.deepcopy(incoming_projects_by_id[pid])
                curr_projects[pid] = project
                stats["projectsAdded"] += 1
                project_id_map[pid] = pid
                stage_count, task_count, stage_ids = _register_imported_project_tree(project, stage_id_map, task_id_map)
                stats["stagesAdded"] += stage_count
                stats["tasksAdded"] += task_count
                fully_imported_project_ids.add(pid)
                fully_imported_stage_ids.update(stage_ids)
                touched_structure_project_ids.add(pid)
        elif atype == "new_stage":
            proj_id = auto.get("projectId", "")
            sid = auto["id"]
            target_project_id = project_id_map.get(proj_id, proj_id)
            if proj_id in fully_imported_project_ids or sid in fully_imported_stage_ids:
                continue
            if target_project_id in curr_projects and proj_id in incoming_projects_by_id:
                inc_proj = incoming_projects_by_id[proj_id]
                for inc_stage in inc_proj.get("stages") or []:
                    if inc_stage.get("id") == sid:
                        stage = copy.deepcopy(inc_stage)
                        curr_projects[target_project_id].setdefault("stages", []).append(stage)
                        stats["stagesAdded"] += 1
                        _, task_count, stage_id = _register_imported_stage_tree(stage, stage_id_map, task_id_map)
                        stats["tasksAdded"] += task_count
                        if stage_id:
                            fully_imported_stage_ids.add(stage_id)
                        touched_structure_project_ids.add(target_project_id)
                        break
        elif atype == "new_task":
            proj_id = auto.get("projectId", "")
            stage_id = auto.get("stageId", "")
            tid = auto["id"]
            target_project_id = project_id_map.get(proj_id, proj_id)
            target_stage_id = stage_id_map.get(stage_id, stage_id)
            if proj_id in fully_imported_project_ids or stage_id in fully_imported_stage_ids:
                continue
            if target_project_id in curr_projects and proj_id in incoming_projects_by_id:
                inc_proj = incoming_projects_by_id[proj_id]
                for inc_stage in inc_proj.get("stages") or []:
                    if inc_stage.get("id") == stage_id:
                        for inc_task in inc_stage.get("tasks") or []:
                            if inc_task.get("id") == tid:
                                curr_stages = curr_projects[target_project_id].setdefault("stages", [])
                                for cs in curr_stages:
                                    if cs.get("id") == target_stage_id:
                                        cs.setdefault("tasks", []).append(copy.deepcopy(inc_task))
                                        stats["tasksAdded"] += 1
                                        task_id_map[tid] = tid
                                        touched_structure_project_ids.add(target_project_id)
                                        break
                                break
                        break
        elif atype == "new_sample":
            sid = auto["id"]
            # 稍后处理

    # 处理样机类别索引（field_conflict 中 sample 类型需要）
    curr_categories = {c["id"]: c for c in (current_data.setdefault("sampleLibrary", {})).setdefault("categories", [])}
    incoming_cats_by_id = {}
    for cat in (incoming.get("sampleLibrary") or {}).get("categories") or []:
        incoming_cats_by_id[cat["id"]] = cat
        for s in cat.get("samples") or []:
            incoming_cats_by_id[s["id"]] = s

    # 处理项目级冲突
    for c in result.get("conflicts") or []:
        cid = c["conflictId"]
        d = decision_map.get(cid, {})
        action = d.get("action", "skip")
        etype = c.get("entity")

        # ── 硬规则：未实现冲突类型必须报错 ──
        ctype = c.get("type", "unknown")
        SUPPORTED = ("field_conflict", "project_name_conflict",
                     "stage_name_conflict", "task_name_conflict",
                     "sample_identity_conflict", "task_occupancy_conflict")
        if ctype not in SUPPORTED:
            return {"ok": False,
                    "error": f"不支持的冲突类型: {ctype} (冲突 {cid})",
                    "error_code": "UNSUPPORTED_IMPORT_CONFLICT", "status": 400}

        # ── field_conflict：统一处理所有实体类型 ──
        if c.get("type") == "field_conflict":
            if action == "apply_field_choices":
                field_choices = d.get("fieldChoices", {})
                target_id = c.get("currentId")
                inc_id = c.get("incomingId")
                if etype == "project":
                    if target_id in curr_projects and inc_id in incoming_projects_by_id:
                        curr_p = curr_projects[target_id]
                        inc_p = incoming_projects_by_id[inc_id]
                        import_commit.apply_import_field_choices(curr_p, inc_p, c.get("diffFields", []), field_choices)
                        stats["projectsMerged"] += 1
                        project_id_map[inc_id] = target_id
                        touched_structure_project_ids.add(target_id)
                elif etype == "stage":
                    # 在当前主库中查找 stage
                    for proj_id, proj in curr_projects.items():
                        for stage in proj.get("stages") or []:
                            if stage.get("id") == target_id:
                                inc_stage = _find_incoming_stage(incoming_projects_by_id, inc_id)
                                if inc_stage:
                                    import_commit.apply_import_field_choices(stage, inc_stage, c.get("diffFields", []), field_choices)
                                if inc_id:
                                    stage_id_map[inc_id] = target_id
                                touched_structure_project_ids.add(proj_id)
                                break
                elif etype == "task":
                    for proj_id, proj in curr_projects.items():
                        for stage in proj.get("stages") or []:
                            for task in stage.get("tasks") or []:
                                if task.get("id") == target_id:
                                    inc_task = _find_incoming_task(incoming_projects_by_id, inc_id)
                                    if inc_task:
                                        import_commit.apply_import_field_choices(task, inc_task, c.get("diffFields", []), field_choices)
                                    if inc_id:
                                        task_id_map[inc_id] = target_id
                                    touched_structure_project_ids.add(proj_id)
                                    break
                elif etype == "sample":
                    for cat_id, cat in curr_categories.items():
                        for cs in cat.get("samples") or []:
                            if cs.get("id") == target_id:
                                inc_sample = incoming_cats_by_id.get(inc_id)
                                if inc_sample and isinstance(inc_sample, dict):
                                    import_commit.apply_import_field_choices(cs, inc_sample, c.get("diffFields", []), field_choices)
                                sample_id_map[inc_id] = target_id
                                stats["samplesMerged"] += 1
                                break
            elif action == "skip":
                if etype == "sample" and c.get("incomingId"):
                    skipped_sample_ids.add(str(c.get("incomingId")))
                stats["skipped"] += 1
            continue  # field_conflict 已处理，跳过后续 entity 特定逻辑

        if etype == "project":
            ipid = c.get("incomingId")
            if action == "merge_into_existing":
                target_id = d.get("targetId") or c.get("preferredMergeTarget") or c.get("currentId")
                if ipid in incoming_projects_by_id and target_id in curr_projects:
                    # 合并：追加子数据（阶段/任务），不覆盖项目主字段
                    inc_proj = incoming_projects_by_id[ipid]
                    curr_proj = curr_projects[target_id]
                    _merge_project_sub_data(curr_proj, inc_proj)
                    stats["projectsMerged"] += 1
                    project_id_map[ipid] = target_id
                    touched_structure_project_ids.add(target_id)
            elif action == "rename_import":
                new_name = d.get("newName", "").strip()
                if new_name and ipid in incoming_projects_by_id:
                    inc_proj = incoming_projects_by_id[ipid]
                    inc_proj["name"] = new_name
                    project = copy.deepcopy(inc_proj)
                    curr_projects[ipid] = project
                    stats["projectsAdded"] += 1
                    project_id_map[ipid] = ipid
                    stage_count, task_count, stage_ids = _register_imported_project_tree(project, stage_id_map, task_id_map)
                    stats["stagesAdded"] += stage_count
                    stats["tasksAdded"] += task_count
                    fully_imported_stage_ids.update(stage_ids)
                    touched_structure_project_ids.add(ipid)
            elif action == "skip":
                stats["skipped"] += 1

        # ── stage_name_conflict ──
        elif c.get("type") == "stage_name_conflict":
            inc_sid = c.get("incomingId")
            inc_stage = _find_incoming_stage(incoming_projects_by_id, inc_sid)
            if action == "merge_into_existing":
                target_id = d.get("targetId") or c.get("preferredMergeTarget") or c.get("currentId")
                if inc_stage and target_id:
                    for proj_id, proj in curr_projects.items():
                        for st in proj.get("stages") or []:
                            if st.get("id") == target_id:
                                existing_task_ids = {t.get("id") for t in (st.get("tasks") or [])}
                                for inc_task in inc_stage.get("tasks") or []:
                                    tid = inc_task.get("id", "")
                                    if tid and tid not in existing_task_ids:
                                        st.setdefault("tasks", []).append(copy.deepcopy(inc_task))
                                        stats["tasksAdded"] += 1
                                        existing_task_ids.add(tid)
                                stats["stagesMerged"] += 1
                                stage_id_map[inc_sid] = target_id
                                touched_structure_project_ids.add(proj_id)
                                break
            elif action == "rename_import":
                new_name = d.get("newName", "").strip()
                if new_name and inc_stage and inc_sid:
                    inc_stage["name"] = new_name
                    # 查找 stage 所属的 incoming project，经 project_id_map 定位 target project
                    for inc_pid, inc_proj in incoming_projects_by_id.items():
                        found = any(s.get("id") == inc_sid for s in (inc_proj.get("stages") or []))
                        if found:
                            target_pid = project_id_map.get(inc_pid, inc_pid)
                            if target_pid in curr_projects:
                                stage = copy.deepcopy(inc_stage)
                                curr_projects[target_pid].setdefault("stages", []).append(stage)
                                stats["stagesAdded"] += 1
                                _, task_count, stage_id = _register_imported_stage_tree(stage, stage_id_map, task_id_map)
                                stats["tasksAdded"] += task_count
                                if stage_id:
                                    fully_imported_stage_ids.add(stage_id)
                                touched_structure_project_ids.add(target_pid)
                                stage_id_map[inc_sid] = inc_sid
                            break
            elif action == "skip":
                stats["skipped"] += 1

        # ── task_name_conflict ──
        elif c.get("type") == "task_name_conflict":
            inc_tid = c.get("incomingId")
            inc_task = _find_incoming_task(incoming_projects_by_id, inc_tid)
            if action == "merge_into_existing":
                target_id = d.get("targetId") or c.get("preferredMergeTarget") or c.get("currentId")
                if inc_task and target_id:
                    for proj_id, proj in curr_projects.items():
                        for st in proj.get("stages") or []:
                            for tk in st.get("tasks") or []:
                                if tk.get("id") == target_id:
                                    # 合并日志/结果
                                    for subkey in ("logs", "resultUploads", "sampleFaultRecords", "removedSampleRecords"):
                                        existing_hashes = {_content_hash(x) for x in (tk.get(subkey) or [])}
                                        for item in (inc_task.get(subkey) or []):
                                            if _content_hash(item) not in existing_hashes:
                                                tk.setdefault(subkey, []).append(copy.deepcopy(item))
                                                existing_hashes.add(_content_hash(item))
                                    stats["tasksMerged"] += 1
                                    task_id_map[inc_tid] = target_id
                                    touched_structure_project_ids.add(proj_id)
                                    break
            elif action == "rename_import":
                new_name = d.get("newName", "").strip()
                if new_name and inc_task and inc_tid:
                    inc_task["testItem"] = new_name
                    # 找到 task 所属的 stage → project，经映射定位
                    for inc_pid, inc_proj in incoming_projects_by_id.items():
                        for inc_st in (inc_proj.get("stages") or []):
                            for inc_tk in (inc_st.get("tasks") or []):
                                if inc_tk.get("id") == inc_tid:
                                    target_pid = project_id_map.get(inc_pid, inc_pid)
                                    target_sid = stage_id_map.get(inc_st.get("id"), inc_st.get("id"))
                                    if target_pid in curr_projects:
                                        for cs in curr_projects[target_pid].get("stages") or []:
                                            if cs.get("id") == target_sid:
                                                cs.setdefault("tasks", []).append(copy.deepcopy(inc_task))
                                                stats["tasksAdded"] += 1
                                                task_id_map[inc_tid] = inc_tid
                                                touched_structure_project_ids.add(target_pid)
                                                break
                                    break
            elif action == "skip":
                stats["skipped"] += 1

        # ── task_occupancy_conflict ──
        elif c.get("type") == "task_occupancy_conflict":
            sid = c.get("sampleId")
            if action in ("skip_occupancy", "import_no_occupy", "skip"):
                if sid and c.get("incomingTaskId"):
                    reservation_key = (str(c["incomingTaskId"]), str(sid))
                    skipped_reservations.add(reservation_key)
                    if c.get("mergeTargetSampleId"):
                        conditional_occupancy_targets[reservation_key] = str(c["mergeTargetSampleId"])
                if action == "skip_occupancy" and sid:
                    # 清除导入样机的占用字段
                    for inc_cat in (incoming.get("sampleLibrary") or {}).get("categories") or []:
                        for inc_s in inc_cat.get("samples") or []:
                            if inc_s.get("id") == sid:
                                inc_s["currentTaskId"] = None
                                inc_s["currentProjectId"] = None
                                inc_s["currentStageId"] = None
                                inc_s["currentTestItem"] = None
                                break
                stats["skipped"] += 1

    # 处理样机
    curr_categories = {c["id"]: c for c in (current_data.setdefault("sampleLibrary", {})).setdefault("categories", [])}
    curr_category_names = {
        str(c.get("name") or "").strip().lower(): c
        for c in curr_categories.values()
        if str(c.get("name") or "").strip()
    }

    def ensure_target_sample_category(incoming_category: dict) -> dict:
        inc_id = str((incoming_category or {}).get("id") or "")
        inc_name = str((incoming_category or {}).get("name") or "")
        inc_name_key = inc_name.strip().lower()
        if inc_id and inc_id in curr_categories:
            sample_category_id_map[inc_id] = inc_id
            return curr_categories[inc_id]
        if inc_name_key and inc_name_key in curr_category_names:
            target = curr_category_names[inc_name_key]
            target_id = str(target.get("id") or "")
            if inc_id and target_id:
                sample_category_id_map[inc_id] = target_id
            return target

        target_id = inc_id or f"cat_{uuid.uuid4().hex[:12]}"
        while target_id in curr_categories:
            target_id = f"cat_{uuid.uuid4().hex[:12]}"
        target = copy.deepcopy(incoming_category or {})
        target["id"] = target_id
        target["name"] = str(target.get("name") or inc_name or "未命名样机池")
        target["description"] = str(target.get("description") or "")
        target["samples"] = []
        curr_categories[target_id] = target
        if inc_name_key:
            curr_category_names[inc_name_key] = target
        if inc_id:
            sample_category_id_map[inc_id] = target_id
        return target

    incoming_cats_by_id = {}
    for cat in (incoming.get("sampleLibrary") or {}).get("categories") or []:
        incoming_cats_by_id[cat["id"]] = cat
        ensure_target_sample_category(cat)
        for s in cat.get("samples") or []:
            incoming_cats_by_id[s["id"]] = s  # 也索引样机

    # 新增样机
    for auto in result.get("autoApply") or []:
        if auto["type"] == "new_sample":
            sid = auto["id"]
            # 找到样机所属类别并添加
            for inc_cat in (incoming.get("sampleLibrary") or {}).get("categories") or []:
                for inc_s in inc_cat.get("samples") or []:
                    if inc_s.get("id") == sid:
                        target_cat = ensure_target_sample_category(inc_cat)
                        target_sample = copy.deepcopy(inc_s)
                        target_sample["categoryId"] = str(target_cat.get("id") or "")
                        target_cat.setdefault("samples", []).append(target_sample)
                        stats["samplesAdded"] += 1
                        sample_id_map[sid] = sid
                        break

    # 处理样机冲突
    for c in result.get("conflicts") or []:
        if c.get("entity") != "sample":
            continue
        cid = c["conflictId"]
        d = decision_map.get(cid, {})
        action = d.get("action", "skip")

        if c["type"] == "sample_identity_conflict":
            if action == "merge_into_existing":
                target_id = d.get("targetId") or c.get("preferredMergeTarget") or c.get("currentId")
                inc_id = c.get("incomingId")
                # 找到导入样机
                inc_sample = None
                for cat in (incoming.get("sampleLibrary") or {}).get("categories") or []:
                    for s in cat.get("samples") or []:
                        if s.get("id") == inc_id:
                            inc_sample = s
                            break
                if inc_sample and target_id:
                    # 找到主库样机并合并
                    for cat_id, cat in curr_categories.items():
                        for cs in cat.get("samples") or []:
                            if cs.get("id") == target_id:
                                # 逐字段选择
                                field_choices = d.get("fieldChoices", {})
                                import_commit.apply_import_field_choices(cs, inc_sample, c.get("mergeableFields", []), field_choices)
                                # 追加子数据
                                sub_data_keys = c.get("autoMergeSubData", [])
                                for subk in sub_data_keys:
                                    if subk == "photos":
                                        # Central photo merge below loads only the touched
                                        # target sample photos before appending incoming photos.
                                        continue
                                    elif subk == "problemRecords":
                                        # Stable problem IDs and photo links are merged
                                        # once by merge_import_sample_subrecords below.
                                        continue
                                stats["samplesMerged"] += 1
                                sample_id_map[inc_id] = target_id
                                break
            elif action == "import_as_new_with_identity_edit":
                inc_id = c.get("incomingId")
                new_sn = d.get("newSN", "").strip()
                new_imei = d.get("newIMEI", "").strip()
                new_board_sn = d.get("newBoardSn", "").strip()
                new_sample_no = d.get("newSampleNo", "").strip()
                # 找到导入样机
                inc_sample = None
                inc_cat = None
                for cat in (incoming.get("sampleLibrary") or {}).get("categories") or []:
                    for s in cat.get("samples") or []:
                        if s.get("id") == inc_id:
                            inc_sample = s
                            inc_cat = cat
                            break
                if inc_sample:
                    if new_sn:
                        inc_sample["sn"] = new_sn
                    if new_imei:
                        inc_sample["imei"] = new_imei
                    if new_board_sn:
                        inc_sample["boardSn"] = new_board_sn
                    if new_sample_no:
                        inc_sample["sampleNo"] = new_sample_no
                    target_cat = ensure_target_sample_category(inc_cat or {})
                    target_sample = copy.deepcopy(inc_sample)
                    target_sample["categoryId"] = str(target_cat.get("id") or "")
                    target_cat.setdefault("samples", []).append(target_sample)
                    stats["samplesAdded"] += 1
                    sample_id_map[inc_id] = inc_id
            elif action == "skip":
                if c.get("incomingId"):
                    skipped_sample_ids.add(str(c.get("incomingId")))
                stats["skipped"] += 1

    incoming_sample_ids = {
        str(sample.get("id"))
        for cat in (incoming.get("sampleLibrary") or {}).get("categories") or []
        for sample in (cat.get("samples") or [])
        if sample.get("id")
    }
    current_sample_ids = {
        str(sample.get("id"))
        for cat in curr_categories.values()
        for sample in (cat.get("samples") or [])
        if sample.get("id")
    }
    for sid in incoming_sample_ids:
        if sid in current_sample_ids and sid not in skipped_sample_ids:
            sample_id_map.setdefault(sid, sid)

    current_data["sampleLibrary"]["categories"] = list(curr_categories.values())
    current_data["projects"] = list(curr_projects.values())

    hydrate_import_target_photos(current_data, incoming, sample_id_map, existing_sample_ids_before_import)
    file_target_ids = set(sample_id_map.values()) & existing_sample_ids_before_import
    with closing(ctx.connect_db()) as file_conn:
        for sid, sample in _sample_index_by_id(current_data).items():
            if sid in file_target_ids:
                sample["files"] = sample_files.load_files(file_conn, sid)
    # Only new photo metadata receives incoming files. Existing photos retain
    # their own content even when another deployment reused the same photo ID.
    existing_photo_ids = {
        (sid, str(photo.get("id") or ""))
        for sid, sample in _sample_index_by_id(current_data).items()
        if sid in existing_sample_ids_before_import
        for photo in [*(sample.get("photos") or []), *(sample.get("files") or [])]
    }
    photo_sources = {}
    incoming_samples_by_id = _sample_index_by_id(incoming)
    for incoming_sid, target_sid in sample_id_map.items():
        incoming_sample = incoming_samples_by_id.get(incoming_sid) or {}
        for photo in [*(incoming_sample.get("photos") or []), *(incoming_sample.get("files") or [])]:
            key = (target_sid, str(photo.get("id") or ""))
            if key not in existing_photo_ids:
                photo_sources.setdefault(key, incoming_sid)
    photo_owners = {pid: sid for sid, pid in photo_sources}
    new_photo_ids = sorted(photo_owners)
    with closing(ctx.connect_db()) as asset_conn:
        for offset in range(0, len(new_photo_ids), 400):
            batch = new_photo_ids[offset:offset + 400]
            placeholders = ",".join("?" for _ in batch)
            for row in asset_conn.execute(f"SELECT id, sample_id FROM sample_assets WHERE id IN ({placeholders})", batch):
                if photo_owners[row["id"]] != row["sample_id"]:
                    return {"ok": False, "status": 400, "error_code": "IMPORT_PHOTO_ID_CONFLICT",
                            "error": f"照片 ID {row['id']} 已属于其他样机，无法覆盖导入"}
    _merge_import_sample_subrecords(current_data, incoming, sample_id_map)

    # ── 重新生成样机数据，同步到 SQLite ──
    # 将 categories dict 转回 list
    current_data["sampleLibrary"]["categories"] = list(curr_categories.values())
    current_data["projects"] = list(curr_projects.values())

    for project in current_data.get("projects") or []:
        default_category_id = str(project.get("defaultSampleCategoryId") or "")
        if default_category_id in sample_category_id_map:
            project["defaultSampleCategoryId"] = sample_category_id_map[default_category_id]

    # ── 统一 ID 重映射：所有交叉引用经映射表重写 ──
    _apply_id_maps(current_data, project_id_map, stage_id_map, task_id_map, sample_id_map)
    # Occupancy belongs to task.sampleIds. Clearing only a sample's cached
    # currentTaskId leaves the imported reservation active and always fails the
    # final conflict check. Keep history as a removed sample, without touching
    # the main library's pre-existing reservation.
    samples_by_id = _sample_index_by_id(current_data)
    for incoming_tid, incoming_sid in skipped_reservations:
        target_tid = task_id_map.get(incoming_tid)
        target_sid = sample_id_map.get(incoming_sid, incoming_sid)
        if not target_tid:
            continue
        required_target = conditional_occupancy_targets.get((incoming_tid, incoming_sid))
        if required_target and target_sid != required_target:
            continue  # The user imported a new identity instead of merging it.
        if (target_tid, target_sid) in existing_task_samples:
            continue  # Merging history must not remove the main task's reservation.
        for project in current_data.get("projects") or []:
            for stage in project.get("stages") or []:
                for task in stage.get("tasks") or []:
                    if task.get("id") != target_tid or target_sid not in (task.get("sampleIds") or []):
                        continue
                    task["sampleIds"] = [sid for sid in task["sampleIds"] if sid != target_sid]
                    sample = samples_by_id.get(target_sid) or {}
                    task.setdefault("removedSampleRecords", []).append({
                        "id": f"removed_{uuid.uuid4().hex}", "sampleId": target_sid,
                        "sampleNo": sample.get("sampleNo") or sample.get("sn") or target_sid,
                        "sn": sample.get("sn") or "", "imei": sample.get("imei") or "",
                        "boardSn": sample.get("boardSn") or "", "removedAt": ctx.now_iso(),
                        "user": "数据导入", "reason": "导入时跳过冲突占用关系",
                    })
                    touched_structure_project_ids.add(str(project.get("id") or ""))
    stats["sampleEventsAdded"] = _merge_import_sample_events(
        current_data, incoming, project_id_map, stage_id_map, task_id_map, sample_id_map
    )
    validation_errors = _validate_import_commit_state(current_data, touched_structure_project_ids)
    try:
        equipment_import.merge_referenced_equipment(current_data, incoming, set(task_id_map.values()),
            source_deployment_id=str(source_manifest.get("sourceDeploymentId") or ""), sample_ids=set(sample_id_map.values()))
        chamber_package.validate_state_structure(current_data)
    except ValueError as exc:
        validation_errors.append(str(exc))
    if validation_errors:
        _cleanup_preview_temp(preview_id)
        import_preview_cache.remove_entry(_IMPORT_PREVIEWS, preview_id)
        return {
            "ok": False,
            "error": "导入后数据一致性校验失败：" + "；".join(validation_errors[:3]),
            "error_code": "IMPORT_STATE_VALIDATION_FAILED",
            "validationErrors": validation_errors,
            "status": 400,
        }

    import_remark = f"导入数据包 (deployment={source_manifest.get('sourceDeploymentId','?')})"
    try:
        with staged_import_assets(ctx, current_data, photo_sources, import_asset_source, asset_lookup) as assets:
            import_commit.rewrite_import_photo_references(current_data, url_for_asset=ctx.url_for_asset,
                                                         thumbnail_asset_id=ctx.thumbnail_asset_id)
            ok, resp = commit_merged_import_state(
                ctx, current_data, preview_revision, "import-bundle", import_remark, "数据导入",
                imported_sample_ids=set(sample_id_map.values()),
            )
            assets["committed"] = ok
            stats["photosAdded"] = assets["photoCount"]
    except (OSError, ValueError) as exc:
        return {"ok": False, "error": str(exc), "status": 400}

    if not ok:
        _cleanup_preview_temp(preview_id)
        import_preview_cache.remove_entry(_IMPORT_PREVIEWS, preview_id)
        return {"ok": False, **resp, "error": resp.get("error", "写入失败"), "status": resp.get("status", 500)}

    _cleanup_preview_temp(preview_id)
    import_preview_cache.remove_entry(_IMPORT_PREVIEWS, preview_id)

    revision = resp.get("revision", 0)
    stats["sampleEventsAdded"] = resp.get("sampleEventsAdded", stats["sampleEventsAdded"])
    mutation_summary = _build_import_mutation_summary(
        current_data,
        project_id_map,
        stage_id_map,
        task_id_map,
        sample_id_map,
        touched_structure_project_ids,
        sample_category_id_map,
    )
    return {
        "ok": True,
        "stats": stats,
        "revision": revision,
        "newRevision": revision,
        "updated_at": resp.get("updated_at", ""),
        "mutationSummary": mutation_summary,
    }


def sample_archive_default_decisions(result: dict) -> dict:
    decisions: dict[str, dict] = {}
    for conflict in result.get("conflicts") or []:
        cid = conflict.get("conflictId")
        if not cid:
            continue
        if conflict.get("type") == "sample_identity_conflict":
            decisions[cid] = {
                "action": "merge_into_existing",
                "targetId": conflict.get("preferredMergeTarget") or conflict.get("currentId"),
                "fieldChoices": {},
            }
        elif conflict.get("type") == "field_conflict" and conflict.get("entity") == "sample":
            decisions[cid] = {
                "action": "apply_field_choices",
                "fieldChoices": {field: "current" for field in conflict.get("diffFields") or []},
            }
        else:
            decisions[cid] = {"action": "skip"}
    return decisions


def commit_sample_archive(ctx: ImportBundleCommitContext, payload: dict) -> dict:
    return _commit_with_preview_claim(ctx, payload, _commit_sample_archive)


def _commit_sample_archive(ctx: ImportBundleCommitContext, payload: dict) -> dict:
    preview_id = payload.get("previewId", "")
    ctx.cleanup_expired_previews()
    entry = ctx.import_previews.get(preview_id)
    if not entry:
        return {"ok": False, "error": "previewId 无效或已过期", "status": 400}
    incoming, result = ctx.load_import_preview_payload(entry)
    package_kind = str((result or {}).get("packageKind") or "")
    scope = str((result or {}).get("scope") or "")
    projects = incoming.get("projects") if isinstance(incoming, dict) else None
    categories = ((incoming.get("sampleLibrary") or {}).get("categories") or []) if isinstance(incoming, dict) else []
    samples = [
        sample
        for category in categories
        if isinstance(category, dict)
        for sample in (category.get("samples") or [])
        if isinstance(sample, dict)
    ]
    if package_kind != "sample-archive" or scope != "selected-samples" or projects != [] or len(samples) != 1:
        return {
            "ok": False,
            "error": "previewId 不属于有效的单台样机档案预览",
            "status": 400,
        }
    decisions = payload.get("decisions")
    if decisions is not None and not isinstance(decisions, dict):
        return {"ok": False, "error": "导入决策格式不正确", "status": 400}
    if not decisions:
        decisions = sample_archive_default_decisions(result or {})
    next_payload = {
        "previewId": preview_id,
        "decisions": decisions,
    }
    return _commit_import_bundle(ctx, next_payload)
