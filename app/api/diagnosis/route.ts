/**
 * POST /api/diagnosis
 * 9문항 진단 답변 → 이별 유형(A/B/C/D) + PHASE 판별
 */

import { NextResponse } from 'next/server'

// 문항별 가중치 매핑
const QUESTION_WEIGHTS: Record<number, Record<number, Partial<Record<'A'|'B'|'C'|'D', number>>>> = {
  // Q1: 이별 주도자
  1: { 1: { A: 2 }, 2: { B: 2 }, 3: { C: 3 }, 4: { A: 1, B: 1 } },
  // Q2: 이별 사유
  2: { 1: { A: 3 }, 2: { B: 3 }, 3: { C: 2 }, 4: { D: 3 } },
  // Q3: 이별 전 분위기
  3: { 1: { A: 2 }, 2: { B: 3 }, 3: { C: 2 }, 4: { D: 2 } },
  // Q4: 현재 연락 상태
  4: { 1: { D: 3 }, 2: { A: 1, C: 1 }, 3: { B: 2 }, 4: { D: 2 } },
  // Q5: 상대방 SNS 활동
  5: { 1: { C: 3 }, 2: { A: 2 }, 3: { B: 1 }, 4: { D: 1 } },
  // Q6: 다툼 빈도
  6: { 1: { A: 1, C: 1 }, 2: { B: 2 }, 3: { B: 3 }, 4: { D: 1 } },
  // Q7: 이별 후 경과 기간
  7: { 1: { A: 1, B: 1 }, 2: { B: 1, C: 1 }, 3: { C: 1, D: 1 }, 4: { D: 3 } },
  // Q8: 상대방 감정 상태 추정
  8: { 1: { A: 3 }, 2: { B: 2 }, 3: { C: 3 }, 4: { D: 2 } },
  // Q9: 재회 의향
  9: { 1: { A: 1, B: 1, C: 1, D: 1 }, 2: { A: 1, B: 1 }, 3: { C: 2 }, 4: { D: 2 } },
}

function determinePhase(daysSinceBreakup: number): 1 | 2 | 3 {
  if (daysSinceBreakup < 30) return 1
  if (daysSinceBreakup < 90) return 2
  return 3
}

export async function POST(request: Request) {
  try {
    const { answers, daysSinceBreakup }: {
      answers: Record<number, number>  // { 1: 2, 2: 1, ... }
      daysSinceBreakup: number
    } = await request.json()

    // 점수 집계
    const scores: Record<'A'|'B'|'C'|'D', number> = { A: 0, B: 0, C: 0, D: 0 }

    for (const [qNum, answerIdx] of Object.entries(answers)) {
      const qWeights = QUESTION_WEIGHTS[Number(qNum)]
      const answerWeights = qWeights?.[answerIdx]
      if (answerWeights) {
        for (const [type, score] of Object.entries(answerWeights) as Array<['A'|'B'|'C'|'D', number]>) {
          scores[type] += score
        }
      }
    }

    // 최고 점수 유형 선택
    const breakupType = (Object.entries(scores) as Array<['A'|'B'|'C'|'D', number]>)
      .sort((a, b) => b[1] - a[1])[0][0]

    const phase = determinePhase(daysSinceBreakup)

    // 유형별 요약 메시지
    const typeDescriptions: Record<'A'|'B'|'C'|'D', { title: string; summary: string; successRate: string }> = {
      A: {
        title: '감정소진형',
        summary: '상대방이 관계에서 감정적으로 지쳐 이별을 선택한 케이스입니다. 충분한 공백과 변화된 모습이 핵심입니다.',
        successRate: '재회 가능성 높음',
      },
      B: {
        title: '갈등반복형',
        summary: '반복적 갈등 패턴이 원인입니다. 근본적인 소통 방식의 변화가 필요합니다.',
        successRate: '노력 여하에 따라 가능',
      },
      C: {
        title: '대체자형',
        summary: '새로운 이성의 존재가 변수입니다. 자신의 가치를 높이는 전략이 최우선입니다.',
        successRate: '시간과 전략 필요',
      },
      D: {
        title: '장기이별형',
        summary: '오랜 시간이 흘렀지만 미해결 감정이 남아 있습니다. 자연스러운 재접촉 명분이 중요합니다.',
        successRate: '접근 방식이 관건',
      },
    }

    return NextResponse.json({
      breakupType,
      scores,
      phase,
      ...typeDescriptions[breakupType],
      daysSinceBreakup,
    })

  } catch (error) {
    console.error('Diagnosis error:', error)
    return NextResponse.json({ error: 'Diagnosis failed' }, { status: 500 })
  }
}
