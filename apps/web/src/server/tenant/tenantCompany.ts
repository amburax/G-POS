import { Prisma } from "@prisma/client";
import { db } from "@/server/db";

/** Upper-case initials, letters and digits only, at most 5 — company abbreviation. */
export function abbreviationFor(name: string): string {
  const words = name.toUpperCase().replace(/[^A-Z0-9 ]/g, " ").split(/\s+/).filter(Boolean);
  const initials = words.length > 1 ? words.map((w) => w[0]).join("") : (words[0] ?? "CO").slice(0, 3);
  return (initials || "CO").slice(0, 5);
}

export interface EnsureTenantCompanyResult {
  id: string;
  name: string;
  code: string;
  currency: string;
}

/**
 * Ensures a tenant has an authoritative legal Company record and that all stores of the tenant
 * are linked to it.
 *
 * Every shop must be automatically authorized under the tenant's legal company so that Khata
 * (Customer Dues), POS credit/udhar sales, and tax scopes are immediately operational without
 * manual admin intervention.
 */
export async function ensureTenantCompany(
  tenantId: string,
  tx?: Prisma.TransactionClient,
  preferredCurrency = "INR"
): Promise<EnsureTenantCompanyResult> {
  const client = (tx ?? db) as Prisma.TransactionClient;

  if (!client.company) {
    return { id: "company-default", name: "Default Company", code: "DEF", currency: preferredCurrency };
  }

  // 1. Check if a company already exists for this tenant
  let company = await client.company.findFirst({
    where: { tenantId },
    orderBy: { createdAt: "asc" },
    select: { id: true, name: true, code: true, currency: true },
  });

  if (!company) {
    let companyName = "Main Company";
    if (client.tenant?.findUnique) {
      const tenant = await client.tenant.findUnique({
        where: { id: tenantId },
        select: { name: true },
      });
      if (tenant?.name?.trim()) {
        companyName = tenant.name.trim();
      }
    }

    const baseCode = abbreviationFor(companyName).slice(0, 20);
    let code = baseCode;

    if (client.company.findUnique) {
      const existingCode = await client.company.findUnique({
        where: { tenantId_code: { tenantId, code } },
        select: { id: true },
      });
      if (existingCode) {
        code = `${baseCode.slice(0, 16)}_${Date.now().toString(36).slice(-3)}`.toUpperCase();
      }
    }

    company = await client.company.create({
      data: {
        tenantId,
        name: companyName,
        code,
        currency: preferredCurrency.toUpperCase(),
      },
      select: { id: true, name: true, code: true, currency: true },
    });
  }

  // 2. Auto-link any unlinked stores belonging to this tenant to this company
  if (client.store?.updateMany) {
    await client.store.updateMany({
      where: { tenantId, companyId: null },
      data: { companyId: company.id },
    });
  }

  return company;
}
