import passport from "passport";
import { Strategy as LocalStrategy } from "passport-local";

import { Express } from "express";
import { z } from "zod";
import session from "express-session";
import logger from "./logger";
import { scrypt, randomBytes, timingSafeEqual, createHash, randomInt } from "crypto";
import { promisify } from "util";
import { storage } from "./storage";

import {
  User as SelectUser,
  type InsertUser,
  shopProfileSchema,

  phoneOtpTokens,
  checkUserSchema,
  ruralRegisterSchema,
  pinLoginSchema,
  resetPinSchema,
  signupOtpRequestSchema,
  forgotPasswordOtpSchema,
  verifyResetOtpSchema,
  resetPasswordSchema,
  workerLoginSchema,
  shops,
  providers,
  users,
  shopWorkers,
} from "@shared/schema";
import { db } from "./db";
import { eq, and, lt } from "drizzle-orm";
import dotenv from "dotenv";
import {
  loginLimiter,
  registerLimiter,
  deleteAccountLimiter,
} from "./security/rateLimiters";
import { sanitizeUser } from "./security/sanitizeUser";
import {
  normalizeUsername,
  normalizeEmail,
  normalizePhone,
} from "./utils/identity";
import { sanitizeAndValidateSecret } from "./security/secretValidators";
import {
  getCache,
  invalidateCache,
  setCache,
} from "./services/cache.service";
import {
  getLocalAuthUser,
  isLocalAuthEnabled,
  matchesLocalSecret,
  type LocalAuthUser,
} from "./services/local-auth";
dotenv.config();

declare module "express-session" {
  interface SessionData {
    returnTo?: string;
  }
}

const PUBLIC_REGISTRATION_ROLES = ["customer", "provider", "shop"] as const;

const usernameRegex = /^[a-z0-9._-]+$/i;

const registrationSchemaBase = z.object({
  username: z
    .string()
    .trim()
    .min(3, "Username must be at least 3 characters")
    .max(32, "Username must be at most 32 characters")
    .regex(
      usernameRegex,
      "Username can only contain letters, numbers, dots, underscores, and hyphens",
    ),
  password: z
    .string()
    .min(8, "Password must be at least 8 characters long")
    .max(64, "Password must be at most 64 characters long"),
  role: z
    .enum(PUBLIC_REGISTRATION_ROLES)
    .default("customer"),
  name: z
    .string()
    .trim()
    .min(1, "Name is required")
    .max(100, "Name must be at most 100 characters"),
  phone: z
    .string()
    .trim()
    .min(8, "Phone number must be at least 8 digits")
    .max(20, "Phone number must be at most 20 digits")
    .regex(/^\d+$/, "Phone number must contain digits only"),
  email: z
    .string()
    .trim()
    .email("Invalid email address"),
  language: z.string().trim().max(10).optional(),
  bio: z.string().trim().max(1000).optional(),
  experience: z.string().trim().max(200).optional(),
  languages: z.string().trim().max(200).optional(),
  shopProfile: shopProfileSchema.optional(),
});

const registrationSchema = registrationSchemaBase
  .extend({
    emailVerified: z.boolean().optional(),
    averageRating: z.string().optional(),
    totalReviews: z.number().int().optional(),
  })
  .strict();

declare global {
  namespace Express {
    interface User extends Omit<SelectUser, "password"> {
      hasShopProfile?: boolean;
      hasProviderProfile?: boolean;
    }
  }
}

const scryptAsync = promisify(scrypt);

export async function hashPasswordInternal(password: string) {
  // Exported for use in password reset
  const salt = randomBytes(16).toString("hex");
  const buf = (await scryptAsync(password, salt, 64)) as Buffer;
  return `${buf.toString("hex")}.${salt}`;
}

async function comparePasswords(
  supplied: string,
  stored: string | null | undefined,
) {
  if (typeof stored !== "string" || stored.length === 0) {
    return false;
  }

  const parts = stored.split(".");
  if (parts.length !== 2) {
    logger.warn("Stored password hash has unexpected format");
    return false;
  }

  const [hashed, salt] = parts;
  if (!hashed || !salt) {
    return false;
  }

  try {
    const hashedBuf = Buffer.from(hashed, "hex");
    const suppliedBuf = (await scryptAsync(supplied, salt, 64)) as Buffer;
    if (hashedBuf.length !== suppliedBuf.length) {
      return false;
    }
    return timingSafeEqual(hashedBuf, suppliedBuf);
  } catch (error) {
    logger.warn({ err: error }, "Password comparison failed");
    return false;
  }
}

async function provisionLocalAuthUser(configuredUser: LocalAuthUser) {
  const normalizedPhone = normalizePhone(configuredUser.phone);
  if (!normalizedPhone) {
    throw new Error("Local auth configuration contains an invalid phone number");
  }

  const existingUser = await storage.getUserByPhone(normalizedPhone);
  if (existingUser) {
    const updates: Partial<SelectUser> = {
      isPhoneVerified: true,
      verificationStatus: "verified",
    };

    // The local config is the source of truth for the dummy PIN. This also
    // upgrades users created by the old password-based demo flow.
    if (
      !existingUser.pin ||
      !(await comparePasswords(configuredUser.pin, existingUser.pin))
    ) {
      updates.pin = await hashPasswordInternal(configuredUser.pin);
    }

    if (
      existingUser.verificationStatus !== "verified" ||
      !existingUser.isPhoneVerified ||
      updates.pin
    ) {
      const updatedUser = await storage.updateUser(existingUser.id, updates);
      await invalidateCache(`user_session:${existingUser.id}`);
      return updatedUser;
    }
    return existingUser;
  }

  const user = await storage.createUser({
    username: `local_${normalizedPhone}`,
    password: null,
    pin: await hashPasswordInternal(configuredUser.pin),
    phone: normalizedPhone,
    name: configuredUser.name,
    role: configuredUser.role,
    language: configuredUser.language,
    isPhoneVerified: true,
    verificationStatus: "verified",
    emailVerified: false,
    averageRating: "0",
    totalReviews: 0,
  });

  if (configuredUser.role === "shop") {
    await db.primary.insert(shops).values({
      ownerId: user.id,
      shopName: `${configuredUser.name}'s Shop`,
    });
  } else if (configuredUser.role === "provider") {
    await db.primary.insert(providers).values({ userId: user.id });
  }

  await invalidateCache(`user_session:${user.id}`);

  return user;
}

/**
 * Profile capabilities are derived from the shops/providers tables rather than
 * the user's primary role. Refresh them whenever a session is hydrated so a
 * customer who creates a second profile can use it immediately.
 */
async function hydrateProfileCapabilities(user: Express.User): Promise<Express.User> {
  if (process.env.NODE_ENV === "test") {
    user.hasShopProfile = user.role === "shop" || Boolean(user.shopProfile);
    user.hasProviderProfile = user.role === "provider";
    return user;
  }

  try {
    const [shopExists, providerExists] = await Promise.all([
      db.primary
        .select({ id: shops.id })
        .from(shops)
        .where(eq(shops.ownerId, user.id))
        .limit(1),
      db.primary
        .select({ id: providers.id })
        .from(providers)
        .where(eq(providers.userId, user.id))
        .limit(1),
    ]);

    user.hasShopProfile = shopExists.length > 0;
    user.hasProviderProfile = providerExists.length > 0;
  } catch (error) {
    logger.warn({ err: error, userId: user.id }, "Failed to refresh profile capabilities");
  }

  return user;
}

export function initializeAuth(app: Express) {
  logger.info(
    isLocalAuthEnabled()
      ? "PIN-only local authentication is enabled"
      : "PIN-only local authentication is disabled",
  );

  const sessionSecret = sanitizeAndValidateSecret(
    "SESSION_SECRET",
    process.env.SESSION_SECRET,
    {
      minLength: 32,
      requireUppercase: true,
      requireLowercase: true,
      requireNumber: true,
      requireSymbol: true,
      disallowedPatterns: [/secret/i, /password/i, /changeme/i, /admin/i],
      environment: process.env.NODE_ENV ?? "development",
    },
  );

  const sessionSettings: session.SessionOptions = {
    secret: sessionSecret,
    resave: false,
    saveUninitialized: false,
    store: storage.sessionStore,
    cookie: {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax",
      maxAge: 30 * 24 * 60 * 60 * 1000, // 30 days for rural users
    },
  };

  const cookieOptions = sessionSettings.cookie!;

  const configuredSameSite = process.env.SESSION_COOKIE_SAMESITE?.toLowerCase();
  if (configuredSameSite === "false" || configuredSameSite === "disabled") {
    cookieOptions.sameSite = false;
  } else if (configuredSameSite === "strict" || configuredSameSite === "lax") {
    cookieOptions.sameSite = configuredSameSite;
  } else if (configuredSameSite === "none") {
    cookieOptions.sameSite = "none";
    const secureOverride = process.env.SESSION_COOKIE_SECURE;
    if (secureOverride === "true") {
      cookieOptions.secure = true;
    } else if (secureOverride === "false") {
      cookieOptions.secure = false;
    } else {
      cookieOptions.secure = true;
    }
  }

  const cookieDomain = process.env.SESSION_COOKIE_DOMAIN;
  if (cookieDomain) {
    cookieOptions.domain = cookieDomain;
  }

  app.set("trust proxy", 1);
  app.use(session(sessionSettings));
  app.use(passport.initialize());
  app.use(passport.session());

  passport.use(
    new LocalStrategy(async (identifier, password, done) => {
      const normalizedUsername = normalizeUsername(identifier);
      const normalizedEmail = normalizeEmail(identifier);
      const normalizedPhone = normalizePhone(identifier);

      let userRecord =
        normalizedUsername !== null
          ? await storage.getUserByUsername(normalizedUsername)
          : undefined;
      if (!userRecord && normalizedEmail) {
        userRecord = await storage.getUserByEmail(normalizedEmail);
      }
      if (!userRecord && normalizedPhone) {
        userRecord = await storage.getUserByPhone(normalizedPhone);
      }
      if (
        !userRecord ||
        !(await comparePasswords(password, (userRecord as SelectUser).password))
      ) {
        return done(null, false);
      }
      // Block suspended users from logging in
      if ((userRecord as any)?.isSuspended) {
        return done(null, false);
      }
      const sanitizedUser = sanitizeUser(userRecord);
      return done(null, (sanitizedUser as Express.User) ?? false);
    }),
  );

  passport.serializeUser((user: Express.User, done) => done(null, user.id));
  passport.deserializeUser(async (id: number, done) => {
    try {
      const cacheKey = `user_session:${id}`;
      const cachedUser = await getCache<Express.User>(cacheKey);

      if (cachedUser) {
        // Older cache entries did not contain capability flags. Refresh those
        // entries once; current entries are kept fast and role guards still
        // refresh a missing capability immediately when it is needed.
        if (
          cachedUser.hasShopProfile === undefined ||
          cachedUser.hasProviderProfile === undefined
        ) {
          await hydrateProfileCapabilities(cachedUser);
          await setCache(cacheKey, cachedUser, 300);
        }
        // Hydrate Date objects from JSON
        if (typeof cachedUser.createdAt === "string") {
          cachedUser.createdAt = new Date(cachedUser.createdAt);
        }
        return done(null, cachedUser);
      }

      const user = await storage.getUser(id);
      if (!user) {
        return done(null, false);
      }
      const safeUser = sanitizeUser(user);

      if (safeUser) {
        await hydrateProfileCapabilities(safeUser as Express.User);

        await setCache(cacheKey, safeUser, 300);
      }

      return done(null, (safeUser as Express.User) ?? false);
    } catch (error) {
      return done(error as Error);
    }
  });
}

export function registerAuthRoutes(app: Express) {
  const localLoginSchema = pinLoginSchema;

  const getLocalSignupOtp = (): string | undefined => {
    const configuredOtp = process.env.LOCAL_AUTH_OTP?.trim();
    return configuredOtp && /^\d{6}$/.test(configuredOtp)
      ? configuredOtp
      : undefined;
  };

  const canUseDevelopmentOtp = () =>
    process.env.NODE_ENV?.toLowerCase() !== "production" &&
    isLocalAuthEnabled();

  const loginWithPin = async (
    req: any,
    res: any,
    next: any,
    phone: string,
    pin: string,
  ) => {
    const normalizedPhone = normalizePhone(phone);
    if (!normalizedPhone) {
      return res.status(400).json({ message: "Invalid phone format" });
    }

    try {
      const configuredUser = getLocalAuthUser(normalizedPhone);
      let user: SelectUser | undefined;

      if (configuredUser) {
        if (matchesLocalSecret(configuredUser.pin, pin)) {
          user = await provisionLocalAuthUser(configuredUser);
        }
      } else {
        user = await storage.getUserByPhone(normalizedPhone);
        if (user?.pin && !(await comparePasswords(pin, user.pin))) {
          user = undefined;
        }
      }

      if (!user) {
        return res.status(401).json({ message: "Invalid mobile number or PIN" });
      }
      if (user.isSuspended) {
        return res.status(403).json({ message: "Account suspended" });
      }
      if (!user.pin) {
        return res.status(400).json({
          message: "PIN not set. Configure a four-digit PIN before signing in.",
          needsPinReset: true,
        });
      }

      const safeUser = sanitizeUser(user);
      if (!safeUser) {
        return res.status(500).json({ message: "Unable to complete login" });
      }

      return req.login(safeUser as Express.User, (error: unknown) => {
        if (error) return next(error);
        return res.status(200).json(safeUser);
      });
    } catch (error) {
      logger.error({ err: error }, "PIN login failed");
      return res.status(500).json({ message: "Unable to sign in with PIN" });
    }
  };

  /**
   * Local, file-configured sign-in. This uses only a phone number and the
   * four-digit PIN from config/local-auth.json.
   */
  app.post("/api/auth/local/login", loginLimiter, async (req, res, next) => {
    const parsed = localLoginSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ message: "Enter a valid phone number and four-digit PIN" });
    }
    return loginWithPin(req, res, next, parsed.data.phone, parsed.data.pin);
  });

  app.post("/api/register", registerLimiter, async (req, res, next) => {
    const parsedBody = registrationSchema.safeParse(req.body);
    if (!parsedBody.success) {
      return res.status(400).json({
        message: "Invalid input",
        errors: parsedBody.error.errors,
      });
    }

    const validatedData = parsedBody.data;
    const normalizedUsername = normalizeUsername(validatedData.username);
    const normalizedEmail = normalizeEmail(validatedData.email);
    const normalizedPhone = normalizePhone(validatedData.phone);

    if (!normalizedUsername) {
      return res.status(400).json({ message: "Username is invalid" });
    }
    if (!normalizedEmail) {
      return res.status(400).json({ message: "Email is invalid" });
    }
    if (!normalizedPhone) {
      return res.status(400).json({ message: "Phone number is invalid" });
    }

    try {
      const existingUser = await storage.getUserByUsername(normalizedUsername);
      if (existingUser) {
        return res.status(400).json({ message: "Username already exists" });
      }

      const existingEmail = await storage.getUserByEmail(normalizedEmail);
      if (existingEmail) {
        return res.status(400).json({ message: "Email already in use" });
      }

      if (normalizedPhone.length > 0) {
        const existingByPhone = await storage.getUserByPhone(normalizedPhone);
        if (existingByPhone) {
          return res.status(400).json({ message: "Phone number already in use" });
        }
      }

      const userToCreate: InsertUser = {
        username: normalizedUsername,
        password: await hashPasswordInternal(validatedData.password),
        role: validatedData.role,
        name: validatedData.name.trim(),
        phone: normalizedPhone,
        email: normalizedEmail,
        language: validatedData.language ?? "ta",
        bio:
          validatedData.role === "provider"
            ? validatedData.bio?.trim() ?? null
            : null,
        experience:
          validatedData.role === "provider"
            ? validatedData.experience?.trim() ?? null
            : null,
        languages:
          validatedData.role === "provider"
            ? validatedData.languages?.trim() ?? null
            : null,
        shopProfile:
          validatedData.role === "shop"
            ? validatedData.shopProfile ?? null
            : null,
        emailVerified: false,
        isPhoneVerified: false,
        averageRating: "0",
        totalReviews: 0,
      };

      const user = await storage.createUser(userToCreate);

      const safeUser = sanitizeUser(user);
      if (!safeUser) {
        return res
          .status(500)
          .json({ message: "Unable to create user. Please try again." });
      }

      req.login(safeUser as Express.User, (err) => {
        if (err) return next(err);
        return res.status(201).json(safeUser);
      });
    } catch (error) {
      logger.error({ err: error }, "Failed to register user");
      return res.status(500).json({ message: "Failed to register user" });
    }
  });

  app.post(
    "/api/login",
    loginLimiter,
    passport.authenticate("local"),
    (req, res) => {
      const safeUser = sanitizeUser(req.user as Express.User);
      if (!safeUser) {
        return res
          .status(500)
          .json({ message: "Unable to complete login. Please try again." });
      }
      res.status(200).json(safeUser);
    },
  );

  app.post("/api/logout", (req, res, next) => {
    req.logout((err) => {
      if (err) return next(err);
      res.sendStatus(200);
    });
  });

  app.get("/api/user", (req, res) => {
    if (!req.isAuthenticated?.() || !req.user) {
      return res.json(null);
    }

    const safeUser = sanitizeUser(req.user as Express.User);
    if (!safeUser) {
      return res.json(null);
    }

    res.json(safeUser);
  });

  app.post("/api/delete-account", deleteAccountLimiter, async (req, res) => {
    if (!req.isAuthenticated() || !req.user) {
      return res.status(401).json({ message: "Unauthorized" });
    }
    try {
      const userId = req.user.id;
      await storage.deleteUserAndData(userId);
      req.logout((err) => {
        if (err) {
          return res
            .status(500)
            .json({ message: "Account deleted, but failed to log out." });
        }
        req.session.destroy(() => {
          res
            .status(200)
            .json({ message: "Account and all data deleted successfully." });
        });
      });
    } catch (error) {
      logger.error({ err: error }, "Error deleting user account");
      res.status(500).json({ message: "Failed to delete account." });
    }
  });

  // =====================================================
  // PIN-FIRST AUTH ROUTES (Mobile + PIN)
  // =====================================================

  // Check if a phone number exists in the system
  app.post("/api/auth/check-user", loginLimiter, async (req, res) => {
    const parsed = checkUserSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({
        message: "Invalid phone number",
        errors: parsed.error.errors,
      });
    }

    const { phone } = parsed.data;
    const normalizedPhone = normalizePhone(phone);

    if (!normalizedPhone) {
      return res.status(400).json({ message: "Invalid phone format" });
    }

    try {
      const configuredUser = getLocalAuthUser(normalizedPhone);
      const user = await storage.getUserByPhone(normalizedPhone);
      if (user) {
        return res.json({
          exists: true,
          name: user.name,
          isPhoneVerified: user.isPhoneVerified,
        });
      }
      if (configuredUser) {
        return res.json({
          exists: true,
          name: configuredUser.name,
          isPhoneVerified: true,
        });
      }
      return res.json({ exists: false });
    } catch (error) {
      logger.error({ err: error }, "Error checking user");
      return res.status(500).json({ message: "Server error" });
    }
  });

  // Local registration: Phone + OTP + Name + PIN + selected role
  app.post("/api/auth/rural-register", registerLimiter, async (req, res, next) => {
    const parsed = ruralRegisterSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({
        message: "Invalid input",
        errors: parsed.error.errors,
      });
    }

    if (!isLocalAuthEnabled()) {
      return res.status(404).json({ message: "PIN registration is disabled" });
    }

    const { phone, name, otp, pin, initialRole, language } = parsed.data;
    const normalizedPhone = normalizePhone(phone);
    if (!normalizedPhone) {
      return res.status(400).json({ message: "Invalid phone format" });
    }

    try {
      // Check if phone already exists
      const existingUser = await storage.getUserByPhone(normalizedPhone);
      if (existingUser) {
        return res.status(400).json({ message: "Phone number already registered" });
      }

      if (getLocalAuthUser(normalizedPhone)) {
        return res.status(400).json({
          message: "This phone is already configured for local sign-in. Use the sign-in tab.",
        });
      }

      // Local development may use a configured dummy OTP so the flow works
      // without Firebase, SMS, or a third-party provider. Production uses an
      // OTP stored by the request endpoint and never receives this bypass.
      const localOtp = getLocalSignupOtp();
      const localOtpMatches =
        canUseDevelopmentOtp() &&
        Boolean(localOtp) &&
        matchesLocalSecret(localOtp!, otp);
      let otpRecordId: number | undefined;

      if (!localOtpMatches) {
        const otpHash = createHash("sha256").update(otp).digest("hex");
        const otpRecords = await db.primary
          .select()
          .from(phoneOtpTokens)
          .where(
            and(
              eq(phoneOtpTokens.phone, normalizedPhone),
              eq(phoneOtpTokens.otpHash, otpHash),
              eq(phoneOtpTokens.purpose, "phone_verification"),
              eq(phoneOtpTokens.isUsed, false),
            ),
          )
          .limit(1);
        const otpRecord = otpRecords[0];

        if (!otpRecord) {
          return res.status(400).json({ message: "Invalid OTP" });
        }
        if (otpRecord.expiresAt < new Date()) {
          return res.status(400).json({ message: "OTP expired. Please request a new one." });
        }
        otpRecordId = otpRecord.id;
      }

      // Hash the PIN using the same scrypt method as passwords
      const hashedPin = await hashPasswordInternal(pin);

      // Generate username from phone number for rural users
      const generatedUsername = `user_${normalizedPhone.replace(/\D/g, "").slice(-10)}`;

      const userToCreate: InsertUser = {
        username: generatedUsername,
        phone: normalizedPhone,
        name: name.trim(),
        pin: hashedPin,
        role: initialRole ?? "customer",
        language: language ?? "ta",
        isPhoneVerified: true,
        emailVerified: false,
        verificationStatus: "verified",
        profileCompleteness: 100,
        averageRating: "0",
        totalReviews: 0,
      };

      const user = await storage.createUser(userToCreate);

      // If they chose shop or provider, create the profile entry
      if (initialRole === "shop") {
        await db.primary.insert(shops).values({
          ownerId: user.id,
          shopName: `${name}'s Shop`,
        });
      } else if (initialRole === "provider") {
        await db.primary.insert(providers).values({
          userId: user.id,
        });
      }

      if (otpRecordId !== undefined) {
        await db.primary
          .update(phoneOtpTokens)
          .set({ isUsed: true })
          .where(eq(phoneOtpTokens.id, otpRecordId));
      }

      const safeUser = sanitizeUser(user);
      if (!safeUser) {
        return res.status(500).json({ message: "Failed to create user" });
      }

      req.login(safeUser as Express.User, (err) => {
        if (err) return next(err);
        return res.status(201).json(safeUser);
      });
    } catch (error) {
      logger.error({ err: error }, "Rural registration failed");
      return res.status(500).json({ message: "Registration failed" });
    }
  });

  // PIN Login: Phone + PIN
  app.post("/api/auth/login-pin", loginLimiter, async (req, res, next) => {
    const parsed = pinLoginSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({
        message: "Invalid input",
        errors: parsed.error.errors,
      });
    }

    return loginWithPin(req, res, next, parsed.data.phone, parsed.data.pin);
  });

  // PIN changes are configuration changes for this private/demo auth mode.
  // Do not expose an unauthenticated reset endpoint that could be used to
  // overwrite a user's stored PIN; edit config/local-auth.json and restart.
  app.post("/api/auth/reset-pin", loginLimiter, async (req, res) => {
    const parsed = resetPinSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({
        message: "Invalid input",
        errors: parsed.error.errors,
      });
    }

    if (!isLocalAuthEnabled()) {
      return res.status(404).json({ message: "PIN reset is disabled" });
    }

    const { phone } = parsed.data;
    const normalizedPhone = normalizePhone(phone);
    if (!normalizedPhone) {
      return res.status(400).json({ message: "Invalid phone format" });
    }
    if (!req.isAuthenticated() || !req.user) {
      return res.status(401).json({ message: "Sign in before changing your PIN" });
    }
    if (normalizePhone(req.user.phone ?? "") !== normalizedPhone) {
      return res.status(403).json({ message: "You can only change your own PIN" });
    }

    return res.status(409).json({
      message: "PIN changes are managed by config/local-auth.json. Restart the server after editing it.",
    });
  });

  // =====================================================
  // WORKER LOGIN (10-digit number + 4-digit PIN)
  // =====================================================
  app.post("/api/auth/worker-login", loginLimiter, async (req, res, next) => {
    const parsed = workerLoginSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({
        message: "Invalid input",
        errors: parsed.error.errors,
      });
    }

    const { workerNumber, pin } = parsed.data;

    try {
      // Find user by workerNumber
      const [user] = await db.primary
        .select()
        .from(users)
        .where(eq(users.workerNumber, workerNumber));

      if (!user) {
        return res.status(401).json({ message: "Invalid worker number or PIN" });
      }

      if (user.isSuspended) {
        return res.status(403).json({ message: "Account suspended" });
      }

      if (user.role !== "worker") {
        return res.status(401).json({ message: "Invalid worker number or PIN" });
      }

      // Check if worker is active in shopWorkers table
      const [workerLink] = await db.primary
        .select({ active: shopWorkers.active })
        .from(shopWorkers)
        .where(eq(shopWorkers.workerUserId, user.id));

      if (!workerLink || !workerLink.active) {
        return res.status(403).json({ message: "Worker account is inactive" });
      }

      if (!user.pin) {
        return res.status(400).json({
          message: "PIN not set. Please contact the shop owner.",
        });
      }

      // Compare PIN using timing-safe comparison
      const isPinValid = await comparePasswords(pin, user.pin);
      if (!isPinValid) {
        return res.status(401).json({ message: "Invalid worker number or PIN" });
      }

      const safeUser = sanitizeUser(user);
      if (!safeUser) {
        return res.status(500).json({ message: "Login failed" });
      }

      req.login(safeUser as Express.User, (err) => {
        if (err) return next(err);
        return res.status(200).json(safeUser);
      });
    } catch (error) {
      logger.error({ err: error }, "Worker login failed");
      return res.status(500).json({ message: "Login failed" });
    }
  });

  // =====================================================
  // FORGOT PASSWORD OTP ENDPOINTS
  // =====================================================

  // Generate 6-digit OTP
  function generateOtp(): string {
    return randomInt(100000, 1000000).toString();
  }

  // Request an OTP for a brand-new local account. In development the code is
  // returned in the response so local testing does not require Firebase/SMS.
  app.post("/api/auth/request-signup-otp", loginLimiter, async (req, res) => {
    const parsed = signupOtpRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({
        message: "Enter a valid 10-digit phone number",
        errors: parsed.error.errors,
      });
    }

    const normalizedPhone = normalizePhone(parsed.data.phone);
    if (!normalizedPhone) {
      return res.status(400).json({ message: "Invalid phone format" });
    }

    try {
      const existingUser = await storage.getUserByPhone(normalizedPhone);
      if (existingUser || getLocalAuthUser(normalizedPhone)) {
        return res.status(409).json({
          message: "This phone number is already registered. Use the sign-in tab.",
        });
      }

      await db.primary.delete(phoneOtpTokens).where(
        and(
          eq(phoneOtpTokens.phone, normalizedPhone),
          eq(phoneOtpTokens.purpose, "phone_verification"),
          eq(phoneOtpTokens.isUsed, false),
        ),
      );

      const otp = canUseDevelopmentOtp()
        ? getLocalSignupOtp() ?? generateOtp()
        : generateOtp();
      const otpHash = createHash("sha256").update(otp).digest("hex");
      const expiresAt = new Date(Date.now() + 10 * 60 * 1000);

      await db.primary.insert(phoneOtpTokens).values({
        phone: normalizedPhone,
        otpHash,
        purpose: "phone_verification",
        expiresAt,
      });

      const response: {
        success: true;
        message: string;
        developmentOtp?: string;
      } = {
        success: true,
        message: "OTP generated. Enter it to finish creating your account.",
      };
      if (canUseDevelopmentOtp()) {
        response.developmentOtp = otp;
      }

      return res.json(response);
    } catch (error) {
      logger.error({ err: error }, "Failed to create signup OTP");
      return res.status(500).json({ message: "Failed to create signup OTP" });
    }
  });

  // Send OTP for forgot password
  app.post("/api/auth/forgot-password-otp", loginLimiter, async (req, res) => {
    const parsed = forgotPasswordOtpSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({
        message: "Invalid phone number",
        errors: parsed.error.errors,
      });
    }

    const { phone } = parsed.data;
    const normalizedPhone = normalizePhone(phone);

    if (!normalizedPhone) {
      return res.status(400).json({ message: "Invalid phone format" });
    }

    try {
      // Check if user exists
      const user = await storage.getUserByPhone(normalizedPhone);
      if (!user) {
        // Don't reveal if user exists or not for security
        return res.json({ success: true, message: "If this phone number is registered, you will receive an OTP" });
      }

      // Delete any existing unused OTPs for this phone
      await db.primary.delete(phoneOtpTokens)
        .where(and(
          eq(phoneOtpTokens.phone, normalizedPhone),
          eq(phoneOtpTokens.purpose, "forgot_password"),
          eq(phoneOtpTokens.isUsed, false)
        ));

      // Generate OTP
      const otp = generateOtp();
      const otpHash = createHash("sha256").update(otp).digest("hex");
      const expiresAt = new Date(Date.now() + 10 * 60 * 1000); // 10 minutes

      // Store OTP
      await db.primary.insert(phoneOtpTokens).values({
        phone: normalizedPhone,
        otpHash,
        purpose: "forgot_password",
        expiresAt,
      });

      // SECURITY: Only log OTP in development - never expose in production logs!
      if (process.env.NODE_ENV === 'development') {
        logger.info(`[FORGOT PASSWORD OTP] Phone: ${normalizedPhone}, OTP: ${otp}`);
        console.log(`\n🔐 FORGOT PASSWORD OTP for ${normalizedPhone}: ${otp}\n`);
      } else {
        // In production, only log that OTP was sent (without the actual OTP value)
        logger.info(`[FORGOT PASSWORD OTP] OTP sent to phone: ${normalizedPhone.slice(0, -4)}****`);
        // TODO: Integrate with SMS provider (Twilio, MSG91, etc.) for actual SMS delivery
      }

      return res.json({ success: true, message: "OTP sent successfully" });
    } catch (error) {
      logger.error({ err: error }, "Failed to send forgot password OTP");
      return res.status(500).json({ message: "Failed to send OTP" });
    }
  });

  // Verify OTP for password reset
  app.post("/api/auth/verify-reset-otp", loginLimiter, async (req, res) => {
    const parsed = verifyResetOtpSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({
        message: "Invalid input",
        errors: parsed.error.errors,
      });
    }

    const { phone, otp } = parsed.data;
    const normalizedPhone = normalizePhone(phone);

    if (!normalizedPhone) {
      return res.status(400).json({ message: "Invalid phone format" });
    }

    try {
      const otpHash = createHash("sha256").update(otp).digest("hex");

      // Find valid OTP
      const otpRecords = await db.primary
        .select()
        .from(phoneOtpTokens)
        .where(and(
          eq(phoneOtpTokens.phone, normalizedPhone),
          eq(phoneOtpTokens.otpHash, otpHash),
          eq(phoneOtpTokens.purpose, "forgot_password"),
          eq(phoneOtpTokens.isUsed, false)
        ))
        .limit(1);

      const otpRecord = otpRecords[0];

      if (!otpRecord) {
        return res.status(400).json({ message: "Invalid OTP" });
      }

      if (otpRecord.expiresAt < new Date()) {
        return res.status(400).json({ message: "OTP expired. Please request a new one." });
      }

      // OTP is valid - don't mark as used yet, that happens on password reset
      return res.json({ success: true, message: "OTP verified" });
    } catch (error) {
      logger.error({ err: error }, "Failed to verify reset OTP");
      return res.status(500).json({ message: "Verification failed" });
    }
  });

  // Reset password/PIN after OTP verification
  app.post("/api/auth/reset-password", loginLimiter, async (req, res) => {
    const parsed = resetPasswordSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({
        message: "Invalid input",
        errors: parsed.error.errors,
      });
    }

    const { phone, otp, newPin } = parsed.data;
    const normalizedPhone = normalizePhone(phone);

    if (!normalizedPhone) {
      return res.status(400).json({ message: "Invalid phone format" });
    }

    try {
      const otpHash = createHash("sha256").update(otp).digest("hex");

      // Verify OTP is still valid
      const otpRecords = await db.primary
        .select()
        .from(phoneOtpTokens)
        .where(and(
          eq(phoneOtpTokens.phone, normalizedPhone),
          eq(phoneOtpTokens.otpHash, otpHash),
          eq(phoneOtpTokens.purpose, "forgot_password"),
          eq(phoneOtpTokens.isUsed, false)
        ))
        .limit(1);

      const otpRecord = otpRecords[0];

      if (!otpRecord) {
        return res.status(400).json({ message: "Invalid or expired OTP" });
      }

      if (otpRecord.expiresAt < new Date()) {
        return res.status(400).json({ message: "OTP expired. Please request a new one." });
      }

      // Find user
      const user = await storage.getUserByPhone(normalizedPhone);
      if (!user) {
        return res.status(404).json({ message: "User not found" });
      }

      // Hash the new PIN
      const hashedPin = await hashPasswordInternal(newPin);

      // Update user's PIN
      await storage.updateUser(user.id, {
        pin: hashedPin,
        isPhoneVerified: true,
      });

      // Mark OTP as used
      await db.primary.update(phoneOtpTokens)
        .set({ isUsed: true })
        .where(eq(phoneOtpTokens.id, otpRecord.id));

      // Cleanup expired OTPs (async, don't wait)
      db.primary.delete(phoneOtpTokens)
        .where(lt(phoneOtpTokens.expiresAt, new Date()))
        .catch(err => logger.warn({ err }, "Failed to cleanup expired OTPs"));

      logger.info(`[FORGOT PASSWORD] PIN reset successful for ${normalizedPhone}`);
      return res.json({ success: true, message: "PIN reset successfully" });
    } catch (error) {
      logger.error({ err: error }, "Failed to reset password");
      return res.status(500).json({ message: "Failed to reset PIN" });
    }
  });

  // Get user profiles (shop and provider status)
  app.get("/api/auth/profiles", async (req, res) => {
    if (!req.isAuthenticated?.() || !req.user) {
      return res.status(401).json({ message: "Not authenticated" });
    }

    try {
      const userId = req.user.id;

      // Check if user has a shop profile
      const shopResult = await db.primary
        .select()
        .from(shops)
        .where(eq(shops.ownerId, userId))
        .limit(1);

      // Check if user has a provider profile
      const providerResult = await db.primary
        .select()
        .from(providers)
        .where(eq(providers.userId, userId))
        .limit(1);

      const hasShop = shopResult.length > 0;
      const hasProvider = providerResult.length > 0;

      req.user.hasShopProfile = hasShop;
      req.user.hasProviderProfile = hasProvider;
      await setCache(`user_session:${userId}`, req.user, 300);

      return res.json({
        hasShop,
        shop: shopResult[0] ?? null,
        hasProvider,
        provider: providerResult[0] ?? null,
      });
    } catch (error) {
      logger.error({ err: error }, "Failed to fetch profiles");
      return res.status(500).json({ message: "Failed to fetch profiles" });
    }
  });

  // Create shop profile
  app.post("/api/auth/create-shop", async (req, res) => {
    if (!req.isAuthenticated?.() || !req.user) {
      return res.status(401).json({ message: "Not authenticated" });
    }

    const createShopSchema = z
      .object({
        shopName: z.string().trim().min(1, "Shop name is required").max(120),
        description: z.string().trim().max(2000).optional(),
        businessType: z.string().trim().max(200).optional(),
        useCustomerAddress: z.boolean().optional().default(true),
        shopAddressStreet: z.string().trim().max(250).optional(),
        shopAddressArea: z.string().trim().max(200).optional(),
        shopAddressCity: z.string().trim().max(100).optional(),
        shopAddressState: z.string().trim().max(100).optional(),
        shopAddressPincode: z.string().trim().max(20).optional(),
        shopLocationLat: z.union([z.string(), z.number()]).optional().nullable(),
        shopLocationLng: z.union([z.string(), z.number()]).optional().nullable(),
      })
      .strict();
    const parsedBody = createShopSchema.safeParse(req.body);
    if (!parsedBody.success) {
      return res.status(400).json({
        message: "Invalid shop profile data",
        errors: parsedBody.error.flatten(),
      });
    }

    try {
      const userId = req.user.id;
      const {
        shopName,
        description,
        businessType,
        useCustomerAddress,
        shopAddressStreet,
        shopAddressArea,
        shopAddressCity,
        shopAddressState,
        shopAddressPincode,
        shopLocationLat,
        shopLocationLng,
      } = parsedBody.data;

      // Check if shop already exists
      const existing = await db.primary
        .select()
        .from(shops)
        .where(eq(shops.ownerId, userId))
        .limit(1);

      if (existing.length > 0) {
        return res.status(400).json({ message: "You already have a shop" });
      }
      const owner = await storage.getUser(userId);
      if (!owner) {
        return res.status(404).json({ message: "User not found" });
      }

      const hasCustomAddress =
        !useCustomerAddress &&
        Boolean(
          shopAddressStreet?.trim() &&
          shopAddressCity?.trim() &&
          shopAddressPincode?.trim(),
        );
      if (!useCustomerAddress && !hasCustomAddress) {
        return res.status(400).json({
          message:
            "Custom shop address requires street, city, and pincode.",
        });
      }

      const resolvedStreet = useCustomerAddress
        ? owner.addressStreet?.trim() || null
        : shopAddressStreet?.trim() || null;
      const resolvedCity = useCustomerAddress
        ? owner.addressCity?.trim() || null
        : shopAddressCity?.trim() || null;
      const resolvedState = useCustomerAddress
        ? owner.addressState?.trim() || null
        : shopAddressState?.trim() || owner.addressState?.trim() || null;
      const resolvedPincode = useCustomerAddress
        ? owner.addressPostalCode?.trim() || null
        : shopAddressPincode?.trim() || null;
      const resolvedArea = useCustomerAddress
        ? owner.addressLandmark?.trim() || null
        : shopAddressArea?.trim() || null;

      const resolvedLat =
        useCustomerAddress && shopLocationLat == null
          ? owner.latitude
          : shopLocationLat == null
            ? null
            : String(shopLocationLat);
      const resolvedLng =
        useCustomerAddress && shopLocationLng == null
          ? owner.longitude
          : shopLocationLng == null
            ? null
            : String(shopLocationLng);

      const [shop] = await db.primary.insert(shops).values({
        ownerId: userId,
        shopName: shopName.trim(),
        description: description?.trim(),
        businessType: businessType?.trim(),
        shopAddressStreet: resolvedStreet,
        shopAddressArea: resolvedArea,
        shopAddressCity: resolvedCity,
        shopAddressState: resolvedState,
        shopAddressPincode: resolvedPincode,
        shopLocationLat: resolvedLat,
        shopLocationLng: resolvedLng,
      }).returning();

      req.user.hasShopProfile = true;
      await invalidateCache(`user_session:${userId}`);

      return res.status(201).json(shop);
    } catch (error) {
      logger.error({ err: error }, "Failed to create shop");
      return res.status(500).json({ message: "Failed to create shop" });
    }
  });

  // Create provider profile
  app.post("/api/auth/create-provider", async (req, res) => {
    if (!req.isAuthenticated?.() || !req.user) {
      return res.status(401).json({ message: "Not authenticated" });
    }

    const { bio, skills, experience } = req.body;

    try {
      const userId = req.user.id;

      // Check if provider already exists
      const existing = await db.primary
        .select()
        .from(providers)
        .where(eq(providers.userId, userId))
        .limit(1);

      if (existing.length > 0) {
        return res.status(400).json({ message: "You already have a provider profile" });
      }

      const [provider] = await db.primary.insert(providers).values({
        userId,
        bio: bio?.trim(),
        skills: skills ?? [],
        experience: experience?.trim(),
      }).returning();

      req.user.hasProviderProfile = true;
      await invalidateCache(`user_session:${userId}`);

      return res.status(201).json(provider);
    } catch (error) {
      logger.error({ err: error }, "Failed to create provider profile");
      return res.status(500).json({ message: "Failed to create provider profile" });
    }
  });
}

export function setupAuth(app: Express) {
  initializeAuth(app);
  registerAuthRoutes(app);
}
