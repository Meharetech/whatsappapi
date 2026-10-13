/**
 * Startup Environment Configuration Validator
 * Validates critical environment variables and enforces fail-fast security policies.
 */

export function validateEnvironment() {
  const isProd = process.env.NODE_ENV === "production";
  const errors = [];
  const warnings = [];

  // 1. Port Validation
  const port = parseInt(process.env.PORT || "3000", 10);
  if (isNaN(port) || port < 1 || port > 65535) {
    errors.push(`Invalid PORT configuration: "${process.env.PORT}". Must be between 1 and 65535.`);
  }

  // 2. Database URI Validation
  const mongoUri = process.env.MONGODB_URI;
  if (!mongoUri) {
    errors.push("Missing required environment variable: MONGODB_URI");
  } else if (!mongoUri.startsWith("mongodb://") && !mongoUri.startsWith("mongodb+srv://")) {
    errors.push("Invalid MONGODB_URI: Must start with 'mongodb://' or 'mongodb+srv://'");
  }

  // 3. JWT Secret Validation
  const jwtSecret = process.env.JWT_SECRET;
  if (!jwtSecret) {
    if (isProd) {
      errors.push("Missing required environment variable: JWT_SECRET in production mode.");
    } else {
      warnings.push("JWT_SECRET is not set. Using default development secret.");
    }
  } else if (isProd && (jwtSecret === "dev-secret-key" || jwtSecret === "dev-secret-key-whatsapp-campaign-2024" || jwtSecret.length < 16)) {
    errors.push("Insecure JWT_SECRET detected in production! Please supply a secure random key with at least 16 characters.");
  }

  // 4. Base URL / Public URL Consistency
  const baseUrl = process.env.PUBLIC_BASE_URL || process.env.BASE_URL || process.env.BACKEND_URL;
  if (!baseUrl) {
    warnings.push("Neither PUBLIC_BASE_URL, BASE_URL, nor BACKEND_URL is set. Defaulting to 'http://localhost:3000'.");
  } else if (!/^https?:\/\//i.test(baseUrl)) {
    warnings.push(`Configured BASE_URL "${baseUrl}" does not begin with http:// or https://.`);
  }

  // 5. Firebase Authentication
  const hasFirebaseAdmin = Boolean(process.env.FIREBASE_PROJECT_ID && process.env.FIREBASE_CLIENT_EMAIL && process.env.FIREBASE_PRIVATE_KEY);
  const hasFirebaseWeb = Boolean(process.env.FIREBASE_WEB_API_KEY || process.env.FIREBASE_API_KEY);
  if (!hasFirebaseAdmin && !hasFirebaseWeb) {
    warnings.push("Firebase authentication credentials (Admin SDK or FIREBASE_WEB_API_KEY) are not set. Google login verification will fail.");
  }

  // 6. Meta / WhatsApp / Instagram Integration
  const metaAppId = process.env.META_APP_ID;
  if (metaAppId === "your_meta_app_id") {
    warnings.push("META_APP_ID is using placeholder value 'your_meta_app_id'.");
  }

  // Output Warnings
  if (warnings.length > 0) {
    console.warn("\n⚠️  [CONFIG WARNINGS]");
    warnings.forEach((w) => console.warn(`   - ${w}`));
  }

  // Fail-Fast on Fatal Errors
  if (errors.length > 0) {
    console.error("\n❌ [FATAL CONFIGURATION ERRORS]");
    errors.forEach((e) => console.error(`   - ${e}`));
    console.error("\nApplication startup aborted due to configuration errors. Please check your .env file.\n");
    process.exit(1);
  }

  console.log("✅ [CONFIG] Environment configuration validated successfully.");
  return {
    port,
    mongoUri,
    isProd,
  };
}

export default validateEnvironment;
