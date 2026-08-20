export interface Env extends Cloudflare.Env {
  DROPBOX_APP_KEY: string;
  DROPBOX_APP_SECRET: string;
  DROPBOX_REFRESH_TOKEN: string;
  INGRESS_TOKEN: string;
  PROJECT_OS_LAYOUT_MODE?: "legacy" | "shadow" | "v2";
}
