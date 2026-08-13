import { createRequire as createNodeRequire } from "node:module";
import type { Driver as YdbDriverType, TableSession } from "ydb-sdk";

const requireYdb = createNodeRequire(import.meta.url);
const { Driver: YdbDriver, TypedValues, Types, getCredentialsFromEnv } = requireYdb(
  "ydb-sdk",
) as typeof import("ydb-sdk");

let driverPromise: Promise<YdbDriverType> | null = null;

export type SessionRunner = <T>(fn: (session: TableSession) => Promise<T>) => Promise<T>;

export async function getDriver(endpoint: string, database: string): Promise<YdbDriverType> {
  if (!driverPromise) {
    const driver = new YdbDriver({ endpoint, database, authService: getCredentialsFromEnv() });
    driverPromise = driver.ready(10000).then((ready) => {
      if (!ready) {
        throw new Error("YDB driver not ready");
      }
      return driver;
    });
  }
  return driverPromise;
}

export async function withSession<T>(
  endpoint: string,
  database: string,
  fn: (session: TableSession) => Promise<T>,
): Promise<T> {
  const driver = await getDriver(endpoint, database);
  return driver.tableClient.withSession(fn);
}

export function createSessionRunner(endpoint: string, database: string): SessionRunner {
  return <T>(fn: (session: TableSession) => Promise<T>) =>
    withSession(endpoint, database, fn);
}

export { TypedValues, Types };
