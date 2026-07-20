import dotenv from "dotenv";

dotenv.config({ path: process.env.NODE_ENV === "test" ? ".env.test" : ".env" });

function getEnv(key: string, fallback?: string): string {
  const value = process.env[key] ?? fallback;
  if (value === undefined) {
    throw new Error(`Missing required environment variable: ${key}`);
  }
  return value;
}

export const env = {
  NODE_ENV: getEnv("NODE_ENV", "development"),
  PORT: Number(getEnv("PORT", "3000")),
  HOST: getEnv("HOST", "0.0.0.0"),
  DATABASE_URL: getEnv("DATABASE_URL"),
  CORS_ORIGIN: getEnv("CORS_ORIGIN", "*") as string,
};
