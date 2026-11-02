// Customer accounts for the gated catalog. Accounts are active the moment the
// row exists — there is deliberately no "pending"/"approved" state and no
// email-confirmation flag, because access must be instant on signup.
import { pgTable, serial, text, timestamp } from "drizzle-orm/pg-core";

export const users = pgTable("users", {
  id: serial().primaryKey(),
  name: text().notNull(),
  email: text().notNull().unique(),
  // scrypt, stored as "scrypt$N$r$p$<salt hex>$<hash hex>" — never the password.
  passwordHash: text("password_hash").notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const passwordResetTokens = pgTable("password_reset_tokens", {
  id: serial().primaryKey(),
  // sha-256 of the token that was emailed; the raw token is never stored.
  tokenHash: text("token_hash").notNull().unique(),
  email: text().notNull(),
  expiresAt: timestamp("expires_at").notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});
