-- CreateTable
CREATE TABLE "CsvImport" (
    "id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "entityCode" TEXT,
    "filename" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "sizeBytes" INTEGER NOT NULL,
    "bytes" BYTEA NOT NULL,
    "uploadedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "uploadedBy" TEXT NOT NULL,
    "processedAt" TIMESTAMP(3),
    "processedRunId" TEXT,
    "notes" TEXT,

    CONSTRAINT "CsvImport_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "CsvImport_kind_uploadedAt_idx" ON "CsvImport"("kind", "uploadedAt" DESC);

