/**
 * Supabase Database 타입 정의
 *
 * 단일 진실의 출처(SoT): lib/db-schema.sql
 * SQL 스키마와 항상 동기화되어야 함. 마이그레이션 추가 시 본 파일도 함께 수정.
 *
 * supabase-js v2.45+ 의 GenericSchema 제약:
 *   - 최상위에 __InternalSupabase 메타 필요
 *   - 각 Tables 항목에 Row/Insert/Update + Relationships: [] 필요
 *   - Views / Functions / Enums / CompositeTypes 키 필요 (비어 있어도)
 * 누락 시 .insert / .upsert 의 인자 타입이 never 로 추론되어 빌드 실패.
 */

export type BreakupType = 'A' | 'B' | 'C' | 'D'
export type Phase = 1 | 2 | 3
export type Gender = 'male' | 'female' | 'other'
export type ChatRole = 'user' | 'assistant'
export type MissionStatus = 'active' | 'completed'
export type CommunityCategory = 'story' | 'forum'

export type Json = string | number | boolean | null | { [key: string]: Json | undefined } | Json[]

export type Database = {
  __InternalSupabase: {
    PostgrestVersion: '12'
  }
  public: {
    Tables: {
      // ── 1. profiles ───────────────────────────────────
      profiles: {
        Row: {
          id: string
          nickname: string | null
          gender: Gender | null
          avatar_url: string | null
          anon_handle: string | null
          total_points: number | null
          chat_count: number | null
          current_phase: number | null
          breakup_date: string | null
          breakup_type: BreakupType | null
          days_since_breakup: number | null
          diagnosis_summary: string | null
          situation_memo: string | null
          last_diagnosis_at: string | null
          created_at: string | null
          updated_at: string | null
        }
        Insert: {
          id: string
          nickname?: string | null
          gender?: Gender | null
          avatar_url?: string | null
          anon_handle?: string | null
          total_points?: number | null
          chat_count?: number | null
          current_phase?: number | null
          breakup_date?: string | null
          breakup_type?: BreakupType | null
          days_since_breakup?: number | null
          diagnosis_summary?: string | null
          situation_memo?: string | null
          last_diagnosis_at?: string | null
          created_at?: string | null
          updated_at?: string | null
        }
        Update: {
          id?: string
          nickname?: string | null
          gender?: Gender | null
          avatar_url?: string | null
          anon_handle?: string | null
          total_points?: number | null
          chat_count?: number | null
          current_phase?: number | null
          breakup_date?: string | null
          breakup_type?: BreakupType | null
          days_since_breakup?: number | null
          diagnosis_summary?: string | null
          situation_memo?: string | null
          last_diagnosis_at?: string | null
          created_at?: string | null
          updated_at?: string | null
        }
        Relationships: []
      }

      // ── 2. diagnosis_results ──────────────────────────
      diagnosis_results: {
        Row: {
          id: string
          user_id: string
          breakup_type: BreakupType
          phase: number
          title: string | null
          summary: string | null
          success_rate: string | null
          days_since_breakup: number | null
          scores: Json | null
          created_at: string | null
        }
        Insert: {
          id?: string
          user_id: string
          breakup_type: BreakupType
          phase: number
          title?: string | null
          summary?: string | null
          success_rate?: string | null
          days_since_breakup?: number | null
          scores?: Json | null
          created_at?: string | null
        }
        Update: {
          id?: string
          user_id?: string
          breakup_type?: BreakupType
          phase?: number
          title?: string | null
          summary?: string | null
          success_rate?: string | null
          days_since_breakup?: number | null
          scores?: Json | null
          created_at?: string | null
        }
        Relationships: []
      }

      // ── 3. chat_history ───────────────────────────────
      chat_history: {
        Row: {
          id: string
          user_id: string
          role: ChatRole
          content: string
          is_error: boolean | null
          created_at: string | null
        }
        Insert: {
          id?: string
          user_id: string
          role: ChatRole
          content: string
          is_error?: boolean | null
          created_at?: string | null
        }
        Update: {
          id?: string
          user_id?: string
          role?: ChatRole
          content?: string
          is_error?: boolean | null
          created_at?: string | null
        }
        Relationships: []
      }

      // ── 4. user_missions ──────────────────────────────
      user_missions: {
        Row: {
          id: string
          user_id: string
          mission_id: string
          title: string
          status: MissionStatus | null
          started_at: string | null
          completed_at: string | null
        }
        Insert: {
          id?: string
          user_id: string
          mission_id: string
          title: string
          status?: MissionStatus | null
          started_at?: string | null
          completed_at?: string | null
        }
        Update: {
          id?: string
          user_id?: string
          mission_id?: string
          title?: string
          status?: MissionStatus | null
          started_at?: string | null
          completed_at?: string | null
        }
        Relationships: []
      }

      // ── 5. mission_completions ────────────────────────
      mission_completions: {
        Row: {
          id: string
          user_id: string
          mission_id: string
          title: string
          points_earned: number
          proof_url: string | null
          note: string | null
          completed_at: string | null
        }
        Insert: {
          id?: string
          user_id: string
          mission_id: string
          title: string
          points_earned: number
          proof_url?: string | null
          note?: string | null
          completed_at?: string | null
        }
        Update: {
          id?: string
          user_id?: string
          mission_id?: string
          title?: string
          points_earned?: number
          proof_url?: string | null
          note?: string | null
          completed_at?: string | null
        }
        Relationships: []
      }

      // ── 6. emotion_checkins ───────────────────────────
      emotion_checkins: {
        Row: {
          id: string
          user_id: string
          emotion_score: number | null
          emotion_label: string | null
          note: string | null
          checked_at: string | null
        }
        Insert: {
          id?: string
          user_id: string
          emotion_score?: number | null
          emotion_label?: string | null
          note?: string | null
          checked_at?: string | null
        }
        Update: {
          id?: string
          user_id?: string
          emotion_score?: number | null
          emotion_label?: string | null
          note?: string | null
          checked_at?: string | null
        }
        Relationships: []
      }

      // ── 7. community_posts ────────────────────────────
      community_posts: {
        Row: {
          id: string
          author_id: string | null
          anon_handle: string
          category: CommunityCategory
          title: string
          content: string
          tag: string | null
          likes_count: number
          comments_count: number
          is_hidden: boolean
          created_at: string
          updated_at: string
        }
        Insert: {
          id?: string
          author_id: string | null
          anon_handle: string
          category: CommunityCategory
          title: string
          content: string
          tag?: string | null
          likes_count?: number
          comments_count?: number
          is_hidden?: boolean
          created_at?: string
          updated_at?: string
        }
        Update: {
          id?: string
          author_id?: string | null
          anon_handle?: string
          category?: CommunityCategory
          title?: string
          content?: string
          tag?: string | null
          likes_count?: number
          comments_count?: number
          is_hidden?: boolean
          created_at?: string
          updated_at?: string
        }
        Relationships: []
      }

      // ── 8. community_comments ─────────────────────────
      community_comments: {
        Row: {
          id: string
          post_id: string
          author_id: string | null
          anon_handle: string
          content: string
          is_ai: boolean
          is_hidden: boolean
          created_at: string
        }
        Insert: {
          id?: string
          post_id: string
          author_id: string | null
          anon_handle: string
          content: string
          is_ai?: boolean
          is_hidden?: boolean
          created_at?: string
        }
        Update: {
          id?: string
          post_id?: string
          author_id?: string | null
          anon_handle?: string
          content?: string
          is_ai?: boolean
          is_hidden?: boolean
          created_at?: string
        }
        Relationships: []
      }

      // ── 9. community_likes ────────────────────────────
      community_likes: {
        Row: {
          user_id: string
          post_id: string
          created_at: string
        }
        Insert: {
          user_id: string
          post_id: string
          created_at?: string
        }
        Update: {
          user_id?: string
          post_id?: string
          created_at?: string
        }
        Relationships: []
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      generate_anon_handle: {
        Args: Record<PropertyKey, never>
        Returns: string
      }
    }
    Enums: {
      [_ in never]: never
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
}

// 편의 헬퍼 — Tables<'profiles'> 처럼 짧게 사용 가능
export type Tables<T extends keyof Database['public']['Tables']> =
  Database['public']['Tables'][T]['Row']
export type TablesInsert<T extends keyof Database['public']['Tables']> =
  Database['public']['Tables'][T]['Insert']
export type TablesUpdate<T extends keyof Database['public']['Tables']> =
  Database['public']['Tables'][T]['Update']
