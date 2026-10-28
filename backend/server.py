#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
数字治理平台 V7 内网协同版服务器

V7 的核心变化：
- 前端代码统一保存在项目根目录 frontend/ 中。
- 后端代码统一保存在项目根目录 backend/ 中。
- 业务数据统一保存在项目根目录 data/ 下。
- 样机库从大 JSON 中外置到 SQLite 表。
- 样机照片等大文件保存到 data/samples/<sampleId>/，SQLite 只保存索引。
"""

from __future__ import annotations

import sqlite3
import sys
import threading
import time
import zipfile
from contextlib import contextmanager
from pathlib import Path
from types import SimpleNamespace

PROJECT_ROOT = Path(__file__).resolve().parents[1]
BACKEND_DIR = PROJECT_ROOT / "backend"
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

from server_modules import app_metadata, bundle_preview_service, chamber_package, database_schema, http_handler, http_helpers, http_multipart, http_routes, http_runtime, import_bundle_service, import_commit, import_diff, mutation_services, mutation_summary, project_library, project_queries, record_writers, runtime_paths, sample_assets, sample_constraints, sample_history, sample_library, sample_queries, server_runner, state_externalization, sample_asset_mutations, state_read_service, status_normalization, storage_core, task_mutation_rules, task_queries, version, zip_security


APP_VERSION = version.APP_VERSION
SERVER_VERSION = version.SERVER_VERSION
ThreadingHTTPServer = server_runner.ThreadingHTTPServer
ROOT_DIR = PROJECT_ROOT
FRONTEND_DIR = ROOT_DIR / "frontend"
DATA_ROOT_ENV_VAR = runtime_paths.DATA_ROOT_ENV_VAR
DATA_ROOT_MARKER_FILE = runtime_paths.DATA_ROOT_MARKER_FILE
DATA_ROOT_SCHEMA = runtime_paths.DATA_ROOT_SCHEMA
DEFAULT_DATA_DIR = runtime_paths.default_data_dir(ROOT_DIR)
_RUNTIME_PATHS = runtime_paths.build_runtime_paths(runtime_paths.resolve_data_root(ROOT_DIR))
DATA_DIR = _RUNTIME_PATHS.data_dir
SAMPLE_DATA_DIR = _RUNTIME_PATHS.sample_data_dir
IMPORT_PREVIEW_DIR = _RUNTIME_PATHS.import_preview_dir
EXPORT_DIR = _RUNTIME_PATHS.export_dir
DB_PATH = _RUNTIME_PATHS.db_path
INDEX_PATH = FRONTEND_DIR / "index.html"
MAX_UPLOAD_BYTES = 80 * 1024 * 1024
IMPORT_PREVIEW_TTL_SECONDS = 1800
IMPORT_PREVIEW_MAX_ENTRIES = 8
IMPORT_PREVIEW_MAX_STATE_BYTES = 120 * 1024 * 1024
IMPORT_PREVIEW_MAX_CACHED_BYTES = 240 * 1024 * 1024
MUTATION_RETURN_ROW_LIMIT = 100

DEPLOYMENT_FILE = _RUNTIME_PATHS.deployment_file
DB_LOCK = threading.Lock()

# 导入预览缓存只保存轻量元数据；大预览 payload 写入对应临时目录。
_IMPORT_PREVIEWS: dict[str, dict] = {}


def validate_data_root(path: Path) -> None:
    runtime_paths.validate_project_data_root(path, ROOT_DIR)


def _apply_runtime_paths(paths: runtime_paths.RuntimePaths) -> None:
    global _RUNTIME_PATHS, DATA_DIR, SAMPLE_DATA_DIR, IMPORT_PREVIEW_DIR, EXPORT_DIR, DB_PATH, DEPLOYMENT_FILE
    _RUNTIME_PATHS = paths
    DATA_DIR = paths.data_dir
    SAMPLE_DATA_DIR = paths.sample_data_dir
    IMPORT_PREVIEW_DIR = paths.import_preview_dir
    EXPORT_DIR = paths.export_dir
    DB_PATH = paths.db_path
    DEPLOYMENT_FILE = paths.deployment_file


def set_data_root(path_value=None) -> Path:
    """Configure the runtime data root without creating or migrating files."""
    data_root = runtime_paths.resolve_data_root(ROOT_DIR, path_value)
    validate_data_root(data_root)
    _apply_runtime_paths(runtime_paths.build_runtime_paths(data_root))
    return DATA_DIR


def prepare_runtime_data_root(path_value=None) -> runtime_paths.RuntimePaths:
    paths = runtime_paths.prepare_runtime_paths(ROOT_DIR, path_value)
    _apply_runtime_paths(paths)
    return paths


now_iso = app_metadata.now_iso


def empty_data() -> dict:
    return app_metadata.empty_data(APP_VERSION)


def ensure_dirs() -> None:
    runtime_paths.ensure_runtime_dirs(_RUNTIME_PATHS, platform_root=ROOT_DIR)


def load_deployment_id() -> str:
    return app_metadata.load_deployment_id(DEPLOYMENT_FILE)


def ensure_deployment_id() -> str:
    return app_metadata.ensure_deployment_id(DEPLOYMENT_FILE)


def connect_db() -> sqlite3.Connection:
    return storage_core.connect_db(DB_PATH)


@contextmanager
def write_db_connection():
    """Open a SQLite write transaction without taking the process-wide DB_LOCK."""
    with storage_core.write_db_connection_from_factory(connect_db) as conn:
        yield conn


json_dumps = app_metadata.json_dumps
stable_json = app_metadata.stable_json
json_obj = app_metadata.json_obj


def _asset_context() -> sample_assets.AssetStorageContext:
    return sample_assets.AssetStorageContext(DATA_DIR, SAMPLE_DATA_DIR, now_iso)


safe_segment = sample_assets.safe_segment
url_for_asset = sample_assets.url_for_asset
thumbnail_asset_id = sample_assets.thumbnail_asset_id
file_ext = sample_assets.file_ext


def path_inside_data(relative_path: str) -> Path:
    return sample_assets.path_inside_data(_asset_context(), relative_path)


iter_samples = state_externalization.iter_samples
find_sample = state_externalization.find_sample


def split_state_for_storage(data: dict) -> dict:
    return state_externalization.split_state_for_storage(data, APP_VERSION)


def ensure_schema(conn: sqlite3.Connection) -> None:
    database_schema.ensure_static_schema(conn)
    record_writers.prune_orphan_operational_logs(conn, clear_empty_platform_audit=True)


def normalize_photo_meta(sample_id: str, photo: dict) -> dict:
    return sample_assets.normalize_photo_meta(_asset_context(), sample_id, photo)


attach_thumbnail_meta = sample_assets.attach_thumbnail_meta


def store_asset_bytes(
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
    return sample_assets.store_asset_bytes(
        _asset_context(),
        conn,
        sample_id,
        content,
        original_name,
        mime_type,
        photo_id=photo_id,
        uploaded_at=uploaded_at,
        uploaded_by=uploaded_by,
    )


def write_sample_asset_file(
    sample_id: str,
    asset_id: str,
    content: bytes | Path,
    original_name: str,
    mime_type: str,
    *,
    uploaded_at: str | None = None,
    file_prefix: str = "photo",
) -> dict:
    return sample_assets.write_sample_asset_file(
        _asset_context(),
        sample_id,
        asset_id,
        content,
        original_name,
        mime_type,
        uploaded_at=uploaded_at,
        file_prefix=file_prefix,
    )


def upsert_sample_asset_meta(
    conn: sqlite3.Connection,
    sample_id: str,
    meta: dict,
    kind: str,
    *,
    uploaded_by: str = "",
) -> None:
    sample_assets.upsert_sample_asset_meta(_asset_context(), conn, sample_id, meta, kind, uploaded_by=uploaded_by)


def store_thumbnail_bytes(
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
    return sample_assets.store_thumbnail_bytes(
        _asset_context(),
        conn,
        sample_id,
        photo_id,
        content,
        original_name,
        mime_type,
        uploaded_at=uploaded_at,
        uploaded_by=uploaded_by,
    )


def upsert_existing_photo_asset(conn: sqlite3.Connection, sample_id: str, photo: dict) -> dict:
    return sample_assets.upsert_existing_photo_asset(_asset_context(), conn, sample_id, photo)


def normalize_sample_photos(conn: sqlite3.Connection, sample: dict) -> list[dict]:
    return sample_assets.normalize_sample_photos(_asset_context(), conn, sample)


def unlink_asset_relative_paths(relative_paths: list[str], *, warn_label: str = "删除资产文件") -> None:
    sample_assets.unlink_asset_relative_paths(_asset_context(), relative_paths, warn_label=warn_label)


sample_asset_relative_paths = sample_assets.sample_asset_relative_paths


def cleanup_sample_asset_files(conn: sqlite3.Connection, sample_ids: list[str]) -> None:
    sample_assets.cleanup_sample_asset_files(_asset_context(), conn, sample_ids)


def _sample_library_context() -> sample_library.SampleLibraryContext:
    return sample_library.SampleLibraryContext(
        asset_context=_asset_context(),
        now_iso=now_iso,
        json_dumps=json_dumps,
        json_obj=json_obj,
    )


def sync_sample_library(conn: sqlite3.Connection, data: dict, *, allow_empty: bool = False) -> bool:
    return sample_library.sync_sample_library(_sample_library_context(), conn, data, allow_empty=allow_empty)


load_sample_photos = sample_library.load_sample_photos
load_sample_photo_counts = sample_library.load_sample_photo_counts


def load_sample_events(conn: sqlite3.Connection, sample_id: str) -> list[dict]:
    return sample_library.load_sample_events(_sample_library_context(), conn, sample_id)


def load_sample_library(conn: sqlite3.Connection, *, include_photos: bool = True, include_logs: bool = True) -> dict:
    return sample_library.load_sample_library(_sample_library_context(), conn, include_photos=include_photos, include_logs=include_logs)


def _project_library_context() -> project_library.ProjectLibraryContext:
    return project_library.ProjectLibraryContext(
        now_iso=now_iso,
        json_dumps=json_dumps,
    )


def sync_project_library(conn: sqlite3.Connection, data: dict, *, allow_empty: bool = False) -> bool:
    return project_library.sync_project_library(_project_library_context(), conn, data, allow_empty=allow_empty)


load_project_library = project_queries.load_project_library
load_project_detail = project_queries.load_project_detail
first_query_value = task_queries.first_query_value
parse_page_params = task_queries.parse_page_params
paginate_list = task_queries.paginate_list
task_flow_status = task_queries.task_flow_status


def replace_task_sample_links(
    conn: sqlite3.Connection,
    task_id: str,
    project_id: str,
    stage_id: str,
    task: dict,
    sample_ids: list[str] | None = None,
) -> None:
    record_writers.replace_task_sample_links(conn, task_id, project_id, stage_id, task, sample_ids)


person_name_from_text = task_queries.person_name_from_text
task_search_text = task_queries.task_search_text
task_matches_query = task_queries.task_matches_query
query_value_present = task_queries.query_value_present
task_query_requires_python_scan = task_queries.task_query_requires_python_scan
task_sql_filter_parts = task_queries.task_sql_filter_parts
task_from_db_row = task_queries.task_from_db_row
load_task_logs_for = task_queries.load_task_logs_for
list_stage_tasks_page = task_queries.list_stage_tasks_page
load_sample_photo_counts_for = sample_queries.load_sample_photo_counts_for
sample_has_problem = sample_queries.sample_has_problem
sample_is_reassembled = sample_queries.sample_is_reassembled
sample_usage_status = sample_queries.sample_usage_status
sample_effective_status = sample_queries.sample_effective_status
sample_usage_status_sql_expr = sample_queries.sample_usage_status_sql_expr
sample_search_text = sample_queries.sample_search_text
sample_matches_query = sample_queries.sample_matches_query
sample_query_requires_python_scan = sample_queries.sample_query_requires_python_scan
sample_problem_state = sample_queries.sample_problem_state
sample_sql_filter_parts = sample_queries.sample_sql_filter_parts
sample_from_db_row = sample_queries.sample_from_db_row
list_sample_categories_summary = sample_queries.list_sample_categories_summary
list_samples_page = sample_queries.list_samples_page
query_id_list = task_queries.query_id_list
sample_candidate_keyword_where = task_queries.sample_candidate_keyword_where
open_task_occupancy_for_sample_ids = task_queries.open_task_occupancy_for_sample_ids
task_sample_candidate_from_row = task_queries.task_sample_candidate_from_row
decorate_task_sample_candidates = task_queries.decorate_task_sample_candidates
sample_identity_value = sample_constraints.sample_identity_value
sample_identity_key = sample_constraints.sample_identity_key
sample_identity_fields = sample_constraints.sample_identity_fields
sample_display_code = sample_constraints.sample_display_code
list_sample_destroy_impact_scope = sample_constraints.list_sample_destroy_impact_scope
compact_sample_identity_row = sample_constraints.compact_sample_identity_row
sample_identity_match_field = sample_constraints.sample_identity_match_field
check_sample_identity_conflicts = sample_constraints.check_sample_identity_conflicts
list_task_sample_candidates_page = task_queries.list_task_sample_candidates_page
sample_task_result_photos = sample_history.sample_task_result_photos
sample_history_row_for = sample_history.sample_history_row_for
list_sample_history_page = sample_history.list_sample_history_page


def load_sample_category_detail(conn: sqlite3.Connection, category_id: str, *, include_photos: bool = False) -> dict | None:
    return sample_queries.load_sample_category_detail(
        conn,
        category_id,
        include_photos=include_photos,
        load_sample_photos=load_sample_photos,
    )


def list_project_summary(conn: sqlite3.Connection) -> list[dict]:
    return project_queries.list_project_summary(conn)


def _state_read_context() -> state_read_service.StateReadContext:
    return state_read_service.StateReadContext(
        app_version=APP_VERSION,
        db_lock=DB_LOCK,
        connect_db=connect_db,
        ensure_dirs=ensure_dirs,
        ensure_deployment_id=ensure_deployment_id,
        ensure_schema=ensure_schema,
        empty_data=empty_data,
        now_iso=now_iso,
        json_obj=json_obj,
        json_dumps=json_dumps,
        split_state_for_storage=split_state_for_storage,
        list_project_summary=list_project_summary,
        list_sample_categories_summary=list_sample_categories_summary,
        load_project_library=load_project_library,
        load_sample_library=load_sample_library,
    )


def compose_bootstrap_state(conn: sqlite3.Connection) -> tuple[dict, int, str]:
    return state_read_service.compose_bootstrap_state(_state_read_context(), conn)


def compose_state(conn: sqlite3.Connection, *, include_sample_photos: bool = True, include_sample_logs: bool = True) -> tuple[dict, int, str]:
    return state_read_service.compose_state(
        _state_read_context(),
        conn,
        include_sample_photos=include_sample_photos,
        include_sample_logs=include_sample_logs,
    )


def begin_read_snapshot(conn: sqlite3.Connection) -> bool:
    return state_read_service.begin_read_snapshot(conn)


def init_db() -> None:
    state_read_service.init_db(_state_read_context())


def get_state(*, compact: bool = False) -> tuple[dict, int, str]:
    return state_read_service.get_state(_state_read_context(), compact=compact)


def get_state_metadata() -> tuple[int, str]:
    return state_read_service.get_state_metadata(_state_read_context())


# ── 导出/导入 bundle ────────────────────────────────────────────

def _bundle_preview_context() -> bundle_preview_service.BundlePreviewContext:
    return bundle_preview_service.BundlePreviewContext(
        app_version=APP_VERSION,
        server_version=SERVER_VERSION,
        data_dir=DATA_DIR,
        export_dir=EXPORT_DIR,
        import_preview_dir=IMPORT_PREVIEW_DIR,
        import_previews=_IMPORT_PREVIEWS,
        import_preview_ttl_seconds=IMPORT_PREVIEW_TTL_SECONDS,
        import_preview_max_entries=IMPORT_PREVIEW_MAX_ENTRIES,
        import_preview_max_state_bytes=IMPORT_PREVIEW_MAX_STATE_BYTES,
        import_preview_max_cached_bytes=IMPORT_PREVIEW_MAX_CACHED_BYTES,
        get_state=get_state,
        connect_db=connect_db,
        list_sample_history_page=list_sample_history_page,
        load_deployment_id=load_deployment_id,
        now_iso=now_iso,
        json_dumps=json_dumps,
        path_inside_data=path_inside_data,
        ensure_dirs=ensure_dirs,
        parse_multipart=parse_multipart,
    )


_preview_id = bundle_preview_service.preview_id


def _cleanup_expired_previews() -> None:
    bundle_preview_service.cleanup_expired_previews(_bundle_preview_context())


def _cleanup_preview_temp(preview_id: str) -> None:
    bundle_preview_service.cleanup_preview_temp(_bundle_preview_context(), preview_id)


def _store_import_preview_payload(tmp_path: Path, incoming: dict, result: dict) -> Path:
    return bundle_preview_service.store_import_preview_payload(_bundle_preview_context(), tmp_path, incoming, result)


_load_import_preview_payload = bundle_preview_service.load_import_preview_payload
_content_hash = import_commit.content_hash
_safe_extract_zip = zip_security.safe_extract_zip
_entity_label_for_conflict = import_diff.entity_label_for_conflict
_strip_view_state = import_diff.strip_view_state
_text_sha256 = bundle_preview_service.text_sha256


def prepare_export_bundle_parts(selection: dict | None = None) -> tuple[dict, dict, dict[str, str], dict, str]:
    return bundle_preview_service.prepare_export_bundle_parts(_bundle_preview_context(), selection=selection)


def write_export_bundle_zip(zf: zipfile.ZipFile, export_data: dict, package: dict, payloads: dict[str, str]) -> None:
    bundle_preview_service.write_export_bundle_zip(_bundle_preview_context(), zf, export_data, package, payloads)


def build_export_bundle_file(selection: dict | None = None) -> tuple[Path, str]:
    return bundle_preview_service.build_export_bundle_file(_bundle_preview_context(), selection=selection)


def build_sample_archive_file(sample_id: str) -> tuple[Path, str]:
    return bundle_preview_service.build_sample_archive_file(_bundle_preview_context(), sample_id)


def analyze_import_bundle(headers, raw_body: bytes) -> dict:
    return bundle_preview_service.analyze_import_bundle(_bundle_preview_context(), headers, raw_body)


def analyze_sample_archive(headers, raw_body: bytes) -> dict:
    return bundle_preview_service.analyze_import_bundle(_bundle_preview_context(), headers, raw_body)

_diff_import_bundle = import_diff.diff_import_bundle
_diff_stages = import_diff.diff_stages


IMPORT_DIFF_SYSTEM_SKIP_KEYS = import_diff.IMPORT_DIFF_SYSTEM_SKIP_KEYS


_diff_fields = import_diff.diff_fields
_sorted_nonempty_ids = mutation_summary.sorted_nonempty_ids


def load_task_rows_for_mutation(conn: sqlite3.Connection, task_ids) -> tuple[list[dict], bool]:
    return mutation_summary.load_task_rows_for_mutation(conn, task_ids, row_limit=MUTATION_RETURN_ROW_LIMIT)


def load_sample_rows_for_mutation(conn: sqlite3.Connection, sample_ids) -> tuple[list[dict], bool]:
    return mutation_summary.load_sample_rows_for_mutation(conn, sample_ids, row_limit=MUTATION_RETURN_ROW_LIMIT)


def build_mutation_affected_summary(conn: sqlite3.Connection,
                                    *,
                                    project_ids=None,
                                    stage_ids=None,
                                    task_ids=None,
                                    sample_category_ids=None,
                                    sample_ids=None) -> dict:
    return mutation_summary.build_mutation_affected_summary(
        conn,
        project_ids=project_ids,
        stage_ids=stage_ids,
        task_ids=task_ids,
        sample_category_ids=sample_category_ids,
        sample_ids=sample_ids,
        row_limit=MUTATION_RETURN_ROW_LIMIT,
    )


def _build_import_mutation_summary(current_data: dict,
                                   project_id_map: dict,
                                   stage_id_map: dict,
                                   task_id_map: dict,
                                   sample_id_map: dict,
                                   touched_structure_project_ids: set[str]) -> dict:
    return mutation_summary.build_import_mutation_summary(
        current_data,
        project_id_map,
        stage_id_map,
        task_id_map,
        sample_id_map,
        touched_structure_project_ids,
    )


def _import_bundle_commit_context() -> import_bundle_service.ImportBundleCommitContext:
    return import_bundle_service.ImportBundleCommitContext(
        app_version=APP_VERSION,
        sample_data_dir=SAMPLE_DATA_DIR,
        import_previews=_IMPORT_PREVIEWS,
        cleanup_expired_previews=_cleanup_expired_previews,
        cleanup_preview_temp=_cleanup_preview_temp,
        load_import_preview_payload=_load_import_preview_payload,
        get_state_metadata=get_state_metadata,
        get_state=get_state,
        detect_sample_occupancy_conflicts=detect_sample_occupancy_conflicts,
        write_db_connection=write_db_connection,
        now_iso=now_iso,
        sync_project_library=sync_project_library,
        sync_sample_library=sync_sample_library,
        split_state_for_storage=split_state_for_storage,
        json_dumps=json_dumps,
        connect_db=connect_db,
        begin_read_snapshot=begin_read_snapshot,
        load_sample_photos=load_sample_photos,
        url_for_asset=url_for_asset,
        thumbnail_asset_id=thumbnail_asset_id,
    )


def commit_merged_import_state(
    merged_data: dict,
    expected_revision: int | None,
    client_ip: str,
    remark: str,
    user: str,
) -> tuple[bool, dict]:
    return import_bundle_service.commit_merged_import_state(
        _import_bundle_commit_context(),
        merged_data,
        expected_revision,
        client_ip,
        remark,
        user,
    )


def commit_import_bundle(payload: dict) -> dict:
    return import_bundle_service.commit_import_bundle(_import_bundle_commit_context(), payload)


def commit_sample_archive(payload: dict) -> dict:
    return import_bundle_service.commit_sample_archive(_import_bundle_commit_context(), payload)

_find_incoming_stage = import_commit.find_incoming_stage
_find_incoming_task = import_commit.find_incoming_task
_register_imported_stage_tree = import_commit.register_imported_stage_tree
_register_imported_project_tree = import_commit.register_imported_project_tree
_apply_id_maps = import_commit.apply_id_maps
_validate_import_commit_state = import_commit.validate_import_commit_state
_remap_log_ids = import_commit.remap_log_ids
_sample_index_by_id = state_externalization.sample_index_by_id
_merge_import_sample_subrecords = import_commit.merge_import_sample_subrecords


def hydrate_import_target_photos(current_data: dict,
                                 incoming: dict,
                                 sample_id_map: dict[str, str],
                                 existing_sample_ids: set[str]) -> None:
    import_commit.hydrate_import_target_photos(
        current_data,
        incoming,
        sample_id_map,
        existing_sample_ids,
        connect_db=connect_db,
        begin_read_snapshot=begin_read_snapshot,
        load_sample_photos=load_sample_photos,
    )


_merge_import_sample_events = import_commit.merge_import_sample_events
_merge_project_sub_data = import_commit.merge_project_sub_data


FINISHED_TASK_STATUSES = import_commit.FINISHED_TASK_STATUSES


detect_sample_occupancy_conflicts = import_commit.detect_sample_occupancy_conflicts


def _sample_asset_mutation_context() -> sample_asset_mutations.SampleAssetMutationContext:
    return sample_asset_mutations.SampleAssetMutationContext(
        app_version=APP_VERSION,
        now_iso=now_iso,
        json_dumps=json_dumps,
        json_obj=json_obj,
        empty_data=empty_data,
        split_state_for_storage=split_state_for_storage,
        load_sample_photos=load_sample_photos,
    )


parse_multipart = http_multipart.parse_multipart


def commit_sample_asset_mutation(
    conn: sqlite3.Connection,
    sample_id: str,
    action: str,
    remark: str,
    client_ip: str,
    *,
    user: str = "",
) -> dict:
    return sample_asset_mutations.commit_sample_asset_mutation(
        _sample_asset_mutation_context(),
        conn,
        sample_id,
        action,
        remark,
        client_ip,
        user=user,
    )


write_task_logs = record_writers.write_task_logs
upsert_task_record = record_writers.upsert_task_record
delete_task_record = record_writers.delete_task_record
update_project_record = record_writers.update_project_record
delete_project_record = record_writers.delete_project_record
update_stage_record = record_writers.update_stage_record
delete_stage_record = record_writers.delete_stage_record
update_sample_category_record = record_writers.update_sample_category_record
update_sample_record = record_writers.update_sample_record
upsert_sample_events = record_writers.upsert_sample_events
detect_task_mutation_occupancy_conflicts = task_mutation_rules.detect_task_mutation_occupancy_conflicts
task_sample_ids = task_mutation_rules.task_sample_ids
existing_task_sample_ids = task_mutation_rules.existing_task_sample_ids
existing_finished_task = task_mutation_rules.existing_finished_task
sample_record_status = task_mutation_rules.sample_record_status
detect_task_mutation_sample_status_blockers = task_mutation_rules.detect_task_mutation_sample_status_blockers


def _mutation_service_context() -> mutation_services.MutationServiceContext:
    return mutation_services.MutationServiceContext(
        write_db_connection=write_db_connection,
        now_iso=now_iso,
        unlink_asset_relative_paths=unlink_asset_relative_paths,
    )


def commit_task_mutation(payload: dict, client_ip: str) -> tuple[bool, dict]:
    return mutation_services.commit_task_mutation(_mutation_service_context(), payload, client_ip)


def commit_task_batch_mutation(payload: dict, client_ip: str) -> tuple[bool, dict]:
    return mutation_services.commit_task_batch_mutation(_mutation_service_context(), payload, client_ip)


def commit_sample_mutation(payload: dict, client_ip: str) -> tuple[bool, dict]:
    return mutation_services.commit_sample_mutation(_mutation_service_context(), payload, client_ip)


def commit_project_mutation(payload: dict, client_ip: str) -> tuple[bool, dict]:
    return mutation_services.commit_project_mutation(_mutation_service_context(), payload, client_ip)


def commit_stage_mutation(payload: dict, client_ip: str) -> tuple[bool, dict]:
    return mutation_services.commit_stage_mutation(_mutation_service_context(), payload, client_ip)


delete_sample_category_record = mutation_services.delete_sample_category_record


def commit_sample_category_mutation(payload: dict, client_ip: str) -> tuple[bool, dict]:
    return mutation_services.commit_sample_category_mutation(_mutation_service_context(), payload, client_ip)


def http_runtime_context() -> SimpleNamespace:
    return http_runtime.build_context(globals())


Handler = http_handler.create_handler(
    server_version=SERVER_VERSION,
    now_iso=now_iso,
    json_dumps=json_dumps,
    runtime_context=http_runtime_context,
    max_upload_bytes=MAX_UPLOAD_BYTES,
)


def runtime_paths_snapshot() -> SimpleNamespace:
    return SimpleNamespace(
        root_dir=ROOT_DIR,
        frontend_dir=FRONTEND_DIR,
        data_dir=DATA_DIR,
        db_path=DB_PATH,
        sample_data_dir=SAMPLE_DATA_DIR,
        import_preview_dir=IMPORT_PREVIEW_DIR,
        export_dir=EXPORT_DIR,
    )


def main() -> None:
    server_runner.run_server(
        description="数字治理平台 V7 内网协同版服务器",
        default_data_dir=DEFAULT_DATA_DIR,
        prepare_runtime_data_root=prepare_runtime_data_root,
        init_db=init_db,
        handler_cls=Handler,
        runtime_paths=runtime_paths_snapshot,
    )


if __name__ == "__main__":
    main()
