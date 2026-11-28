/**
 * うちのごはん - Cloudflare Worker 完成版
 * 5種類の無料AI対応・コース自動補正・初心者向け詳しい作り方＆コツ生成・予算1円超過禁止
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

const STAPLE_RE = /(ご飯|ごはん|白米|雑穀|玄米|むすび|おにぎり|パン|トースト|うどん|そば|蕎麦|パスタ|スパゲティ|麺|ラーメン|チャーハン|炒飯|ピラフ|雑炊|おかゆ|丼|カレーライス|オムライス|焼きそば|そうめん)/;
const SOUP_RE = /(汁|スープ|みそ汁|味噌汁|豚汁|けんちん|ポタージュ|チャウダー|吸い物|すまし)/;
const MAIN_RE = /(ハンバーグ|唐揚げ|から揚げ|からあげ|照り焼き|生姜焼き|焼き鮭|塩焼き|煮付け|味噌煮|ホイル焼き|ムニエル|ステーキ|ソテー|カツ|フライ|天ぷら|肉じゃが|麻婆|炒め|回鍋肉|青椒肉絲|酢豚|餃子|焼売|オムレツ|卵焼き|だし巻き|目玉焼き|ハムエッグ|納豆|焼肉|ロールキャベツ|シチュー|筑前煮|ぶり大根)/;

const SAVING_FALLBACK = {
  staple: [
    {
      course: "staple", name: "白ごはん（節約）", minutes: 5, cost_for_4: 140,
      ingredients: [{ name: "お米 2.5合", amount: "" }],
      steps: [
        "ボウルまたは内釜にお米を入れ、たっぷりの水を注いで大きく2回混ぜたら、ぬかの臭いを吸わないよう最初の水はすぐに捨てる。",
        "水を切った状態で指を立てて20回ほどやさしくシャカシャカ研ぎ、水を入れて濁りを流す作業を2〜3回繰り返す。",
        "炊飯釜の目盛りに合わせて水を入れ、30分ほど浸水させてから炊飯スイッチを押す。",
        "炊き上がったら10分ほど蒸らし、しゃもじで十字に切れ目を入れて底からふんわりほぐす。"
      ],
      tip: "最初の水を素早く捨てることと、炊く前に30分浸水させることで安いお米でも芯が残らずふっくら甘く炊き上がります。", source_url: ""
    },
    {
      course: "staple", name: "塩むすび", minutes: 8, cost_for_4: 140,
      ingredients: [{ name: "お米 2合", amount: "" }, { name: "塩 少々", amount: "" }],
      steps: [
        "手を清潔に洗ったあと水でさっと濡らし、余分な水気を軽く払う（ご飯が手にくっつくのを防ぎます）。",
        "塩を1つまみ手のひら全体に薄くすり込むように広げる。",
        "お茶碗1杯分の温かいご飯を手のひらに乗せ、指をそろえて軽く包み込む。",
        "力を入れすぎず、くるっと向きを変えながら3〜4回やさしく握って三角形に整える。"
      ],
      tip: "ぎゅっと力を入れて握ると固くなります。表面だけ形作るようにやさしく握ると口の中でほろっとほどけるおにぎりになります。", source_url: ""
    }
  ],
  main: [
    {
      course: "main", name: "もやしと卵のあんかけ炒め", minutes: 10, cost_for_4: 150,
      ingredients: [{ name: "もやし 1袋", amount: "" }, { name: "卵 3個", amount: "" }, { name: "醤油 大さじ1.5", amount: "" }, { name: "片栗粉 小さじ2", amount: "" }],
      steps: [
        "卵はボウルに割り入れて溶きほぐす。小皿に水大さじ3・醤油・片栗粉を入れてよく混ぜ、あんの液を作っておく。",
        "フライパンに油大さじ1をひいて中火で温め、水洗いして水気を切ったもやしを入れて約1分〜1分半さっと炒め、塩こしょうを振ってお皿に盛る。",
        "同じフライパンに油を少し足して中火にかけ、溶き卵を流し入れる。フチが固まってきたら大きく2〜3回混ぜ、半熟トロトロで火を止めもやしの上に乗せる。",
        "空いたフライパンに混ぜておいた醤油あん（入れる直前に再度混ぜる）を入れ、弱めの中火で混ぜながらとろみがつくまで30秒加熱し卵の上にかける。"
      ],
      tip: "もやしは炒めすぎると水っぽくなるので1分程度で引き上げることと、あんは混ぜながら温めるのがダマにならないポイントです。", source_url: ""
    },
    {
      course: "main", name: "豆腐ステーキ", minutes: 12, cost_for_4: 160,
      ingredients: [{ name: "木綿豆腐 2丁", amount: "" }, { name: "片栗粉 大さじ2", amount: "" }, { name: "醤油 大さじ2", amount: "" }, { name: "みりん 大さじ2", amount: "" }],
      steps: [
        "木綿豆腐をキッチンペーパー2枚で包み、耐熱皿に乗せてラップをせず600Wの電子レンジで2分加熱し、そのまま5分置いてしっかり水切りをする。",
        "粗熱が取れたら横半分・厚さ1.5cmほどに切り、全体に片栗粉を薄くまぶす。小皿に醤油とみりんを混ぜておく。",
        "フライパンに油大さじ1をひいて中火にかけ豆腐を並べる。最初の3分間は崩れやすいので触らずに焼き、焼き目がついたら裏返して反対側も3分焼く。",
        "弱火に落とし、混ぜた醤油とみりんをフチから回し入れ、スプーンで煮汁を豆腐にかけながら30秒ほどツヤよく絡める。"
      ],
      tip: "しっかり水切りをして片栗粉をまぶすことで油はねを防ぎ、外はカリッと中はふんわり・たれがよく絡む仕上がりになります。", source_url: ""
    }
  ],
  soup: [
    {
      course: "soup", name: "わかめとねぎのスープ", minutes: 5, cost_for_4: 80,
      ingredients: [{ name: "乾燥わかめ 大さじ1", amount: "" }, { name: "長ねぎ 1/3本", amount: "" }, { name: "鶏ガラスープの素 小さじ3", amount: "" }],
      steps: [
        "長ねぎは根元を少し切り落とし、端から2〜3mm幅の薄い小口切りにしておく。",
        "鍋に水800mlと鶏ガラスープの素を入れて中火にかけ、全体がブクブク沸騰するまで温める。",
        "沸騰したら弱火にし、乾燥わかめ（戻さずそのままでOK）と刻んだ長ねぎを加えて1分ほど温め火を止める。",
        "味見をして薄ければ塩ひとつまみを足し、仕上げに香り付けのごま油を2〜3滴垂らして完成。"
      ],
      tip: "乾燥わかめは湯に入れると大きく膨らむので入れすぎないのがコツです。ねぎとごま油を最後に加えると香りが飛びません。", source_url: ""
    },
    {
      course: "soup", name: "もやしとねぎの味噌汁", minutes: 10, cost_for_4: 100,
      ingredients: [{ name: "もやし 1/2袋", amount: "" }, { name: "長ねぎ 1/3本", amount: "" }, { name: "だしの素 小さじ2", amount: "" }, { name: "味噌 大さじ3", amount: "" }],
      steps: [
        "もやしは水でさっと振り洗いして水気を切り、長ねぎは薄い小口切りにしておく。",
        "鍋に水800ml・だしの素・もやしを入れて中火にかけ、沸騰したら弱めの中火で2分ほど煮て火を通す。",
        "一度火を止め、お玉に味噌を取って鍋の汁を少し混ぜながらダマがなくなるまで溶かし入れる。",
        "刻んだ長ねぎを加えて弱火にかけ、お鍋のフチが小さくふつふつと動き始めた瞬間（沸騰直前）に火を止める。"
      ],
      tip: "味噌を入れたあとにグラグラ沸騰させると香りが飛んでしまうため、必ず沸騰直前で火を止めるのが美味しさの秘訣です。", source_url: ""
    }
  ]
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

function checkMeal(inputDishes, people, perPersonBudget, dayNum = 1) {
  const byCourse = {};
  for (const d of inputDishes) {
    if (!d.course) continue;
    if (!byCourse[d.course]) byCourse[d.course] = clone(d);
  }
  for (const req of ["staple", "main", "soup"]) {
    if (!byCourse[req]) {
      const list = SAVING_FALLBACK[req];
      byCourse[req] = clone(list[(dayNum - 1) % list.length]);
    }
  }
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
    const bRaw = row.meals?.breakfast || row.b || [], lRaw = row.meals?.lunch || row.l || [], dRaw = row.meals?.dinner || row.d || [];
    out.push({
      day: i + 1,
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
  const timeout = setTimeout(() => controller.abort(), 35000);
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
      if (st === 503 || st === 429) await new Promise(r => setTimeout(r, 150));
      return { ok: false, error: `${model}(${mode} ${st})：${msg}` };
    }
    return { ok: false, error: "未対応" };
  } catch (e) {
    return { ok: false, error: `${model}：${e.name === "AbortError" ? "タイムアウト" : e.message}` };
  } finally { clearTimeout(timeout); }
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
  const max4B = Math.floor(budgets.breakfast * 4), max4L = Math.floor(budgets.lunch * 4), max4D = Math.floor(budgets.dinner * 4);
  const lightEx = existing.slice(0, 20).map(r => r.name).join("、"), lightPan = pantry.slice(0, 25).map(p => p.name).join("、");

  return `家庭料理AIとして${people}人分の${days}日間の献立を作成。
【4人分合計の予算上限(1円も超過禁止)】朝:${max4B}円以下/昼:${max4L}円以下/夕:${max4D}円以下(各料理のpの合計を必ずこの額以下にすること)
【各食必須・分類厳守】
・c:"s"(主食)＝必ずご飯・おにぎり・パン・麺類のみ！ハンバーグやおかずを絶対に入れないこと。
・c:"m"(主菜)＝肉・魚・卵・豆腐のおかず1品
・c:"p"(汁物)＝味噌汁・スープ等1品
・予算余裕時のみc:"d"(副菜),c:"k"(小鉢)追加。朝は15分以内。
【初めて作る人にもわかりやすい作り方・コツ（超重要）】
・s(作り方配列)は料理初心者でも迷わず作れるよう「野菜の切り方と大きさ」「火加減（弱火/中火/強火）」「加熱時間（約○分）」「見た目の仕上がり目安（きつね色・しんなり等）」「調味料を加える順番」まで詳しく書いた4工程前後にしてください。
・k(ポイント・コツ)は、初心者向けに「失敗しないポイントとなぜそうすると美味しくなるのか」を2文程度で丁寧に必ず書いてください。
【在庫優先】${lightPan || "なし"}【期限注意】${JSON.stringify(expiry)}
【登録レシピ】${lightEx || "なし"}【重複禁止】${previous.slice(0, 35).join("、") || "なし"}
【避ける】${avoid.join("、") || "なし"}【使いたい】${body.wanted || "なし"}

以下のJSONのみ出力(Markdown不要):
{"days":[{"day":1,"b":[料理],"l":[料理],"d":[料理]}]}
料理:{"c":"s|m|d|p|k","n":"料理名","t":15,"p":160,"i":["材料名 4人分量"],"s":["1. 下ごしらえと切り方...","2. 火加減と加熱目安...","3. 味付けと仕上げ...","4. 盛り付け..."],"k":"失敗しないポイントと美味しくなる理由"}`;
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
      const budgets = { breakfast: Math.max(0, Number(body.budgets?.breakfast) || 0), lunch: Math.max(0, Number(body.budgets?.lunch) || 0), dinner: Math.max(0, Number(body.budgets?.dinner) || 0) };
      const context = { days, people, budgets, avoid: safeArray(body.avoid, 40), existing: safeArray(body.existing, 30), previous: safeArray(body.previous, 50), pantry: safeArray(body.pantry, 35), expiry: body.expiry && typeof body.expiry === "object" ? body.expiry : {} };

      const prompt = buildCompactPrompt(body, context);
      const res = await callAI(env, prompt, 8000);
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
