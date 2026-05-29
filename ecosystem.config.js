/**
 * PM2 Ecosystem Config — MIK 프로세스 자가 치유 설정
 *
 * 사용법:
 *   pm2 start ecosystem.config.js     # 전체 시작
 *   pm2 stop all                       # 전체 중지
 *   pm2 restart mlx-server             # AI 서버만 재시작
 *   pm2 logs mik-watcher               # 번역 로그 실시간 확인
 *   pm2 status                         # 프로세스 상태 확인
 *   pm2 save && pm2 startup            # 맥 재부팅 후 자동시작 등록
 *
 * ⚠️  주의: mlx-server가 완전히 올라온 뒤(약 20초) mik-watcher가 첫 번역을 시도함
 *           pm2 start 후 `pm2 logs mlx-server`로 모델 로딩 완료 메시지 확인 권장
 */

module.exports = {
  apps: [
    // ── 1. rapid-mlx AI 서버 ─────────────────────────────────────────
    {
      name:          'mlx-server',
      script:        'bash',
      args:          '-c "rapid-mlx serve qwen3.5-9b --served-model-name default --no-thinking"',
      autorestart:   true,       // 크래시 시 자동 재시작
      max_restarts:  20,         // 무한 재시작 방지 (20회 초과 시 pm2가 중지)
      min_uptime:    '30s',      // 30초 이상 살아 있어야 정상 기동으로 간주
      restart_delay: 8000,       // 재시작 전 8초 대기 (모델 언로드 시간)
      watch:         false,
      kill_timeout:  10000,      // 종료 시 10초 대기
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
      out_file:      './logs/mlx-server.out.log',
      error_file:    './logs/mlx-server.err.log',
      merge_logs:    false,
    },

    // ── 2. MIK 번역 Watch 스크립트 ──────────────────────────────────
    {
      name:          'mik-watcher',
      script:        'run_local_ai.js',
      interpreter:   'node',
      args:          '--watch',
      autorestart:   true,
      max_restarts:  10,
      min_uptime:    '60s',      // watch 모드는 루프이므로 최소 60초 생존해야 정상
      restart_delay: 15000,      // mlx-server 재시작 후 안정화 시간 확보
      watch:         false,
      kill_timeout:  5000,
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
      out_file:      './logs/mik-watcher.out.log',
      error_file:    './logs/mik-watcher.err.log',
      merge_logs:    false,
      env: {
        MLX_URL:        'http://localhost:8000/v1',
        MLX_MODEL:      'default',
        MIK_SECRET:     'mik_secret_key_2026',  // .env 파일 또는 실제 시크릿으로 교체 권장
        BATCH_SIZE:     '10',
        NODE_ENV:       'production',
      },
    },
  ],
};
