// The only place the page talks to the server. `fetch` is injected so Node tests can drive it without a network.

export class ApiError extends Error {
  constructor(message, status, body) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.body = body;
  }
}

/** Relative URLs on purpose: the page works at "/" and behind any path prefix or preview proxy. */
/** @param {{ fetch?: typeof fetch, token?: string }} [options] */
export function createApi({ fetch: fetchImpl = globalThis.fetch?.bind(globalThis), token = "" } = {}) {
  async function readJson(response) {
    try {
      return await response.json();
    } catch {
      return null;
    }
  }

  /** @param {string} path @param {{ signal?: AbortSignal }} [options] */
  async function getJson(path, { signal } = {}) {
    let response;
    try {
      // The token is sent on reads as well: a Control Center on a LAN address (`--control-host 0.0.0.0`) serves its
      // snapshot only to a caller that has it, and this page does.
      response = await fetchImpl(path, {
        headers: { accept: "application/json", "x-gamemind-token": token },
        cache: "no-store",
        ...(signal ? { signal } : {}),
      });
    } catch (error) {
      throw new ApiError(`Could not reach GameMind (${error instanceof Error ? error.message : String(error)})`, 0, null);
    }
    const body = await readJson(response);
    if (!response.ok) throw new ApiError(body?.message ?? `${path} answered ${response.status}`, response.status, body);
    return body;
  }

  return {
    snapshot: ({ fresh = false } = {}) => getJson(`./api/snapshot${fresh ? "?fresh=1" : ""}`),
    query(name, params = {}) {
      const search = new URLSearchParams();
      for (const [key, value] of Object.entries(params)) {
        if (value !== undefined && value !== null && value !== "") search.set(key, String(value));
      }
      const text = search.toString();
      return getJson(`./api/${name}${text ? `?${text}` : ""}`);
    },
    /** Resolves with the server's answer for accepted and refused commands alike; rejects only when it cannot be reached. */
    async command(type, payload) {
      let response;
      try {
        response = await fetchImpl("./api/command", {
          method: "POST",
          headers: { "content-type": "application/json", "x-gamemind-token": token },
          body: JSON.stringify(payload === undefined ? { type } : { type, payload }),
        });
      } catch (error) {
        throw new ApiError(`Could not reach GameMind (${error instanceof Error ? error.message : String(error)})`, 0, null);
      }
      const body = (await readJson(response)) ?? {};
      return { ok: response.ok && body.ok !== false, status: response.status, message: typeof body.message === "string" ? body.message : response.ok ? "Done." : `The command was refused (${response.status}).`, data: body.data };
    },
  };
}
