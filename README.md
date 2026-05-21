# 재회컨설팅 웹앱

AI 기반 재회 전문 상담 서비스

## 빠른 시작

### 1. 의존성 설치
```bash
npm install
```

### 2. 환경변수 설정
```bash
cp .env.example .env.local
# .env.local 파일을 열어 값 입력
```

필요한 키:
- **GOOGLE_AI_API_KEY**: [Google AI Studio](https://aistudio.google.com/app/apikey)에서 발급
- **NEXT_PUBLIC_SUPABASE_URL**: Supabase 프로젝트 URL
- **NEXT_PUBLIC_SUPABASE_ANON_KEY**: Supabase anon (publishable) key

### 3. Supabase DB 초기화
- **신규 프로젝트**: Supabase Dashboard → SQL Editor에서 `lib/db-schema.sql` 한 번만 실행
- **운영 중인 DB**: `lib/migrations/` 디렉토리의 날짜순 파일을 차례로 실행 (가장 최신: `2026-05-05_phase1.sql`)
> ⚠️ `lib/supabase/schema.sql`은 deprecated. 단일 진실의 출처는 `lib/db-schema.sql`.

### 4. 개발 서버 실행
```bash
npm run dev
# http://localhost:3000
```

## 배포 (Vercel)

```bash
# Vercel CLI 설치
npm i -g vercel

# 배포
vercel deploy

# 환경변수는 Vercel Dashboard에서 설정
```

## 프로젝트 구조

```
app/
  api/
    chat/route.ts          ← Gemini SSE 스트리밍 엔드포인트
    diagnosis/route.ts     ← 이별 유형 판별 API
  auth/callback/route.ts   ← Supabase OAuth 콜백
  chat/page.tsx            ← AI 상담 페이지
  diagnosis/page.tsx       ← 진단 페이지
  mission/page.tsx         ← 미션 센터
  dashboard/page.tsx       ← 홈 대시보드
  community/page.tsx       ← 커뮤니티(스토리/포럼)
  mypage/page.tsx          ← 마이페이지
  login/page.tsx           ← 로그인
  page.tsx                 ← 랜딩 페이지

components/
  chat/ChatWindow.tsx      ← 스트리밍 채팅 UI
  layout/BottomNav.tsx     ← 하단 글로벌 내비
  auth/AuthObserver.tsx    ← 로그인 상태 감지·동기화 트리거

lib/
  ai-system-prompt.ts      ← Gemini 시스템 프롬프트 빌더
  store.ts                 ← Zustand 전역 상태 (persist)
  supabase.ts              ← 브라우저/서버 Supabase 클라이언트 팩토리
  sync.ts                  ← 로컬 → Supabase 마이그레이션 (멱등)
  db-schema.sql            ← DB 스키마 (SoT)
  data/missions.ts         ← 정적 미션 카탈로그
```

## AI 모델 선택

`app/api/chat/route.ts`에서 모델 변경 (환경변수 `GEMMA_MODEL_ID`로 override 가능):

| 모델 | 비고 |
|------|------|
| `gemini-flash-latest` (기본) | 무료 티어 할당량 우회용. 빠르고 저렴. |
| `gemini-1.5-flash` | 안정 버전. |
| `gemini-1.5-pro` | 품질 우선. 비용/지연 ↑ |

## 주요 기능

- ✅ 9문항 이별 유형 진단 (A/B/C/D)
- ✅ 재회 전문가 AI 상담 (스트리밍)
- ✅ PHASE별 미션 108개
- ✅ 포인트·스트릭 게임화
- ✅ Supabase 인증·데이터 저장
- 🔲 푸시 알림 (Firebase FCM)
- 🔲 유료 구독 (토스페이먼츠)
