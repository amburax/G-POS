import { PrismaClient } from "@prisma/client";

declare global {
  // `var` is required here: this is the only declaration form that augments globalThis.
  // (The previous eslint-disable for `no-var` is gone — typescript-eslint does not flag
  // ambient declarations, so the directive was dead.)
  var __prisma: PrismaClient | undefined;
}

function createPrismaClient(): PrismaClient {
  const client = new PrismaClient();
  const origTransaction = client.$transaction.bind(client);
  client.$transaction = function (arg: any, options?: any) {
    if (typeof arg === "function") {
      return origTransaction(arg, {
        maxWait: 10000,
        timeout: 30000,
        ...options,
      });
    }
    return origTransaction(arg, options);
  } as typeof client.$transaction;
  return client;
}

export const db = globalThis.__prisma ?? createPrismaClient();

if (process.env.NODE_ENV !== "production") {
  globalThis.__prisma = db;
}
