/**
 * うちのごはん - Cloudflare Worker
 * 7日分まとめて献立を作成する修正版
 */
const ALLOWED_ORIGIN = "https://kk611025.github.io";
const MODELS = ["gemini-3.5-flash-lite", "gemini-3.1-flash-lite"];

function cors(origin) {
  return {
    "Access-Control-Allow-Origin": ALLOWED_ORIGIN,
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

  return data.candidates?.[0]?.content?.parts
    ?.map(p => p.text || "").join("\n") || "";
}

function parseJson(text) {
  const cleaned = String(text || "")
    .replace(/```(?:json)?/gi, "")
    .trim();

  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");

  if (start < 0 || end <= start) {
    throw new Error(
      "AIの返答がJSON形式ではありません。出力が途中で切れた可能性があります。"
    );
  }

  try {
    return JSON.parse(cleaned.slice(start, end + 1));
  } catch (_) {
    throw new Error(
      "AIのJSONが途中で切れています。もう一度試してください。"
    );
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

  const valid = required.every(course =>
    dishes.some(d => d.course === course)
  );

  return {
    dishes,
    budget,
    allowedBudget,
    cost: totalCost(),
    valid
  };
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
    throw new Error(
      "AIから" + days + "日分の献立が返りませんでした。"
    );
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

async function callGemini(env, prompt, maxTokens) {
  let lastError = "AIとの通信に失敗しました。";
  for (let i = 0; i < MODELS.length; i++) {
    const model = MODELS[i];
    // 503の場合は最大1回だけ再試行
    for (let attempt = 0; attempt < 2; attempt++) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 90000);
      let response;
      let raw;
      try {
        response = await fetch(
          "https://generativelanguage.googleapis.com/v1beta/interactions",
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "x-goog-api-key": env.GEMINI_API_KEY
            },
            body: JSON.stringify({
              model,
              input: prompt,
              store: false,
              generation_config: {
                max_output_tokens: maxTokens,
                thinking_level: "low"
              }
            }),
            signal: controller.signal
          }
        );
        raw = await response.json();
      } catch (e) {
        lastError = e.name === "AbortError"
          ? "AIの応答が90秒以内に完了しませんでした。"
          : "AIとの通信に失敗しました。";
        if (e.name === "AbortError") {
          throw new Error(lastError);
        }
      } finally {
        clearTimeout(timeout);
      }
      if (response && response.ok) {
        if (raw.status !== "completed") {
          if (
            raw.status === "incomplete" ||
            raw.status === "budget_exceeded"
          ) {
            throw new Error(
              "AIの回答が途中で切れました。献立の量を減らすか、もう一度試してください。"
            );
          }
          throw new Error(
            "AIの処理が正常に完了しませんでした（" +
            (raw.status || "状態不明") + "）。"
          );
        }
        const text = extractText(raw);
        if (!text) {
          throw new Error("AIから文章が返りませんでした。");
        }
        return parseJson(text);
      }
      const status = response ? response.status : 0;
      lastError = raw?.error?.message ||
        ("AI APIエラー（HTTP " + status + "）");
      // 503だけ、1秒待って同じモデルを再試行
      if (status === 503 && attempt === 0) {
        await new Promise(resolve => setTimeout(resolve, 1000));
        continue;
      }
      // 認証・設定エラーは再試行しない
      if ([400, 401, 403].includes(status)) {
        throw new Error(lastError);
      }
      break;
    }
  }
  throw new Error(lastError);
}
function recipeRules() {
  return `
各食に主食(staple)・主菜(main)・汁物(soup)を各1品必ず含める。
予算内に収まる場合だけ副菜(side)、さらに余裕がある場合だけ小鉢(kobachi)を加える。
昼食・夕食の主菜は肉または魚。朝食の主菜は卵料理可。
副菜は野菜中心、小鉢はサラダ・酢の物・和え物など。
副菜と小鉢は似た料理にしない。

朝は簡単、昼は満足感、夕食は主菜と野菜のバランス重視。
和洋中韓エスニックを適度に混ぜる。
料理名の重複を避ける。
主食はご飯・パン・麺など、汁物は汁物にする。

各料理は4人分の材料量、cost_for_4（4人分の食材費・円）、
ingredients（材料名と分量）、steps（短い3工程程度）、
minutes、tip、source_urlを含める。

参考URLは渡された検索結果にあるURLだけを使い、
なければ空欄にする。
JSON以外の文章やMarkdownは返さない。

料理オブジェクト形式：
{"course":"staple","name":"料理名","category":"分類","minutes":15,"cost_for_4":300,"ingredients":[{"name":"材料","amount":"分量"}],"steps":["手順1","手順2","手順3"],"tip":"","source_url":""}
`;
}
function buildWeekPrompt(body, context) {
  const {
    days, people, budgets, avoid,
    existing, previous, pantry, expiry, searchResults
  } = context;

  return `
あなたは家庭料理に詳しい献立作成AIです。
${people}人分の${days}日間の献立を一括作成してください。

【1人あたり予算】
朝食：${budgets.breakfast}円
昼食：${budgets.lunch}円
夕食：${budgets.dinner}円

各食の総予算は1人あたり予算×${people}人です。
食材費はcost_for_4×人数÷4で計算してください。
1人50円までの超過は許容します。

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

【ネット検索結果】
${JSON.stringify(searchResults)}

【重要】
1日目から${days}日目まで、朝食・昼食・夕食をすべて作成してください。
合計${days * 3}食です。
各食に主食・主菜・汁物を必ず含めてください。
料理名を重複させないでください。
予算に無理がある場合は品数を減らしてください。
材料と作り方は簡潔にしてください。

必ず次の形式のJSONだけを返してください。

{
  "days": [
    {
      "day": 1,
      "meals": {
        "breakfast": [],
        "lunch": [],
        "dinner": []
      }
    }
  ]
}

dayの数字を2、3、4と進め、${days}日目まで必ず出力してください。
`;
}

function buildRetryPrompt(slots, context) {
  return `
あなたは食材費を抑える献立作成AIです。

【作り直す食事】
${JSON.stringify(slots)}

人数：${context.people}人

【1人あたり予算】
${JSON.stringify(context.budgets)}

総予算は1人あたり予算×人数です。
食材費はcost_for_4×人数÷4で計算してください。

${recipeRules()}

登録済みレシピ：
${JSON.stringify(context.existing)}

家にある食材：
${JSON.stringify(context.pantry)}

避けたい食材：
${JSON.stringify(context.avoid)}

対象の食事だけを作り直してください。
対象外の食事は空配列にしてください。
必ず主食・主菜・汁物を各1品入れてください。
予算に収まらない場合は副菜・小鉢を追加しないでください。

次のJSONだけを返してください。

{
  "days": [
    {
      "day": 1,
      "meals": {
        "breakfast": [],
        "lunch": [],
        "dinner": []
      }
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

    if (origin && origin !== ALLOWED_ORIGIN) {
      return json({ error: "許可されていない接続元です。" }, 403, origin);
    }

    if (request.method !== "POST") {
      return json({ error: "POSTで送信してください。" }, 405, origin);
    }

    try {
      const body = await request.json();

      const accessCode = request.headers.get("X-App-Code") ||
        body.accessCode ||
        "";

      if (!env.APP_ACCESS_CODE ||
          accessCode !== env.APP_ACCESS_CODE) {
        return json({ error: "接続コードが正しくありません。" }, 401, origin);
      }

      const url = new URL(request.url);

      // レシピ取り込み
      if (url.pathname.endsWith("/import")) {
        const recipeUrl = String(body.url || "").trim();

        if (!recipeUrl) {
          return json({ error: "レシピURLがありません。" }, 400, origin);
        }

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
            headers: {
              "User-Agent": "Mozilla/5.0",
              "Accept": "text/html"
            },
            signal: controller.signal
          });

          if (!page.ok) {
            throw new Error("レシピページを取得できませんでした。");
          }

          const html = await page.text();

          const scripts = [
            ...html.matchAll(
              /<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi
            )
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

            if (types.some(t =>
              String(t).toLowerCase() === "recipe"
            )) {
              return value;
            }

            if (value["@graph"]) {
              return findRecipe(value["@graph"]);
            }

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
            return json({
              error: "このページからレシピ情報を見つけられませんでした。"
            }, 422, origin);
          }

          const ingredients = safeArray(
            recipe.recipeIngredient, 100
          ).map(item => ({
            name: String(item),
            amount: ""
          }));

          const instructions = [];

          function collectSteps(value) {
            if (!value) return;

            if (typeof value === "string") {
              instructions.push(value);
              return;
            }

            if (Array.isArray(value)) {
              value.forEach(collectSteps);
              return;
            }

            if (typeof value === "object") {
              if (value.text) instructions.push(String(value.text));
              else if (value.name) instructions.push(String(value.name));

              if (value.itemListElement) {
                collectSteps(value.itemListElement);
              }
            }
          }

          collectSteps(recipe.recipeInstructions);

          const imported = {
            name: recipe.name || "読み込んだレシピ",
            description: recipe.description || "",
            ingredients,
            steps: instructions,
            source_url: parsedUrl.toString(),
            minutes: recipe.totalTime || "",
            image: Array.isArray(recipe.image)
              ? recipe.image[0]
              : (typeof recipe.image === "string"
                ? recipe.image
                : recipe.image?.url || "")
          };

          return json({ recipe: imported }, 200, origin);

        } finally {
          clearTimeout(timer);
        }
      }

      if (!env.GEMINI_API_KEY) {
        return json({
          error: "Gemini APIキーが設定されていません。"
        }, 500, origin);
      }

      const days = Math.min(
        7,
        Math.max(1, Number(body.days) || 7)
      );

      const people = Math.min(
        40,
        Math.max(1, Number(body.people) || 8)
      );

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
        existing: safeArray(body.existing, 200),
        previous: safeArray(body.previous, 200),
        pantry: safeArray(body.pantry, 100),
        expiry: body.expiry && typeof body.expiry === "object"
  ? body.expiry
  : {},
        searchResults: []
      };

      // ネット検索は短時間だけ試す
      const searchWords = [
        "家庭料理 節約 献立 レシピ",
        "簡単 朝食 昼食 夕食 レシピ"
      ];

      const searchController = new AbortController();
      const searchTimer = setTimeout(
        () => searchController.abort(),
        4500
      );

      try {
        const query = encodeURIComponent(searchWords.join(" "));
        const searchResponse = await fetch(
          "https://html.duckduckgo.com/html/?q=" + query,
          {
            headers: {
              "User-Agent": "Mozilla/5.0"
            },
            signal: searchController.signal
          }
        );

        if (searchResponse.ok) {
          const html = await searchResponse.text();

          context.searchResults = [
            ...html.matchAll(
              /class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi
            )
          ].slice(0, 8).map(match => ({
            url: match[1],
            title: match[2].replace(/<[^>]+>/g, "").trim()
          }));
        }
      } catch (_) {
        // 検索に失敗しても献立作成は続ける
      } finally {
        clearTimeout(searchTimer);
      }

      const prompt = buildWeekPrompt(body, context);
      const generated = await callGemini(
        env,
        prompt,
        16000
      );

      const week = normalizeDays(generated, days);
            // 21食（7日×3食）の予算を確認
      const overBudget = [];

      for (const row of week) {
        for (const mealName of ["breakfast", "lunch", "dinner"]) {
          const checked = checkMeal(
            row.meals[mealName],
            mealName,
            people,
            budgets[mealName]
          );

          row.meals[mealName] = checked.dishes;

          if (!checked.valid) {
            throw new Error(
              row.day + "日目の" + mealName +
              "に主食・主菜・汁物がそろっていません。"
            );
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

      // 予算オーバーの食事だけをまとめて1回作り直す
      if (overBudget.length > 0) {
        retryUsed = true;

        const retryPrompt = buildRetryPrompt(
          overBudget,
          context
        );

        const retryResult = await callGemini(
          env,
          retryPrompt,
          10000
        );

        const retryRows = Array.isArray(retryResult.days)
  ? retryResult.days
  : [];
        for (const slot of overBudget) {
  const retryRow = retryRows.find(
    row => Number(row.day) === slot.day
  );
          const candidate = retryRow?.meals?.[slot.meal];

          if (!Array.isArray(candidate)) continue;

          try {
            validateMeal(
              candidate,
              slot.day + "日目の" + slot.meal
            );

            const checked = checkMeal(
              candidate,
              slot.meal,
              people,
              budgets[slot.meal]
            );

            const originalDifference = Math.abs(
              slot.originalCost - slot.budget
            );

            const retryDifference = Math.abs(
              checked.cost - slot.budget
            );

            // 予算に近い方を採用する
            if (retryDifference < originalDifference) {
              week[slot.day - 1].meals[slot.meal] =
                checked.dishes;
            }
          } catch (_) {
            // 作り直しに失敗した食事は元の献立を残す
          }
        }
      }

      return json({
        days: week,
        meta: {
          days,
          people,
          retryUsed,
          retrySlots: overBudget.length
        }
      }, 200, origin);

    } catch (error) {
      return json({
        error: error.message || "献立の作成に失敗しました。"
      }, 500, origin);
    }
  }
};
