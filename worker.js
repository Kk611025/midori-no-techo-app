/**
 * うちのごはん - Cloudflare Worker
 * 並列生成・モデル自動学習・高速JSON修復 強化版
 */
const ALLOWED_ORIGINS = [
  "https://kk611025.github.io"
];

const MODELS_GEMMA = [
  "gemma-4-26b-a4b-it",
  "gemma-4-31b-it",
  "gemma-3-27b-it"
];

const MODELS_GEMINI = [
  "gemini-3.5-flash-lite",
  "gemini-3.8-flash",
  "gemini-3.6-flash",
  "gemini-3.1-flash-lite",
  "gemini-4-hydrogen"
];

const MODELS_GROQ = [
  "llama-3.3-70b-versatile",
  "openai/gpt-oss-120b",
  "llama-3.1-8b-instant"
];

const MODELS_WORKERS_AI = [
  "@cf/google/gemma-4-26b-a4b-it",
  "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
  "@cf/zai-org/glm-4.7-flash"
];

// 直近で成功したAIを記憶して次回から最優先で呼ぶ
let lastWinner = null;

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
  if (text && typeof text === "object") return text;

  const cleaned = String(text || "")
    .replace(/```(?:json)?/gi, "")
    .trim();

  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");

  if (start < 0 || end <= start) {
    throw new Error("AIの返答がJSON形式ではありません。");
  }

  // 末尾カンマなど軽微なJSON崩れを自動修復
  const slice = cleaned
    .slice(start, end + 1)
    .replace(/,\s*([}\]])/g, "$1");

  try {
    return JSON.parse(slice);
  } catch (_) {
    throw new Error("AIのJSONが途中で切れています。");
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

function checkMeal(inputDishes, people, perPersonBudget) {
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
  return { dishes, valid };
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

function normalizeChunk(parsed, startDay, endDay) {
  const expectedCount = endDay - startDay + 1;
  let rows = Array.isArray(parsed.days) ? parsed.days : null;

  if (!rows && parsed.meals && expectedCount === 1) {
    rows = [{ day: startDay, meals: parsed.meals }];
  }
  if (!rows || rows.length < expectedCount) {
    throw new Error(`${startDay}〜${endDay}日目の献立が不足しています。`);
  }

  const out = [];
  for (let i = 0; i < expectedCount; i++) {
    const targetDay = startDay + i;
    const row = rows.find(x => Number(x.day) === targetDay) || rows[i];
    if (!row || !row.meals) {
      throw new Error(`${targetDay}日目の献立がありません。`);
    }
    const meals = {};
    for (const name of ["breakfast", "lunch", "dinner"]) {
      validateMeal(row.meals[name], `${targetDay}日目の${name}`);
      meals[name] = row.meals[name];
    }
    out.push({ day: targetDay, meals });
  }
  return out;
}

async function runSingleCandidate(env, task, prompt, maxTokens) {
  const { provider, model, mode } = task;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 22000);

  try {
    if (provider === "groq") {
      const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": "Bearer " + env.GROQ_API_KEY
        },
        body: JSON.stringify({
          model,
          messages: [{ role: "user", content: prompt }],
          temperature: 0.4,
          max_tokens: Math.min(maxTokens, 6000),
          response_format: { type: "json_object" }
        }),
        signal: controller.signal
      });
      const data = await res.json();
      const content = data?.choices?.[0]?.message?.content;
      if (res.ok && content) return { ok: true, data: parseJson(content) };
      return { ok: false, error: `Groq(${model} ${res.status})：${data?.error?.message || "失敗"}` };
    }

    if (provider === "workers_ai") {
      const result = await env.AI.run(model, {
        messages: [{ role: "user", content: prompt }],
        max_tokens: 4096,
        response_format: { type: "json_object" }
      });
      if (result?.response) {
        return { ok: true, data: parseJson(result.response) };
      }
      return { ok: false, error: `WorkersAI(${model})：空応答` };
    }

    if (provider === "google") {
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
            maxOutputTokens: Math.min(maxTokens, 8192),
            temperature: 0.4
          }
        };
      } else {
        payload = {
          contents: [{ role: "user", parts: [{ text: prompt }] }],
          generationConfig: {
            maxOutputTokens: maxTokens,
            responseMimeType: "application/json",
            temperature: 0.4
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
      try { raw = JSON.parse(rawText); } catch (_) { raw = { error: { message: rawText.slice(0, 150) } }; }

      if (response.ok) {
        if (mode === "interactions" && raw.status !== "completed") {
          return { ok: false, error: `${model}(${mode})：${raw.status || "未完了"}` };
        }
        if (mode !== "interactions" && raw.candidates?.[0]?.finishReason === "MAX_TOKENS") {
          return { ok: false, error: `${model}(${mode})：文字数上限で途切れ` };
        }
        const text = extractText(raw);
        if (!text) return { ok: false, error: `${model}(${mode})：空応答` };
        return { ok: true, data: parseJson(text) };
      }

      const status = response.status;
      const message = raw?.error?.message || ("HTTP " + status);
      if (status === 401 || status === 403) {
        return { ok: false, fatal: true, error: "Gemini APIキーの認証エラー：" + message };
      }
      if (status === 503 || status === 429) {
        await new Promise(resolve => setTimeout(resolve, 150));
      }
      return { ok: false, error: `${model}(${mode} ${status})：${message}` };
    }

    return { ok: false, error: "未対応プロバイダ" };
  } catch (e) {
    return { ok: false, error: `${model}：${e.name === "AbortError" ? "タイムアウト" : e.message}` };
  } finally {
    clearTimeout(timeout);
  }
}

async function callAI(env, prompt, maxTokens) {
  const candidates = [];

  if (env.GROQ_API_KEY) {
    MODELS_GROQ.forEach(model => candidates.push({ provider: "groq", model, mode: "chat" }));
  }
  if (env.GEMINI_API_KEY) {
    MODELS_GEMMA.forEach(model => candidates.push({ provider: "google", model, mode: "gemma" }));
    MODELS_GEMINI.forEach(model => candidates.push({ provider: "google", model, mode: "generateContent" }));
    MODELS_GEMINI.forEach(model => candidates.push({ provider: "google", model, mode: "interactions" }));
  }
  if (env.AI) {
    MODELS_WORKERS_AI.forEach(model => candidates.push({ provider: "workers_ai", model, mode: "run" }));
  }

  // 直近で成功したモデルがあれば先頭に移動して爆速化
  if (lastWinner) {
    const idx = candidates.findIndex(
      c => c.provider === lastWinner.provider && c.model === lastWinner.model && c.mode === lastWinner.mode
    );
    if (idx > 0) {
      const [winner] = candidates.splice(idx, 1);
      candidates.unshift(winner);
    }
  }

  const errors = [];
  for (const task of candidates) {
    const res = await runSingleCandidate(env, task, prompt, maxTokens);
    if (res.ok) {
      lastWinner = task;
      return { parsed: res.data, modelUsed: `${task.provider}:${task.model}` };
    }
    if (res.fatal) throw new Error(res.error);
    errors.push(res.error);
  }

  throw new Error("すべてのAIモデルで失敗しました。\n" + errors.join("\n"));
}

function buildChunkPrompt(body, context, startDay, endDay, styleHint) {
  const { people, budgets, avoid, existing, previous, pantry, expiry } = context;
  const lightExisting = existing.slice(0, 30).map(r => `${r.name}(${r.category || ""})`).join("、");
  const lightPantry = pantry.slice(0, 25).map(p => `${p.name}${p.amount || ""}${p.unit || ""}`).join("、");

  return `日本の家庭料理の献立AIとして${people}人分の${startDay}日目〜${endDay}日目の献立を作成してください。
【1人1食予算】朝${budgets.breakfast}円/昼${budgets.lunch}円/夕${budgets.dinner}円（cost_for_4×${people}÷4で計算し予算厳守）
【各食必須】staple(主食),main(主菜),soup(汁物)各1品。予算余裕時のみside(副菜),kobachi(小鉢)を追加。
【献立の質】
・朝は15分以内（ご飯+味噌汁+卵/魚 または パン+スープ+卵など）
・昼夕の主菜は肉・魚・卵・豆腐が偏らないよう交互に変える
・和食・洋食・中華をバランスよく混ぜる
・${styleHint}
【在庫食材（優先使用）】${lightPantry || "特になし"}
【期限注意】${JSON.stringify(expiry)}
【登録レシピ候補】${lightExisting || "なし"}
【重複禁止】${previous.slice(0, 40).join("、") || "なし"}
【避ける条件】${avoid.join("、") || "なし"}
【使いたい食材】${body.wanted || "指定なし"}

stepsは短い2工程、ingredientsは主要4〜6点のみで簡潔に。JSONのみ返すこと。
形式:{"days":[{"day":${startDay},"meals":{"breakfast":[料理],"lunch":[料理],"dinner":[料理]}}]}
料理:{"course":"staple|main|side|soup|kobachi","name":"料理名","minutes":15,"cost_for_4":300,"ingredients":[{"name":"材料","amount":"4人分量"}],"steps":["手順1","手順2"]}`;
}

export default {
  async fetch(request, env) {
    const origin = request.headers.get("Origin") || "";

    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: { ...cors(origin), "Access-Control-Max-Age": "86400" }
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
        try { parsedUrl = new URL(recipeUrl); } catch (_) {
          return json({ error: "URLの形式が正しくありません。" }, 400, origin);
        }
        if (!["http:", "https:"].includes(parsedUrl.protocol)) {
          return json({ error: "このURLは読み込めません。" }, 400, origin);
        }

        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 10000);
        try {
          const page = await fetch(parsedUrl.toString(), {
            headers: { "User-Agent": "Mozilla/5.0", "Accept": "text/html" },
            signal: controller.signal
          });
          if (!page.ok) throw new Error("レシピページを取得できませんでした。");
          const html = await page.text();
          const scripts = [...html.matchAll(/<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)];

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
            const types = Array.isArray(value["@type"]) ? value["@type"] : [value["@type"]];
            if (types.some(t => String(t).toLowerCase() === "recipe")) return value;
            if (value["@graph"]) return findRecipe(value["@graph"]);
            return null;
          }
          for (const match of scripts) {
            try {
              recipe = findRecipe(JSON.parse(match[1]));
              if (recipe) break;
            } catch (_) {}
          }
          if (!recipe) return json({ error: "レシピ情報を見つけられませんでした。" }, 422, origin);

          const instructions = [];
          function collectSteps(v) {
            if (!v) return;
            if (typeof v === "string") instructions.push(v);
            else if (Array.isArray(v)) v.forEach(collectSteps);
            else if (typeof v === "object") {
              if (v.text) instructions.push(String(v.text));
              else if (v.name) instructions.push(String(v.name));
              if (v.itemListElement) collectSteps(v.itemListElement);
            }
          }
          collectSteps(recipe.recipeInstructions);

          return json({
            recipe: {
              name: recipe.name || "読み込んだレシピ",
              description: recipe.description || "",
              ingredients: safeArray(recipe.recipeIngredient, 100).map(item => ({ name: String(item), amount: "" })),
              steps: instructions,
              source_url: parsedUrl.toString(),
              minutes: recipe.totalTime || "",
              image: Array.isArray(recipe.image) ? recipe.image[0] : (typeof recipe.image === "string" ? recipe.image : recipe.image?.url || "")
            }
          }, 200, origin);
        } finally {
          clearTimeout(timer);
        }
      }

      if (!env.GEMINI_API_KEY && !env.GROQ_API_KEY && !env.AI) {
        return json({ error: "AIキーまたはWorkers AIが設定されていません。" }, 500, origin);
      }

      const days = Math.min(7, Math.max(1, Number(body.days) || 7));
      const people = Math.min(40, Math.max(1, Number(body.people) || 4));
      const budgets = {
        breakfast: Math.max(0, Number(body.budgets?.breakfast) || 0),
        lunch: Math.max(0, Number(body.budgets?.lunch) || 0),
        dinner: Math.max(0, Number(body.budgets?.dinner) || 0)
      };

      const context = {
        days,
        people,
        budgets,
        avoid: safeArray(body.avoid, 50),
        existing: safeArray(body.existing, 40),
        previous: safeArray(body.previous, 60),
        pantry: safeArray(body.pantry, 40),
        expiry: body.expiry && typeof body.expiry === "object" ? body.expiry : {}
      };

      let week = [];
      let modelUsed = "";

      if (days <= 3) {
        const prompt = buildChunkPrompt(body, context, 1, days, "和洋中バランスよく。");
        const res = await callAI(env, prompt, 7000);
        week = normalizeChunk(res.parsed, 1, days);
        modelUsed = res.modelUsed;
      } else {
        const mid = Math.ceil(days / 2);
        const prompt1 = buildChunkPrompt(body, context, 1, mid, "和食・鶏肉・白身魚・麺類を中心に。");
        const prompt2 = buildChunkPrompt(body, context, mid + 1, days, "洋食・中華・豚肉・青魚・ひき肉料理を中心に。");

        const [res1, res2] = await Promise.all([
          callAI(env, prompt1, 7500),
          callAI(env, prompt2, 7500)
        ]);

        week = [
          ...normalizeChunk(res1.parsed, 1, mid),
          ...normalizeChunk(res2.parsed, mid + 1, days)
        ];
        modelUsed = res1.modelUsed;
      }

      for (const row of week) {
        for (const mealName of ["breakfast", "lunch", "dinner"]) {
          const checked = checkMeal(row.meals[mealName], people, budgets[mealName]);
          if (!checked.valid) {
            throw new Error(row.day + "日目の" + mealName + "に主食・主菜・汁物がそろっていません。");
          }
          row.meals[mealName] = checked.dishes;
        }
      }

      return json({
        days: week,
        meta: { days, people, modelUsed }
      }, 200, origin);

    } catch (error) {
      return json({ error: error.message || "献立の作成に失敗しました。" }, 500, origin);
    }
  }
};
