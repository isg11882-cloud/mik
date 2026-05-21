export interface Mission {
  id: string;
  phase: 1 | 2 | 3;
  category: string;
  title: string;
  description: string;
  difficulty: 'easy' | 'medium' | 'hard';
  points: number;
}

export const MISSIONS: Mission[] = [
  // PHASE 1: 공백기 (감정 안정 및 상황 분석)
  {
    id: 'm1-1',
    phase: 1,
    category: '무연락 유지',
    title: '7일간 무연락 유지하기',
    description: '상대방에게 어떤 연락도 하지 않고 7일을 버팁니다. 상대방의 예측 가능성을 깨고 내 가치를 보호하는 첫 단계입니다.',
    difficulty: 'medium',
    points: 100
  },
  {
    id: 'm1-2',
    phase: 1,
    category: '감정 정리',
    title: '감정 쓰레기통 작성',
    description: '상대방에게 하고 싶은 말을 종이에 모두 적어보세요. 적은 후에는 그 종이를 찢어버리며 감정을 털어냅니다.',
    difficulty: 'easy',
    points: 50
  },
  {
    id: 'm1-3',
    phase: 1,
    category: '이별 분석',
    title: '객관적 이별 원인 3가지 찾기',
    description: '감정을 배제하고 우리가 헤어진 진짜 이유 3가지를 적어보세요. 프레임과 신뢰감 관점에서 분석합니다.',
    difficulty: 'medium',
    points: 80
  },
  {
    id: 'm1-4',
    phase: 1,
    category: 'SNS 관리',
    title: 'SNS 활동 일시 중단',
    description: '3일간 SNS에 어떤 게시물이나 스토리도 올리지 마세요. 상대방에게 궁금증을 유발하는 전략적 침묵입니다.',
    difficulty: 'easy',
    points: 40
  },

  // PHASE 2: 자기계발기 (변화와 성장)
  {
    id: 'm2-1',
    phase: 2,
    category: '외적 변화',
    title: '새로운 스타일링 시도',
    description: '평소와 다른 스타일의 옷을 입거나 헤어스타일에 변화를 줍니다. 시각적 변화는 가장 빠른 가치 상승 수단입니다.',
    difficulty: 'medium',
    points: 150
  },
  {
    id: 'm2-2',
    phase: 2,
    category: '내적 성장',
    title: '심리학 도서 1권 읽기',
    description: '관계 심리학이나 자존감 관련 도서를 읽고 느낀 점을 기록하세요. 내적 프레임을 강화합니다.',
    difficulty: 'medium',
    points: 120
  },
  {
    id: 'm2-3',
    phase: 2,
    category: '사회적 확장',
    title: '새로운 모임 참여하기',
    description: '동호회나 원데이 클래스 등 새로운 사람들을 만날 수 있는 곳에 가보세요. 삶의 영역을 넓히는 것이 중요합니다.',
    difficulty: 'hard',
    points: 200
  },
  {
    id: 'm2-4',
    phase: 2,
    category: 'SNS 전략',
    title: '근황 사진 업로드 (잘 지내는 모습)',
    description: '내가 즐겁게 지내는 모습을 SNS에 올리세요. 단, 상대방을 의식한 티가 나지 않게 자연스러워야 합니다.',
    difficulty: 'medium',
    points: 100
  },

  // PHASE 3: 재접근기 (실행)
  {
    id: 'm3-1',
    phase: 3,
    category: '재접근 준비',
    title: '자연스러운 연락 명분 찾기',
    description: '빌려준 물건, 공통 지인 소식 등 무겁지 않게 연락할 수 있는 명분을 3가지 리스트업 하세요.',
    difficulty: 'medium',
    points: 100
  },
  {
    id: 'm3-2',
    phase: 3,
    category: '첫 연락',
    title: '가벼운 안부 톡 보내기',
    description: '준비된 명분을 활용해 짧고 가볍게 연락을 시도합니다. 상대방의 반응에 일희일비하지 않는 것이 핵심입니다.',
    difficulty: 'hard',
    points: 250
  },
  {
    id: 'm3-3',
    phase: 3,
    category: '만남 재구축',
    title: '첫 만남 시뮬레이션',
    description: '만났을 때 나눌 대화 주제와 태도를 미리 연습해 보세요. 저프레임 행동을 하지 않도록 마인드 컨트롤이 필요합니다.',
    difficulty: 'medium',
    points: 120
  },
  {
    id: 'm3-4',
    phase: 3,
    category: '관계 설계',
    title: '새로운 관계 규칙 정하기',
    description: '재회 후 같은 실수를 반복하지 않기 위해 서로 지켜야 할 규칙들을 미리 생각해보세요.',
    difficulty: 'hard',
    points: 180
  }
];
