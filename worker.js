/**
 * うちのごはん - Cloudflare Worker
 * Secret: GEMINI_API_KEY (Google AI Studio)
 * Deploy this Worker, then paste its workers.dev URL into the app.
 */
const ALLOWED_ORIGIN = "https://kk611025.github.io";
const MODEL = "gemini-3.5-flash";

function cors(origin) {
  const allow = origin === ALLOWED_ORIGIN ? origin : ALLOWED_ORIGIN;
  return {
    "Access-Control-Allow-Origin": allow,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Vary": "Origin"
  };
}
function json(data, status, origin) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...cors(origin), "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" }
  });
}
function extractText(data) {
  if (data.output_text) return data.output_text;
  const steps = data.steps || [];
  const blocks = [];
  for (const step of steps) {
    if (step.type === "model_output") {
      for (const c of (step.content || [])) if (c.type === "text" && c.text) blocks.push(c.text);
    }
  }
  if (blocks.length) return blocks.join("\n");
  // Fallback for generateContent-style responses.
  return data.candidates?.[0]?.content?.parts?.map(p => p.text || "").join("\n") || "";
}
function parseJson(text) {
  const cleaned = text.replace(/```(?:json)?/gi, "").trim();
  const start = cleaned.indexOf("{"), end = cleaned.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("AIの返答をJSONとして読み取れませんでした。");
  return JSON.parse(cleaned.slice(start, end + 1));
}
export default {
  async fetch(request, env) {
    const origin = request.headers.get("Origin") || "";
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors(origin) });
    if (request.method !== "POST") return json({ error: "POSTで送信してください。" }, 405, origin);
    if (origin && origin !== ALLOWED_ORIGIN) return json({ error: "許可されていない接続元です。" }, 403, origin);
    if (!env.GEMINI_API_KEY) return json({ error: "WorkerにGEMINI_API_KEYが設定されていません。" }, 500, origin);
    if (!env.APP_ACCESS_CODE) return json({ error: "WorkerにAPP_ACCESS_CODEが設定されていません。" }, 500, origin);
    if ((request.headers.get("X-App-Code") || "") !== env.APP_ACCESS_CODE) return json({ error: "接続コードが違います。" }, 401, origin);
    try {
      const body = await request.json();
      const people = Math.max(1, Math.min(20, Number(body.people) || 4));
      const day = Math.max(1, Math.min(7, Number(body.day) || 1));
      const budgets = body.budgets || {};
      const existing = (body.existingRecipes || []).slice(0, 100);
      const previous = (body.previousNames || []).slice(-80);
      const pantry = (body.pantry || []).slice(0, 60);
      const expiry = body.pantryExpiry || {};
      const prompt = `
あなたは日本の家庭料理に詳しい献立作成AIです。Google検索で実在するレシピ情報を調べ、その情報を参考にしつつ、不足する材料・分量・作り方は料理として自然で安全な内容に補って完成させてください。
対象は${people}人家族の${day}日目。朝食予算${budgets.breakfast||0}円、昼食予算${budgets.lunch||0}円、夕食予算${budgets.dinner||0}円（各食5品全体の目安）です。
必ず朝食・昼食・夕食の各食に、主食(staple)、メイン(main)、副菜(side)、汁物(soup)、小鉢(kobachi)を各1品ずつ、合計15品作ってください。
朝は食べやすく簡単に、昼は満足感があり、夕食は主菜と野菜のバランスを重視。和食・洋食・中華を適度に混ぜ、同じ味付け・食材・調理法が偏らないようにしてください。
前日までに使った料理名（重複禁止）: ${JSON.stringify(previous)}
アプリに登録済みのレシピ（使えるものは優先）: ${JSON.stringify(existing)}
家にある食材: ${JSON.stringify(pantry)}
期限情報: ${JSON.stringify(expiry)}
優先したい食材・避けたい食材の入力: ${JSON.stringify(body.avoid||[])}
すべてのレシピは4人分の材料量に統一。cost_for_4は4人分の食材費の概算円。各レシピに具体的な材料名と分量、初心者にも分かる4〜7工程の作り方、調理時間、参考にしたレシピのURLを入れてください。主食はご飯・パン・麺などの炭水化物を含む料理にしてください。汁物は汁物、小鉢は少量の和え物・冷奴・酢の物などにしてください。副菜と小鉢を同じ料理にしないでください。
必ず次のJSONだけを返してください。説明文・Markdown・コード囲みは不要です。
{
 "meals":{
  "breakfast":[
   {"course":"staple","name":"料理名","category":"ご飯もの","minutes":15,"cost_for_4":200,"ingredients":[{"name":"米","amount":"2合"}],"steps":["手順1","手順2"],"tip":"コツ","source_url":"https://..."},
   {"course":"main","name":"料理名","category":"和食","minutes":15,"cost_for_4":300,"ingredients":[{"name":"卵","amount":"4個"}],"steps":["手順1"],"tip":"","source_url":"https://..."},
   {"course":"side","name":"料理名","category":"サラダ・副菜","minutes":10,"cost_for_4":150,"ingredients":[{"name":"野菜","amount":"適量"}],"steps":["手順1"],"tip":"","source_url":"https://..."},
   {"course":"soup","name":"料理名","category":"汁物・スープ","minutes":10,"cost_for_4":100,"ingredients":[{"name":"味噌","amount":"大さじ2"}],"steps":["手順1"],"tip":"","source_url":"https://..."},
   {"course":"kobachi","name":"料理名","category":"サラダ・副菜","minutes":5,"cost_for_4":100,"ingredients":[{"name":"きゅうり","amount":"1本"}],"steps":["手順1"],"tip":"","source_url":"https://..."}
  ],
  "lunch":[
   {"course":"staple","name":"料理名","category":"ご飯もの","minutes":20,"cost_for_4":250,"ingredients":[{"name":"米","amount":"2合"}],"steps":["手順1","手順2"],"tip":"","source_url":"https://..."},
   {"course":"main","name":"料理名","category":"和食","minutes":20,"cost_for_4":350,"ingredients":[{"name":"豚肉","amount":"300g"}],"steps":["手順1","手順2"],"tip":"","source_url":"https://..."},
   {"course":"side","name":"料理名","category":"サラダ・副菜","minutes":10,"cost_for_4":150,"ingredients":[{"name":"野菜","amount":"適量"}],"steps":["手順1"],"tip":"","source_url":"https://..."},
   {"course":"soup","name":"料理名","category":"汁物・スープ","minutes":10,"cost_for_4":100,"ingredients":[{"name":"味噌","amount":"大さじ2"}],"steps":["手順1"],"tip":"","source_url":"https://..."},
   {"course":"kobachi","name":"料理名","category":"サラダ・副菜","minutes":5,"cost_for_4":100,"ingredients":[{"name":"きゅうり","amount":"1本"}],"steps":["手順1"],"tip":"","source_url":"https://..."}
  ],
  "dinner":[
   {"course":"staple","name":"料理名","category":"ご飯もの","minutes":20,"cost_for_4":250,"ingredients":[{"name":"米","amount":"2合"}],"steps":["手順1","手順2"],"tip":"","source_url":"https://..."},
   {"course":"main","name":"料理名","category":"和食","minutes":25,"cost_for_4":500,"ingredients":[{"name":"魚","amount":"4切れ"}],"steps":["手順1","手順2"],"tip":"","source_url":"https://..."},
   {"course":"side","name":"料理名","category":"サラダ・副菜","minutes":10,"cost_for_4":150,"ingredients":[{"name":"野菜","amount":"適量"}],"steps":["手順1"],"tip":"","source_url":"https://..."},
   {"course":"soup","name":"料理名","category":"汁物・スープ","minutes":10,"cost_for_4":100,"ingredients":[{"name":"味噌","amount":"大さじ2"}],"steps":["手順1"],"tip":"","source_url":"https://..."},
   {"course":"kobachi","name":"料理名","category":"サラダ・副菜","minutes":5,"cost_for_4":100,"ingredients":[{"name":"わかめ","amount":"適量"}],"steps":["手順1"],"tip":"","source_url":"https://..."}
  ]
 }
}
`;
      const api = await fetch("https://generativelanguage.googleapis.com/v1beta/interactions", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-goog-api-key": env.GEMINI_API_KEY },
        body: JSON.stringify({ model: MODEL, input: prompt, tools: [{ type: "google_search" }] })
      });
      const raw = await api.json();
      if (!api.ok) {
        const msg = raw.error?.message || "Gemini APIでエラーが発生しました。";
        return json({ error: msg }, api.status, origin);
      }
      const parsed = parseJson(extractText(raw));
      for (const meal of ["breakfast", "lunch", "dinner"]) {
        if (!Array.isArray(parsed.meals?.[meal])) throw new Error(meal + "の献立が不足しています。");
      }
      return json(parsed, 200, origin);
    } catch (e) {
      return json({ error: e.message || "処理中にエラーが発生しました。" }, 500, origin);
    }
  }
};
// Cloudflare build trigger
