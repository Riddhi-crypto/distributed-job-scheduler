import dotenv from 'dotenv';
dotenv.config();

export const config = {
  port: parseInt(process.env.PORT || '4000', 10),
  databaseUrl:
    process.env.DATABASE_URL ||
    'postgres://aegis:aegis@localhost:5432/aegis',
  jwtSecret: process.env.JWT_SECRET || 'dev-secret-change-me',
  jwtExpiresIn: process.env.JWT_EXPIRES_IN || '7d',
  // Lease/heartbeat tuning (seconds)
  leaseSeconds: parseInt(process.env.LEASE_SECONDS || '30', 10),
  heartbeatTimeoutSeconds: parseInt(process.env.HEARTBEAT_TIMEOUT || '45', 10),
  dispatcherLeaseSeconds: parseInt(process.env.DISPATCHER_LEASE || '15', 10),
};
