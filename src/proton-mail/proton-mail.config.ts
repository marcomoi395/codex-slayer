export interface ProtonMailConfig {
  url: string;
  email: string;
  profileDir: string;
  sender: string;
  keywords: string[];
  pollIntervalMs: number;
  pollTimeoutMs: number;
  loginTimeoutMs: number;
}
