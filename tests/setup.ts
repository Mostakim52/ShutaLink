try {
  process.loadEnvFile();
} catch {
  // .env is optional in test environments
}

process.env.REDIS_URL = "redis://localhost:6379";
