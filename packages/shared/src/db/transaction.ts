import type { TableSession } from "ydb-sdk";

export type QueryParameters = NonNullable<Parameters<TableSession["executeQuery"]>[1]>;
export type QueryResult = Awaited<ReturnType<TableSession["executeQuery"]>>;

export interface SerializableTransaction {
  executeQuery(query: string, params?: QueryParameters): Promise<QueryResult>;
}

export async function withSerializableTransaction<T>(
  session: TableSession,
  operation: (transaction: SerializableTransaction) => Promise<T>,
): Promise<T> {
  const metadata = await session.beginTransaction({ serializableReadWrite: {} });
  if (!metadata.id) {
    throw new Error("YDB did not return a transaction ID");
  }

  const transactionControl = { txId: metadata.id };
  const transaction: SerializableTransaction = {
    executeQuery: (query, params = {}) =>
      session.executeQuery(query, params, transactionControl),
  };

  try {
    const result = await operation(transaction);
    await session.commitTransaction(transactionControl);
    return result;
  } catch (error) {
    await session.rollbackTransaction(transactionControl).catch(() => undefined);
    throw error;
  }
}
