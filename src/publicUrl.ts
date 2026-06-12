import { request } from "undici";
import { config } from "./config.js";
import { logger } from "./logger.js";

/**
 * Resolves the public base URL used to build the image links Meta downloads.
 *
 * Images are served by a dedicated media server bound to MEDIA_PORT. Only that
 * port needs to be reachable from the Internet (port-forward / firewall rule);
 * the admin API + OAuth can stay local.
 *
 * Base URL precedence:
 *   1. MEDIA_PUBLIC_BASE_URL (full override, e.g. behind a reverse proxy / HTTPS)
 *   2. http://<public host>:<MEDIA_PORT>
 *      where <public host> = MEDIA_PUBLIC_HOST, or the auto-detected public IP.
 */
let resolvedPublicHost: string | null = null;

async function detectPublicIp(): Promise<string | null> {
  try {
    const res = await request("https://api.ipify.org?format=text", { method: "GET" });
    const ip = (await res.body.text()).trim();
    if (/^\d{1,3}(\.\d{1,3}){3}$/.test(ip) || ip.includes(":")) return ip;
    return null;
  } catch (err) {
    logger.warn({ err: (err as Error).message }, "Could not auto-detect public IP");
    return null;
  }
}

/** Resolve the public host once at boot (call before building URLs). */
export async function initPublicHost(): Promise<void> {
  const configured = config.MEDIA_PUBLIC_HOST?.trim();

  if (configured && configured.toLowerCase() !== "auto") {
    resolvedPublicHost = configured;
    logger.info(`Media public host: ${configured}`);
    return;
  }

  const ip = await detectPublicIp();
  resolvedPublicHost = ip ?? "localhost";
  if (ip) {
    logger.info(`Auto-detected public IP for media: ${ip}`);
  } else {
    logger.warn(
      "Could not determine a public host for media — using 'localhost'. " +
        "Set MEDIA_PUBLIC_HOST to your public IP/domain so Meta can fetch images."
    );
  }
}

export function getMediaBaseUrl(): string {
  if (config.MEDIA_PUBLIC_BASE_URL) {
    return config.MEDIA_PUBLIC_BASE_URL.replace(/\/$/, "");
  }
  const host = resolvedPublicHost ?? config.MEDIA_PUBLIC_HOST ?? "localhost";
  return `http://${host}:${config.MEDIA_PORT}`;
}
