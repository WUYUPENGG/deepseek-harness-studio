#!/usr/bin/env bash
# ============================================================================
# .ci/sync-harness.sh — Jenkins 手动 CI "同步 deepseek-harness 代码 + 打包" 用脚本
#
# 作用: 在仓库工作区里, 按 sync-harness-paths.txt 白名单, 把
#       WUYUPENGG/deepseek-harness 的最新代码选择性覆盖到当前仓库。
#       仅覆盖白名单内路径; 不删除 studio 特有的文件 (rsync 不带 --delete)。
#
# 用法:
#   bash .ci/sync-harness.sh [--dry-run] [--source-dir <dir>]
#     --dry-run            只列出将覆盖的差异, 不写入
#     --source-dir <dir>   用本地已有 clone 作为上游源码 (本地测试用);
#                          缺省时自动 clone/fetch 到 $HARNESS_SRC (默认 /tmp/dsh-harness-src)
#
# 环境变量:
#   HARNESS_URL      默认 https://github.com/WUYUPENGG/deepseek-harness.git
#   HARNESS_BRANCH   默认 master
#   SYNC_PATHS_FILE  默认 <repo-root>/sync-harness-paths.txt
# ============================================================================
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
HARNESS_URL="${HARNESS_URL:-https://github.com/WUYUPENGG/deepseek-harness.git}"
HARNESS_BRANCH="${HARNESS_BRANCH:-master}"
LIST_FILE="${SYNC_PATHS_FILE:-${ROOT}/sync-harness-paths.txt}"
SRC_DIR="${HARNESS_SRC:-/tmp/dsh-harness-src}"
EXPLICIT_SRC=0
DRY_RUN=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --dry-run) DRY_RUN=1; shift ;;
    --source-dir) SRC_DIR="$2"; EXPLICIT_SRC=1; shift 2 ;;
    *) echo "未知参数: $1" >&2; exit 1 ;;
  esac
done

echo "==> 仓库工作区     : ${ROOT}"
echo "==> 上游源码目录   : ${SRC_DIR}"
echo "==> 白名单文件     : ${LIST_FILE}"

# 1) 准备上游源码目录
#    --source-dir 模式: 使用本地已就绪的 clone, 不碰网络 (本地测试用)
#    缺省模式 (Jenkins): 使用 /tmp 缓存, 每次增量 fetch 上游最新
if [[ "${EXPLICIT_SRC}" == "1" ]]; then
  # 显式 --source-dir 视为本地已就绪的源码, 跳过 fetch/clone (本地测试用)
  echo "==> [source-dir] 使用本地源码, 跳过网络: ${SRC_DIR}"
elif [[ -d "${SRC_DIR}/.git" ]]; then
  echo "==> [fetch] 增量更新上游源码: ${SRC_DIR}"
  if ! git -C "${SRC_DIR}" fetch --depth 1 origin "${HARNESS_BRANCH}"; then
    echo "[警告] 上游 fetch 失败 (网络/代理问题), 继续使用本地已有源码。" >&2
  fi
  git -C "${SRC_DIR}" reset --hard "origin/${HARNESS_BRANCH}" 2>/dev/null || true
else
  if [[ -e "${SRC_DIR}" ]]; then
    echo "==> ${SRC_DIR} 存在但不是 git 仓库, 备份后重建"
    mv "${SRC_DIR}" "${SRC_DIR}.bak.$(date +%s)"
  fi
  echo "==> [clone] 拉取上游源码 -> ${SRC_DIR}"
  mkdir -p "$(dirname "${SRC_DIR}")"
  if ! git clone --depth 1 --branch "${HARNESS_BRANCH}" "${HARNESS_URL}" "${SRC_DIR}"; then
    echo "[错误] 首次拉取上游源码失败, 无法同步。请检查网络/代理后重试。" >&2
    exit 1
  fi
fi
HARNESS_HEAD="$(git -C "${SRC_DIR}" rev-parse --short HEAD 2>/dev/null || echo unknown)"
echo "==> 上游 deepseek-harness HEAD: ${HARNESS_HEAD}"

[[ -f "${LIST_FILE}" ]] || { echo "[错误] 白名单文件不存在: ${LIST_FILE}" >&2; exit 1; }

# 2) 读取白名单 (跳过 # 注释、空行; 兼容 bash 3.x)
PATHS=()
while IFS= read -r raw; do
  line="$(printf '%s' "${raw}" | sed -E 's/[[:space:]]*#.*$//; s/^[[:space:]]+//; s/[[:space:]]+$//')"
  [[ -n "${line}" ]] && PATHS+=("${line}")
done < "${LIST_FILE}"
[[ ${#PATHS[@]} -gt 0 ]] || { echo "[错误] 白名单为空: ${LIST_FILE}" >&2; exit 1; }

echo "==> 白名单路径: ${PATHS[*]}"

# 3) 按白名单覆盖
for p in "${PATHS[@]}"; do
  if [[ ! -e "${SRC_DIR}/${p}" ]]; then
    echo "[跳过] 上游不存在: ${p}"
    continue
  fi
  if [[ "${DRY_RUN}" == "1" ]]; then
    echo "----- [dry-run] ${p} -----"
    diff -rq "${SRC_DIR}/${p}" "${ROOT}/${p}" 2>&1 | head -10 || true
  else
    if [[ -d "${SRC_DIR}/${p}" ]]; then
      rsync -a --exclude '.git' "${SRC_DIR}/${p}/" "${ROOT}/${p}/"
    else
      mkdir -p "$(dirname "${ROOT}/${p}")"
      cp "${SRC_DIR}/${p}" "${ROOT}/${p}"
    fi
    echo "[已同步] ${p}"
  fi
done

echo
echo "==> 同步后工作区状态:"
git -C "${ROOT}" status --short
git -C "${ROOT}" diff --stat
if [[ "${DRY_RUN}" == "1" ]]; then
  echo "==> dry-run 结束, 未写入任何文件"
else
  echo "==> 同步完成。Jenkins 内不自动提交: 本次构建使用同步后的代码直接打包;"
  echo "    如需把变更留存进仓库, 请本地 sync-harness.sh sync --apply 后 commit + push fork。"
fi
