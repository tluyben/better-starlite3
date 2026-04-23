import type { DatabaseClient } from "./types.js";
import type { FlexDBClientOptions } from "flexdb-node";

async function loadFlexDB() {
  try {
    const mod = await import("flexdb-node");
    return mod.FlexDBClient;
  } catch {
    throw new Error(
      "[better-starlite3] flexdb-node is not installed. " +
      "Run: npm install flexdb-node",
    );
  }
}

export async function openFlexDB(options: Omit<FlexDBClientOptions, never>): Promise<DatabaseClient> {
  const FlexDBClient = await loadFlexDB();
  const client = new FlexDBClient(options);

  return {
    driver: "flexdb",
    query: client.query.bind(client),
    execute: client.execute.bind(client),
    beginTransaction: client.beginTransaction.bind(client),
    transaction: client.transaction.bind(client),
    destroy: client.destroy.bind(client),
    get honker() { return client.honker; },
  };
}
