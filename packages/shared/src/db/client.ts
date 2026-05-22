import type { TableSession } from "ydb-sdk";
import { Driver as YdbDriver, TypedValues, Types, getCredentialsFromEnv } from "ydb-sdk";

let driverPromise: Promise<YdbDriver> | null = null;

export async function getDriver(endpoint: string, database: string): Promise<YdbDriver> {
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

export { TypedValues, Types };
