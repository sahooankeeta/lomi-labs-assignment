-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "document_type" AS ENUM ('invoice', 'lease', 'market_report');

-- CreateEnum
CREATE TYPE "version_status" AS ENUM ('queued', 'extracting', 'extracted', 'failed', 'superseded');

-- CreateEnum
CREATE TYPE "run_status" AS ENUM ('running', 'succeeded', 'failed', 'abandoned');

-- CreateEnum
CREATE TYPE "review_action" AS ENUM ('approve', 'correct');

-- CreateTable
CREATE TABLE "documents" (
    "id" UUID NOT NULL,
    "type" "document_type" NOT NULL,
    "title" TEXT NOT NULL,
    "current_version_id" UUID,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "documents_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "document_versions" (
    "id" UUID NOT NULL,
    "document_id" UUID NOT NULL,
    "version_no" INTEGER NOT NULL,
    "file_key" TEXT NOT NULL,
    "sha256" TEXT NOT NULL,
    "status" "version_status" NOT NULL DEFAULT 'queued',
    "error" TEXT,
    "parsed_text" TEXT,
    "page_offsets" INTEGER[],
    "total_tokens" INTEGER,
    "chars_per_token" DOUBLE PRECISION,
    "active_run_id" UUID,
    "lease_expires_at" TIMESTAMPTZ,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "document_versions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "extraction_runs" (
    "id" UUID NOT NULL,
    "version_id" UUID NOT NULL,
    "status" "run_status" NOT NULL DEFAULT 'running',
    "model" TEXT NOT NULL,
    "error" TEXT,
    "started_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finished_at" TIMESTAMPTZ,

    CONSTRAINT "extraction_runs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "version_chunks" (
    "version_id" UUID NOT NULL,
    "chunk_index" INTEGER NOT NULL,
    "start" INTEGER NOT NULL,
    "end" INTEGER NOT NULL,
    "tokens" INTEGER NOT NULL,
    "first_page" INTEGER NOT NULL,
    "last_page" INTEGER NOT NULL,

    CONSTRAINT "version_chunks_pkey" PRIMARY KEY ("version_id","chunk_index")
);

-- CreateTable
CREATE TABLE "chunk_results" (
    "version_id" UUID NOT NULL,
    "chunk_index" INTEGER NOT NULL,
    "prompt_version" TEXT NOT NULL,
    "run_id" UUID NOT NULL,
    "prompt" TEXT NOT NULL,
    "raw_response" JSONB NOT NULL,
    "candidates" JSONB NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "chunk_results_pkey" PRIMARY KEY ("version_id","chunk_index","prompt_version")
);

-- CreateTable
CREATE TABLE "extracted_values" (
    "id" UUID NOT NULL,
    "version_id" UUID NOT NULL,
    "field" TEXT NOT NULL,
    "value" TEXT,
    "evidence" TEXT,
    "gap_reason" TEXT,
    "candidates" JSONB,
    "evidence_page" INTEGER,
    "evidence_start" INTEGER,
    "evidence_end" INTEGER,
    "previous_value_id" UUID,
    "carried_review_id" UUID,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "extracted_values_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "reviews" (
    "id" UUID NOT NULL,
    "value_id" UUID NOT NULL,
    "action" "review_action" NOT NULL,
    "corrected_value" TEXT,
    "note" TEXT,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "reviews_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "documents_current_version_id_key" ON "documents"("current_version_id");

-- CreateIndex
CREATE INDEX "document_versions_status_lease_expires_at_idx" ON "document_versions"("status", "lease_expires_at");

-- CreateIndex
CREATE UNIQUE INDEX "document_versions_document_id_version_no_key" ON "document_versions"("document_id", "version_no");

-- CreateIndex
CREATE INDEX "extraction_runs_version_id_idx" ON "extraction_runs"("version_id");

-- CreateIndex
CREATE UNIQUE INDEX "extracted_values_version_id_field_key" ON "extracted_values"("version_id", "field");

-- CreateIndex
CREATE INDEX "reviews_value_id_created_at_idx" ON "reviews"("value_id", "created_at");

-- AddForeignKey
ALTER TABLE "documents" ADD CONSTRAINT "documents_current_version_id_fkey" FOREIGN KEY ("current_version_id") REFERENCES "document_versions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "document_versions" ADD CONSTRAINT "document_versions_document_id_fkey" FOREIGN KEY ("document_id") REFERENCES "documents"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "extraction_runs" ADD CONSTRAINT "extraction_runs_version_id_fkey" FOREIGN KEY ("version_id") REFERENCES "document_versions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "version_chunks" ADD CONSTRAINT "version_chunks_version_id_fkey" FOREIGN KEY ("version_id") REFERENCES "document_versions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "chunk_results" ADD CONSTRAINT "chunk_results_version_id_fkey" FOREIGN KEY ("version_id") REFERENCES "document_versions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "extracted_values" ADD CONSTRAINT "extracted_values_version_id_fkey" FOREIGN KEY ("version_id") REFERENCES "document_versions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "extracted_values" ADD CONSTRAINT "extracted_values_previous_value_id_fkey" FOREIGN KEY ("previous_value_id") REFERENCES "extracted_values"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "extracted_values" ADD CONSTRAINT "extracted_values_carried_review_id_fkey" FOREIGN KEY ("carried_review_id") REFERENCES "reviews"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reviews" ADD CONSTRAINT "reviews_value_id_fkey" FOREIGN KEY ("value_id") REFERENCES "extracted_values"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- Hand-written: Prisma can't express CHECK constraints.
-- A value is either a real value with evidence, or a gap with a reason. Never both, never neither.
ALTER TABLE "extracted_values" ADD CONSTRAINT "value_xor_gap" CHECK (
  ("value" IS NOT NULL AND "evidence" IS NOT NULL AND "gap_reason" IS NULL)
  OR ("value" IS NULL AND "gap_reason" IS NOT NULL)
);
-- A correction must carry the corrected value.
ALTER TABLE "reviews" ADD CONSTRAINT "correct_has_value" CHECK (
  "action" <> 'correct' OR "corrected_value" IS NOT NULL
);
