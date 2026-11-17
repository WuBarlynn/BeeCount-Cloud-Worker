export interface Env {
  DB: D1Database;
  ASSETS: Fetcher;
  BUCKET?: R2Bucket;
  SYNC_HUB?: DurableObjectNamespace;
  JWT_SECRET?: string;
  APP_NAME?: string;
  APP_VERSION?: string;
  ACCESS_TOKEN_TTL?: string;
  REFRESH_TOKEN_TTL_DAYS?: string;
  AI_BASE_URL?: string;
  AI_API_KEY?: string;
  AI_MODEL?: string;
  AI_VISION_MODEL?: string;
  ADMIN_EMAIL?: string;
  ADMIN_PASSWORD?: string;
  ALLOW_REGISTRATION?: string;
}

export type AuthUser = {
  id: string;
  email: string;
  is_admin: boolean;
  is_enabled: boolean;
  totp_enabled_at: string | null;
  created_at: string;
};

export type AuthInfo = {
  user: AuthUser;
  scopes: string[];
  clientType: string;
  via: 'jwt' | 'pat';
  tokenExp?: number;
};
