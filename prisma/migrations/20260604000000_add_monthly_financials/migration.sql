-- CreateTable
CREATE TABLE "MonthlyFinancials" (
    "id" TEXT NOT NULL,
    "entityCode" TEXT NOT NULL,
    "month" TEXT NOT NULL,
    "totalIncome" DOUBLE PRECISION,
    "totalCostOfSales" DOUBLE PRECISION,
    "grossProfit" DOUBLE PRECISION,
    "totalOtherIncome" DOUBLE PRECISION,
    "totalOperatingExpenses" DOUBLE PRECISION,
    "netProfit" DOUBLE PRECISION,
    "sourceFilename" TEXT,
    "uploadedBy" TEXT NOT NULL,
    "uploadedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MonthlyFinancials_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "MonthlyFinancials_entityCode_month_key" ON "MonthlyFinancials"("entityCode", "month");

-- CreateIndex
CREATE INDEX "MonthlyFinancials_entityCode_month_idx" ON "MonthlyFinancials"("entityCode", "month");
