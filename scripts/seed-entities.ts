// Idempotent. Runs on every boot. Upserts the two JBC entities.

import { PrismaClient } from "../lib/generated/prisma";

const prisma = new PrismaClient();

async function main() {
  await prisma.entity.upsert({
    where: { code: "SC" },
    create: {
      code: "SC",
      legalName: "Just Better Care Sunshine Coast Pty Ltd",
      xeroTenantId: process.env.XERO_SC_TENANT_ID ?? "",
    },
    update: { xeroTenantId: process.env.XERO_SC_TENANT_ID ?? "" },
  });
  await prisma.entity.upsert({
    where: { code: "CQ" },
    create: {
      code: "CQ",
      legalName: "Just Better Care Central Queensland Pty Ltd",
      xeroTenantId: process.env.XERO_CQ_TENANT_ID ?? "",
    },
    update: { xeroTenantId: process.env.XERO_CQ_TENANT_ID ?? "" },
  });
  // eslint-disable-next-line no-console
  console.log("[seed] entities upserted");
}

main()
  .catch((e) => {
    // eslint-disable-next-line no-console
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
