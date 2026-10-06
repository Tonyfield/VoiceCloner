#!/usr/bin/env python3
"""打包 VoiceCloner Web（与 webapp 独立存放于 tools/）。

两种模式：
  1) 默认（运行时部署包）：只含部署所需内容（编译产物 + 生产依赖清单 + 词典 + 运行时就绪 Dockerfile）。
     归档结构：
       README.md
       tools/pack.py, tools/deploy.py
       webapp/Dockerfile            ← 由 webapp/Dockerfile.deploy 归档而来
       webapp/server/dist/**
       webapp/server/package.json + package-lock.json
       webapp/client/dist/**
       webapp/data/cedict_*.txt, webapp/data/named_entities.json

  2) --source（源码包）：打包 webapp 源码，**不含 dist**（也无 node_modules / 日志 / 运行数据）。
     归档结构：
       README.md
       tools/pack.py, tools/deploy.py
       data/cedict_*.txt, data/named_entities.json
       webapp/**                    源码（client/src、server/src、配置、Dockerfile 等）
     包名含 src 标记（默认 <app>_src_yyyymmdd_HHMMSS；-o 指定的名字若不含 src 会自动补 _src）。

输出（全部写入仓库的 dist/ 目录）：
  用 -o/--output NAME 指定：
    - NAME 含明确的压缩后缀（zip/tar.gz/tgz/tar/xz/bz2 等）→ 只输出该文件；
    - 否则把 NAME 当作基名 → 输出 NAME.zip 与 NAME.tar.gz；
    - NAME 为绝对路径时按其路径输出，否则一律落在 dist/ 下。

用法（在仓库根目录执行）：
  python tools/pack.py                         # 部署包：dist/<app>_yyyymmdd_HHMMSS.zip 与 .tar.gz
  python tools/pack.py -o release             # dist/release.zip + dist/release.tar.gz
  python tools/pack.py -o release.tar.gz      # 只输出 dist/release.tar.gz
  python tools/pack.py --source               # 源码包：dist/<app>_src_yyyymmdd_HHMMSS.zip 与 .tar.gz
  python tools/pack.py --source -o release    # dist/release_src.zip + dist/release_src.tar.gz
  python tools/pack.py --no-build             # 部署包不自动构建（要求已有 dist）
"""
from __future__ import annotations

import argparse
import json
import shutil
import subprocess
import sys
import tarfile
import zipfile
from datetime import datetime
from pathlib import Path

TOOLS = Path(__file__).resolve().parent
REPO = TOOLS.parent
WEBAPP = REPO / "webapp"
DIST_DIR = REPO / "dist"

# 明确指定这些后缀时只输出一个包
SINGLE_EXTS = [
    ".zip", ".tar.gz", ".tgz", ".tar", ".tar.xz", ".txz", ".xz",
    ".tar.bz2", ".tbz2", ".bz2", ".tar.lz4", ".lz4", ".rar", ".7z",
]

# 源码包中要跳过的目录（相对 webapp/ 的任一层级）
SOURCE_SKIP_DIRS = {"node_modules", "dist", "log", "data", ".git"}
SOURCE_SKIP_FILES = {".DS_Store"}


def app_name() -> str:
    try:
        data = json.loads((WEBAPP / "package.json").read_text(encoding="utf-8"))
        return str(data.get("name") or "voicecloner-webapp")
    except Exception:
        return "voicecloner-webapp"


def ensure_build(no_build: bool) -> None:
    needed = [WEBAPP / "server" / "dist" / "main.js", WEBAPP / "client" / "dist" / "index.html"]
    missing = [p for p in needed if not p.exists()]
    if missing and no_build:
        sys.exit("缺少构建产物：\n  " + "\n  ".join(str(p) for p in missing) + "\n请先 `npm run build`，或去掉 --no-build。")
    if missing:
        npm = shutil.which("npm") or shutil.which("npm.cmd")
        if not npm:
            sys.exit("未找到 npm，无法自动构建；请先手动 `npm run build` 或加 --no-build。")
        print("缺少构建产物，正在执行 `npm run build` …")
        subprocess.run([npm, "run", "build"], cwd=str(WEBAPP), check=True)
        for p in needed:
            if not p.exists():
                sys.exit(f"构建后仍缺少：{p}")


def collect_deploy() -> list[tuple[Path, str]]:
    """运行时部署包内容（app 置于 webapp/ 前缀下）。"""
    items: list[tuple[Path, str]] = []

    def add_tree(root: Path, arc_prefix: str) -> None:
        if not root.is_dir():
            return
        for f in sorted(root.rglob("*")):
            if f.is_file() and not f.name.endswith(".map"):
                items.append((f, f"{arc_prefix}/{f.relative_to(root).as_posix()}"))

    def add_file(src: Path, arc: str) -> None:
        if src.is_file():
            items.append((src, arc))

    add_file(WEBAPP / "Dockerfile.deploy", "webapp/Dockerfile")
    add_file(WEBAPP / "server" / "package.json", "webapp/server/package.json")
    add_file(WEBAPP / "server" / "package-lock.json", "webapp/server/package-lock.json")
    add_tree(WEBAPP / "server" / "dist", "webapp/server/dist")
    add_tree(WEBAPP / "client" / "dist", "webapp/client/dist")
    add_file(REPO / "data" / "cedict_1_0_ts_utf-8_mdbg.txt", "webapp/data/cedict_1_0_ts_utf-8_mdbg.txt")
    add_file(REPO / "data" / "named_entities.json", "webapp/data/named_entities.json")
    add_common(items)
    return items


def collect_source() -> list[tuple[Path, str]]:
    """源码包内容：webapp 源码（不含 dist / node_modules / 日志 / 运行数据）+ data + 工具 + README。"""
    items: list[tuple[Path, str]] = []
    if WEBAPP.is_dir():
        for f in sorted(WEBAPP.rglob("*")):
            if not f.is_file():
                continue
            rel = f.relative_to(WEBAPP)
            if any(part in SOURCE_SKIP_DIRS for part in rel.parts):
                continue
            if f.name in SOURCE_SKIP_FILES or f.suffix == ".log":
                continue
            items.append((f, f"webapp/{rel.as_posix()}"))

    def add_file(src: Path, arc: str) -> None:
        if src.is_file():
            items.append((src, arc))

    add_file(REPO / "data" / "cedict_1_0_ts_utf-8_mdbg.txt", "data/cedict_1_0_ts_utf-8_mdbg.txt")
    add_file(REPO / "data" / "named_entities.json", "data/named_entities.json")
    add_common(items)
    return items


def add_common(items: list[tuple[Path, str]]) -> None:
    for src, arc in (
        (TOOLS / "pack.py", "tools/pack.py"),
        (TOOLS / "deploy.py", "tools/deploy.py"),
        (REPO / "README.md", "README.md"),
    ):
        if src.is_file():
            items.append((src, arc))


def preflight(items: list[tuple[Path, str]], source: bool) -> None:
    arcs = {arc for _, arc in items}
    required = ["tools/pack.py", "tools/deploy.py", "README.md"]
    required += (
        ["webapp/package.json", "webapp/server/package.json", "webapp/client/package.json", "data/cedict_1_0_ts_utf-8_mdbg.txt"]
        if source
        else [
            "webapp/Dockerfile",
            "webapp/server/package.json",
            "webapp/server/package-lock.json",
            "webapp/server/dist/main.js",
            "webapp/client/dist/index.html",
            "webapp/data/cedict_1_0_ts_utf-8_mdbg.txt",
        ]
    )
    for req in required:
        if req not in arcs:
            sys.exit(f"打包缺少必要文件：{req}")
    for src, _ in items:
        if not src.is_file():
            sys.exit(f"文件不存在：{src}")


def write_zip(path: Path, items: list[tuple[Path, str]]) -> None:
    with zipfile.ZipFile(path, "w", zipfile.ZIP_DEFLATED, compresslevel=6) as zf:
        for src, arc in items:
            zf.write(src, arc)


def write_tar(path: Path, items: list[tuple[Path, str]], mode: str) -> None:
    with tarfile.open(path, mode) as tf:
        for src, arc in items:
            tf.add(src, arcname=arc, recursive=False)


def write_archive(path: Path, items: list[tuple[Path, str]]) -> None:
    low = path.name.lower()
    if low.endswith(".zip"):
        write_zip(path, items)
    elif low.endswith((".tar.gz", ".tgz")):
        write_tar(path, items, "w:gz")
    elif low.endswith((".tar.xz", ".txz", ".xz")):
        write_tar(path, items, "w:xz")
    elif low.endswith((".tar.bz2", ".tbz2", ".bz2")):
        write_tar(path, items, "w:bz2")
    elif low.endswith(".tar"):
        write_tar(path, items, "w")
    else:
        sys.exit(
            f"不支持的压缩格式：{path.name}\n"
            "本脚本可写：.zip / .tar.gz(.tgz) / .tar / .tar.xz(.txz/.xz) / .tar.bz2(.tbz2/.bz2)"
        )


def split_ext(name: str) -> tuple[str, str]:
    low = name.lower()
    for ext in SINGLE_EXTS:
        if low.endswith(ext):
            return name[: len(name) - len(ext)], name[len(name) - len(ext):]
    return name, ""


def ensure_src_tag(name: str) -> str:
    """确保名字含有 src 标记（不区分大小写）。"""
    if "src" in name.lower():
        return name
    stem, ext = split_ext(name)
    return f"{stem}_src{ext}"


def output_names(output: str | None, base_stem: str, require_src: bool) -> list[str]:
    if output:
        low = output.lower()
        if any(low.endswith(ext) for ext in SINGLE_EXTS):
            return [ensure_src_tag(output) if require_src else output]
        base = ensure_src_tag(output) if require_src else output
        return [base + ".zip", base + ".tar.gz"]
    return [base_stem + ".zip", base_stem + ".tar.gz"]


def resolve_output(name: str) -> Path:
    path = Path(name)
    return path if path.is_absolute() else DIST_DIR / path


def main() -> None:
    ap = argparse.ArgumentParser(description="打包 VoiceCloner Web（部署包 / 源码包）")
    ap.add_argument("-o", "--output", help="输出文件名或基名（含压缩后缀则只输出一个文件）")
    ap.add_argument("-s", "--source", action="store_true", help="打包源码（不含 dist），包名含 src 标记")
    ap.add_argument("--app-name", help="默认包名中的应用名（默认取自 package.json）")
    ap.add_argument("--no-build", action="store_true", help="（部署包）不自动构建，要求已存在构建产物")
    args = ap.parse_args()

    if args.source:
        items = collect_source()
    else:
        ensure_build(args.no_build)
        items = collect_deploy()
    preflight(items, args.source)

    stamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    base = args.app_name or app_name()
    base_stem = f"{base}_src_{stamp}" if args.source else f"{base}_{stamp}"
    names = output_names(args.output, base_stem, args.source)

    DIST_DIR.mkdir(parents=True, exist_ok=True)
    total_mb = sum(src.stat().st_size for src, _ in items) / (1024 * 1024)
    kind = "源码包" if args.source else "部署包"
    print(f"{kind}：{len(items)} 个文件（解压后约 {total_mb:.1f} MB）")

    for name in names:
        path = resolve_output(name)
        path.parent.mkdir(parents=True, exist_ok=True)
        write_archive(path, items)
        mb = path.stat().st_size / (1024 * 1024)
        print(f"生成 {path}  ({mb:.1f} MB)")


if __name__ == "__main__":
    main()
