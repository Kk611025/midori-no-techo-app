/**
 * うちのごはん - Cloudflare Worker
 * Secret: GEMINI_API_KEY (Google AI Studio)
 * Deploy this Worker, then paste its workers.dev URL into the app.
 */
const ALLOWED_ORIGIN = "https://kk611025.github.io";
const MODEL = "gemini-3.8-flash";

function cors(origin) {
  const allow = origin === ALLOWED_ORIGIN ? origin : ALLOWED_ORIGIN;
  return {
    "Access-Control-Allow-Origin": allow,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, X-App-Code",
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
    if (request.url.endsWith("/import")) {
      if (!env.APP_ACCESS_CODE) return json({error:"WorkerにAPP_ACCESS_CODEが設定されていません。"},500,origin);
      if ((request.headers.get("X-App-Code") || "") !== env.APP_ACCESS_CODE) return json({error:"接続コードが違います。"},401,origin);
      try {
        const body = await request.json();
        const target = new URL(body.url || "");
        const host = target.hostname.toLowerCase();
        const blockedHost = host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host === "0.0.0.0" || host === "::1" || /^127\./.test(host) || /^10\./.test(host) || /^192\.168\./.test(host) || /^169\.254\./.test(host) || /^172\.(1[6-9]|2[0-9]|3[0-1])\./.test(host);
        if (!['http:','https:'].includes(target.protocol) || blockedHost || target.username || target.password) return json({error:"公開されているWebページのURLを入力してね。"},400,origin);
        const page = await fetch(target.toString(), {headers:{"User-Agent":"Mozilla/5.0 (compatible; UchiNoGohan/1.0)","Accept":"text/html,application/xhtml+xml"}, redirect:"follow"});
        if (!page.ok) return json({error:"サイトが読み込めませんでした。ログインが必要なページやアクセス制限のあるサイトは取り込めない場合があります。"},422,origin);
        const html = await page.text();
        const scripts = [...html.matchAll(/<script\b[^>]*type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)];
        const candidates=[];
        function walk(v){ if(!v)return; if(Array.isArray(v)){v.forEach(walk);return;} if(typeof v==='object'){const t=v['@type'];if(t==='Recipe'||(Array.isArray(t)&&t.includes('Recipe')))candidates.push(v); for(const [k,val] of Object.entries(v)){if(k==='@type')continue; if(val&&typeof val==='object')walk(val);}}}
        for(const m of scripts){try{walk(JSON.parse(m[1].replace(/\u003c/gi,'<')))}catch(_){}}
        const r=candidates[0];
        if(!r)return json({error:"このページからレシピ情報を自動取得できませんでした。材料と作り方を入力欄に貼り付けて保存してね。"},422,origin);
        const flatten=(x)=>{if(!x)return[];if(Array.isArray(x))return x.flatMap(flatten);if(typeof x==='string')return[x];if(typeof x==='object'){if(x.text)return[x.text];if(x.itemListElement)return flatten(x.itemListElement);if(x.name)return[x.name];if(x.description)return[x.description];}return[]};
        const instructions=flatten(r.recipeInstructions).map(x=>x.replace(/<[^>]*>/g,' ').trim()).filter(Boolean);
        const ingredients=flatten(r.recipeIngredient);
        const duration=(r.totalTime||r.cookTime||r.prepTime||'').match(/PT(?:(\d+)H)?(?:(\d+)M)?/i);
        const minutes=duration?Math.max(1,(Number(duration[1]||0)*60)+Number(duration[2]||0)):30;
        return json({recipe:{name:r.name||'',description:r.description||'',category:r.recipeCategory||'和食',minutes,ingredients,instructions}},200,origin);
      } catch(e) { return json({error:e.message||"レシピの読み込みに失敗しました。"},500,origin); }
    }
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
      // Search the public web without a paid search API. Search results are references, not guaranteed full recipe text.
      const searchTerms = [
        `${pantry.join(" ")} 人気 レシピ 和食 洋食 中華 韓国料理`,
        `家庭料理 主菜 副菜 汁物 レシピ ${day}日目`,
        `簡単 家庭料理 レシピ ${people}人分`
      ];
      const searchResults = [];
      for (const term of searchTerms) {
        try {
          const searchUrl = "https://html.duckduckgo.com/html/?q=" + encodeURIComponent(term);
          const sr = await fetch(searchUrl, { headers: { "User-Agent": "Mozilla/5.0 (compatible; UchiNoGohan/1.0)", "Accept": "text/html" } });
          if (!sr.ok) continue;
          const page = await sr.text();
          const blocks = [...page.matchAll(/<div class="result[^>]*>[\s\S]*?<a class="result__a" href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?(?:<a class="result__snippet"[^>]*>([\s\S]*?)<\/a>)?[\s\S]*?<\/div>/gi)];
          for (const m of blocks.slice(0, 8)) {
            const clean = v => String(v || "").replace(/<[^>]*>/g, " ").replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#x27;|&#39;/g, "'").replace(/\s+/g, " ").trim();
            let link = m[1];
            try { const u = new URL(link, "https://duckduckgo.com"); const redirected = u.searchParams.get("uddg"); if (redirected) link = decodeURIComponent(redirected); } catch (_) {}
            if (/^https?:\/\//i.test(link) && !searchResults.some(x => x.url === link)) searchResults.push({ title: clean(m[2]), url: link, snippet: clean(m[3]) });
          }
        } catch (_) {}
      }
      const prompt = `
あなたは世界各国の家庭料理に詳しい献立作成AIです。以下のネット検索結果を参考に、和食・洋食・中華・韓国料理・エスニックなど幅広いジャンルから献立を組み立ててください。検索結果のURLは実在する参考ページとして該当する料理に紐づけてください。検索結果から材料や分量・作り方が十分に分からない場合は、一般的な料理知識を使って自然で安全なレシピに補完してください。検索結果にないURLを作らないでください。参考URLが見つからない料理はsource_urlを空欄にしてください。
ネット検索結果:
${JSON.stringify(searchResults.slice(0, 24))}

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
      // Gemini 3.8 uses the Interactions API. store:false avoids retaining
      // this one-shot meal-planning interaction on the server.
      const api = await fetch("https://generativelanguage.googleapis.com/v1beta/interactions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-goog-api-key": env.GEMINI_API_KEY
        },
        body: JSON.stringify({
          model: MODEL,
          input: prompt,
          store: false
        })
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
