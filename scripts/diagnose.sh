#!/bin/bash
# MIK 시스템 전체 진단 스크립트
# 실행: bash scripts/diagnose.sh
# ──────────────────────────────────────────────────────────

WORKER_URL="https://mik-worker.isg11882.workers.dev"
SECRET="${MIK_SECRET:-mik_secret_key_2026}"
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; NC='\033[0m'

echo "================================================================"
echo "       MIK 시스템 진단 — $(date '+%Y-%m-%d %H:%M:%S')"
echo "================================================================"
echo ""

# ─── 1. Worker 헬스체크 ─────────────────────────────────────────────
echo "▶ [1/5] Worker 헬스체크..."
HEALTH=$(curl -s --max-time 10 "$WORKER_URL/health")
if echo "$HEALTH" | grep -q '"ok"'; then
  echo -e "  ${GREEN}✅ Worker 정상 응답${NC}: $HEALTH"
else
  echo -e "  ${RED}❌ Worker 응답 없음${NC}"
  echo "  응답: $HEALTH"
  echo ""
  echo "  → 가능한 원인: Worker 미배포 / Cloudflare 장애"
  echo "  → 확인: npx wrangler tail"
  echo ""
fi

# ─── 2. D1 articles 개수 확인 ───────────────────────────────────────
echo "▶ [2/5] D1 기사 개수 확인..."
DB_COUNT=$(npx wrangler d1 execute mik_db --remote \
  --command "SELECT COUNT(*) as total FROM articles" \
  --json 2>/dev/null | python3 -c "import sys,json; r=json.load(sys.stdin); print(r[0]['results'][0]['total'] if r else 'error')" 2>/dev/null)
if [ -z "$DB_COUNT" ] || [ "$DB_COUNT" = "error" ]; then
  echo -e "  ${RED}❌ D1 쿼리 실패${NC} — wrangler 로그인 확인 또는 테이블 미존재"
  echo "  → 스키마 초기화: npx wrangler d1 execute mik_db --remote --file=./schema.sql"
else
  if [ "$DB_COUNT" = "0" ]; then
    echo -e "  ${RED}❌ articles 테이블이 비어있음 (0건)${NC}"
    echo "  → 크롤 트리거 필요 (단계 5 참고)"
  else
    echo -e "  ${GREEN}✅ D1 articles 총 ${DB_COUNT}건${NC}"
  fi
fi

# ─── 3. 번역 현황 ───────────────────────────────────────────────────
echo "▶ [3/5] 번역 현황..."
TRANS=$(npx wrangler d1 execute mik_db --remote \
  --command "SELECT
    COUNT(*) as total,
    SUM(CASE WHEN insight='' OR insight IS NULL THEN 1 ELSE 0 END) as pending,
    SUM(CASE WHEN insight='skip-non-mice' THEN 1 ELSE 0 END) as skipped,
    SUM(CASE WHEN insight!='' AND insight IS NOT NULL AND insight!='skip-non-mice' THEN 1 ELSE 0 END) as done
  FROM articles" \
  --json 2>/dev/null | python3 -c "
import sys,json
try:
  r=json.load(sys.stdin)
  row=r[0]['results'][0]
  print(f\"  총 {row['total']}건 | 번역완료 {row['done']}건 | 대기 {row['pending']}건 | MICE무관 {row['skipped']}건\")
except:
  print('  집계 실패')
" 2>/dev/null)
echo "$TRANS"

# ─── 4. API /api/articles 응답 확인 ────────────────────────────────
echo "▶ [4/5] API /api/articles 응답 확인..."
API_RESP=$(curl -s --max-time 15 \
  -H "Accept: application/json" \
  "$WORKER_URL/api/articles?limit=1")
if echo "$API_RESP" | grep -q '"articles"'; then
  ARTICLE_CNT=$(echo "$API_RESP" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('total',0))" 2>/dev/null)
  echo -e "  ${GREEN}✅ API 정상 — total: ${ARTICLE_CNT}건${NC}"
  # 샘플 기사 출력
  echo "$API_RESP" | python3 -c "
import sys,json
d=json.load(sys.stdin)
if d.get('articles'):
  a=d['articles'][0]
  print(f\"  샘플: [{a.get('id')}] {a.get('title','')[:60]}\")
  print(f\"  insight: {a.get('insight','')[:50]}\")
" 2>/dev/null
else
  echo -e "  ${RED}❌ API 응답 이상${NC}"
  echo "  응답(처음 200자): ${API_RESP:0:200}"
fi

# ─── 5. 크롤 강제 실행 (D1이 비어있을 때) ──────────────────────────
echo "▶ [5/5] 크롤 강제 실행 (필요 시)..."
if [ "$DB_COUNT" = "0" ] 2>/dev/null; then
  echo -e "  ${YELLOW}⚡ D1이 비어있으므로 크롤을 자동 트리거합니다...${NC}"
  CRAWL=$(curl -s --max-time 30 -X POST \
    -H "Authorization: Bearer $SECRET" \
    -H "Content-Type: application/json" \
    "$WORKER_URL/api/crawl/raw")
  echo "  크롤 결과: $CRAWL"
else
  echo "  ⏭️  기사가 있으므로 크롤 생략"
fi

echo ""
echo "================================================================"
echo "                     진단 완료"
echo "================================================================"
echo ""
echo "📋 요약:"
echo "  Worker URL : $WORKER_URL"
echo "  Dashboard  : https://mik-dashboard.pages.dev"
echo "  D1 총 기사 : ${DB_COUNT:-알수없음}건"
echo ""
echo "🔧 추가 명령어:"
echo "  D1 직접 쿼리 : npx wrangler d1 execute mik_db --remote --command 'SELECT ...' "
echo "  Worker 로그  : npx wrangler tail"
echo "  크롤 트리거  : curl -X POST -H 'Authorization: Bearer $SECRET' $WORKER_URL/api/crawl/raw"
echo "  gibberish 초기화: curl -X POST -H 'Authorization: Bearer $SECRET' \\"
echo "                    -d '{\"fix\":true}' $WORKER_URL/api/admin/scan-gibberish"
