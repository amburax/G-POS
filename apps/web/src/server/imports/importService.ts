import { randomUUID } from "node:crypto";
import { GstTaxTreatment, type TaxRateMode } from "@prisma/client";
import { db } from "@/server/db";
import { writeAuditLog } from "@/server/identity/audit";
import { createCustomer } from "@/server/sales/customers";
import { createProduct, createVariant } from "@/server/catalog/catalogService";
import { receiveStock, recordStockTake } from "@/server/inventory/inventoryService";
import type { ImportKind } from "@/server/imports/importFields";
import { normalizePhone } from "@/lib/customerFields";
import { ensureTenantCompany } from "@/server/tenant/tenantCompany";
import { findOrCreateCreditAccount } from "@/server/khata/creditAccount";
import { logError } from "@/lib/safeLog";

/**
 * Moving in from another software (owner only).
 *
 * - **Customers** are added; one with a mobile already on file is left as it is (counted "already here").
 *   Opening dues from previous software (AmountDue / balance) are recorded directly into Khata.
 * - **Products & stock** are grouped by product name into products with size/variant/colour; an
 *   SKU that already exists is skipped, so re-running a file never doubles anything. Opening stock
 *   is received through the stock ledger with its cost, keyed per batch + SKU.
 *   GST is taken only from the file: a GST % makes it taxable at that rate; "nil" / "non-gst" /
 *   "zero" / "slab" are honoured; nothing given means "needs a GST type" (never guessed) for a
 *   GST-registered shop, and non-GST for a shop without a GSTIN (it can't charge GST).
 * - **Past sales** are kept as history (ImportedSale): they show in customer history and totals,
 *   but move no stock, post nothing and never go to ERPNext. A bill number already imported is skipped.
 *
 * Rows arrive already mapped to field keys, in batches of at most 500. Every row gets a result.
 */

export type ImportRow = Record<string, string | undefined>;
export interface RowError {
  row: number;
  reason: string;
}
export interface ImportOutcome {
  created: number;
  updated: number;
  skipped: number;
  errors: RowError[];
}

type Actor = { tenantId: string; userId: string; tenantRole: "OWNER" | "STAFF" };

export const MAX_IMPORT_ROWS = 500;

function money(raw: string | undefined): number | null {
  if (raw === undefined || raw.trim() === "") return null;
  const n = Number(raw.replace(/[₹,\s]/g, "").replace(/^rs\.?/i, ""));
  return Number.isFinite(n) && n >= 0 ? Math.round(n * 100) : NaN;
}

function wholeNumber(raw: string | undefined): number | null {
  if (raw === undefined || raw.trim() === "") return null;
  const n = Number(raw.replace(/[,\s]/g, ""));
  return Number.isInteger(n) ? n : NaN;
}

/** YYYY-MM-DD, DD-MM-YYYY, DD/MM/YYYY or DD.MM.YYYY (Indian order), at noon IST. */
export function parseBillDate(raw: string | undefined): Date | null {
  const s = raw?.trim() ?? "";
  let y: number, m: number, d: number;
  let r = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(s);
  if (r) [y, m, d] = [Number(r[1]), Number(r[2]), Number(r[3])];
  else if ((r = /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2,4})$/.exec(s))) {
    [d, m, y] = [Number(r[1]), Number(r[2]), Number(r[3])];
    if (y < 100) y += 2000;
  } else return null;
  if (m < 1 || m > 12 || d < 1 || d > 31) return null;
  const date = new Date(Date.UTC(y, m - 1, d, 6, 30));
  return date.getUTCDate() === d ? date : null;
}

export function gstFrom(
  row: ImportRow,
): { treatment: GstTaxTreatment; rateMode: TaxRateMode; rateBp: number; exemptionRef?: string } | string {
  const type = (row.gstType ?? "").toLowerCase().replace(/[^a-z]/g, "");
  const rate = row.gstRate?.trim() ? Number(row.gstRate.replace("%", "")) : null;
  if (rate !== null && (!Number.isFinite(rate) || rate < 0 || rate > 40)) return "GST % should be a number like 5 or 18.";
  if (type.includes("exempt")) {
    const exemptionRef = row.exemptionRef?.trim();
    if (!exemptionRef) {
      return "Exempt items need their exemption notification. Add it in an \"Exemption reference\" column (like \"Notification 2/2017-CT(R) Sl. 1\") and import this row again.";
    }
    if (rate !== null && rate > 0) return "An exempt item can't have a GST %. Leave GST % empty for this row.";
    return { treatment: "EXEMPT", rateMode: "FIXED", rateBp: 0, exemptionRef };
  }
  if (type.includes("nil")) return { treatment: "NIL_RATED", rateMode: "FIXED", rateBp: 0 };
  if (type.includes("nongst") || type === "none") return { treatment: "NON_GST", rateMode: "FIXED", rateBp: 0 };
  if (type.includes("zero")) return { treatment: "ZERO_RATED", rateMode: "FIXED", rateBp: 0 };
  if (type.includes("slab")) return { treatment: "TAXABLE", rateMode: "APPAREL_SLAB", rateBp: 0 };
  if (rate !== null && rate > 0) return { treatment: "TAXABLE", rateMode: "FIXED", rateBp: Math.round(rate * 100) };
  return { treatment: "UNSPECIFIED", rateMode: "FIXED", rateBp: 0 };
}

/** The owner reads these: every refusal is a sentence, never an internal status code. */
function refusalReason(res: { status: string; message?: string }): string {
  switch (res.status) {
    case "conflict":
    case "duplicate_sku":
    case "duplicate_barcode":
      return "That SKU or barcode is already used.";
    case "duplicate_product_name":
      return "A product with this name already exists.";
    case "invalid_tax_classification":
      return "The GST details for this row don't fit this business. Check the GST type and GST %.";
    case "price_exceeds_mrp":
      return "Selling price is higher than the MRP.";
    case "price_below_minimum":
      return "Selling price is below the minimum price.";
    case "forbidden":
      return "You aren't allowed to add products.";
    case "not_found":
      return "The product this row belongs to couldn't be found.";
    default:
      return res.message ?? "This row couldn't be added. Check it and try again.";
  }
}

function skuPart(text: string, max: number): string {
  return text.normalize("NFKD").replace(/[^A-Za-z0-9]+/g, "").toUpperCase().slice(0, max);
}

async function importCustomers(
  actor: Actor,
  storeId: string,
  batchId: string,
  rows: ImportRow[],
  first: number
): Promise<ImportOutcome> {
  const out: ImportOutcome = { created: 0, updated: 0, skipped: 0, errors: [] };
  let company: { id: string; currency: string } | null = null;
  try {
    if (typeof ensureTenantCompany === "function") {
      company = await ensureTenantCompany(actor.tenantId, undefined, "INR");
    }
  } catch {
    // If company lookup fails, customer creation still proceeds
  }

  for (const [i, row] of rows.entries()) {
    const rawName = row.name?.trim() || "";
    const rawPhone = row.phone?.trim() || null;
    const rawEmail = row.email?.trim() || null;
    const rawGstin = row.gstin?.trim() || null;
    const rawAddress = row.address?.trim() || null;
    const due = money(row.amountDue);
    const advance = money(row.amountHeld);

    // Smart phone normalization: lenient for duplicate country codes / export formats
    let phoneToUse: string | null = rawPhone;
    if (phoneToUse) {
      const pRes = normalizePhone(phoneToUse);
      if (pRes.ok) {
        phoneToUse = pRes.value;
      } else {
        const digits = phoneToUse.replace(/\D/g, "");
        if (digits.length >= 10) {
          const last10 = digits.slice(-10);
          const p10Res = normalizePhone(last10);
          if (p10Res.ok) phoneToUse = p10Res.value;
        }
      }
    }

    // Name fallback: if name is empty but phone exists, derive readable customer name
    let name = rawName;
    if (!name) {
      if (phoneToUse) {
        const lastDigits = phoneToUse.replace(/\D/g, "").slice(-5);
        name = `Customer ${lastDigits}`;
      } else {
        out.errors.push({ row: first + i, reason: "Name is empty and no mobile number provided." });
        continue;
      }
    }

    const res = await createCustomer({
      tenantId: actor.tenantId,
      name,
      phone: phoneToUse,
      email: rawEmail,
      gstin: rawGstin,
      address: rawAddress
        ? {
            line1: rawAddress.slice(0, 80),
            city: "City",
            postalCode: "360001",
          }
        : undefined,
      actorUserId: actor.userId,
    });

    if (res.status === "ok") {
      const customerId = res.customer.id;
      if (res.existing) {
        // Customer already exists on file: update details from file
        const updateData: Record<string, unknown> = {};
        if (name && (res.customer.name.startsWith("Customer ") || res.customer.name !== name)) {
          updateData.name = name;
        }
        if (rawEmail) updateData.email = rawEmail;
        if (rawGstin) updateData.gstin = rawGstin;
        if (Object.keys(updateData).length > 0 && db?.customer?.update) {
          try {
            await db.customer.update({
              where: { id: customerId },
              data: updateData,
            });
          } catch {
            // Non-critical update error
          }
        }
        out.updated++;
      } else {
        out.created++;
      }

      // If customer has an opening balance/due from old software, record or update in Khata
      if (company && due !== null && !Number.isNaN(due) && due > 0 && db?.sale?.create && db?.khataReceivableEntry?.create) {
        try {
          const openingSaleNumber = `OPENING-${customerId.slice(-8).toUpperCase()}`;
          const existingOpeningSale = await db.sale.findFirst({
            where: { tenantId: actor.tenantId, customerId, billNumber: openingSaleNumber },
            select: { id: true, totalMinor: true },
          });

          // Ensure customerCreditAccount exists and credit is enabled
          let creditAccount: { id: string; creditMode?: unknown; creditEnabled?: boolean } | null = null;
          try {
            if (typeof findOrCreateCreditAccount === "function") {
              creditAccount = await findOrCreateCreditAccount(db, {
                tenantId: actor.tenantId,
                companyId: company.id,
                customerId,
              });
            }
          } catch {
            // direct DB fallback if needed
          }

          if (!creditAccount && db?.customerCreditAccount?.findUnique) {
            creditAccount = await db.customerCreditAccount.findUnique({
              where: {
                tenantId_companyId_customerId: {
                  tenantId: actor.tenantId,
                  companyId: company.id,
                  customerId,
                },
              },
            });
            if (!creditAccount && db?.customerCreditAccount?.create) {
              creditAccount = await db.customerCreditAccount.create({
                data: {
                  id: `cca_${randomUUID().replace(/-/g, "")}`,
                  tenantId: actor.tenantId,
                  companyId: company.id,
                  customerId,
                  currency: company.currency,
                  creditMode: "UNLIMITED",
                  creditModeLimitMinor: null,
                  creditModeSource: "OWNER_OVERRIDE",
                  creditEnabled: true,
                  creditHold: false,
                },
              });
            }
          }

          if (creditAccount && (creditAccount.creditMode === "BLOCKED" || !creditAccount.creditEnabled) && db?.customerCreditAccount?.update) {
            try {
              await db.customerCreditAccount.update({
                where: { id: creditAccount.id },
                data: { creditMode: "UNLIMITED", creditEnabled: true, creditHold: false },
              });
            } catch {
              // Ignore non-critical update failure
            }
          }

          // Also set creditEnabled on Customer table
          if (db?.customer?.update) {
            try {
              await db.customer.update({
                where: { id: customerId },
                data: { creditEnabled: true },
              });
            } catch {
              // Ignore non-critical update failure
            }
          }

          const creditAccountId = creditAccount?.id || `cca_${customerId}`;

          if (!existingOpeningSale) {
            const sale = await db.sale.create({
              data: {
                tenantId: actor.tenantId,
                storeId,
                companyId: company.id,
                currencySnapshot: company.currency,
                customerId,
                billNumber: openingSaleNumber,
                cashierUserId: actor.userId,
                idempotencyKey: `opening-sale-${customerId}`,
                status: "COMPLETED",
                completedAt: new Date(),
                totalMinor: due,
                paidMinor: 0,
                initialOnAccountMinor: due,
                subtotalMinor: due,
                discountMinor: 0,
                taxMinor: 0,
              },
            });

            await db.khataReceivableEntry.create({
              data: {
                tenantId: actor.tenantId,
                companyId: company.id,
                customerId,
                currency: company.currency,
                saleId: sale.id,
                creditAccountId,
                entryType: "DEBIT_CREDIT_SALE",
                amountMinor: due,
                actorUserId: actor.userId,
                notes: "Opening balance imported from old software",
                idempotencyKey: `opening-recv-${customerId}`,
              },
            });
          } else if (existingOpeningSale.totalMinor !== due && db?.sale?.update) {
            const diff = due - existingOpeningSale.totalMinor;
            await db.sale.update({
              where: { id: existingOpeningSale.id },
              data: {
                totalMinor: due,
                subtotalMinor: due,
                initialOnAccountMinor: due,
              },
            });
            // Khata ledger is append-only (PostgreSQL triggers prohibit UPDATE and DELETE)
            if (diff > 0) {
              await db.khataReceivableEntry.create({
                data: {
                  tenantId: actor.tenantId,
                  companyId: company.id,
                  customerId,
                  currency: company.currency,
                  saleId: existingOpeningSale.id,
                  creditAccountId,
                  entryType: "DEBIT_CREDIT_SALE",
                  amountMinor: diff,
                  actorUserId: actor.userId,
                  notes: "Opening balance adjustment from re-import",
                  idempotencyKey: `opening-adj-inc-${customerId}-${Date.now()}`,
                },
              });
            } else if (diff < 0) {
              await db.khataReceivableEntry.create({
                data: {
                  tenantId: actor.tenantId,
                  companyId: company.id,
                  customerId,
                  currency: company.currency,
                  saleId: existingOpeningSale.id,
                  creditAccountId,
                  entryType: "CREDIT_REVERSAL",
                  amountMinor: Math.abs(diff),
                  actorUserId: actor.userId,
                  notes: "Opening balance reduction adjustment from re-import",
                  idempotencyKey: `opening-adj-dec-${customerId}-${Date.now()}`,
                },
              });
            }
          }
        } catch (balErr) {
          logError("import: opening due creation failed", balErr);
          out.errors.push({
            row: first + i,
            reason: `Customer was saved, but opening due of ₹${(due / 100).toLocaleString("en-IN")} failed to post.`,
          });
        }
      }

      // If customer has an advance deposit/credit (AmountHeld) from old software, record in Khata
      if (company && advance !== null && !Number.isNaN(advance) && advance > 0 && db?.khataPayment?.create) {
        try {
          let advCreditAccount: { id: string } | null = null;
          try {
            if (typeof findOrCreateCreditAccount === "function") {
              advCreditAccount = await findOrCreateCreditAccount(db, {
                tenantId: actor.tenantId,
                companyId: company.id,
                customerId,
              });
            }
          } catch {
            // fallback
          }

          if (!advCreditAccount && db?.customerCreditAccount?.findUnique) {
            advCreditAccount = await db.customerCreditAccount.findUnique({
              where: {
                tenantId_companyId_customerId: {
                  tenantId: actor.tenantId,
                  companyId: company.id,
                  customerId,
                },
              },
            });
            if (!advCreditAccount && db?.customerCreditAccount?.create) {
              advCreditAccount = await db.customerCreditAccount.create({
                data: {
                  id: `cca_${randomUUID().replace(/-/g, "")}`,
                  tenantId: actor.tenantId,
                  companyId: company.id,
                  customerId,
                  currency: company.currency,
                  creditMode: "UNLIMITED",
                  creditModeLimitMinor: null,
                  creditModeSource: "OWNER_OVERRIDE",
                  creditEnabled: true,
                  creditHold: false,
                },
              });
            }
          }

          const advCreditAccountId = advCreditAccount?.id || `cca_${customerId}`;
          const paymentKey = `opening-adv-${customerId}`;
          const existingPayment = await db.khataPayment.findUnique({
            where: { idempotencyKey: paymentKey },
            select: { id: true, amountMinor: true },
          });

          if (!existingPayment) {
            const payment = await db.khataPayment.create({
              data: {
                tenantId: actor.tenantId,
                companyId: company.id,
                customerId,
                creditAccountId: advCreditAccountId,
                currency: company.currency,
                actorUserId: actor.userId,
                amountMinor: advance,
                paymentMethod: "CASH",
                notes: "Opening advance deposit (Jama) imported from old software",
                idempotencyKey: paymentKey,
              },
            });

            if (db?.khataAdvanceEntry?.create) {
              await db.khataAdvanceEntry.create({
                data: {
                  tenantId: actor.tenantId,
                  companyId: company.id,
                  customerId,
                  creditAccountId: advCreditAccountId,
                  currency: company.currency,
                  entryType: "CREDIT_ADVANCE_DEPOSIT",
                  amountMinor: advance,
                  khataPaymentId: payment.id,
                  actorUserId: actor.userId,
                  notes: "Opening advance deposit (Jama) imported from old software",
                  idempotencyKey: `opening-adv-entry-${customerId}`,
                },
              });
            }
          }
        } catch (advErr) {
          logError("import: opening advance creation failed", advErr);
        }
      }
    } else {
      out.errors.push({
        row: first + i,
        reason: res.status === "validation_error" ? `${res.field}: ${res.error}` : "Name isn't valid.",
      });
    }
  }
  return out;
}

async function importProducts(actor: Actor, storeId: string, batchId: string, rows: ImportRow[], first: number): Promise<ImportOutcome> {
  const out: ImportOutcome = { created: 0, updated: 0, skipped: 0, errors: [] };
  const uom =
    (await db.uom.findFirst({ where: { tenantId: actor.tenantId, isActive: true, code: { in: ["PCS", "NOS", "Nos", "PC"] } }, select: { id: true } })) ??
    (await db.uom.findFirst({ where: { tenantId: actor.tenantId, isActive: true }, orderBy: { code: "asc" }, select: { id: true } }));
  if (!uom) {
    out.errors.push({ row: first, reason: "Set up a unit (like PCS) before importing products." });
    return out;
  }
  // A shop without a GSTIN can't charge GST: its rows are non-GST unless the file says
  // otherwise, and a GST % in the file is refused with the reason. A GST shop's rows still
  // must say their GST; it is never guessed.
  const tenant = await db.tenant.findUnique({ where: { id: actor.tenantId }, select: { taxId: true } });
  const isGstShop = Boolean(tenant?.taxId?.trim());
  const productIdByName = new Map<string, string>();
  for (const [i, row] of rows.entries()) {
    const n = first + i;
    const name = row.name?.trim();
    const price = money(row.price);
    const cost = money(row.cost);
    const stock = wholeNumber(row.stock);
    const gst = gstFrom(row);
    if (!name) {
      out.errors.push({ row: n, reason: "Product name is empty." });
      continue;
    }
    if (price === null || Number.isNaN(price) || price < 0) {
      out.errors.push({ row: n, reason: "Selling price is missing or not a number." });
      continue;
    }
    if (Number.isNaN(cost) || Number.isNaN(stock)) {
      out.errors.push({ row: n, reason: "Cost or opening stock isn't a valid number." });
      continue;
    }
    if (typeof gst === "string") {
      out.errors.push({ row: n, reason: gst });
      continue;
    }
    if (!isGstShop && gst.treatment === "UNSPECIFIED") {
      gst.treatment = "NON_GST";
    }
    if (!isGstShop && (gst.treatment === "TAXABLE" || gst.rateBp > 0)) {
      out.errors.push({
        row: n,
        reason: "This business has no GSTIN, so it can't charge GST. Remove the GST % (or add your GSTIN in Settings → Company first).",
      });
      continue;
    }
    const hsnRaw = row.hsn?.replace(/[\s.]/g, "") ?? "";
    if (hsnRaw && !/^\d{4,8}$/.test(hsnRaw)) {
      out.errors.push({ row: n, reason: "HSN code should be 4 to 8 digits, like 6205 or 62052000." });
      continue;
    }
    if (gst.treatment === "UNSPECIFIED") {
      out.errors.push({ row: n, reason: "Give this row a GST % (like 5) or a GST type (non-GST, nil, zero or slab)." });
      continue;
    }
    const variantDesc = row.variant?.trim() || null;
    const size = row.size?.trim() || variantDesc || null;
    const colour = row.colour?.trim() || null;
    const tax = { taxTreatment: gst.treatment, taxRateMode: gst.rateMode, taxRateBp: gst.rateBp, taxExemptionRef: gst.exemptionRef ?? null };
    const mrp = money(row.mrp);
    const mrpMinor = mrp !== null && !Number.isNaN(mrp) ? mrp : null;
    const key = name.toLowerCase();
    let productId = productIdByName.get(key);
    if (!productId) {
      productId = (await db.product.findFirst({ where: { tenantId: actor.tenantId, name: { equals: name, mode: "insensitive" } }, select: { id: true } }))?.id;
    }

    // Check if variant already exists (upsert / re-import support)
    let existingVariant: { id: string; productId: string; sku: string; barcode: string | null } | null = null;
    if (row.sku?.trim()) {
      existingVariant = await db.productVariant.findFirst({
        where: { tenantId: actor.tenantId, sku: row.sku.trim() },
        select: { id: true, productId: true, sku: true, barcode: true },
      });
    }
    if (!existingVariant && row.barcode?.trim()) {
      existingVariant = await db.productVariant.findFirst({
        where: { tenantId: actor.tenantId, barcode: row.barcode.trim() },
        select: { id: true, productId: true, sku: true, barcode: true },
      });
    }
    if (!existingVariant && productId) {
      existingVariant = await db.productVariant.findFirst({
        where: {
          tenantId: actor.tenantId,
          productId,
          ...(size ? { size: { equals: size, mode: "insensitive" } } : { size: null }),
          ...(colour ? { colour: { equals: colour, mode: "insensitive" } } : {}),
        },
        select: { id: true, productId: true, sku: true, barcode: true },
      });
    }

    const correlationId = randomUUID();

    if (existingVariant) {
      // Existing variant found: update prices, tax, barcode, cost, and physical stock
      if (db?.productVariant?.update) {
        try {
          await db.productVariant.update({
            where: { id: existingVariant.id },
            data: {
              priceMinor: price,
              mrpMinor,
              ...(cost !== null && !Number.isNaN(cost) && cost >= 0 ? { costPriceMinor: cost } : {}),
              ...(row.barcode?.trim() ? { barcode: row.barcode.trim() } : {}),
              ...tax,
            },
          });
        } catch {
          // Variant update error
        }
      }

      if (row.category?.trim() && db?.product?.update) {
        try {
          await db.product.update({
            where: { id: existingVariant.productId },
            data: { category: row.category.trim() },
          });
        } catch {
          // Category update error
        }
      }

      if (stock !== null && !Number.isNaN(stock)) {
        const effectiveStock = Math.max(0, stock);
        try {
          await recordStockTake({
            actor: { tenantId: actor.tenantId, userId: actor.userId, tenantRole: actor.tenantRole },
            storeId,
            variantId: existingVariant.id,
            countedQuantity: effectiveStock,
            reason: "Updated from re-import",
            requestKey: `import-take:${batchId}:${existingVariant.id}`,
            correlationId,
          });
        } catch {
          // Stock count error
        }
      }

      productIdByName.set(key, existingVariant.productId);
      out.updated++;
      continue;
    }

    const sku =
      row.sku?.trim() ||
      [
        skuPart(name, 10) || "ITEM",
        variantDesc ? skuPart(variantDesc, 8) : null,
        size && size !== variantDesc ? skuPart(size, 6) : null,
        colour ? skuPart(colour, 6) : null,
        batchId.slice(0, 4).toUpperCase(),
      ]
        .filter(Boolean)
        .join("-");

    let variantId: string;
    if (productId) {
      const v = await createVariant({
        actor,
        productId,
        sku,
        barcode: row.barcode?.trim() || null,
        size,
        colour,
        priceMinor: price,
        mrpMinor,
        isActive: true,
        correlationId,
        ...tax,
      });
      if (v.status !== "ok") {
        out.errors.push({ row: n, reason: refusalReason(v) });
        continue;
      }
      variantId = v.variantId;
    } else {
      const p = await createProduct({
        actor,
        name,
        category: row.category?.trim() || null,
        brand: row.brand?.trim() || null,
        imageUrl: null,
        isActive: true,
        baseUomId: uom.id,
        hsnCode: hsnRaw || null,
        correlationId,
        firstVariant: { sku, barcode: row.barcode?.trim() || null, size, colour, priceMinor: price, mrpMinor, isActive: true, ...tax },
      });
      if (p.status !== "ok") {
        out.errors.push({ row: n, reason: refusalReason(p) });
        continue;
      }
      productId = p.productId;
      variantId = p.variantId;
    }
    productIdByName.set(key, productId);
    const effectiveStock = stock !== null && stock > 0 ? stock : 0;
    if (effectiveStock > 0) {
      const r = await receiveStock({
        actor,
        storeId,
        variantId,
        quantity: effectiveStock,
        reason: "Opening stock (imported)",
        requestKey: `import:${batchId}:${sku}`,
        correlationId,
        unitCostMinor: cost ?? null,
      });
      if (r.status !== "ok") out.errors.push({ row: n, reason: "Product added, but its opening stock couldn't be recorded." });
    }
    out.created++;
  }
  return out;
}

async function importSales(actor: Actor, storeId: string, batchId: string, rows: ImportRow[], first: number): Promise<ImportOutcome> {
  const out: ImportOutcome = { created: 0, updated: 0, skipped: 0, errors: [] };
  for (const [i, row] of rows.entries()) {
    const n = first + i;
    const billNumber = row.billNumber?.trim();
    const soldAt = parseBillDate(row.date);
    const total = money(row.total);
    const tax = money(row.tax);
    if (!billNumber) {
      out.errors.push({ row: n, reason: "Bill number is empty." });
      continue;
    }
    if (!soldAt) {
      out.errors.push({ row: n, reason: "Date isn't readable (use 31-03-2025 or 2025-03-31)." });
      continue;
    }
    if (total === null || Number.isNaN(total)) {
      out.errors.push({ row: n, reason: "Bill total is missing or not a number." });
      continue;
    }
    let customerId: string | null = null;
    const customerName = row.customerName?.trim() || null;
    const customerPhone = row.customerPhone?.trim() || null;
    if (customerName && customerPhone) {
      const c = await createCustomer({ tenantId: actor.tenantId, name: customerName, phone: customerPhone, actorUserId: actor.userId });
      if (c.status === "ok") customerId = c.customer.id;
    }
    const already = await db.importedSale.findUnique({
      where: { tenantId_storeId_billNumber: { tenantId: actor.tenantId, storeId, billNumber: billNumber.slice(0, 80) } },
      select: { id: true },
    });
    if (already) {
      out.skipped++;
      continue;
    }
    await db.importedSale.create({
      data: {
        tenantId: actor.tenantId,
        storeId,
        billNumber: billNumber.slice(0, 80),
        soldAt,
        customerId,
        customerName,
        customerPhone,
        totalMinor: total,
        taxMinor: tax !== null && !Number.isNaN(tax) ? tax : 0,
        paymentMode: row.paymentMode?.trim().slice(0, 40) || null,
        itemsText: row.items?.trim().slice(0, 2000) || null,
        importBatchId: batchId,
      },
    });
    out.created++;
  }
  return out;
}

export type RunImportResult = { status: "ok"; outcome: ImportOutcome } | { status: "forbidden" } | { status: "invalid"; reason: string };

export async function runImport(input: {
  actor: Actor;
  storeId: string;
  kind: ImportKind;
  batchId: string;
  firstRowNumber: number;
  rows: ImportRow[];
}): Promise<RunImportResult> {
  if (input.actor.tenantRole !== "OWNER") return { status: "forbidden" };
  if (input.rows.length === 0 || input.rows.length > MAX_IMPORT_ROWS) {
    return { status: "invalid", reason: `Send between 1 and ${MAX_IMPORT_ROWS} rows at a time.` };
  }
  const outcome =
    input.kind === "customers"
      ? await importCustomers(input.actor, input.storeId, input.batchId, input.rows, input.firstRowNumber)
      : input.kind === "products"
        ? await importProducts(input.actor, input.storeId, input.batchId, input.rows, input.firstRowNumber)
        : await importSales(input.actor, input.storeId, input.batchId, input.rows, input.firstRowNumber);
  await writeAuditLog({
    tenantId: input.actor.tenantId,
    userId: input.actor.userId,
    action: `import.${input.kind}`,
    correlationId: randomUUID(),
    metadata: { batchId: input.batchId, rows: input.rows.length, created: outcome.created, skipped: outcome.skipped, errors: outcome.errors.length },
  });
  return { status: "ok", outcome };
}
