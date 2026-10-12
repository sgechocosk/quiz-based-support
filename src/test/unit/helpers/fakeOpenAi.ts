import * as http from "node:http";
import { FakeEmbedder } from "./nodeWorkspace";

export interface RecordedRequest {
  path: string;
  body: any;
}

export type Handler = (req: RecordedRequest, n: number) => { status?: number; json?: unknown; headers?: Record<string, string> };

/** OpenAI互換の偽サーバー。リクエストを記録し、ハンドラが返すJSONを返す。 */
export async function startFakeOpenAi(handler: Handler): Promise<{
  baseUrl: string;
  requests: RecordedRequest[];
  close: () => Promise<void>;
}> {
  const requests: RecordedRequest[] = [];
  const embedder = new FakeEmbedder();
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", async () => {
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
      const rec = { path: req.url ?? "", body };
      requests.push(rec);
      if (rec.path.endsWith("/embeddings")) {
        const data = (await embedder.embed(body.input)).map((embedding, index) => ({ index, embedding }));
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ data }));
        return;
      }
      const out = handler(rec, requests.length);
      res.statusCode = out.status ?? 200;
      res.setHeader("content-type", "application/json");
      for (const [k, v] of Object.entries(out.headers ?? {})) {
        res.setHeader(k, v);
      }
      res.end(JSON.stringify(out.json ?? {}));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as { port: number }).port;
  return {
    baseUrl: `http://127.0.0.1:${port}/v1`,
    requests,
    close: () =>
      new Promise<void>((r) => {
        server.closeAllConnections();
        server.close(() => r());
      }),
  };
}

export const msg = (content: string | null, toolCalls?: Array<{ name: string; args: unknown }>) => ({
  choices: [
    {
      message: {
        role: "assistant",
        content,
        tool_calls: toolCalls?.map((c, i) => ({
          id: `call_${i}_${c.name}`,
          type: "function",
          function: { name: c.name, arguments: JSON.stringify(c.args) },
        })),
      },
    },
  ],
});
