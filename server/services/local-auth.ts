import { timingSafeEqual } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";

import { normalizePhone } from "../utils/identity";

const localAuthUserSchema = z.object({
  phone: z.string().regex(/^\d{10}$/, "Phone must be a 10 digit number"),
  pin: z.string().regex(/^\d{4}$/, "PIN must be exactly 4 digits"),
  name: z.string().trim().min(1).max(100).default("Local User"),
  role: z.enum(["customer", "provider", "shop"]).default("customer"),
  language: z.string().trim().max(10).default("en"),
});

const localAuthConfigSchema = z.object({
  enabled: z.boolean().default(true),
  users: z.array(localAuthUserSchema).min(1),
});

export type LocalAuthUser = z.infer<typeof localAuthUserSchema>;

export function isLocalAuthEnabled(): boolean {
  const configured = process.env.LOCAL_AUTH_ENABLED?.trim().toLowerCase();
  const isProduction = process.env.NODE_ENV?.toLowerCase() === "production";

  if (configured === "false") return false;
  return !isProduction || configured === "true";
}

function configPath(): string {
  return path.resolve(
    process.env.LOCAL_AUTH_CONFIG_PATH?.trim() || "config/local-auth.json",
  );
}

/**
 * Local auth is enabled by default for development and must be explicitly
 * enabled in production. It is intended for demos and private deployments
 * where the operator owns the credential file.
 */
export function getLocalAuthUser(phone: string): LocalAuthUser | undefined {
  // A local config is enough while developing. Production requires an explicit
  // opt-in so a copied demo file can never accidentally open a live server.
  if (!isLocalAuthEnabled()) return undefined;

  try {
    const rawConfig = fs.readFileSync(configPath(), "utf8");
    const config = localAuthConfigSchema.parse(JSON.parse(rawConfig));
    if (!config.enabled) return undefined;

    const normalizedPhone = normalizePhone(phone);
    return config.users.find(
      (user) => normalizePhone(user.phone) === normalizedPhone,
    );
  } catch {
    // Do not reveal configuration paths or parsing errors to an unauthenticated client.
    return undefined;
  }
}

export function matchesLocalSecret(expected: string, supplied: string): boolean {
  const expectedBuffer = Buffer.from(expected, "utf8");
  const suppliedBuffer = Buffer.from(supplied, "utf8");
  return (
    expectedBuffer.length === suppliedBuffer.length &&
    timingSafeEqual(expectedBuffer, suppliedBuffer)
  );
}
