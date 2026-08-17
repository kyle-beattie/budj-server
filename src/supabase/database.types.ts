export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  public: {
    Tables: {
      accounts: {
        Row: {
          akahu_account_id: string
          connection_id: string
          created_at: string
          currency: string
          disconnected_at: string | null
          id: string
          last_seen_at: string
          name: string
          payment_from: boolean
          payment_to: boolean
          type: Database["public"]["Enums"]["account_type"]
          updated_at: string
          user_id: string
        }
        Insert: {
          akahu_account_id: string
          connection_id: string
          created_at?: string
          currency?: string
          disconnected_at?: string | null
          id?: string
          last_seen_at?: string
          name: string
          payment_from?: boolean
          payment_to?: boolean
          type: Database["public"]["Enums"]["account_type"]
          updated_at?: string
          user_id: string
        }
        Update: {
          akahu_account_id?: string
          connection_id?: string
          created_at?: string
          currency?: string
          disconnected_at?: string | null
          id?: string
          last_seen_at?: string
          name?: string
          payment_from?: boolean
          payment_to?: boolean
          type?: Database["public"]["Enums"]["account_type"]
          updated_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "accounts_connection_id_fkey"
            columns: ["connection_id"]
            isOneToOne: false
            referencedRelation: "akahu_connections"
            referencedColumns: ["id"]
          },
        ]
      }
      akahu_connections: {
        Row: {
          connected_at: string
          connection_id: string
          created_at: string
          disconnected_at: string | null
          id: string
          logo_url: string | null
          name: string
          updated_at: string
          user_id: string
        }
        Insert: {
          connected_at?: string
          connection_id: string
          created_at?: string
          disconnected_at?: string | null
          id?: string
          logo_url?: string | null
          name?: string
          updated_at?: string
          user_id: string
        }
        Update: {
          connected_at?: string
          connection_id?: string
          created_at?: string
          disconnected_at?: string | null
          id?: string
          logo_url?: string | null
          name?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      akahu_tokens: {
        Row: {
          akahu_user_id: string | null
          created_at: string
          token_ciphertext: string
          updated_at: string
          user_id: string
        }
        Insert: {
          akahu_user_id?: string | null
          created_at?: string
          token_ciphertext: string
          updated_at?: string
          user_id: string
        }
        Update: {
          akahu_user_id?: string | null
          created_at?: string
          token_ciphertext?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      apple_grants: {
        Row: {
          created_at: string
          refresh_token_ciphertext: string
          updated_at: string
          user_id: string
        }
        Insert: {
          created_at?: string
          refresh_token_ciphertext: string
          updated_at?: string
          user_id: string
        }
        Update: {
          created_at?: string
          refresh_token_ciphertext?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      billing_subscriptions: {
        Row: {
          created_at: string
          expires_at: string | null
          last_notification_at: string | null
          last_notification_uuid: string | null
          original_transaction_id: string
          plan_code: string
          product_id: string
          status: Database["public"]["Enums"]["subscription_status"]
          updated_at: string
          user_id: string
        }
        Insert: {
          created_at?: string
          expires_at?: string | null
          last_notification_at?: string | null
          last_notification_uuid?: string | null
          original_transaction_id: string
          plan_code: string
          product_id: string
          status: Database["public"]["Enums"]["subscription_status"]
          updated_at?: string
          user_id: string
        }
        Update: {
          created_at?: string
          expires_at?: string | null
          last_notification_at?: string | null
          last_notification_uuid?: string | null
          original_transaction_id?: string
          plan_code?: string
          product_id?: string
          status?: Database["public"]["Enums"]["subscription_status"]
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      device_registrations: {
        Row: {
          apns_token: string
          created_at: string
          device_id: string
          id: string
          registered_at: string
          revoked_at: string | null
          updated_at: string
          user_id: string
        }
        Insert: {
          apns_token: string
          created_at?: string
          device_id: string
          id?: string
          registered_at?: string
          revoked_at?: string | null
          updated_at?: string
          user_id: string
        }
        Update: {
          apns_token?: string
          created_at?: string
          device_id?: string
          id?: string
          registered_at?: string
          revoked_at?: string | null
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      profiles: {
        Row: {
          avatar_url: string | null
          created_at: string
          display_name: string
          id: string
          updated_at: string
        }
        Insert: {
          avatar_url?: string | null
          created_at?: string
          display_name?: string
          id: string
          updated_at?: string
        }
        Update: {
          avatar_url?: string | null
          created_at?: string
          display_name?: string
          id?: string
          updated_at?: string
        }
        Relationships: []
      }
      rules: {
        Row: {
          actions: Json
          conditions: Json
          created_at: string
          description: string | null
          id: string
          is_enabled: boolean
          name: string
          priority: number
          stop_processing: boolean
          updated_at: string
          user_id: string
        }
        Insert: {
          actions?: Json
          conditions?: Json
          created_at?: string
          description?: string | null
          id?: string
          is_enabled?: boolean
          name: string
          priority?: number
          stop_processing?: boolean
          updated_at?: string
          user_id: string
        }
        Update: {
          actions?: Json
          conditions?: Json
          created_at?: string
          description?: string | null
          id?: string
          is_enabled?: boolean
          name?: string
          priority?: number
          stop_processing?: boolean
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      [_ in never]: never
    }
    Enums: {
      account_type:
        | "checking"
        | "savings"
        | "credit_card"
        | "cash"
        | "loan"
        | "investment"
        | "other"
      subscription_status: "active" | "grace_period" | "expired" | "revoked"
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
}

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] &
        DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] &
        DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R
      }
      ? R
      : never
    : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I
      }
      ? I
      : never
    : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U
      }
      ? U
      : never
    : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never

export const Constants = {
  public: {
    Enums: {
      account_type: [
        "checking",
        "savings",
        "credit_card",
        "cash",
        "loan",
        "investment",
        "other",
      ],
      subscription_status: ["active", "grace_period", "expired", "revoked"],
    },
  },
} as const

