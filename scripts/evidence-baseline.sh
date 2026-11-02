#!/bin/bash
# 生成可核验的证据基线。
#
# 目的：让审计方可以确认「报告里说的东西，确实对应这个版本的代码」。
# 输出：docs/evidence/ 下的 hash 清单 + 测试输出存档。
#
# 用法：bash scripts/evidence-baseline.sh

set -e
cd "$(dirname "$0")/.."

OUT=docs/evidence
mkdir -p "$OUT"

echo "=== 生成证据基线 ==="
echo ""

# ── 1. 版本信息 ──────────────────────────────────────────
#
# 关键：这里记录的是**工作树**，不是 HEAD。
#
# 如果工作区是干净的，两者相同，SOURCE-HASHES 就能精确对应 commit。
# 如果不干净，SOURCE-HASHES 对应的是「HEAD + 未提交改动」，
# 别人只 checkout 那个 commit 是复现不出来的。
# 必须把这件事写在文件里，否则读者会默认它是 commit 可复现证据。
DIRTY_COUNT=0
if git rev-parse --git-dir > /dev/null 2>&1; then
  DIRTY_COUNT=$(git status --porcelain | wc -l | tr -d ' ')
fi

{
  echo "# 证据基线"
  echo ""
  echo "生成时间：$(date -Iseconds)"
  echo ""
  if [ "$DIRTY_COUNT" != "0" ]; then
    echo "> ⚠️ **这是 dirty-tree manifest，不是 commit 可复现证据。**"
    echo ">"
    echo "> 下面记录的 commit 是 HEAD，但源码哈希是对**当前工作树**算的。"
    echo "> 工作树相对 HEAD 有 $DIRTY_COUNT 项未提交改动，"
    echo "> 只 checkout 该 commit 无法复现相同的哈希。"
    echo "> 审计方应直接对收到的源码目录重算哈希，而不是从 git 取。"
    echo ""
  fi
  echo "## Git"
  echo ""
  if git rev-parse --git-dir > /dev/null 2>&1; then
    echo '```'
    echo "commit:    $(git rev-parse HEAD)"
    echo "branch:    $(git rev-parse --abbrev-ref HEAD)"
    echo "dirty:     $DIRTY_COUNT 个未提交改动"
    echo "工作树状态: $([ "$DIRTY_COUNT" = "0" ] && echo '干净（哈希可由 commit 复现）' || echo '不干净（哈希只对当前工作树有效）')"
    echo '```'
    echo ""
    echo "## 工作树偏离 HEAD 的文件"
    echo ""
    echo '```'
    git status --porcelain
    echo '```'
  else
    echo "（不是 git 仓库）"
  fi
  echo ""
  echo "## 环境"
  echo ""
  echo '```'
  echo "node:    $(node --version)"
  echo "npm:     $(npm --version)"
  echo "os:      $(uname -s) $(uname -r)"
  echo '```'
} > "$OUT/VERSION.md"

echo "✓ VERSION.md"

# ── 2. 源码 hash ─────────────────────────────────────────
{
  echo "# 源码文件 SHA-256"
  echo ""
  echo "对 src/ 下每个 .ts 文件计算。审计方可用同样命令复核："
  echo ""
  echo '```bash'
  echo "cd src && find . -name '*.ts' -type f | sort | xargs sha256sum"
  echo '```'
  echo ""
  echo '```'
  cd src
  find . -name '*.ts' -type f | sort | xargs sha256sum 2>/dev/null || \
    find . -name '*.ts' -type f | sort | while read -r f; do
      printf "%s  %s\n" "$(sha256sum "$f" | cut -d' ' -f1)" "$f"
    done
  cd ..
  echo '```'
} > "$OUT/SOURCE-HASHES.md"

echo "✓ SOURCE-HASHES.md"

# ── 3. 依赖锁 hash ───────────────────────────────────────
{
  echo "# 依赖锁文件 SHA-256"
  echo ""
  echo '```'
  if [ -f package-lock.json ]; then
    printf "%s  package-lock.json\n" "$(sha256sum package-lock.json | cut -d' ' -f1)"
  else
    echo "（package-lock.json 不存在）"
  fi
  echo '```'
} > "$OUT/DEPENDENCY-HASHES.md"

echo "✓ DEPENDENCY-HASHES.md"

# ── 4. 测试输出存档 ──────────────────────────────────────
#
# 用 npx 直接调 vitest，不用 npm test：
# 在 Git Bash 里 npm 脚本有时会报 "Could not determine Node.js install directory"。
echo ""
echo "运行测试..."
# 先写到临时文件再读回来。
# 直接在 { } > file 里跑 vitest 会让它的 TTY 检测出问题，输出被截断。
TMP_TEST=$(mktemp)
npx vitest run > "$TMP_TEST" 2>&1
TEST_EXIT=$?
{
  echo "# 测试输出"
  echo ""
  echo "生成时间：$(date -Iseconds)"
  echo ""
  echo "运行命令：\`npx vitest run\`"
  echo ""
  echo "退出码：$TEST_EXIT"
  echo ""
  echo '```'
  cat "$TMP_TEST"
  echo '```'
} > "$OUT/TEST-OUTPUT.md"
rm -f "$TMP_TEST"

echo "✓ TEST-OUTPUT.md"

# ── 5. 类型检查输出 ──────────────────────────────────────
{
  echo "# 类型检查输出"
  echo ""
  echo "运行命令：\`npx tsc -p tsconfig.json --noEmit\`"
  echo ""
  echo '```'
  npx tsc -p tsconfig.json --noEmit 2>&1 && echo "（无输出 = 通过）" || echo "（失败）"
  echo '```'
} > "$OUT/TYPECHECK-OUTPUT.md"

echo "✓ TYPECHECK-OUTPUT.md"

# ── 6. 汇总 ──────────────────────────────────────────────
echo ""
echo "=== 完成 ==="
echo ""
echo "证据文件位于 $OUT/"
ls -1 "$OUT"
