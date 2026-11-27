/**
 * うちのごはん - Cloudflare Worker
 * 超軽量JSON高速生成・最大7週間＆10人分対応・予算1円超過禁止版
 */
const ALLOWED_ORIGINS = ["https://kk611025.github.io"];

const MODELS_GROQ = ["openai/gpt-oss-120b", "qwen/qwen3.8-27b", "llama-3.1-8b-instant"];
const MODELS_MISTRAL = ["mistral-small-latest", "open-mistral-nemo"];
const MODELS_OPENROUTER = ["openrouter/free", "baidu/ernie-5.5-flash-preview:free", "google/gemma-4-26b-a4b-it:free"];
const MODELS_GEMMA = ["gemma-4-26b-a4b-it", "gemma-4-31b-it", "gemma-3-27b-it"];
const MODELS_GEMINI = ["gemini-3.5-flash-lite", "gemini-3.8-flash", "gemini-3.6-flash", "gemini-3.1-flash-lite"];
const MODELS_WORKERS_AI = ["@cf/meta/llama-3.3-70b-instruct-fp8-fast", "@cf/google/gemma-4-26b-a4b-it", "@cf/zai-org/glm-4.7-flash"];

const COURSE_ALIAS = {
  s: "staple", staple: "staple", "主食": "staple",
  m: "main", main: "main", "主菜": "main",
  d: "side", side: "side", "副菜": "side",
  p: "soup", soup: "soup", "汁物": "soup",
  k: "kobachi", kobachi: "kobachi", "小鉢": "kobachi"
};

const SAVING_FALLBACK = {
  staple: [
    { course: "staple", name: "白ごはん（節約）", minutes: 5, cost_for_4: 140, ingredients: [{ name: "米 2.5合", amount: "" }], steps: ["米を研いで炊く"], tip: "", source_url: "" },
    { course: "staple", name: "塩むすび", minutes: 8, cost_for_4: 140, ingredients: [{ name: "ご飯 4膳", amount: "" }, { name: "塩 少々", amount: "" }], steps: ["塩を付けて握る"], tip: "", source_url: "" }
  ],
  main: [
    { course: "main", name: "もやしと卵のあんかけ炒め", minutes: 10, cost_for_4: 150, ingredients: [{ name: "もやし 1袋", amount: "" }, { name: "卵 3個", amount: "" }, { name: "醤油 大さじ1.5", amount: "" }], steps: ["もやしを炒め卵でとじる", "醤油あんで調える"], tip: "", source_url: "" },
    { course: "main", name: "豆腐ステーキ", minutes: 12, cost_for_4: 160, ingredients: [{ name: "木綿豆腐 2丁", amount: "" }, { name: "醤油 大さじ2", amount: "" }, { name: "みりん 大さじ2", amount: "" }], steps: ["水切り豆腐を焼く", "醤油みりんを絡める"], tip: "", source_url: "" },
    { course: "main", name: "納豆とねぎの卵焼き", minutes: 10, cost_for_4: 180, ingredients: [{ name: "納豆 2パック", amount: "" }, { name: "卵 4個", amount: "" }], steps: ["混ぜて両面焼く"], tip: "", source_url: "" }
  ],
  soup: [
    { course: "soup", name: "わかめとねぎのスープ", minutes: 5, cost_for_4: 80, ingredients: [{ name: "乾燥わかめ 大さじ1", amount: "" }, { name: "鶏ガラ 小さじ3", amount: "" }], steps: ["湯に溶かして具を入れる"], tip: "", source_url: "" },
    { course: "soup", name: "もやしとねぎの味噌汁", minutes: 10, cost_for_4: 100, ingredients: [{ name: "もやし 1/2袋", amount: "" }, { name: "味噌 大さじ3", amount: "" }], steps: ["もやしを煮て味噌を溶く"], tip: "", source_url: "" }
  ]
};

let lastWinner = null;

function resolveOrigin(origin) {
  if (!origin) return ALLOWED_ORIGINS[0];
  return ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
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
    headers: { ...cors(origin), "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" }
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
  const ans = parts.filter(p => !p.thought && p.text);
  return (ans.length ? ans : parts).map(p => p.text || "").join("\n");
}
function parseJson(text) {
  if (text && typeof text === "object") return text;
  const cleaned = String(text || "").replace(/```(?:json)?/gi, "").trim();
  const s = cleaned.indexOf("{"), e = cleaned.lastIndexOf("}");
  if (s < 0 || e <= s) throw new Error("AIの返答がJSON形式ではありません。");
  try {
    return JSON.parse(cleaned.slice(s, e + 1).replace(/,\s*([}\]])/g, "$1"));
  } catch (_) {
    throw new Error("AIのJSONが途中で切れました。");
  }
}
function safeParse(raw) {
  try { return JSON.parse(raw); } catch (_) { return { error: { message: String(raw || "").slice(0, 150) } }; }
}
const safeArray = (v, max) => Array.isArray(v) ? v.slice(0, max) : [];
const clone = v => JSON.parse(JSON.stringify(v));
const costOf = (dishes, people) => dishes.reduce((s, d) => s + Math.round((Number(d.cost_for_4) || 0) * people / 4), 0);

function expandDish(raw) {
  if (!raw || typeof raw !== "object") return null;
  const cKey = String(raw.c ?? raw.course ?? "").trim().toLowerCase();
  const course = COURSE_ALIAS[cKey] || COURSE_ALIAS[raw.course] || "";
  const rawIng = Array.isArray(raw.i ?? raw.ingredients) ? (raw.i ?? raw.ingredients) : [];
  const ingredients = rawIng.map(x => typeof x === "string" ? { name: x, amount: "" } : { name: String(x?.name || ""), amount: String(x?.amount || "") }).filter(x => x.name);
  const rawSteps = raw.s ?? raw.steps;
  const steps = Array.isArray(rawSteps) ? rawSteps.map(String) : (rawSteps ? [String(rawSteps)] : []);
  return {
    course,
    name: String(raw.n ?? raw.name ?? "料理"),
    minutes: Number(raw.t ?? raw.minutes ?? 15) || 15,
    cost_for_4: Number(raw.p ?? raw.cost_for_4 ?? 200) || 0,
    ingredients,
    steps,
    tip: String(raw.tip || ""),
    source_url: String(raw.source_url || "")
  };
}

function checkMeal(inputDishes, people, perPersonBudget, dayNum = 1) {
  const dishes = clone(inputDishes);
  const budget = Math.max(0, Number(perPersonBudget) || 0) * people;
  const totalCost = () => costOf(dishes, people);

  for (const course of ["kobachi", "side"]) {
    if (totalCost() <= budget) break;
    const idx = dishes.findIndex(d => d.course === course);
    if (idx >= 0) dishes.splice(idx, 1);
  }
  for (const course of ["main", "staple", "soup"]) {
    if (totalCost() <= budget) break;
    const idx = dishes.findIndex(d => d.course === course);
    const list = SAVING_FALLBACK[course] || [];
    if (idx >= 0 && list.length) {
      const fb = list[(dayNum - 1) % list.length];
      if ((Number(dishes[idx].cost_for_4) || 0) > fb.cost_for_4) dishes[idx] = clone(fb);
    }
  }
  const valid = ["staple", "main", "soup"].every(c => dishes.some(d => d.course === c));
  return { dishes, valid };
}

function normalizeDays(parsed, days) {
  let rows = Array.isArray(parsed.days) ? parsed.days : null;
  if (!rows && (parsed.meals || parsed.b) && days === 1) rows = [parsed];
  if (!rows || rows.length < days) throw new Error(`AIから${days}日分の献立が返りませんでした。`);

  const out = [];
  for (let i = 0; i < days; i++) {
    const row = rows.find(x => Number(x.day) === i + 1) || rows[i];
    if (!row) throw new Error(`${i + 1}日目の献立がありません。`);
    const bRaw = row.meals?.breakfast || row.b || [];
    const lRaw = row.meals?.lunch || row.l || [];
    const dRaw = row.meals?.dinner || row.d || [];
    const meals = {
      breakfast: bRaw.map(expandDish).filter(Boolean),
      lunch: lRaw.map(expandDish).filter(Boolean),
      dinner: dRaw.map(expandDish).filter(Boolean)
    };
    for (const [slot, arr] of Object.entries(meals)) {
      for (const req of ["staple", "main", "soup"]) {
        if (!arr.some(x => x.course === req)) throw new Error(`${i + 1}日目の${slot}に必須料理(${req})がありません。`);
      }
    }
    out.push({ day: i + 1, meals });
  }
  return out;
}

async function runSingleCandidate(env, task, prompt, maxTokens) {
  const { provider, model, mode } = task;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 35000);

  try {
    if (provider === "groq" || provider === "mistral" || provider === "openrouter") {
      const urls = {
        groq: "https://api.groq.com/openai/v1/chat/completions",
        mistral: "https://api.mistral.ai/v1/chat/completions",
        openrouter: "https://openrouter.ai/api/v1/chat/completions"
      };
      const keys = { groq: env.GROQ_API_KEY, mistral: env.MISTRAL_API_KEY, openrouter: env.OPENROUTER_API_KEY };
      const headers = { "Content-Type": "application/json", "Authorization": "Bearer " + keys[provider] };
      if (provider === "openrouter") {
        headers["HTTP-Referer"] = ALLOWED_ORIGINS[0];
        headers["X-Title"] = "Uchinogohan";
      }
      const body = { model, messages: [{ role: "user", content: prompt }], temperature: 0.4, max_tokens: Math.min(maxTokens, 6500) };
      if (provider !== "openrouter") body.response_format = { type: "json_object" };

      const res = await fetch(urls[provider], { method: "POST", headers, body: JSON.stringify(body), signal: controller.signal });
      const data = safeParse(await res.text());
      const content = data?.choices?.[0]?.message?.content;
      if (res.ok && content) return { ok: true, data: parseJson(content) };
      return { ok: false, error: `${provider}(${model} ${res.status})：${data?.error?.message || data?.message || "失敗"}` };
    }

    if (provider === "workers_ai") {
      const result = await env.AI.run(model, {
        messages: [{ role: "user", content: prompt }],
        max_tokens: 4096,
        response_format: { type: "json_object" }
      });
      if (result?.response) return { ok: true, data: parseJson(result.response) };
      return { ok: false, error: `WorkersAI(${model})：空応答` };
    }

    if (provider === "google") {
      const url = mode === "interactions"
        ? "https://generativelanguage.googleapis.com/v1beta/interactions"
        : `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;
      const payload = mode === "interactions"
        ? { model, input: prompt, store: false, generation_config: { max_output_tokens: maxTokens, thinking_level: "low" } }
        : mode === "gemma"
          ? { contents: [{ parts: [{ text: prompt }] }], generationConfig: { maxOutputTokens: Math.min(maxTokens, 8192), temperature: 0.4 } }
          : { contents: [{ role: "user", parts: [{ text: prompt }] }], generationConfig: { maxOutputTokens: maxTokens, responseMimeType: "application/json", temperature: 0.4 } };

      const response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-goog-api-key": env.GEMINI_API_KEY },
        body: JSON.stringify(payload),
        signal: controller.signal
      });
      const raw = safeParse(await response.text());
      if (response.ok) {
        if (mode === "interactions" && raw.status !== "completed") return { ok: false, error: `${model}：${raw.status}` };
        if (mode !== "interactions" && raw.candidates?.[0]?.finishReason === "MAX_TOKENS") return { ok: false, error: `${model}：上限途切れ` };
        const text = extractText(raw);
        return text ? { ok: true, data: parseJson(text) } : { ok: false, error: `${model}：空応答` };
      }
      const st = response.status, msg = raw?.error?.message || ("HTTP " + st);
      if (st === 401 || st === 403) return { ok: false, fatal: true, error: "Gemini認証エラー：" + msg };
      if (st === 503 || st === 429) await new Promise(r => setTimeout(r, 150));
      return { ok: false, error: `${model}(${mode} ${st})：${msg}` };
    }
    return { ok: false, error: "未対応" };
  } catch (e) {
    return { ok: false, error: `${model}：${e.name === "AbortError" ? "タイムアウト" : e.message}` };
  } finally {
    clearTimeout(timeout);
  }
}

async function callAI(env, prompt, maxTokens) {
  const cands = [];
  if (env.GROQ_API_KEY) MODELS_GROQ.forEach(m => cands.push({ provider: "groq", model: m, mode: "chat" }));
  if (env.MISTRAL_API_KEY) MODELS_MISTRAL.forEach(m => cands.push({ provider: "mistral", model: m, mode: "chat" }));
  if (env.OPENROUTER_API_KEY) MODELS_OPENROUTER.forEach(m => cands.push({ provider: "openrouter", model: m, mode: "chat" }));
  if (env.GEMINI_API_KEY) {
    MODELS_GEMMA.forEach(m => cands.push({ provider: "google", model: m, mode: "gemma" }));
    MODELS_GEMINI.forEach(m => cands.push({ provider: "google", model: m, mode: "generateContent" }));
    MODELS_GEMINI.slice(0, 2).forEach(m => cands.push({ provider: "google", model: m, mode: "interactions" }));
  }
  if (env.AI) MODELS_WORKERS_AI.forEach(m => cands.push({ provider: "workers_ai", model: m, mode: "run" }));

  if (lastWinner) {
    const idx = cands.findIndex(c => c.provider === lastWinner.provider && c.model === lastWinner.model && c.mode === lastWinner.mode);
    if (idx > 0) { const [w] = cands.splice(idx, 1); cands.unshift(w); }
  }
  const errors = [];
  for (const task of cands) {
    const res = await runSingleCandidate(env, task, prompt, maxTokens);
    if (res.ok) { lastWinner = task; return { parsed: res.data, modelUsed: `${task.provider}:${task.model}` }; }
    if (res.fatal) throw new Error(res.error);
    errors.push(res.error);
  }
  throw new Error("すべてのAIモデルで失敗しました。\n" + errors.join("\n"));
}

function buildCompactPrompt(body, context) {
  const { days, people, budgets, avoid, existing, previous, pantry, expiry } = context;
  const max4B = Math.floor(budgets.breakfast * 4);
  const max4L = Math.floor(budgets.lunch * 4);
  const max4D = Math.floor(budgets.dinner * 4);
  const lightEx = existing.slice(0, 20).map(r => r.name).join("、");
  const lightPan = pantry.slice(0, 25).map(p => p.name).join("、");

  return `家庭料理AIとして${people}人分の${days}日間の献立を作成。
【4人分合計の予算上限(1円も超過禁止)】朝:${max4B}円以下/昼:${max4L}円以下/夕:${max4D}円以下(各料理のpの合計を必ずこの額以下にすること)
【各食必須】c:"s"(主食),c:"m"(主菜),c:"p"(汁物)各1品。予算余裕時のみc:"d"(副菜),c:"k"(小鉢)追加。朝は15分以内。昼夕の主菜は肉魚卵豆腐をバランス良く。
【子ども優先】子どもが喜んで食べる味付け（甘辛・照り焼き・バター醤油・ケチャップ・マヨ・チーズ・カレー風味等）や人気家庭料理（ハンバーグ・から揚げ・オムライス・肉じゃが・鮭バター・コーンスープ等）を優先。激辛・苦味・クセの強い大人向け料理は避けること。
【在庫優先】${lightPan || "なし"}【期限注意】${JSON.stringify(expiry)}
【登録レシピ】${lightEx || "なし"}【重複禁止】${previous.slice(0, 35).join("、") || "なし"}
【避ける】${avoid.join("、") || "なし"}【使いたい】${body.wanted || "なし"}

以下の超短縮JSONのみ出力(Markdown不要):
{"days":[{"day":1,"b":[料理],"l":[料理],"d":[料理]}]}
料理形式:{"c":"s|m|d|p|k","n":"料理名","t":15,"p":160,"i":["材料1 4人分量","材料2 量"],"s":["手順1","手順2"]}`;
}

export default {
  async fetch(request, env) {
    const origin = request.headers.get("Origin") || "";
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: { ...cors(origin), "Access-Control-Max-Age": "86400" } });
    if (origin && !ALLOWED_ORIGINS.includes(origin)) return json({ error: "許可されていない接続元です。" }, 403, origin);
    if (request.method !== "POST") return json({ error: "POSTで送信してください。" }, 405, origin);

    try {
      const body = await request.json();
      const accessCode = request.headers.get("X-App-Code") || body.accessCode || "";
      if (!env.APP_ACCESS_CODE || accessCode !== env.APP_ACCESS_CODE) return json({ error: "接続コードが正しくありません。" }, 401, origin);

      const url = new URL(request.url);
      if (url.pathname.endsWith("/import")) {
        const recipeUrl = String(body.url || "").trim();
        if (!recipeUrl) return json({ error: "レシピURLがありません。" }, 400, origin);
        let parsedUrl;
        try { parsedUrl = new URL(recipeUrl); } catch (_) { return json({ error: "URLの形式が正しくありません。" }, 400, origin); }
        if (!["http:", "https:"].includes(parsedUrl.protocol)) return json({ error: "このURLは読み込めません。" }, 400, origin);

        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 10000);
        try {
          const page = await fetch(parsedUrl.toString(), { headers: { "User-Agent": "Mozilla/5.0", "Accept": "text/html" }, signal: controller.signal });
          if (!page.ok) throw new Error("ページを取得できませんでした。");
          const html = await page.text();
          const scripts = [...html.matchAll(/<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)];
          let recipe = null;
          const findR = v => {
            if (!v) return null;
            if (Array.isArray(v)) { for (const x of v) { const f = findR(x); if (f) return f; } }
            if (typeof v !== "object") return null;
            const t = Array.isArray(v["@type"]) ? v["@type"] : [v["@type"]];
            if (t.some(x => String(x).toLowerCase() === "recipe")) return v;
            return v["@graph"] ? findR(v["@graph"]) : null;
          };
          for (const m of scripts) { try { recipe = findR(JSON.parse(m[1])); if (recipe) break; } catch (_) {} }
          if (!recipe) return json({ error: "レシピ情報を見つけられませんでした。" }, 422, origin);
          const steps = [];
          const col = v => { if (!v) return; if (typeof v === "string") steps.push(v); else if (Array.isArray(v)) v.forEach(col); else if (typeof v === "object") { if (v.text) steps.push(String(v.text)); else if (v.name) steps.push(String(v.name)); if (v.itemListElement) col(v.itemListElement); } };
          col(recipe.recipeInstructions);
          return json({
            recipe: {
              name: recipe.name || "読み込んだレシピ", description: recipe.description || "",
              ingredients: safeArray(recipe.recipeIngredient, 100).map(x => ({ name: String(x), amount: "" })),
              steps, source_url: parsedUrl.toString(), minutes: recipe.totalTime || "",
              image: Array.isArray(recipe.image) ? recipe.image[0] : (typeof recipe.image === "string" ? recipe.image : recipe.image?.url || "")
            }
          }, 200, origin);
        } finally { clearTimeout(timer); }
      }

      if (!env.GEMINI_API_KEY && !env.GROQ_API_KEY && !env.MISTRAL_API_KEY && !env.OPENROUTER_API_KEY && !env.AI) {
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
        days, people, budgets,
        avoid: safeArray(body.avoid, 40),
        existing: safeArray(body.existing, 30),
        previous: safeArray(body.previous, 50),
        pantry: safeArray(body.pantry, 35),
        expiry: body.expiry && typeof body.expiry === "object" ? body.expiry : {}
      };

      const prompt = buildCompactPrompt(body, context);
      const res = await callAI(env, prompt, 7500);
      const week = normalizeDays(res.parsed, days);

      for (const row of week) {
        for (const mealName of ["breakfast", "lunch", "dinner"]) {
          const checked = checkMeal(row.meals[mealName], people, budgets[mealName], row.day);
          if (!checked.valid) throw new Error(`${row.day}日目の${mealName}に必須品がありません。`);
          row.meals[mealName] = checked.dishes;
        }
      }

      return json({ days: week, meta: { days, people, modelUsed: res.modelUsed } }, 200, origin);
    } catch (error) {
      return json({ error: error.message || "献立の作成に失敗しました。" }, 500, origin);
    }
  }
};
