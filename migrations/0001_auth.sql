-- ============================================
-- @contentgrowth/content-auth - Database Schema Template
-- ============================================
-- 
-- USAGE:
-- 1. Copy this file to your project's migrations folder
-- 2. Add your application-specific tables after the auth tables
-- 3. Run migrations (e.g., wrangler d1 migrations apply DB --local)
--
-- EXTENDING TABLES:
-- You can add extra columns to any table for your business needs.
-- Just ensure you keep ALL the columns defined here - they are required
-- by Better Auth to function correctly.
--
-- ============================================

-- ==========================================
-- Core Authentication Tables
-- ==========================================

-- Users
CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    email TEXT NOT NULL UNIQUE,
    emailVerified BOOLEAN NOT NULL,
    image TEXT,
    createdAt TIMESTAMP NOT NULL,
    updatedAt TIMESTAMP NOT NULL,
    lastSignedInAt TIMESTAMP
    -- Optional: For Gmail duplicate prevention (see docs)
    -- normalized_email TEXT
);

-- Sessions
CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    expiresAt TIMESTAMP NOT NULL,
    token TEXT NOT NULL UNIQUE,
    createdAt TIMESTAMP NOT NULL,
    updatedAt TIMESTAMP NOT NULL,
    ipAddress TEXT,
    userAgent TEXT,
    userId TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    activeOrganizationId TEXT
);

-- OAuth/Credential Accounts
CREATE TABLE IF NOT EXISTS accounts (
    id TEXT PRIMARY KEY,
    accountId TEXT NOT NULL,
    providerId TEXT NOT NULL,
    userId TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    accessToken TEXT,
    refreshToken TEXT,
    idToken TEXT,
    accessTokenExpiresAt TIMESTAMP,
    refreshTokenExpiresAt TIMESTAMP,
    scope TEXT,
    password TEXT,
    createdAt TIMESTAMP NOT NULL,
    updatedAt TIMESTAMP NOT NULL
);

-- Email/Token Verification
CREATE TABLE IF NOT EXISTS verifications (
    id TEXT PRIMARY KEY,
    identifier TEXT NOT NULL,
    value TEXT NOT NULL,
    expiresAt TIMESTAMP NOT NULL,
    createdAt TIMESTAMP,
    updatedAt TIMESTAMP
);

-- ==========================================
-- Organization Plugin Tables
-- ==========================================

-- Organizations
CREATE TABLE IF NOT EXISTS organizations (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    slug TEXT UNIQUE,
    logo TEXT,
    createdAt TIMESTAMP NOT NULL,
    updatedAt TIMESTAMP,  -- onboarding / org plugin writes this
    metadata TEXT  -- JSON: Use for custom org data (e.g., billing, verification status)
);

-- Organization Members
CREATE TABLE IF NOT EXISTS members (
    id TEXT PRIMARY KEY,
    organizationId TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    userId TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    role TEXT NOT NULL,  -- 'owner', 'admin', 'member'
    createdAt TIMESTAMP NOT NULL
);

-- Organization Invitations
CREATE TABLE IF NOT EXISTS invitations (
    id TEXT PRIMARY KEY,
    organizationId TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    email TEXT NOT NULL,
    role TEXT,
    status TEXT NOT NULL,  -- 'pending', 'accepted', 'rejected', 'expired'
    expiresAt TIMESTAMP NOT NULL,
    inviterId TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    createdAt TIMESTAMP NOT NULL
);

-- ==========================================
-- YOUR APPLICATION TABLES GO BELOW
-- ==========================================
-- Example:
-- 
-- CREATE TABLE IF NOT EXISTS my_entity (
--     id TEXT PRIMARY KEY,
--     org_id TEXT NOT NULL,  -- References organizations.id
--     name TEXT NOT NULL,
--     created_at INTEGER
-- );
