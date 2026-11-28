/**
 * うちのごはん - Cloudflare Worker 完成版
 * 最速AIレース高速化・テーマ統一・夕飯パン/飲み物ブロック・詳しい4工程作り方・予算厳守
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

const STAPLE_RE = /(ご飯|ごはん|白米|雑穀|玄米|むすび|おにぎり|パン|トースト|クロワッサン|ベーグル|ロールパン|バゲット|サンドイッチ|ホットケーキ|パンケーキ|うどん|そば|蕎麦|パスタ|スパゲティ|麺|ラーメン|チャーハン|炒飯|ピラフ|ドリア|雑炊|おかゆ|丼|カレーライス|オムライス|焼きそば|そうめん)/;
const SOUP_RE = /(汁|スープ|みそ汁|味噌汁|豚汁|けんちん|ポタージュ|チャウダー|吸い物|すまし)/;
const DRINK_RE = /^(牛乳|ミルク|豆乳|コーヒー|紅茶|お茶|緑茶|麦茶|ジュース|オレンジジュース|カフェオレ|ヨーグルト|飲むヨーグルト|ホットミルク)$/;
const PAN_ONIGIRI_RE = /(パン|トースト|クロワッサン|ベーグル|ロールパン|バゲット|サンドイッチ|むすび|おにぎり|そうめん)/;
const MAIN_RE = /(ハンバーグ|唐揚げ|から揚げ|からあげ|照り焼き|生姜焼き|焼き鮭|塩焼き|煮付け|味噌煮|ホイル焼き|ムニエル|ステーキ|ソテー|カツ|フライ|天ぷら|肉じゃが|麻婆|炒め|回鍋肉|青椒肉絲|酢豚|餃子|焼売|オムレツ|卵焼き|だし巻き|目玉焼き|ハムエッグ|納豆|焼肉|ロールキャベツ|シチュー|筑前煮|ぶり大根)/;

const SAVING_FALLBACK = {
  staple: [
    {
      course: "staple", name: "白ごはん（節約）", minutes: 5, cost_for_4: 140,
      ingredients: [{ name: "お米 2.5合", amount: "" }],
      steps: [
        "ボウルにお米を入れ最初の水はぬか臭を防ぐためすぐ捨てる。",
        "指を立て20回ほどやさしく研ぎ、水を換えて2〜3回すすぐ。",
        "目盛り通りの水を入れて30分浸水してから炊飯スイッチを押す。",
        "炊き上がったら10分蒸らして底からふんわりほぐす。"
      ],
      tip: "最初の水を素早く捨てることと30分浸水させることでふっくら甘く炊き上がります。", source_url: ""
    }
  ],
  main: [
    {
      course: "main", name: "もやしと卵のあんかけ炒め", minutes: 10, cost_for_4: 150,
      ingredients: [{ name: "もやし 1袋", amount: "" }, { name: "卵 3個", amount: "" }, { name: "醤油 大さじ1.5", amount: "" }, { name: "片栗粉 小さじ2", amount: "" }],
      steps: [
        "卵を溶きほぐし、小皿に水大さじ3・醤油・片栗粉を混ぜてあんを作る。",
        "フライパンに油を熱して中火でもやしを1分半ほど手早く炒め皿に盛る。",
        "溶き卵を半熟状にふんわり焼いて、炒めたもやしの上に乗せる。",
        "あんを弱めの中火で混ぜながら30秒煮詰めてとろみをつけ、卵の上にかける。"
      ],
      tip: "もやしは炒めすぎないことと、あんは入れる直前にもう一度混ぜるのがダマにならないコツです。", source_url: ""
    },
    {
      course: "main", name: "豆腐ステーキ", minutes: 12, cost_for_4: 160,
      ingredients: [{ name: "木綿豆腐 2丁", amount: "" }, { name: "片栗粉 大さじ2", amount: "" }, { name: "醤油 大さじ2", amount: "" }, { name: "みりん 大さじ2", amount: "" }],
      steps: [
        "豆腐をキッチンペーパーで包み600Wで2分加熱し5分置いて水切りする。",
        "厚さ1.5cmに切り、崩れ防止に片栗粉を薄くまぶす。",
        "油をひいたフライパンで中火にかけ、触らずに3分ずつ両面に焼き色をつける。",
        "弱火にし、混ぜた醤油とみりんを回し入れて30秒ほどツヤよく絡める。"
      ],
      tip: "しっかり水切りして片栗粉をまぶすことで油はねを防ぎ外はカリッと中はふんわり仕上がります。", source_url: ""
    }
  ],
  soup: {
    "和食": {
      course: "soup", name: "もやしとねぎの味噌汁", minutes: 10, cost_for_4: 100,
      ingredients: [{ name: "もやし 1/2袋", amount: "" }, { name: "長ねぎ 1/3本", amount: "" }, { name: "だしの素 小さじ2", amount: "" }, { name: "味噌 大さじ3", amount: "" }],
      steps: [
        "もやしは水でさっと洗い、長ねぎは薄い小口切りにする。",
        "鍋に水800ml・だしの素・もやしを入れて中火で沸かし、弱めの中火で2分煮る。",
        "一度火を止め、お玉に味噌を取って汁で溶き入れる。",
        "刻んだ長ねぎを加えて弱火にかけ、沸騰する直前で火を止める。"
      ],
      tip: "味噌を入れたあとに沸騰させると風味が飛ぶため、必ず沸騰直前で火を止めましょう。", source_url: ""
    },
    "洋食": {
      course: "soup", name: "玉ねぎとキャベツのコンソメスープ", minutes: 10, cost_for_4: 110,
      ingredients: [{ name: "玉ねぎ 1/2個", amount: "" }, { name: "キャベツ 2枚", amount: "" }, { name: "固形コンソメ 2個", amount: "" }],
      steps: [
        "玉ねぎは薄切り、キャベツは食べやすい一口大に切る。",
        "鍋に少量の油を熱して野菜を中火で1分ほどさっと炒める。",
        "水800mlとコンソメを加えて沸騰したら弱火で5〜6分煮て野菜を柔らかくする。",
        "味を見て塩・黒こしょう少々で味を調える。"
      ],
      tip: "野菜を最初に軽く炒めてから煮ることで、お肉なしでも甘みとコクのあるスープになります。", source_url: ""
    },
    "中華": {
      course: "soup", name: "わかめとねぎの中華スープ", minutes: 5, cost_for_4: 80,
      ingredients: [{ name: "乾燥わかめ 大さじ1", amount: "" }, { name: "長ねぎ 1/3本", amount: "" }, { name: "鶏ガラスープの素 小さじ3", amount: "" }],
      steps: [
        "長ねぎは根元を落とし、端から2〜3mm幅の薄い小口切りにする。",
        "鍋に水800mlと鶏ガラスープの素を入れて中火で沸騰させる。",
        "弱火にして乾燥わかめと長ねぎを加え、1分ほど温めて火を止める。",
        "仕上げにごま油を2〜3滴垂らして香りを立てる。"
      ],
      tip: "乾燥わかめは湯に入れると大きく増えるため入れすぎないのがちょうど良いコツです。", source_url: ""
    }
  }
};

let lastWinner = null;

function resolveOrigin(origin) {
  if (!origin) return ALLOWED_ORIGINS[0];
  return ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
}
function cors(origin) {
  return { "Access-Control-Allow-Origin": resolveOrigin(origin), "Access-Control-Allow-Methods": "POST, OPTIONS", "Access-Control-Allow-Headers": "Content-Type, X-App-Code", "Vary": "Origin" };
}
function json(data, status, origin) {
  return new Response(JSON.stringify(data), { status, headers: { ...cors(origin), "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" } });
}
function extractText(data) {
  if (data.output_text) return data.output_text;
  const blocks = [];
  for (const step of (data.steps || [])) {
    if (step.type === "model_output") for (const c of (step.content || [])) if (c.type === "text" && c.text) blocks.push(c.text);
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
  try { return JSON.parse(cleaned.slice(s, e + 1).replace(/,\s*([}\]])/g, "$1")); }
  catch (_) { throw new Error("AIのJSONが途中で切れました。"); }
}
const safeParse = raw => { try { return JSON.parse(raw); } catch (_) { return { error: { message: String(raw || "").slice(0, 150) } }; } };
const safeArray = (v, max) => Array.isArray(v) ? v.slice(0, max) : [];
const clone = v => JSON.parse(JSON.stringify(v));
const costOf = (dishes, people) => dishes.reduce((s, d) => s + Math.round((Number(d.cost_for_4) || 0) * people / 4), 0);

function expandDish(raw) {
  if (!raw || typeof raw !== "object") return null;
  const name = String(raw.n ?? raw.name ?? "料理").trim();
  if (DRINK_RE.test(name)) return null; // 牛乳・お茶等の飲み物を除外

  let course = COURSE_ALIAS[String(raw.c ?? raw.course ?? "").trim().toLowerCase()] || COURSE_ALIAS[raw.course] || "";
  if (SOUP_RE.test(name)) course = "soup";
  else if (STAPLE_RE.test(name) && !/肉じゃが|生姜焼き|照り焼き/.test(name)) course = "staple";
  else if (MAIN_RE.test(name) && course === "staple") course = "main";
  else if (course === "staple" && !STAPLE_RE.test(name)) course = "main";

  const rawIng = Array.isArray(raw.i ?? raw.ingredients) ? (raw.i ?? raw.ingredients) : [];
  const ingredients = rawIng.map(x => typeof x === "string" ? { name: x, amount: "" } : { name: String(x?.name || ""), amount: String(x?.amount || "") }).filter(x => x.name);
  const rawSteps = raw.s ?? raw.steps;
  const steps = Array.isArray(rawSteps) ? rawSteps.map(String) : (rawSteps ? [String(rawSteps)] : []);
  return {
    course, name,
    minutes: Number(raw.t ?? raw.minutes ?? 15) || 15,
    cost_for_4: Number(raw.p ?? raw.cost_for_4 ?? 200) || 0,
    ingredients, steps,
    tip: String(raw.k ?? raw.tip ?? ""),
    source_url: String(raw.source_url || "")
  };
}

function getFallbackSoup(theme) {
  if (theme === "洋食") return SAVING_FALLBACK.soup["洋食"];
  if (theme === "中華") return SAVING_FALLBACK.soup["中華"];
  return SAVING_FALLBACK.soup["和食"];
}

function checkMeal(inputDishes, people, perPersonBudget, dayNum = 1, mealName = "dinner", theme = "和食") {
  const byCourse = {};
  for (const d of inputDishes) {
    if (!d || !d.course) continue;
    // 夕食の主食にパン・おにぎり系が来たら強制除外して白ごはんへ
    if (mealName === "dinner" && d.course === "staple" && PAN_ONIGIRI_RE.test(d.name)) continue;
    if (!byCourse[d.course]) byCourse[d.course] = clone(d);
  }
  if (!byCourse.staple) byCourse.staple = clone(SAVING_FALLBACK.staple[0]);
  if (!byCourse.main) byCourse.main = clone(SAVING_FALLBACK.main[(dayNum - 1) % SAVING_FALLBACK.main.length]);
  if (!byCourse.soup) byCourse.soup = clone(getFallbackSoup(theme));

  const dishes = ["staple", "main", "side", "soup", "kobachi"].map(c => byCourse[c]).filter(Boolean);
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
    const fb = course === "soup"
      ? getFallbackSoup(theme)
      : SAVING_FALLBACK[course][(dayNum - 1) % SAVING_FALLBACK[course].length];
    if (idx >= 0 && fb && (Number(dishes[idx].cost_for_4) || 0) > fb.cost_for_4) {
      dishes[idx] = clone(fb);
    }
  }
  const valid = ["staple", "main", "soup"].every(c => dishes.some(d => d.course === c));
  return { dishes, valid };
}

function normalizeDays(parsed, days, fallbackTheme) {
  let rows = Array.isArray(parsed.days) ? parsed.days : null;
  if (!rows && (parsed.meals || parsed.b) && days === 1) rows = [parsed];
  if (!rows || rows.length < days) throw new Error(`AIから${days}日分の献立が返りませんでした。`);
  const out = [];
  for (let i = 0; i < days; i++) {
    const row = rows.find(x => Number(x.day) === i + 1) || rows[i];
    if (!row) throw new Error(`${i + 1}日目の献立がありません。`);
    const bRaw = row.meals?.breakfast || row.b || [], lRaw = row.meals?.lunch || row.l || [], dRaw = row.meals?.dinner || row.d || [];
    const dayTheme = String(row.theme || (fallbackTheme === "auto" ? ["和食", "洋食", "中華"][i % 3] : fallbackTheme));
    out.push({
      day: i + 1,
      theme: dayTheme,
      meals: {
        breakfast: bRaw.map(expandDish).filter(Boolean),
        lunch: lRaw.map(expandDish).filter(Boolean),
        dinner: dRaw.map(expandDish).filter(Boolean)
      }
    });
  }
  return out;
}

async function runSingleCandidate(env, task, prompt, maxTokens) {
  const { provider, model, mode } = task;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 16000); // 高速16秒タイムアウト
  try {
    if (provider === "groq" || provider === "mistral" || provider === "openrouter") {
      const urls = { groq: "https://api.groq.com/openai/v1/chat/completions", mistral: "https://api.mistral.ai/v1/chat/completions", openrouter: "https://openrouter.ai/api/v1/chat/completions" };
      const keys = { groq: env.GROQ_API_KEY, mistral: env.MISTRAL_API_KEY, openrouter: env.OPENROUTER_API_KEY };
      const headers = { "Content-Type": "application/json", "Authorization": "Bearer " + keys[provider] };
      if (provider === "openrouter") { headers["HTTP-Referer"] = ALLOWED_ORIGINS[0]; headers["X-Title"] = "Uchinogohan"; }
      const body = { model, messages: [{ role: "user", content: prompt }], temperature: 0.4, max_tokens: Math.min(maxTokens, 7500) };
      if (provider !== "openrouter") body.response_format = { type: "json_object" };
      const res = await fetch(urls[provider], { method: "POST", headers, body: JSON.stringify(body), signal: controller.signal });
      const data = safeParse(await res.text());
      const content = data?.choices?.[0]?.message?.content;
      if (res.ok && content) return { ok: true, data: parseJson(content) };
      return { ok: false, error: `${provider}(${model} ${res.status})：${data?.error?.message || data?.message || "失敗"}` };
    }
    if (provider === "workers_ai") {
      const result = await env.AI.run(model, { messages: [{ role: "user", content: prompt }], max_tokens: 4096, response_format: { type: "json_object" } });
      if (result?.response) return { ok: true, data: parseJson(result.response) };
      return { ok: false, error: `WorkersAI(${model})：空応答` };
    }
    if (provider === "google") {
      const url = mode === "interactions" ? "https://generativelanguage.googleapis.com/v1beta/interactions" : `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;
      const payload = mode === "interactions"
        ? { model, input: prompt, store: false, generation_config: { max_output_tokens: maxTokens, thinking_level: "low" } }
        : mode === "gemma"
          ? { contents: [{ parts: [{ text: prompt }] }], generationConfig: { maxOutputTokens: Math.min(maxTokens, 8192), temperature: 0.4 } }
          : { contents: [{ role: "user", parts: [{ text: prompt }] }], generationConfig: { maxOutputTokens: maxTokens, responseMimeType: "application/json", temperature: 0.4 } };
      const response = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json", "x-goog-api-key": env.GEMINI_API_KEY }, body: JSON.stringify(payload), signal: controller.signal });
      const raw = safeParse(await response.text());
      if (response.ok) {
        if (mode === "interactions" && raw.status !== "completed") return { ok: false, error: `${model}：${raw.status}` };
        if (mode !== "interactions" && raw.candidates?.[0]?.finishReason === "MAX_TOKENS") return { ok: false, error: `${model}：上限途切れ` };
        const text = extractText(raw);
        return text ? { ok: true, data: parseJson(text) } : { ok: false, error: `${model}：空応答` };
      }
      const st = response.status, msg = raw?.error?.message || ("HTTP " + st);
      if (st === 401 || st === 403) return { ok: false, fatal: true, error: "Gemini認証エラー：" + msg };
      return { ok: false, error: `${model}(${mode} ${st})：${msg}` };
    }
    return { ok: false, error: "未対応" };
  } catch (e) {
    return { ok: false, error: `${model}：${e.name === "AbortError" ? "タイムアウト" : e.message}` };
  } finally { clearTimeout(timeout); }
}

async function callAI(env, prompt, maxTokens) {
  const allCands = [];
  const raceStarters = [];

  if (env.GROQ_API_KEY) {
    raceStarters.push({ provider: "groq", model: MODELS_GROQ[0], mode: "chat" });
    MODELS_GROQ.slice(1).forEach(m => allCands.push({ provider: "groq", model: m, mode: "chat" }));
  }
  if (env.MISTRAL_API_KEY) {
    raceStarters.push({ provider: "mistral", model: MODELS_MISTRAL[0], mode: "chat" });
    MODELS_MISTRAL.slice(1).forEach(m => allCands.push({ provider: "mistral", model: m, mode: "chat" }));
  }
  if (env.OPENROUTER_API_KEY) {
    raceStarters.push({ provider: "openrouter", model: MODELS_OPENROUTER[0], mode: "chat" });
    MODELS_OPENROUTER.slice(1).forEach(m => allCands.push({ provider: "openrouter", model: m, mode: "chat" }));
  }
  if (env.AI) {
    raceStarters.push({ provider: "workers_ai", model: MODELS_WORKERS_AI[0], mode: "run" });
    MODELS_WORKERS_AI.slice(1).forEach(m => allCands.push({ provider: "workers_ai", model: m, mode: "run" }));
  }
  if (env.GEMINI_API_KEY) {
    raceStarters.push({ provider: "google", model: MODELS_GEMMA[0], mode: "gemma" });
    MODELS_GEMMA.slice(1).forEach(m => allCands.push({ provider: "google", model: m, mode: "gemma" }));
    MODELS_GEMINI.forEach(m => allCands.push({ provider: "google", model: m, mode: "generateContent" }));
  }

  // 1. 直近の勝者があれば最初に1回だけ試す（最速ルート）
  const errors = [];
  if (lastWinner) {
    const res = await runSingleCandidate(env, lastWinner, prompt, maxTokens);
    if (res.ok) return { parsed: res.data, modelUsed: `${lastWinner.provider}:${lastWinner.model}` };
    if (res.fatal) throw new Error(res.error);
    errors.push(res.error);
  }

  // 2. 未確定または前回勝者失敗時は、別プロバイダ最大3つを同時レース（最速勝ち抜き）
  const raceList = raceStarters.filter(t => !lastWinner || t.provider !== lastWinner.provider || t.model !== lastWinner.model).slice(0, 3);
  if (raceList.length > 0) {
    try {
      const winner = await Promise.any(raceList.map(async task => {
        const res = await runSingleCandidate(env, task, prompt, maxTokens);
        if (res.ok) return { parsed: res.data, task };
        throw new Error(res.error || "失敗");
      }));
      lastWinner = winner.task;
      return { parsed: winner.parsed, modelUsed: `${winner.task.provider}:${winner.task.model}` };
    } catch (aggErr) {
      if (Array.isArray(aggErr.errors)) aggErr.errors.forEach(e => errors.push(e.message));
    }
  }

  // 3. 予備モデルで順番にフォロー
  for (const task of allCands) {
    const res = await runSingleCandidate(env, task, prompt, maxTokens);
    if (res.ok) { lastWinner = task; return { parsed: res.data, modelUsed: `${task.provider}:${task.model}` }; }
    if (res.fatal) throw new Error(res.error);
    errors.push(res.error);
  }
  throw new Error("すべてのAIモデルで失敗しました。\n" + errors.join("\n"));
}

function buildCompactPrompt(body, context) {
  const { days, people, budgets, theme, avoid, existing, previous, pantry, expiry } = context;
  const max4B = Math.floor(budgets.breakfast * 4), max4L = Math.floor(budgets.lunch * 4), max4D = Math.floor(budgets.dinner * 4);
  const lightEx = existing.slice(0, 20).map(r => r.name).join("、"), lightPan = pantry.slice(0, 25).map(p => p.name).join("、");
  const themeInstruction = theme === "auto"
    ? "1日ごとに「和食」「洋食」「中華」のテーマを決め（例：1日目和食、2日目洋食、3日目中華）、各日の昼食・夕食は必ずその日のテーマで統一し、和洋中がチグハグに混ざらないようにしてください。各日のオブジェクトに \"theme\":\"和食\" 等を入れてください。"
    : `すべて【${theme}】のテーマで統一し、主食・主菜・汁物・副菜が【${theme}】でまとまるようにしてください。各日のオブジェクトに \"theme\":\"${theme}\" を入れてください。`;

  return `家庭料理AIとして${people}人分の${days}日間の献立を作成。
【4人分合計の予算上限(1円も超過禁止)】朝:${max4B}円以下/昼:${max4L}円以下/夕:${max4D}円以下(各料理のpの合計を必ずこの額以下にすること)
【テーマ統一・バランス（厳守）】
・${themeInstruction}
【各食必須・禁止事項（厳守）】
・c:"s"(主食)＝ご飯・おにぎり・パン・麺類のみ。クロワッサンやパン類を絶対にc:"m"(主菜)に入れないこと。
・夕食(d)の主食にパン・トースト・クロワッサン・おにぎり・サンドイッチは禁止！必ず温かいご飯・麺・丼等にすること。
・c:"m"(主菜)＝肉・魚・卵・豆腐のおかず1品
・c:"p"(汁物)＝味噌汁やスープ等のみ！牛乳・お茶・ジュース等の飲み物は絶対に入れないこと。
・予算余裕時のみc:"d"(副菜),c:"k"(小鉢)追加。朝は15分以内。
【初めて作る人にもわかりやすい作り方・コツ】
・s(作り方配列)は切り方・火加減・加熱時間(約○分)・仕上がりの目安まで書いた詳しい4工程前後にすること。
・k(ポイント・コツ)は失敗しないコツと美味しくなる理由を丁寧に1〜2文書くこと。
【在庫優先】${lightPan || "なし"}【期限注意】${JSON.stringify(expiry)}
【登録レシピ】${lightEx || "なし"}【重複禁止】${previous.slice(0, 35).join("、") || "なし"}
【避ける】${avoid.join("、") || "なし"}【使いたい】${body.wanted || "なし"}

以下のJSONのみ出力(Markdown不要):
{"days":[{"day":1,"theme":"和食","b":[料理],"l":[料理],"d":[料理]}]}
料理:{"c":"s|m|d|p|k","n":"料理名","t":15,"p":160,"i":["材料名 4人分量"],"s":["1. 下ごしらえ...","2. 火加減と加熱...","3. 味付け...","4. 仕上げ..."],"k":"失敗しないコツと理由"}`;
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
        let parsedUrl; try { parsedUrl = new URL(recipeUrl); } catch (_) { return json({ error: "URLの形式が正しくありません。" }, 400, origin); }
        if (!["http:", "https:"].includes(parsedUrl.protocol)) return json({ error: "このURLは読み込めません。" }, 400, origin);
        const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 10000);
        try {
          const page = await fetch(parsedUrl.toString(), { headers: { "User-Agent": "Mozilla/5.0", "Accept": "text/html" }, signal: controller.signal });
          if (!page.ok) throw new Error("ページを取得できませんでした。");
          const html = await page.text(), scripts = [...html.matchAll(/<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)];
          let recipe = null;
          const findR = v => { if (!v) return null; if (Array.isArray(v)) { for (const x of v) { const f = findR(x); if (f) return f; } } if (typeof v !== "object") return null; const t = Array.isArray(v["@type"]) ? v["@type"] : [v["@type"]]; if (t.some(x => String(x).toLowerCase() === "recipe")) return v; return v["@graph"] ? findR(v["@graph"]) : null; };
          for (const m of scripts) { try { recipe = findR(JSON.parse(m[1])); if (recipe) break; } catch (_) {} }
          if (!recipe) return json({ error: "レシピ情報を見つけられませんでした。" }, 422, origin);
          const steps = [];
          const col = v => { if (!v) return; if (typeof v === "string") steps.push(v); else if (Array.isArray(v)) v.forEach(col); else if (typeof v === "object") { if (v.text) steps.push(String(v.text)); else if (v.name) steps.push(String(v.name)); if (v.itemListElement) col(v.itemListElement); } };
          col(recipe.recipeInstructions);
          return json({ recipe: { name: recipe.name || "読み込んだレシピ", description: recipe.description || "", ingredients: safeArray(recipe.recipeIngredient, 100).map(x => ({ name: String(x), amount: "" })), steps, source_url: parsedUrl.toString(), minutes: recipe.totalTime || "", image: Array.isArray(recipe.image) ? recipe.image[0] : (typeof recipe.image === "string" ? recipe.image : recipe.image?.url || "") } }, 200, origin);
        } finally { clearTimeout(timer); }
      }

      if (!env.GEMINI_API_KEY && !env.GROQ_API_KEY && !env.MISTRAL_API_KEY && !env.OPENROUTER_API_KEY && !env.AI) {
        return json({ error: "AIキーまたはWorkers AIが設定されていません。" }, 500, origin);
      }
      const days = Math.min(7, Math.max(1, Number(body.days) || 7));
      const people = Math.min(40, Math.max(1, Number(body.people) || 4));
      const theme = String(body.theme || "auto");
      const budgets = { breakfast: Math.max(0, Number(body.budgets?.breakfast) || 0), lunch: Math.max(0, Number(body.budgets?.lunch) || 0), dinner: Math.max(0, Number(body.budgets?.dinner) || 0) };
      const context = { days, people, theme, budgets, avoid: safeArray(body.avoid, 40), existing: safeArray(body.existing, 30), previous: safeArray(body.previous, 50), pantry: safeArray(body.pantry, 35), expiry: body.expiry && typeof body.expiry === "object" ? body.expiry : {} };

      const prompt = buildCompactPrompt(body, context);
      const res = await callAI(env, prompt, 8000);
      const week = normalizeDays(res.parsed, days, theme);

      for (const row of week) {
        for (const mealName of ["breakfast", "lunch", "dinner"]) {
          const checked = checkMeal(row.meals[mealName], people, budgets[mealName], row.day, mealName, row.theme);
          if (!checked.valid) throw new Error(`${row.day}日目の${mealName}に必須品がありません。`);
          row.meals[mealName] = checked.dishes;
        }
      }
      return json({ days: week, meta: { days, people, theme, modelUsed: res.modelUsed } }, 200, origin);
    } catch (error) {
      return json({ error: error.message || "献立の作成に失敗しました。" }, 500, origin);
    }
  }
};
