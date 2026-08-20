export type Env = Omit<Cloudflare.Env, "PROJECT_OS_LAYOUT_MODE"> & {
  DROPBOX_APP_KEY: string;
  DROPBOX_APP_SECRET: string;
  DROPBOX_REFRESH_TOKEN: string;
  INGRESS_TOKEN: string;
  PROJECT_OS_LAYOUT_MODE?: "legacy" | "shadow" | "v2";
};
