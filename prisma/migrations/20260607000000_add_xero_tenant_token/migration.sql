-- CreateTable
CREATE TABLE "XeroTenantToken" (
    "id" TEXT NOT NULL,
    "xeroApp" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "tenantName" TEXT,
    "entityCode" TEXT,
    "accessToken" TEXT NOT NULL,
    "refreshToken" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "scope" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "lastRefreshAt" TIMESTAMP(3),
    "lastUsedAt" TIMESTAMP(3),

    CONSTRAINT "XeroTenantToken_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "XeroTenantToken_xeroApp_tenantId_key" ON "XeroTenantToken"("xeroApp", "tenantId");

-- CreateIndex
CREATE INDEX "XeroTenantToken_xeroApp_idx" ON "XeroTenantToken"("xeroApp");
