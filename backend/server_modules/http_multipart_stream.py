"""Bounded multipart uploads staged on disk; caller owns publication and SQLite.

Only sample attachments use this path. The ordinary small-body parser and its
80 MB request limit remain unchanged for all other API routes.
"""
from __future__ import annotations

import re
import tempfile
from contextlib import contextmanager
from email.parser import BytesParser
from email.policy import default as email_policy
from pathlib import Path

CHUNK_BYTES = 1024 * 1024
MAX_HEADER_BYTES = 16 * 1024
MAX_FIELD_BYTES = 1024
MAX_PARTS = 128


def request_length(headers, maximum):
    if headers.get("Transfer-Encoding"):
        raise ValueError("不支持分块传输，请提供 Content-Length")
    values = (headers.get_all("Content-Length") if hasattr(headers, "get_all")
              else [headers.get("Content-Length", "")]) or []
    if len(values) != 1 or not re.fullmatch(r"[0-9]{1,12}", str(values[0]).strip()):
        raise ValueError("Content-Length 必须是非负整数")
    length = int(str(values[0]).strip())
    if length > maximum:
        raise ValueError("单次上传不能超过 1 GB，请分次添加文件")
    return length


class _Reader:
    def __init__(self, stream, length):
        self.stream, self.remaining, self.buffer = stream, length, bytearray()

    def fill(self):
        if not self.remaining:
            return False
        read = getattr(self.stream, "read1", self.stream.read)
        chunk = read(min(CHUNK_BYTES, self.remaining))
        if not chunk:
            raise ValueError("请求体不完整，请重新上传")
        self.remaining -= len(chunk)
        self.buffer.extend(chunk)
        return True

    def line(self, maximum):
        while True:
            end = self.buffer.find(b"\r\n")
            if end >= 0:
                if end + 2 > maximum:
                    raise ValueError("multipart 请求头过长")
                line = bytes(self.buffer[:end + 2])
                del self.buffer[:end + 2]
                return line
            if len(self.buffer) > maximum:
                raise ValueError("multipart 请求头过长")
            if not self.fill():
                raise ValueError("上传内容不完整或 multipart 格式损坏，请重新上传")

    def part(self, boundary, output, maximum, limit_label):
        marker, total = b"\r\n--" + boundary, 0

        def emit(length):
            nonlocal total
            if total + length > maximum:
                raise ValueError(limit_label)
            if length:
                output.write(self.buffer[:length])
                del self.buffer[:length]
                total += length

        while True:
            at = self.buffer.find(marker)
            if at >= 0:
                after = at + len(marker)
                while len(self.buffer) < after + 4 and self.remaining:
                    self.fill()
                suffix = self.buffer[after:after + 2]
                final = suffix == b"--" and (self.buffer[after + 2:after + 4] == b"\r\n"
                                                or (not self.remaining and len(self.buffer) == after + 2))
                if suffix == b"\r\n" or final:
                    emit(at)
                    del self.buffer[:len(marker) + 2]
                    return total, final
                # Boundary-like bytes inside a binary STL are ordinary content.
                emit(at + 2)
                continue
            emit(max(0, len(self.buffer) - len(marker) - 4))
            if not self.fill():
                raise ValueError("上传内容不完整或 multipart 格式损坏，请重新上传")

    def finish(self):
        if len(self.buffer) + self.remaining > 2:
            raise ValueError("multipart 结束标记后存在无效内容")
        while self.remaining:
            self.fill()
        if self.buffer not in (b"", b"\r\n"):
            raise ValueError("multipart 结束标记不完整")


@contextmanager
def staged_multipart(headers, stream, *, data_dir, max_request_bytes, file_limit):
    """Yield fields/files with temporary Path content; remove leftovers on exit.

    file_limit(filename) returns the per-file byte limit and its error message.
    Staging lives on the data volume so publishing can use an atomic rename.
    """
    from io import BytesIO

    length = request_length(headers, max_request_bytes)
    envelope = BytesParser(policy=email_policy).parsebytes(
        ("Content-Type: " + headers.get("Content-Type", "") + "\r\n\r\n").encode("utf-8"))
    boundary = envelope.get_boundary() or ""
    if (envelope.get_content_type() != "multipart/form-data"
            or not re.fullmatch(r"[\x21-\x7e ]{1,200}", boundary) or boundary.endswith(" ")):
        raise ValueError("请求必须使用带 boundary 的 multipart/form-data")
    boundary = boundary.encode("ascii")
    reader = _Reader(stream, length)
    fields, files = {}, []
    with tempfile.TemporaryDirectory(prefix=".sample-upload-", dir=data_dir) as folder:
        if reader.line(MAX_HEADER_BYTES) != b"--" + boundary + b"\r\n":
            raise ValueError("multipart 起始标记不正确")
        for index in range(MAX_PARTS):
            raw_headers = bytearray()
            while True:
                line = reader.line(MAX_HEADER_BYTES - len(raw_headers))
                raw_headers.extend(line)
                if line == b"\r\n":
                    break
            part = BytesParser(policy=email_policy).parsebytes(bytes(raw_headers))
            name, filename = part.get_param("name", header="content-disposition"), part.get_filename()
            if (part.defects or part.get_content_disposition() != "form-data" or not name
                    or part.get("Content-Transfer-Encoding") or part.is_multipart()):
                raise ValueError("multipart 文件字段格式不正确")
            if filename is not None:
                if name != "files" or not filename:
                    raise ValueError("上传文件字段不正确")
                maximum, label = file_limit(filename)
                target = Path(folder) / str(index)
                with target.open("xb") as output:
                    size, final = reader.part(boundary, output, maximum, label)
                files.append({"field": name, "filename": filename, "path": target, "size": size})
            else:
                if name != "category" or name in fields:
                    raise ValueError("上传类别字段不正确")
                output = BytesIO()
                _, final = reader.part(boundary, output, MAX_FIELD_BYTES, "上传类别字段过长")
                fields[name] = output.getvalue().decode("utf-8", errors="strict")
            if final:
                reader.finish()
                yield fields, files
                return
        raise ValueError("一次上传的文件过多，请分次添加")
