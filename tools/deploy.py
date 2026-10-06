#!/usr/bin/env python3
"""Docker 部署 VoiceCloner Web（与 webapp 独立存放于 tools/）。

接受 pack.py 生成的部署包，解压后用其中的 Dockerfile 构建镜像并运行容器。
可指定对外端口；未指定时会交互式确认默认端口（3000）或输入，端口无效/被占用时会要求重新输入。

用法：
  python tools/deploy.py voicecloner-webapp_20261006_120000.zip
  python tools/deploy.py release.tar.gz --port 8080
  python tools/deploy.py release.zip --port 8080 --name my-vc --force
"""
from __future__ import annotations

import argparse
import shutil
import socket
import subprocess
import sys
import tarfile
import tempfile
import time
import zipfile
from pathlib import Path

DEFAULT_PORT = 3000          # 对外默认端口
CONTAINER_PORT = 3000        # 容器内服务端口（镜像 EXPOSE 3000）


def sh(cmd: list[str], **kwargs) -> subprocess.CompletedProcess:
    print("+", " ".join(cmd))
    return subprocess.run(cmd, check=True, **kwargs)


def docker_exe() -> str | None:
    return shutil.which("docker") or shutil.which("docker.exe")


def docker_ready(exe: str) -> bool:
    try:
        return subprocess.run(
            [exe, "info"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL
        ).returncode == 0
    except Exception:
        return False


def valid_port(port: object) -> bool:
    return isinstance(port, int) and 1 <= port <= 65535


def port_free(port: int) -> bool:
    """尝试绑定 0.0.0.0:port（不设 REUSEADDR，避免误判占用）。"""
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        try:
            s.bind(("0.0.0.0", port))
            return True
        except OSError:
            return False


def prompt_port(text: str) -> int | None:
    try:
        raw = input(text).strip()
    except EOFError:
        return None
    if raw == "":
        return DEFAULT_PORT
    try:
        return int(raw)
    except ValueError:
        return None


def choose_port(provided: int | None) -> int:
    interactive = sys.stdin.isatty()
    port = provided

    if port is None:
        if not interactive:
            port = DEFAULT_PORT
        else:
            port = prompt_port(f"请输入部署端口 [{DEFAULT_PORT}]: ")

    while True:
        if not valid_port(port):
            print(f"端口无效：{port!r}（需为 1-65535 的整数）。")
            if not interactive:
                sys.exit(1)
            port = prompt_port("请重新输入端口: ")
            continue
        if not port_free(port):
            print(f"端口 {port} 已被占用，请更换。")
            if not interactive:
                sys.exit(1)
            port = prompt_port("请重新输入端口: ")
            continue
        return port


def safe_target(dest: Path, name: str) -> Path:
    target = (dest / name).resolve()
    root = dest.resolve()
    if target != root and root not in target.parents:
        raise SystemExit(f"压缩包内非法路径：{name}")
    return target


def extract(package: Path, dest: Path) -> None:
    dest.mkdir(parents=True, exist_ok=True)
    if package.name.lower().endswith(".zip"):
        with zipfile.ZipFile(package) as zf:
            for member in zf.infolist():
                safe_target(dest, member.filename)
            zf.extractall(dest)
        return
    try:
        with tarfile.open(package, "r:*") as tf:
            for member in tf.getmembers():
                safe_target(dest, member.name)
            tf.extractall(dest)
    except tarfile.TarError as exc:
        sys.exit(f"无法识别压缩包（{package.name}）：{exc}")


def container_exists(exe: str, name: str) -> bool:
    out = subprocess.run(
        [exe, "ps", "-a", "--filter", f"name=^{name}$", "--format", "{{.Names}}"],
        capture_output=True, text=True,
    ).stdout.strip()
    return bool(out)


def main() -> None:
    ap = argparse.ArgumentParser(description="Docker 部署 VoiceCloner Web")
    ap.add_argument("package", help="pack.py 生成的部署包（.zip / .tar.gz / …）")
    ap.add_argument("-p", "--port", type=int, default=None, help=f"对外端口（默认 {DEFAULT_PORT}）")
    ap.add_argument("--name", default="voicecloner-web", help="容器名（默认 voicecloner-web）")
    ap.add_argument("--image", default="voicecloner-web", help="镜像名（默认 voicecloner-web）")
    ap.add_argument("--force", action="store_true", help="同名容器存在时先删除再部署")
    ap.add_argument("--keep", action="store_true", help="保留解压目录（默认部署后删除）")
    args = ap.parse_args()

    package = Path(args.package)
    if not package.is_file():
        sys.exit(f"找不到部署包：{package}")

    exe = docker_exe()
    if not exe:
        sys.exit("未检测到 docker，请先安装并启动 Docker。")
    if not docker_ready(exe):
        sys.exit("Docker 未运行或不可用，请启动 Docker Engine/Desktop 后重试。")

    port = choose_port(args.port)
    print(f"将部署到端口 {port}（容器内 {CONTAINER_PORT}）")

    context = Path(tempfile.mkdtemp(prefix="vc-deploy-"))
    try:
        print(f"解压 {package} → {context}")
        extract(package, context)
        # 归档内 app 位于 webapp/ 前缀下；兼容旧的“根即上下文”包。
        build_ctx = context / "webapp" if (context / "webapp" / "Dockerfile").is_file() else context
        if not (build_ctx / "Dockerfile").is_file():
            sys.exit("部署包内缺少 Dockerfile（请用 tools/pack.py 重新打包）。")

        image = f"{args.image}:{int(time.time())}"
        print("构建镜像（首次会安装 ffmpeg 与生产依赖，需要联网）…")
        sh([exe, "build", "-t", image, "-t", f"{args.image}:latest", str(build_ctx)])

        if container_exists(exe, args.name):
            if not args.force:
                sys.exit(f"容器 {args.name} 已存在；如需覆盖请加 --force。")
            sh([exe, "rm", "-f", args.name])

        sh([
            exe, "run", "-d",
            "--name", args.name,
            "--restart", "unless-stopped",
            "-p", f"{port}:{CONTAINER_PORT}",
            "-v", "voicecloner-data:/app/data",
            "-v", "voicecloner-log:/app/log",
            f"{args.image}:latest",
        ])

        print(f"\n已部署：http://localhost:{port}")
        print("   默认账号：admin / StanislawLem")
        print(f"   查看日志：docker logs -f {args.name}")
        print(f"   停止/删除：docker rm -f {args.name}")
    finally:
        if args.keep:
            print(f"解压目录保留：{context}")
        else:
            shutil.rmtree(context, ignore_errors=True)


if __name__ == "__main__":
    main()
