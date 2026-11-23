/**
 * うちのごはん - Cloudflare Worker
 * Gemma 4優先 ＋ 無料AIフォールバック強化版
 */
const ALLOWED_ORIGINS = [
  "https://kk611025.github.io"
];

const MODELS_GEMMA = [
  "gemma-4-31b-it",
  "gemma-4-26b-a4b-it",
  "gemma-3-27b-it"
];

const MODELS_INTERACTIONS = [
  "gemini-3.8-flash",
  "gemini-3.5-flash-lite",
  "gemini-4-hydrogen",
  "gemini-3.6-flash",
  "gemini-3.5-flash",
  "gemini-3.1-flash-lite"
];

const MODELS_GENERATE = [
  "gemini-3.5-flash-lite",
  "gemini-3.8-flash",
  "gemini-3.6-flash",
  "gemini-3.1-flash-lite"
];

function resolveOrigin(origin) {
  if (!origin) return ALLOWED_ORIGINS[0];
  if (ALLOWED_ORIGINS.includes(origin)) return origin;
  return ALLOWED_ORIGINS[0];
}

function cors(origin) {
  return {
    "Access-Control-Allow-Origin": resolveOrigin(origin),
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, X-App-Code",
    "Vary": "Origin"
  };
}

function json(data, status, origin) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      ...cors(origin),
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store"
    }
  });
}

function extractText(data) {
  if (data.output_text) return data.output_text;

  const blocks = [];
  for (const step of (data.steps || [])) {
    if (step.type === "model_output") {
      for (const c of (step.content || [])) {
        if (c.type === "text" && c.text) blocks.push(c.text);
      }
    }
  }
  if (blocks.length) return blocks.join("\n");

  const parts = data.candidates?.[0]?.content?.parts || [];
  const answerParts = parts.filter(p => !p.thought && p.text);
  if (answerParts.length) return answerParts.map(p => p.text).join("\n");
  return parts.map(p => p.text || "").join("\n");
}

function parseJson(text) {
  const cleaned = String(text || "")
    .replace(/```(?:json)?/gi, "")
    .trim();

  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");

  if (start < 0 || end <= start) {
    throw new Error("AIの返答がJSON形式ではありません。日数を減らして試してください。");
  }

  try {
    return JSON.parse(cleaned.slice(start, end + 1));
  } catch (_) {
    throw new Error("AIのJSONが途中で切れています。日数を1〜3日に減らして試してください。");
  }
}

function safeArray(value, max) {
  return Array.isArray(value) ? value.slice(0, max) : [];
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function costOf(dishes, people) {
  return dishes.reduce(
    (sum, d) => sum + (Number(d.cost_for_4) || 0) * people / 4,
    0
  );
}

function checkMeal(inputDishes, mealName, people, perPersonBudget) {
  const dishes = clone(inputDishes);
  const budget = Math.max(0, Number(perPersonBudget) || 0) * people;
  const allowedBudget = budget + 50 * people;
  const totalCost = () => costOf(dishes, people);

  for (const course of ["kobachi", "side"]) {
    if (totalCost() <= allowedBudget) break;
    const index = dishes.findIndex(d => d.course === course);
    if (index >= 0) dishes.splice(index, 1);
  }

  const required = ["staple", "main", "soup"];
  const valid = required.every(course => dishes.some(d => d.course === course));

  return { dishes, budget, allowedBudget, cost: totalCost(), valid };
}

function validateMeal(dishes, label) {
  if (!Array.isArray(dishes)) {
    throw new Error(label + "の献立がありません。");
  }
  for (const course of ["staple", "main", "soup"]) {
    if (!dishes.some(d => d && d.course === course)) {
      throw new Error(label + "に必須料理がありません：" + course);
    }
  }
}

function normalizeDays(parsed, days) {
  let rows = Array.isArray(parsed.days) ? parsed.days : null;

  if (!rows && parsed.meals && days === 1) {
    rows = [{ day: 1, meals: parsed.meals }];
  }

  if (!rows || rows.length < days) {
    throw new Error("AIから" + days + "日分の献立が返りませんでした。");
  }

  const out = [];
  for (let i = 0; i < days; i++) {
    const row = rows.find(x => Number(x.day) === i + 1) || rows[i];
    if (!row || !row.meals) {
      throw new Error((i + 1) + "日目の献立がありません。");
    }

    const meals = {};
    for (const name of ["breakfast", "lunch", "dinner"]) {
      validateMeal(row.meals[name], (i + 1) + "日目の" + name);
      meals[name] = row.meals[name];
    }
    out.push({ day: i + 1, meals });
  }
  return out;
}

async function callAI(env, prompt, maxTokens) {
  const errors = [];

  // 1. Google Gemini API（Gemma 4 → Gemini Interactions → Gemini GenerateContent の順）
  if (env.GEMINI_API_KEY) {
    const tasks = [
      ...MODELS_GEMMA.map(model => ({ model, mode: "gemma" })),
      ...MODELS_INTERACTIONS.map(model => ({ model, mode: "interactions" })),
      ...MODELS_GENERATE.map(model => ({ model, mode: "generateContent" }))
    ];

    for (const { model, mode } of tasks) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 35000);

      try {
        const url = mode === "interactions"
          ? "https://generativelanguage.googleapis.com/v1beta/interactions"
          : `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;

        let payload;
        if (mode === "interactions") {
          payload = {
            model,
            input: prompt,
            store: false,
            generation_config: {
              max_output_tokens: maxTokens,
              thinking_level: "low"
            }
          };
        } else if (mode === "gemma") {
          payload = {
            contents: [{ parts: [{ text: prompt }] }],
            generationConfig: {
              maxOutputTokens: Math.min(maxTokens, 8192)
            }
          };
        } else {
          payload = {
            contents: [{ role: "user", parts: [{ text: prompt }] }],
            generationConfig: {
              maxOutputTokens: maxTokens,
              responseMimeType: "application/json"
            }
          };
        }

        const response = await fetch(url, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-goog-api-key": env.GEMINI_API_KEY
          },
          body: JSON.stringify(payload),
          signal: controller.signal
        });

        const rawText = await response.text();
        let raw = null;
        try {
          raw = JSON.parse(rawText);
        } catch (_) {
          raw = { error: { message: rawText.slice(0, 200) } };
        }

        if (response.ok) {
          if (mode === "interactions" && raw.status !== "completed") {
            errors.push(`${model}(${mode})：処理状態 ${raw.status || "不明"}`);
            continue;
          }
          if (mode !== "interactions" && raw.candidates?.[0]?.finishReason === "MAX_TOKENS") {
            errors.push(`${model}(${mode})：出力上限で途切れ`);
            continue;
          }
          const text = extractText(raw);
          if (!text) {
            errors.push(`${model}(${mode})：回答が空でした`);
            continue;
          }
          return parseJson(text);
        }

        const status = response.status;
        const message = raw?.error?.message || ("HTTP " + status);
        errors.push(`${model}(${mode} HTTP ${status})：${message}`);

        if (status === 401 || status === 403) {
          throw new Error("Gemini APIキーの認証エラー：" + message);
        }
        if (status === 503 || status === 429) {
          await new Promise(resolve => setTimeout(resolve, 400));
        }
      } catch (e) {
        if (e.message?.startsWith("Gemini APIキーの認証エラー：")) throw e;
        const message = e.name === "AbortError" ? "タイムアウト" : ("通信エラー：" + e.message);
        errors.push(`${model}(${mode})：${message}`);
      } finally {
        clearTimeout(timeout);
      }
    }
  }

  // 2. Groq 無料枠（環境変数 GROQ_API_KEY が設定されている場合）
  if (env.GROQ_API_KEY) {
    for (const model of ["openai/gpt-oss-120b", "qwen/qwen3.8-27b"]) {
      try {
        const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Authorization": "Bearer " + env.GROQ_API_KEY
          },
          body: JSON.stringify({
            model,
            messages: [{ role: "user", content: prompt }],
            temperature: 0.5,
            response_format: { type: "json_object" }
          })
        });
        const data = await res.json();
        const content = data?.choices?.[0]?.message?.content;
        if (res.ok && content) return parseJson(content);
        errors.push(`Groq(${model} HTTP ${res.status})：${data?.error?.message || "失敗"}`);
      } catch (e) {
        errors.push(`Groq(${model})：${e.message}`);
      }
    }
  }

  // 3. Cloudflare Workers AI（バインディング AI が設定されている場合）
  if (env.AI) {
    try {
      const result = await env.AI.run("@cf/meta/llama-3.1-8b-instruct", {
        messages: [{ role: "user", content: prompt }],
        max_tokens: 4096
      });
      if (result?.response) return parseJson(result.response);
    } catch (e) {
      errors.push(`Workers AI：${e.message}`);
    }
  }

  throw new Error("すべてのAIモデルで失敗しました。\n" + errors.join("\n"));
}

function recipeRules() {
  return `
各食に主食(staple)・主菜(main)・汁物(soup)を各1品必ず含める。
予算内に収まる場合だけ副菜(side)、さらに余裕がある場合だけ小鉢(kobachi)を加える。
昼食・夕食の主菜は肉または魚。朝食の主菜は卵料理可。
副菜は野菜中心、小鉢はサラダ・酢の物・和え物など。
朝は簡単、昼は満足感、夕食は主菜と野菜のバランス重視。料理名の重複を避ける。

各料理は4人分の材料量、cost_for_4（4人分の食材費・円）、
ingredients（材料名と分量）、steps（短い2〜3工程）、
minutes、tip、source_urlを含める。
JSON以外の文章やMarkdownは返さない。

料理オブジェクト形式：
{"course":"staple","name":"料理名","category":"分類","minutes":15,"cost_for_4":300,"ingredients":[{"name":"材料","amount":"分量"}],"steps":["手順1","手順2"],"tip":"","source_url":""}
`;
}

function buildWeekPrompt(body, context) {
  const {
    days, people, budgets, avoid,
    existing, previous, pantry, expiry, searchResults
  } = context;

  return `
あなたは家庭料理に詳しい献立作成AIです。
${people}人分の${days}日間の献立を作成してください。

【1人あたり予算】
朝食：${budgets.breakfast}円 / 昼食：${budgets.lunch}円 / 夕食：${budgets.dinner}円
各食の総予算は1人あたり予算×${people}人（1人50円までの超過許容）。
食材費はcost_for_4×人数÷4で計算してください。

${recipeRules()}

【重複禁止の料理名】
${JSON.stringify(previous)}

【登録済みレシピ】
${JSON.stringify(existing)}

【家にある食材】
${JSON.stringify(pantry)}

【期限情報】
${JSON.stringify(expiry)}

【避けたい食材など】
${JSON.stringify(avoid)}

【優先して使いたい食材】
${JSON.stringify(body.wanted || "")}

【参考検索結果】
${JSON.stringify(searchResults)}

【重要】
1日目から${days}日目まで、朝食・昼食・夕食（合計${days * 3}食）をすべて作成してください。
材料と手順はできるだけ簡潔に書いてください。
必ず次の形式のJSONだけを返してください。

{
  "days": [
    {
      "day": 1,
      "meals": { "breakfast": [], "lunch": [], "dinner": [] }
    }
  ]
}
`;
}

function buildRetryPrompt(slots, context) {
  return `
あなたは食材費を抑える献立作成AIです。

【作り直す食事（day番号は変更しないでください）】
${JSON.stringify(slots)}

人数：${context.people}人
【1人あたり予算】
${JSON.stringify(context.budgets)}

${recipeRules()}

登録済みレシピ：${JSON.stringify(context.existing)}
家にある食材：${JSON.stringify(context.pantry)}
避けたい食材：${JSON.stringify(context.avoid)}

対象のdayと食事だけを作り直し、予算に収まらない場合は副菜・小鉢を省いてください。
必ず各要素の "day" に元の日数番号を入れてJSONだけを返してください。

{
  "days": [
    {
      "day": ${slots[0]?.day || 1},
      "meals": { "breakfast": [], "lunch": [], "dinner": [] }
    }
  ]
}
`;
}

export default {
  async fetch(request, env) {
    const origin = request.headers.get("Origin") || "";

    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: {
          ...cors(origin),
          "Access-Control-Max-Age": "86400"
        }
      });
    }

    if (origin && !ALLOWED_ORIGINS.includes(origin)) {
      return json({ error: "許可されていない接続元です。" }, 403, origin);
    }

    if (request.method !== "POST") {
      return json({ error: "POSTで送信してください。" }, 405, origin);
    }

    try {
      const body = await request.json();
      const accessCode = request.headers.get("X-App-Code") || body.accessCode || "";

      if (!env.APP_ACCESS_CODE || accessCode !== env.APP_ACCESS_CODE) {
        return json({ error: "接続コードが正しくありません。" }, 401, origin);
      }

      const url = new URL(request.url);

      if (url.pathname.endsWith("/import")) {
        const recipeUrl = String(body.url || "").trim();
        if (!recipeUrl) return json({ error: "レシピURLがありません。" }, 400, origin);

        let parsedUrl;
        try {
          parsedUrl = new URL(recipeUrl);
        } catch (_) {
          return json({ error: "URLの形式が正しくありません。" }, 400, origin);
        }
        if (!["http:", "https:"].includes(parsedUrl.protocol)) {
          return json({ error: "このURLは読み込めません。" }, 400, origin);
        }

        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 12000);
        try {
          const page = await fetch(parsedUrl.toString(), {
            headers: { "User-Agent": "Mozilla/5.0", "Accept": "text/html" },
            signal: controller.signal
          });
          if (!page.ok) throw new Error("レシピページを取得できませんでした。");
          const html = await page.text();
          const scripts = [
            ...html.matchAll(/<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)
          ];

          let recipe = null;
          function findRecipe(value) {
            if (!value) return null;
            if (Array.isArray(value)) {
              for (const item of value) {
                const found = findRecipe(item);
                if (found) return found;
              }
            }
            if (typeof value !== "object") return null;
            const type = value["@type"];
            const types = Array.isArray(type) ? type : [type];
            if (types.some(t => String(t).toLowerCase() === "recipe")) return value;
            if (value["@graph"]) return findRecipe(value["@graph"]);
            return null;
          }

          for (const match of scripts) {
            try {
              const data = JSON.parse(match[1]);
              recipe = findRecipe(data);
              if (recipe) break;
            } catch (_) {}
          }

          if (!recipe) {
            return json({ error: "このページからレシピ情報を見つけられませんでした。" }, 422, origin);
          }

          const ingredients = safeArray(recipe.recipeIngredient, 100).map(item => ({
            name: String(item),
            amount: ""
          }));
          const instructions = [];
          function collectSteps(value) {
            if (!value) return;
            if (typeof value === "string") { instructions.push(value); return; }
            if (Array.isArray(value)) { value.forEach(collectSteps); return; }
            if (typeof value === "object") {
              if (value.text) instructions.push(String(value.text));
              else if (value.name) instructions.push(String(value.name));
              if (value.itemListElement) collectSteps(value.itemListElement);
            }
          }
          collectSteps(recipe.recipeInstructions);

          return json({
            recipe: {
              name: recipe.name || "読み込んだレシピ",
              description: recipe.description || "",
              ingredients,
              steps: instructions,
              source_url: parsedUrl.toString(),
              minutes: recipe.totalTime || "",
              image: Array.isArray(recipe.image)
                ? recipe.image[0]
                : (typeof recipe.image === "string" ? recipe.image : recipe.image?.url || "")
            }
          }, 200, origin);
        } finally {
          clearTimeout(timer);
        }
      }

      if (!env.GEMINI_API_KEY && !env.GROQ_API_KEY && !env.AI) {
        return json({ error: "AIキーが設定されていません。" }, 500, origin);
      }

      const days = Math.min(7, Math.max(1, Number(body.days) || 7));
      const people = Math.min(40, Math.max(1, Number(body.people) || 8));
      const budgets = {
        breakfast: Math.max(0, Number(body.budgets?.breakfast) || 0),
        lunch: Math.max(0, Number(body.budgets?.lunch) || 0),
        dinner: Math.max(0, Number(body.budgets?.dinner) || 0)
      };

      const context = {
        days,
        people,
        budgets,
        avoid: safeArray(body.avoid, 100),
        existing: safeArray(body.existing, 80),
        previous: safeArray(body.previous, 150),
        pantry: safeArray(body.pantry, 80),
        expiry: body.expiry && typeof body.expiry === "object" ? body.expiry : {},
        searchResults: []
      };

      const pantryWords = context.pantry.map(x => x?.name || "").filter(Boolean).slice(0, 10);
      const wantedWords = Array.isArray(body.wanted)
        ? body.wanted
        : String(body.wanted || "").split(/[、,，]/).map(x => x.trim()).filter(Boolean);

      const searchController = new AbortController();
      const searchTimer = setTimeout(() => searchController.abort(), 3000);
      try {
        const query = encodeURIComponent([
          "家庭料理 献立 レシピ " + pantryWords.slice(0, 5).join(" "),
          "簡単 レシピ " + wantedWords.join(" ")
        ].join(" "));
        const searchResponse = await fetch("https://html.duckduckgo.com/html/?q=" + query, {
          headers: { "User-Agent": "Mozilla/5.0" },
          signal: searchController.signal
        });
        if (searchResponse.ok) {
          const html = await searchResponse.text();
          context.searchResults = [
            ...html.matchAll(/class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi)
          ].slice(0, 5).map(match => ({
            url: match[1],
            title: match[2].replace(/<[^>]+>/g, "").trim()
          }));
        }
      } catch (_) {
      } finally {
        clearTimeout(searchTimer);
      }

      const prompt = buildWeekPrompt(body, context);
      const generated = await callAI(env, prompt, 12000);
      const week = normalizeDays(generated, days);

      const overBudget = [];
      for (const row of week) {
        for (const mealName of ["breakfast", "lunch", "dinner"]) {
          const checked = checkMeal(row.meals[mealName], mealName, people, budgets[mealName]);
          row.meals[mealName] = checked.dishes;
          if (!checked.valid) {
            throw new Error(row.day + "日目の" + mealName + "に主食・主菜・汁物がそろっていません。");
          }
          if (checked.cost > checked.allowedBudget) {
            overBudget.push({
              day: row.day,
              meal: mealName,
              original: clone(checked.dishes),
              originalCost: checked.cost,
              budget: checked.budget,
              allowedBudget: checked.allowedBudget
            });
          }
        }
      }

      let retryUsed = false;
      if (overBudget.length > 0) {
        try {
          retryUsed = true;
          const retryPrompt = buildRetryPrompt(overBudget, context);
          const retryResult = await callAI(env, retryPrompt, 8000);
          const retryRows = Array.isArray(retryResult.days) ? retryResult.days : [];

          for (const slot of overBudget) {
            const retryRow = retryRows.find(row => Number(row.day) === slot.day);
            const candidate = retryRow?.meals?.[slot.meal];
            if (!Array.isArray(candidate)) continue;

            try {
              validateMeal(candidate, slot.day + "日目の" + slot.meal);
              const checked = checkMeal(candidate, slot.meal, people, budgets[slot.meal]);
              if (Math.abs(checked.cost - slot.budget) < Math.abs(slot.originalCost - slot.budget)) {
                week[slot.day - 1].meals[slot.meal] = checked.dishes;
              }
            } catch (_) {}
          }
        } catch (_) {}
      }

      return json({
        days: week,
        meta: { days, people, retryUsed, retrySlots: overBudget.length }
      }, 200, origin);

    } catch (error) {
      return json({ error: error.message || "献立の作成に失敗しました。" }, 500, origin);
    }
  }
};
