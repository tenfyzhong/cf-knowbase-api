import { OAuthStore } from "../oauth-store.js";

export function createOAuthStore() {
  const objects = new Map<string, OAuthStore>();
  return {
    getByName(name: string) {
      if (!objects.has(name)) {
        const data = new Map<string, unknown>();
        let queue = Promise.resolve();
        const storage = {
          get: async (key: string) => data.get(key),
          put: async (key: string, value: unknown) => {
            data.set(key, structuredClone(value));
          },
          delete: async (key: string) => data.delete(key),
          deleteAll: async () => data.clear(),
          setAlarm: async () => {},
          transaction<T>(
            fn: (store: DurableObjectStorage) => Promise<T>
          ): Promise<T> {
            const result = queue.then(() =>
              fn(storage as unknown as DurableObjectStorage)
            );
            queue = result.then(
              () => {},
              () => {}
            );
            return result;
          }
        };
        objects.set(
          name,
          new OAuthStore({ storage } as unknown as DurableObjectState)
        );
      }
      return {
        fetch: async (url: string, init?: RequestInit) =>
          objects.get(name)!.fetch(new Request(url, init))
      };
    }
  } as unknown as DurableObjectNamespace;
}
