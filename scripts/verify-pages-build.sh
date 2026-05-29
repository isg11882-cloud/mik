#!/bin/bash
# ============================================================
#  MIK Pages 빌드 검증 스크립트
#  Pages 배포 전 dist/index.html의 WORKER_URL을 검사한다.
#  exit 0 → 검증 통과  |  exit 1 → 배포 차단
# ============================================================
set -euo pipefail

TARGET="dist/index.html"
ALLOWED="https://mik-worker.isg11882.workers.dev"

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; NC='\033[0m'

echo "🔍 [verify-pages-build] WORKER_URL 검증 시작..."

# ── 1. 파일 존재 확인 ─────────────────────────────────────────
if [ ! -f "$TARGET" ]; then
  echo -e "${RED}❌ FAIL: $TARGET 파일이 없습니다. 빌드를 먼저 실행하세요.${NC}"
  exit 1
fi

# ── 2. WORKER_URL 라인 추출 ──────────────────────────────────
URL_LINE=$(grep -o "WORKER_URL = '[^']*'" "$TARGET" 2>/dev/null | head -1 || true)

if [ -z "$URL_LINE" ]; then
  echo -e "${RED}❌ FAIL: $TARGET 에서 WORKER_URL을 찾을 수 없습니다.${NC}"
  exit 1
fi

ACTUAL_URL=$(echo "$URL_LINE" | grep -o "'[^']*'" | tr -d "'")
echo "  감지된 URL: $ACTUAL_URL"

# ── 3. 블랙리스트 검사 ───────────────────────────────────────
FAIL=0

if echo "$ACTUAL_URL" | grep -q "isg11882-cloud"; then
  echo -e "${RED}❌ FAIL: 잘못된 도메인 'isg11882-cloud' 포함${NC}"
  FAIL=1
fi

if echo "$ACTUAL_URL" | grep -q "localhost"; then
  echo -e "${RED}❌ FAIL: localhost가 포함됩니다. 로컬 URL은 배포 불가${NC}"
  FAIL=1
fi

if echo "$ACTUAL_URL" | grep -q "127\.0\.0\.1"; then
  echo -e "${RED}❌ FAIL: 127.0.0.1이 포함됩니다.${NC}"
  FAIL=1
fi

# ── 4. 허용 URL 화이트리스트 검사 ───────────────────────────
if [ "$ACTUAL_URL" != "$ALLOWED" ]; then
  echo -e "${RED}❌ FAIL: WORKER_URL이 허용값과 다릅니다."
  echo -e "  허용: $ALLOWED"
  echo -e "  실제: $ACTUAL_URL${NC}"
  FAIL=1
fi

# ── 5. 최종 판정 ─────────────────────────────────────────────
if [ "$FAIL" -eq 1 ]; then
  echo -e "${RED}"
  echo "============================================================"
  echo "  배포 차단: WORKER_URL 검증 실패"
  echo "  dist/index.html의 WORKER_URL을 수정하고 다시 빌드하세요."
  echo "============================================================"
  echo -e "${NC}"
  exit 1
fi

echo -e "${GREEN}✅ PASS: WORKER_URL 검증 완료 → $ACTUAL_URL${NC}"
exit 0
