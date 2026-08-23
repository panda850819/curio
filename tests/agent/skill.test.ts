import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";

const skillPath = resolve(import.meta.dir, "../../skills/curio/SKILL.md");

describe("Curio agent skill", () => {
  test("documents manifest-first operation and secret boundaries", async () => {
    const skill = await Bun.file(skillPath).text();

    expect(skill).toContain("GET /api/v1/agent/manifest");
    expect(skill).toContain("POST /api/v1/probes");
    expect(skill).toContain("POST /api/v1/subscriptions/ensure");
    expect(skill).toContain("POST /api/v1/subscriptions");
    expect(skill).toContain("POST /api/v1/routes");
    expect(skill).toContain("POST /api/v1/subscriptions/:id/poll");
    expect(skill).toContain("POST /api/v1/destinations/:id/verify");
    expect(skill).toContain("bun run curio probe");
    expect(skill).toContain("subscriptions.remove");
    expect(skill).toContain("routes.remove");
    expect(skill).toContain("TELEGRAM_BOT_TOKEN");
    expect(skill).toContain("X_AUTH_TOKEN");
    expect(skill).toContain("作者缺失時保留原始來源");
    expect(skill).toContain("人物連結只有在來源明確提供且使用者確認後才合併");
    expect(skill).toContain("curio_subscribe_source");
    expect(skill).toContain("curio_get_item");
    expect(skill).toContain("curio_list_quotes");
    expect(skill).toContain("curio_enrich_item");
    expect(skill).toContain("curio_save_quote");
    expect(skill).toContain("quote_text_not_found");
    expect(skill).toContain("回應不包含 raw `contentHtml`");
    expect(skill).not.toMatch(/gho_[A-Za-z0-9]{20,}/u);
    expect(skill).not.toContain("secret-bot-token");
  });
});
