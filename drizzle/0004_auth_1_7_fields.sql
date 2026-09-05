ALTER TABLE "auth_users" ALTER COLUMN "two_factor_enabled" SET DEFAULT false;--> statement-breakpoint
ALTER TABLE "auth_accounts" ADD COLUMN "issuer" text;--> statement-breakpoint
ALTER TABLE "auth_jwks" ADD COLUMN "expires_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "auth_jwks" ADD COLUMN "alg" text;--> statement-breakpoint
ALTER TABLE "auth_jwks" ADD COLUMN "crv" text;--> statement-breakpoint
ALTER TABLE "auth_two_factors" ADD COLUMN "verified" boolean DEFAULT true;--> statement-breakpoint
ALTER TABLE "auth_two_factors" ADD COLUMN "failed_verification_count" integer DEFAULT 0;--> statement-breakpoint
ALTER TABLE "auth_two_factors" ADD COLUMN "locked_until" timestamp with time zone;