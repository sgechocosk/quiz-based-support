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

/**
 * 調査の「調べることの整理」(investigation_plan)と「材料の確認」(sufficiency)への既定の応答。対象外のリクエストなら undefined。
 * - 整理: 変更する場所の項目を1つ
 * - 確認: read_file で最初に読んだ範囲を根拠に、すべての項目を「分かった」とする(まだ何も読んでいなければ「まだ」)。
 *   summary は調査担当の最後のまとめ(JSON でない応答)
 */
export function investigationReply(body: any): { json: unknown } | undefined {
  const name = body?.response_format?.json_schema?.name;
  if (name === "investigation_plan") {
    return { json: msg(JSON.stringify({ needs: [{ need: "変更する場所はどこか", kind: "change_site", why: "w", hints: "" }] })) };
  }
  if (name !== "sufficiency") {
    return undefined;
  }
  const messages: any[] = body.messages;
  const ids = [...String(messages[messages.length - 1].content).matchAll(/^- (n\d+) \[/gm)].map((m) => m[1]);
  const read = messages
    .filter((m) => m.role === "tool")
    .map((m) => /^(\S+) \(L(\d+)-(\d+) \//.exec(m.content ?? ""))
    .find((m) => m !== null);
  const summary =
    [...messages].reverse().find((m) => m.role === "assistant" && m.content && !String(m.content).trim().startsWith("{"))?.content ?? "";
  return {
    json: msg(
      JSON.stringify({
        needs: ids.map((id) =>
          read
            ? { id, status: "found", locations: [{ path: read[1], startLine: Number(read[2]), endLine: Number(read[3]) }], note: "読んだ" }
            : { id, status: "missing", locations: [], note: "まだ読んでいない" },
        ),
        newNeeds: [],
        summary,
      }),
    ),
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
