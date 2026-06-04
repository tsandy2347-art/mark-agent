-- CreateTable
CREATE TABLE "PayrollMonth" (
    "id" TEXT NOT NULL,
    "entityCode" TEXT NOT NULL,
    "month" TEXT NOT NULL,
    "totalGross" DOUBLE PRECISION,
    "totalSuper" DOUBLE PRECISION,
    "totalAllowances" DOUBLE PRECISION,
    "totalLeaveTaken" DOUBLE PRECISION,
    "payRuns" JSONB,
    "lineItems" JSONB,
    "sourceFilename" TEXT,
    "uploadedBy" TEXT NOT NULL,
    "uploadedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PayrollMonth_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "PayrollMonth_entityCode_month_key" ON "PayrollMonth"("entityCode", "month");

-- CreateIndex
CREATE INDEX "PayrollMonth_entityCode_month_idx" ON "PayrollMonth"("entityCode", "month");
