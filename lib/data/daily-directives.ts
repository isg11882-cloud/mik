import type { BreakupType } from '@/lib/store'

export interface DailyDirective {
  text: string
  // 추가 메타가 필요해지면 여기 확장 (예: relatedTheory, missionId 등)
}

/**
 * 이별 유형 × PHASE × 경과 일수 버킷 기반의 일일 행동 지침.
 * 단순 매핑 테이블로 시작 — 추후 /api/daily-directive 로 동적 생성 가능.
 */
type Bucket = 'early' | 'mid' | 'late' // PHASE 내 경과 단계

const DIRECTIVES: Record<BreakupType, Record<1 | 2 | 3, Record<Bucket, string>>> = {
  A: {
    // 감정소진형
    1: {
      early: '연락하고 싶은 충동이 들 때마다, 휴대폰을 다른 방에 두고 30분 산책을 다녀오세요. 침묵이 곧 회복입니다.',
      mid: '상대의 부정적 감정이 옅어지는 시기입니다. 새로운 루틴(운동·독서) 하나만 추가해보세요.',
      late: '공백기 후반입니다. SNS에 가장 멋진 일상 한 컷만 담담하게 올려보세요. 매달림이 아닌 존재감을 남기는 것이 핵심입니다.',
    },
    2: {
      early: '오늘은 거울 앞에서 1분간 자세를 점검하세요. 외적 변화는 가장 빠른 가치 신호입니다.',
      mid: '꾸준함을 증명할 수 있는 활동(헬스·자기계발)을 SNS에 1주 1회 노출하세요. 변화는 보여줘야 의미가 있습니다.',
      late: '재접근 직전입니다. 상대가 마주칠 가능성이 있는 공간에서 가장 자연스러운 모습을 의도적으로 준비하세요.',
    },
    3: {
      early: '첫 메시지는 10단어 이내. 과거를 끌어오지 말고 사소한 안부 한 줄로 시작하세요.',
      mid: '상대의 답장이 짧아도 흔들리지 마세요. 빠른 회신은 오히려 가치 하락 신호입니다.',
      late: '만남을 제안할 때는 부담 없는 명분(우연/짧은 약속)을 사용하세요. 단호하게, 길게 끌지 마세요.',
    },
  },
  B: {
    // 갈등반복형
    1: {
      early: '오늘은 마지막 다툼의 원인을 객관적으로 글로 적어보세요. 감정을 빼고 사실만요.',
      mid: '같은 갈등 패턴이 반복된 이유 3가지를 적고, 그 중 내가 바꿀 수 있는 것 1가지를 정하세요.',
      late: '소통 방식의 변화를 보여줄 작은 행동을 정해두세요. 말이 아닌 행동이 신뢰를 만듭니다.',
    },
    2: {
      early: '갈등 시 사용했던 말투/패턴을 의식적으로 다른 방식으로 바꿔보는 연습을 하루 한 번.',
      mid: '감정 일기를 일주일간 기록하세요. 트리거를 알면 같은 갈등을 반복하지 않습니다.',
      late: '변화한 모습을 직접적으로 광고하지 말고, 일상의 톤(SNS·주변 평판)으로 자연스럽게 흘려보내세요.',
    },
    3: {
      early: '재접촉 시 첫 톤이 결정적입니다. 가벼운 농담이나 객관적 안부로 시작하세요. 사과 모드 금지.',
      mid: '대화 중 과거 갈등이 떠올라도 반응하지 마세요. 한 번이라도 같은 패턴이 보이면 재신뢰는 무너집니다.',
      late: '만남에서는 “내가 바뀌었다”를 말로 증명하려 하지 마세요. 행동의 일관성으로만 보여주세요.',
    },
  },
  C: {
    // 대체자형
    1: {
      early: '상대 SNS 확인 충동이 들면 즉시 차단·뮤트하세요. 정보 노출은 회복의 가장 큰 적입니다.',
      mid: '비교는 패배의 시작입니다. 오늘은 나의 매력 자산 3가지를 노트에 기록하세요.',
      late: '리바운드는 길지 않습니다. 조급해하지 말고 본인의 가치 상승에만 집중하세요.',
    },
    2: {
      early: '스타일·체형·취향 중 가장 빨리 바꿀 수 있는 한 가지를 골라 오늘 시작하세요.',
      mid: '주변 인간관계를 넓히는 활동(원데이 클래스 등) 한 가지를 신청하세요. 사회적 가치 신호가 강력합니다.',
      late: '매력적인 일상이 자연스럽게 흘러가고 있다는 인상을 SNS로 남기세요. 직접적 어필 금지.',
    },
    3: {
      early: '재접근 시 상대가 새 관계와 비교하지 못하도록, 완전히 다른 결의 모습을 보여주세요.',
      mid: '메시지는 짧고 자신감 있게. 상대가 “돌아갈 곳이 있다”는 안전감을 느끼지 못하게 하세요.',
      late: '만남 제안은 상대 쪽에서 먼저 흥미를 보일 때만. 매달리는 순간 모든 상승이 무너집니다.',
    },
  },
  D: {
    // 장기이별형
    1: {
      early: '오랜 시간이 흘렀어도 미해결 감정은 남습니다. 오늘은 그 감정을 글로 정리하세요.',
      mid: '자연스러운 재접촉 명분(공통 지인의 행사·옛 물건 반환 등)을 1가지 메모해두세요.',
      late: '연락이 없었던 시간을 부담스럽게 만들지 마세요. 짧은 안부 한 줄이 가장 강력합니다.',
    },
    2: {
      early: '시간이 만든 빈자리를 채울 수 있는 “지금의 나”를 보여줄 활동을 하나 시작하세요.',
      mid: '과거 이미지에서 벗어나는 변화를 만들고 있다면, 자연스럽게 SNS에 흘려보내세요.',
      late: '재접근 직전, 옛 추억을 끌어오기보다 “지금의 너는 어때?”라는 호기심을 자극하세요.',
    },
    3: {
      early: '첫 메시지는 부담 없는 명분 하나로. 과거 정리/사과 톤은 절대 금지.',
      mid: '상대가 답장하면 곧장 만남 제안하지 말고, 자연스러운 대화를 1~2회 주고받으세요.',
      late: '오랜 공백 후의 만남은 “현재의 모습”이 모든 것을 결정합니다. 약속 직전 컨디션을 점검하세요.',
    },
  },
}

function bucketForPhase(phase: 1 | 2 | 3, daysSinceBreakup: number): Bucket {
  // PHASE 1: 0~30일, PHASE 2: 30~90일, PHASE 3: 90일~ 를 가정해 내부에서 3분할
  if (phase === 1) {
    if (daysSinceBreakup <= 7) return 'early'
    if (daysSinceBreakup <= 21) return 'mid'
    return 'late'
  }
  if (phase === 2) {
    if (daysSinceBreakup <= 45) return 'early'
    if (daysSinceBreakup <= 70) return 'mid'
    return 'late'
  }
  // phase 3
  if (daysSinceBreakup <= 110) return 'early'
  if (daysSinceBreakup <= 150) return 'mid'
  return 'late'
}

export function getDailyDirective(
  type: BreakupType | null,
  phase: 1 | 2 | 3,
  daysSinceBreakup: number,
): DailyDirective {
  const safeType: BreakupType = type ?? 'A'
  const bucket = bucketForPhase(phase, daysSinceBreakup)
  return { text: DIRECTIVES[safeType][phase][bucket] }
}
