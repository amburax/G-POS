import { describe, expect, it, vi, beforeEach } from "vitest";
import { autoMapColumns } from "@/server/imports/importFields";
import { normalizeName, normalizePhone } from "@/lib/customerFields";

const mockDb = {
  uom: { findFirst: vi.fn() },
  tenant: { findUnique: vi.fn() },
  productVariant: { findFirst: vi.fn() },
  product: { findFirst: vi.fn() },
  sale: { findFirst: vi.fn(), create: vi.fn() },
  khataReceivableEntry: { create: vi.fn() },
  customerCreditAccount: { findUnique: vi.fn(), findUniqueOrThrow: vi.fn(), create: vi.fn() },
  customer: { findFirst: vi.fn(), create: vi.fn() },
  company: { findFirst: vi.fn(), create: vi.fn(), findUnique: vi.fn() },
  store: { updateMany: vi.fn(), findUnique: vi.fn() },
};

vi.mock("@/server/db", () => ({ db: mockDb }));
vi.mock("@/server/identity/audit", () => ({ writeAuditLog: vi.fn(async () => {}) }));
vi.mock("@/server/inventory/inventoryService", () => ({ receiveStock: vi.fn(async () => ({ status: "ok" })) }));
vi.mock("@/server/tenant/tenantCompany", () => ({
  ensureTenantCompany: vi.fn(async () => ({ id: "c1", code: "CO", name: "Hazari", currency: "INR" })),
}));
vi.mock("@/server/khata/creditAccount", () => ({
  findOrCreateCreditAccount: vi.fn(async () => ({ id: "cca-1" })),
}));

const { runImport } = await import("@/server/imports/importService");
const { createProduct, createVariant } = await import("@/server/catalog/catalogService");
const { createCustomer } = await import("@/server/sales/customers");

vi.mock("@/server/catalog/catalogService", () => ({
  createProduct: vi.fn(async ({ name, firstVariant }) => ({
    status: "ok",
    productId: `prod-${name}`,
    variantId: `var-${firstVariant.sku}`,
  })),
  createVariant: vi.fn(async ({ sku }) => ({ status: "ok", variantId: `var-${sku}` })),
}));

vi.mock("@/server/sales/customers", () => ({
  createCustomer: vi.fn(async ({ name, phone }) => ({
    status: "ok",
    customer: { id: `cust-${phone || name}`, name, phone },
    existing: false,
  })),
}));

const actor = { tenantId: "t1", userId: "u1", tenantRole: "OWNER" as const };

describe("Real-world Smart Import Verification", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDb.uom.findFirst.mockResolvedValue({ id: "uom-pcs" });
    mockDb.tenant.findUnique.mockResolvedValue({ taxId: "24AABCH1234F1Z1" });
    mockDb.productVariant.findFirst.mockResolvedValue(null);
    mockDb.product.findFirst.mockResolvedValue(null);
    mockDb.sale.findFirst.mockResolvedValue(null);
    mockDb.sale.create.mockResolvedValue({ id: "sale-1" });
    mockDb.khataReceivableEntry.create.mockResolvedValue({ id: "entry-1" });
  });

  describe("File 1 (Products & Stock): Columns, Variants, Negative Stocks", () => {
    const productHeaders = [
      "CATEGORY",
      "ITEM_TYPE",
      "ITEM_NAME",
      "VARIANT_NAME",
      "PRICE",
      "COST_PRICE",
      "STOCK",
      "BARCODE",
      "SKU",
    ];

    it("auto-maps all garment product headers correctly", () => {
      const mapping = autoMapColumns("products", productHeaders);
      expect(mapping.category).toBe(0); // CATEGORY
      expect(mapping.name).toBe(2); // ITEM_NAME
      expect(mapping.variant).toBe(3); // VARIANT_NAME
      expect(mapping.price).toBe(4); // PRICE
      expect(mapping.cost).toBe(5); // COST_PRICE
      expect(mapping.stock).toBe(6); // STOCK
      expect(mapping.barcode).toBe(7); // BARCODE
      expect(mapping.sku).toBe(8); // SKU
    });

    it("handles multiple variants of the same product without duplicate SKUs or skipping", async () => {
      const rows = [
        { name: "Capri", variant: "Hosiery 23XL", price: "150", cost: "80", stock: "-2", gstType: "slab" },
        { name: "Capri", variant: "4 Way", price: "200", cost: "120", stock: "17", gstType: "slab" },
        { name: "Capri", variant: "Svg XL", price: "200", cost: "108", stock: "0", gstType: "slab" },
      ];

      const res = await runImport({
        actor,
        storeId: "store-1",
        kind: "products",
        batchId: "batch-real",
        firstRowNumber: 2,
        rows,
      });

      expect(res.status).toBe("ok");
      const outcome = (res as { outcome: { created: number; errors: unknown[] } }).outcome;
      expect(outcome.errors).toHaveLength(0);
      expect(outcome.created).toBe(3);
    });

    it("gracefully imports items with negative stock without throwing an error", async () => {
      const res = await runImport({
        actor,
        storeId: "store-1",
        kind: "products",
        batchId: "batch-neg",
        firstRowNumber: 2,
        rows: [{ name: "Cotton Capri", variant: "Milletry", price: "250", cost: "115", stock: "-10", gstType: "slab" }],
      });

      expect(res.status).toBe("ok");
      const outcome = (res as { outcome: { created: number; errors: unknown[] } }).outcome;
      expect(outcome.errors).toHaveLength(0);
      expect(outcome.created).toBe(1);
    });
  });

  describe("File 2 (Customers & Khata Opening Dues)", () => {
    const customerHeaders = [
      "Name",
      "Email",
      "Phone",
      "Address",
      "Gender",
      "NumberOfOrders",
      "AddedDate",
      "LastVisited",
      "AmountDue",
      "AmountHeld (Advance)",
    ];

    it("auto-maps customer headers including Address and AmountDue", () => {
      const mapping = autoMapColumns("customers", customerHeaders);
      expect(mapping.name).toBe(0);
      expect(mapping.email).toBe(1);
      expect(mapping.phone).toBe(2);
      expect(mapping.address).toBe(3);
      expect(mapping.amountDue).toBe(8);
    });

    it("normalizes real Indian customer phone numbers with repeated +91 or trunk 0", () => {
      expect(normalizePhone("+91+91 87804 63531")).toEqual({ ok: true, value: "+918780463531" });
      expect(normalizePhone("9108140605323")).toEqual({ ok: true, value: "+918140605323" });
      expect(normalizePhone("9108780463531")).toEqual({ ok: true, value: "+918780463531" });
      expect(normalizePhone("919925250852")).toEqual({ ok: true, value: "+919925250852" });
    });

    it("allows real retail customer names with numbers and emojis", () => {
      expect(normalizeName("Aman 2")).toEqual({ ok: true, value: "Aman 2" });
      expect(normalizeName("PARESH BHAI 2")).toEqual({ ok: true, value: "PARESH BHAI 2" });
      expect(normalizeName("HATIM BHAI 2. S. HAZARI")).toEqual({ ok: true, value: "HATIM BHAI 2. S. HAZARI" });
      expect(normalizeName("Safu😇🔥")).toEqual({ ok: true, value: "Safu😇🔥" });
    });

    it("imports customers with opening Khata dues and creates opening receivable ledger entries", async () => {
      const rows = [
        { name: "", phone: "+91+91 87804 63531", amountDue: "0" },
        { name: "ALI SHOP", phone: "919998238034", amountDue: "1200" },
        { name: "ALLU", phone: "916359253524", amountDue: "2105" },
        { name: "PARESH BHAI 2", phone: "919638838516", amountDue: "203" },
      ];

      const res = await runImport({
        actor,
        storeId: "store-1",
        kind: "customers",
        batchId: "batch-cust",
        firstRowNumber: 2,
        rows,
      });

      expect(res.status).toBe("ok");
      const outcome = (res as { outcome: { created: number; errors: unknown[] } }).outcome;
      expect(outcome.errors).toHaveLength(0);
      expect(outcome.created).toBe(4);

      // Verify opening sales and khata receivables were created for customers with dues
      expect(mockDb.sale.create).toHaveBeenCalledTimes(3); // ALI SHOP (1200), ALLU (2105), PARESH BHAI 2 (203)
      expect(mockDb.khataReceivableEntry.create).toHaveBeenCalledTimes(3);

      const firstCall = mockDb.sale.create.mock.calls[0]![0].data;
      expect(firstCall.totalMinor).toBe(120000);
      expect(firstCall.paidMinor).toBe(0);
      expect(firstCall.initialOnAccountMinor).toBe(120000);
      expect(firstCall.billNumber).toContain("OPENING-");
    });
  });
});
