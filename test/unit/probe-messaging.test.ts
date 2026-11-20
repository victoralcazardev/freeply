import { describe, expect, it } from "vitest";
import { probeMessaging } from "../../src/index";

const sha = async (s: string) =>
  [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)))]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");

describe("probeMessaging", () => {
  it("logs metadata only and pairs an echo with the reply", async () => {
    const text = "Hola, prueba privada";
    const lines = await probeMessaging(
      {
        entry: [
          {
            id: "acct",
            messaging: [
              { sender: { id: "acct" }, recipient: { id: "lead-1" }, message: { text, is_echo: true } },
              { sender: { id: "lead-1" }, recipient: { id: "acct" }, message: { text: "respuesta" } },
            ],
          },
        ],
      },
      await sha(text),
    );
    const peer = (await sha("lead-1")).slice(0, 8);
    expect(lines).toEqual([
      `probe echo=true peer=${peer} text=yes m1_match=true`,
      `probe echo=false peer=${peer} text=yes m1_match=false`,
    ]);
    for (const l of lines) expect(l).not.toMatch(/prueba|respuesta|lead-1/);
  });
});
