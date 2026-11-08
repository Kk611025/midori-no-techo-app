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
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");

  if (start < 0 || end <= start) {
    throw new Error("AIから正しいJSON形式の返答がありませんでした。");
  }

  const jsonText = cleaned.slice(start, end + 1);

  try {
    return JSON.parse(jsonText);
  } catch (error) {
    const match = error.message.match(/position (\d+)/);
    const position = match ? Number(match[1]) : 0;
    const preview = jsonText.slice(
      Math.max(0, position - 100),
      position + 100
    );

    throw new Error(
      "AIのJSON形式に問題があります。位置：" +
      position + "。該当箇所：" + preview
    );
  }
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
      const people = Math.max(1, Math.min(8, Number(body.people) || 4));
      const day = Math.max(1, Math.min(7, Number(body.day) || 1));
      const budgets = body.budgets || {};
      const mealBudgets = {
  breakfast: Math.max(0, Number(budgets.breakfast) || 0),
  lunch: Math.max(0, Number(budgets.lunch) || 0),
  dinner: Math.max(0, Number(budgets.dinner) || 0)
};
      const existing = (body.existingRecipes || []).slice(0, 100);
      const previous = (body.previousNames || []).slice(-80);
      const pantry = (body.pantry || []).slice(0, 60);
      const expiry = body.pantryExpiry || {};
      // Search the public web without a paid search API. Search results are references, not guaranteed full recipe text.
      // ネット検索は1回だけ実行して待ち時間を短縮
      const searchResults = [];

      try {
        const term = `${pantry.join(" ")} 家庭料理 人気レシピ 和食 洋食 中華`;
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 5000);

        try {
          const searchUrl = "https://html.duckduckgo.com/html/?q=" + encodeURIComponent(term);
          const sr = await fetch(searchUrl, {
            headers: {
              "User-Agent": "Mozilla/5.0 (compatible; UchiNoGohan/1.0)",
              "Accept": "text/html"
            },
            signal: controller.signal
          });

          if (sr.ok) {
            const page = await sr.text();
            const blocks = [...page.matchAll(/<div class="result[^>]*>[\s\S]*?<a class="result__a" href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?(?:<a class="result__snippet"[^>]*>([\s\S]*?)<\/a>)?[\s\S]*?<\/div>/gi)];

            for (const m of blocks.slice(0, 5)) {
              const clean = v => String(v || "")
                .replace(/<[^>]*>/g, " ")
                .replace(/&amp;/g, "&")
                .replace(/&quot;/g, '"')
                .replace(/&#x27;|&#39;/g, "'")
                .replace(/\s+/g, " ")
                .trim();

              let link = m[1];
              try {
                const u = new URL(link, "https://duckduckgo.com");
                const redirected = u.searchParams.get("uddg");
                if (redirected) link = decodeURIComponent(redirected);
              } catch (_) {}

              if (/^https?:\/\//i.test(link) &&
                  !searchResults.some(x => x.url === link)) {
                searchResults.push({
                  title: clean(m[2]),
                  url: link,
                  snippet: clean(m[3])
                });
              }
            }
          }
        } finally {
          clearTimeout(timer);
        }
      } catch (_) {
        // 検索に失敗してもAIによる献立作成は続ける
      }
      const prompt = `
あなたは世界各国の家庭料理に詳しい献立作成AIです。以下のネット検索結果を参考に、和食・洋食・中華・韓国料理・エスニックなど幅広いジャンルから献立を組み立ててください。検索結果のURLは実在する参考ページとして該当する料理に紐づけてください。検索結果から材料や分量・作り方が十分に分からない場合は、一般的な料理知識を使って自然で安全なレシピに補完してください。検索結果にないURLを作らないでください。参考URLが見つからない料理はsource_urlを空欄にしてください。
ネット検索結果:
${JSON.stringify(searchResults.slice(0, 24))}

対象は${people}人家族の${day}日目。
予算は1人あたり朝食${mealBudgets.breakfast}円、昼食${mealBudgets.lunch}円、夕食${mealBudgets.dinner}円です。各食の総予算は「1人あたりの予算×人数」で計算してください。
朝食・昼食・夕食それぞれに、必ず次の3品を各1品ずつ作ってください。
・主食(staple)
・主菜(main)
・汁物(soup)

予算に余裕がある場合のみ、副菜(side)を追加してください。さらに余裕がある場合のみ、小鉢(kobachi)を追加してください。
予算を超える場合は、小鉢、次に副菜の順で省いてください。主食・主菜・汁物は省略しないでください。
【献立の構成ルール】
・朝食の主菜（main）は卵料理でも構いません。
・朝食の肉料理は、ウインナー炒めやボイルウインナーなど、簡単に作れるものを優先してください。
・昼食と夕食の主菜（main）は必ず肉料理または魚料理にしてください。
・昼食と夕食の主菜にサラダ、野菜だけの料理、卵料理、豆腐料理を選ばないでください。
・肉料理は鶏肉、豚肉、牛肉、ひき肉、ウインナーなどを使ってください。
・魚料理は鮭、さば、たら、ぶり、あじなどを使ってください。
・副菜（side）は野菜を中心とした料理にしてください。
・小鉢（kobachi）はサラダ、酢の物、和え物などにしてください。
・副菜と小鉢で同じ料理や似た料理を重複させないでください。
・サラダが副菜と小鉢の両方に入らないようにしてください。

【料理の重複防止】
・朝食、昼食、夕食で同じ料理名を使わないでください。
・同じ日に同じ料理を別の食事に出さないでください。
・前日までに使った料理名も重複させないでください。
・同じ食材を使う場合でも、料理名、味付け、調理方法を変えてください。
・主菜の肉料理や魚料理が1日に偏らないようにしてください。

各食の食材費は、含まれる料理のcost_for_4を合計し、人数÷4を掛けて計算してください。各食の総予算を目標にしてください。1人あたり50円までの超過は許容します。予算を超えそうな場合は、最初から食材費の安い料理を選び、必須の3品は必ず維持してください。
料理数は各食3〜5品とし、予算内で無理に品数を増やさないでください。

朝は食べやすく簡単に、昼は満足感があり、夕食は主菜と野菜のバランスを重視してください。和食・洋食・中華・韓国料理・エスニックなどを適度に混ぜ、同じ味付け・食材・調理法が偏らないようにしてください。

前日までに使った料理名（重複禁止）: ${JSON.stringify(previous)}
アプリに登録済みのレシピ（使えるものは優先）: ${JSON.stringify(existing)}
家にある食材: ${JSON.stringify(pantry)}
期限情報: ${JSON.stringify(expiry)}
優先したい食材・避けたい食材の入力: ${JSON.stringify(body.avoid||[])}

すべてのレシピは4人分の材料量に統一してください。cost_for_4は4人分の食材費の概算円です。各レシピに具体的な材料名と分量、初心者にも分かる3〜5工程の作り方、調理時間、参考にしたレシピのURLを入れてください。主食はご飯・パン・麺などの炭水化物を含む料理にしてください。汁物は必ず汁物にしてください。副菜と小鉢を追加する場合は、同じ料理にしないでください。
必ず次のJSONだけを返してください。説明文・Markdown・コード囲みは不要です。
{
  "meals": {
    "breakfast": [
      {"course":"staple","name":"料理名","category":"ご飯もの","minutes":15,"cost_for_4":200,"ingredients":[{"name":"米","amount":"2合"}],"steps":["手順1","手順2"],"tip":"","source_url":""},
      {"course":"main","name":"料理名","category":"和食","minutes":15,"cost_for_4":300,"ingredients":[{"name":"卵","amount":"4個"}],"steps":["手順1","手順2"],"tip":"","source_url":""},
      {"course":"soup","name":"料理名","category":"汁物・スープ","minutes":10,"cost_for_4":100,"ingredients":[{"name":"味噌","amount":"大さじ2"}],"steps":["手順1"],"tip":"","source_url":""}
    ],
    "lunch": [
      {"course":"staple","name":"料理名","category":"麺類","minutes":20,"cost_for_4":250,"ingredients":[{"name":"麺","amount":"4人分"}],"steps":["手順1","手順2"],"tip":"","source_url":""},
      {"course":"main","name":"料理名","category":"中華","minutes":20,"cost_for_4":350,"ingredients":[{"name":"豚肉","amount":"300g"}],"steps":["手順1","手順2"],"tip":"","source_url":""},
      {"course":"soup","name":"料理名","category":"汁物・スープ","minutes":10,"cost_for_4":100,"ingredients":[{"name":"野菜","amount":"100g"}],"steps":["手順1"],"tip":"","source_url":""}
    ],
    "dinner": [
      {"course":"staple","name":"料理名","category":"ご飯もの","minutes":20,"cost_for_4":250,"ingredients":[{"name":"米","amount":"2合"}],"steps":["手順1","手順2"],"tip":"","source_url":""},
      {"course":"main","name":"料理名","category":"和食","minutes":25,"cost_for_4":500,"ingredients":[{"name":"魚","amount":"4切れ"}],"steps":["手順1","手順2"],"tip":"","source_url":""},
      {"course":"soup","name":"料理名","category":"汁物・スープ","minutes":10,"cost_for_4":100,"ingredients":[{"name":"味噌","amount":"大さじ2"}],"steps":["手順1"],"tip":"","source_url":""}
    ]
  }
}
`;
      // Gemini 3.8 uses the Interactions API. store:false avoids retaining
      // this one-shot meal-planning interaction on the server.
     const models = [
  "gemini-3.5-flash-lite",
  "gemini-3.1-flash-lite"
];

      let api;
      let raw;

      for (const model of models) {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 15000);

        try {
          api = await fetch("https://generativelanguage.googleapis.com/v1beta/interactions", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "x-goog-api-key": env.GEMINI_API_KEY
            },
            body: JSON.stringify({
              model,
              input: prompt,
              store: false
            }),
            signal: controller.signal
          });

          raw = await api.json();
        } catch (error) {
          api = { ok: false, status: 504 };
          raw = { error: { message: model + " の応答がタイムアウトしました。" } };
        } finally {
          clearTimeout(timeoutId);
        }

        if (api.ok) break;

        if (![429, 500, 502, 503, 504].includes(api.status)) {
          break;
        }
      }

      if (!api.ok) {
        const msg = raw.error?.message || "すべてのAIモデルでエラーが発生しました。";
        return json({ error: msg }, api.status, origin);
      }
            const parsed = parseJson(extractText(raw));
      const originalParsed = JSON.parse(JSON.stringify(parsed));
      const retryMeals = [];

      // 食事ごとの予算チェック
      function checkMeal(meals, mealName) {
        const dishes = meals[mealName];

        if (!Array.isArray(dishes)) {
          throw new Error(mealName + "の献立が不足しています。");
        }

        // 必須料理の確認
        for (const course of ["staple", "main", "soup"]) {
          if (!dishes.some(d => d.course === course)) {
            throw new Error(mealName + "に必須料理がありません：" + course);
          }
        }

        const budget = mealBudgets[mealName] * people;
        const allowedBudget = budget + (50 * people);

        const totalCost = () => dishes.reduce(
          (sum, d) => sum + (Number(d.cost_for_4) || 0) * people / 4,
          0
        );

        // 小鉢、副菜の順に削除
        for (const course of ["kobachi", "side"]) {
          if (totalCost() <= allowedBudget) break;

          const index = dishes.findIndex(d => d.course === course);
          if (index !== -1) dishes.splice(index, 1);
        }

        return {
          budget,
          allowedBudget,
          cost: totalCost()
        };
      }

      // 最初の献立を予算チェック
      for (const mealName of ["breakfast", "lunch", "dinner"]) {
        const result = checkMeal(parsed.meals, mealName);

        if (result.cost > result.allowedBudget) {
          retryMeals.push(mealName);
        }
      }

      // 予算超過した食事だけをまとめて1回再生成
      if (retryMeals.length > 0) {
        const retryPrompt = `
あなたは食材費を抑える献立作成AIです。

次の食事だけを作り直してください。
対象の食事：${JSON.stringify(retryMeals)}

人数：${people}人

各食の1人あたり予算：
朝食：${mealBudgets.breakfast}円
昼食：${mealBudgets.lunch}円
夕食：${mealBudgets.dinner}円

予算は1人あたり50円までの超過を許容します。
できるだけ予算内に収めてください。

必ず主食(staple)、主菜(main)、汁物(soup)を各1品ずつ入れてください。
予算に収まらない場合は小鉢(kobachi)、副菜(side)の順に省いてください。
料理は食材費の安いものを優先してください。
材料と分量は4人分で記載してください。
cost_for_4は4人分の食材費です。

元の献立：
${JSON.stringify(originalParsed.meals)}

作り直し対象の献立：
${JSON.stringify(retryMeals.map(name => ({
  meal: name,
  dishes: parsed.meals[name]
})))}

対象の食事だけを次の形式のJSONで返してください。
説明文やMarkdownは不要です。

{
  "meals": {
    "breakfast": [],
    "lunch": [],
    "dinner": []
  }
}

対象外の食事は空配列にしてください。
`;

        let retryApi;
        let retryRaw;

        for (const model of models) {
          const controller = new AbortController();
          const timeoutId = setTimeout(() => controller.abort(), 15000);

          try {
            retryApi = await fetch(
              "https://generativelanguage.googleapis.com/v1beta/interactions",
              {
                method: "POST",
                headers: {
                  "Content-Type": "application/json",
                  "x-goog-api-key": env.GEMINI_API_KEY
                },
                body: JSON.stringify({
                  model,
                  input: retryPrompt,
                  store: false
                }),
                signal: controller.signal
              }
            );

            retryRaw = await retryApi.json();
          } catch (error) {
            retryApi = { ok: false, status: 504 };
            retryRaw = {
              error: {
                message: "作り直しの応答がタイムアウトしました。"
              }
            };
          } finally {
            clearTimeout(timeoutId);
          }

          if (retryApi.ok) break;

          if (![429, 500, 502, 503, 504].includes(retryApi.status)) {
            break;
          }
        }

        // 作り直しに成功した場合だけ比較
        if (retryApi && retryApi.ok) {
          try {
            const retryParsed = parseJson(extractText(retryRaw));

            for (const mealName of retryMeals) {
              const retryDishes = retryParsed.meals?.[mealName];

              if (!Array.isArray(retryDishes)) continue;

              // 作り直した献立の必須料理を確認
              const required = ["staple", "main", "soup"];
              if (!required.every(course =>
                retryDishes.some(d => d.course === course)
              )) {
                continue;
              }

              const originalResult = checkMeal(parsed.meals, mealName);

              const candidateMeals = {
                [mealName]: JSON.parse(JSON.stringify(retryDishes))
              };

              const retryResult = checkMeal(candidateMeals, mealName);

              // 予算との差が小さい方を採用
              const originalDifference = Math.abs(
                originalResult.cost - originalResult.budget
              );

              const retryDifference = Math.abs(
                retryResult.cost - retryResult.budget
              );

              if (retryDifference < originalDifference) {
                parsed.meals[mealName] = candidateMeals[mealName];
              }
            }
          } catch (error) {
            // 作り直し結果に問題があれば最初の献立を使用
          }
        }
      }

      return json(parsed, 200, origin);
    } catch (e) {
      return json(
        { error: e.message || "処理中にエラーが発生しました。" },
        500,
        origin
      );
    }
  }
};
