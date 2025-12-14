export default async (req) => {
  try {
    if (req.method !== "POST") {
      return new Response("Method Not Allowed", { status: 405 });
    }

    const apiKey = process.env.GOOGLE_VISION_API_KEY;
    if (!apiKey) {
      return new Response(JSON.stringify({ error: "Missing GOOGLE_VISION_API_KEY" }), {
        status: 500,
        headers: { "Content-Type": "application/json" }
      });
    }

    const body = await req.json();
    const dataUrl = String(body?.image || "");
    const m = dataUrl.match(/^data:(image\/[a-zA-Z0-9.+-]+);base64,(.+)$/);
    if (!m) {
      return new Response(JSON.stringify({ error: "Invalid image data URL" }), {
        status: 400,
        headers: { "Content-Type": "application/json" }
      });
    }

    const base64 = m[2];

    // Google Vision TEXT_DETECTION
    const visionResp = await fetch(
      "https://vision.googleapis.com/v1/images:annotate?key=" + encodeURIComponent(apiKey),
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          requests: [{
            image: { content: base64 },
            features: [{ type: "TEXT_DETECTION" }]
          }]
        })
      }
    );

    if (!visionResp.ok) {
      const txt = await visionResp.text().catch(()=> "");
      return new Response(JSON.stringify({ error: "Vision HTTP " + visionResp.status, detail: txt.slice(0, 500) }), {
        status: 502,
        headers: { "Content-Type": "application/json" }
      });
    }

    const visionJson = await visionResp.json();
    const rawText =
      visionJson?.responses?.[0]?.fullTextAnnotation?.text ||
      visionJson?.responses?.[0]?.textAnnotations?.[0]?.description ||
      "";

    // Parse macros (molto conservativo)
    const norm = rawText
      .replace(/\r/g, "")
      .replace(/\t/g, " ")
      .replace(/ +/g, " ")
      .toLowerCase();

    // prova a isolare la sezione "per 100 g"
    let section = norm;
    const idx = norm.search(/per\s*100\s*g|per\s*100\s*gr|per\s*100\s*ml|per\s*100\s*m[l1]/);
    if (idx >= 0) section = norm.slice(idx, idx + 800);

    const num = (s) => {
      const mm = s.match(/(\d+(?:[.,]\d+)?)/);
      if (!mm) return null;
      const v = parseFloat(mm[1].replace(",", "."));
      return Number.isFinite(v) ? v : null;
    };

    const findNear = (labelRegex) => {
      const re = new RegExp(labelRegex.source + r".{0,40}(\d+(?:[.,]\d+)?)", "i");
      const mm = section.match(re) || norm.match(re);
      if (!mm) return null;
      const v = parseFloat(String(mm[1]).replace(",", "."));
      return Number.isFinite(v) ? v : null;
    };

    // keyword IT/EN
    const c = findNear(/carboidrati|carbohydrates|carbs/);
    const p = findNear(/proteine|protein/);
    const f = findNear(/grassi|fat/);
    const kcal = findNear(/kcal/);

    const per100 = {};
    if (c !== null) per100.c = c;
    if (p !== null) per100.p = p;
    if (f !== null) per100.f = f;
    if (kcal !== null) per100.kcalLabel = kcal;

    // confidence grezza: quante metriche ho trovato
    const found = ["c", "p", "f"].filter(k => per100[k] !== undefined).length;
    const confidence = found === 3 ? 0.9 : (found === 2 ? 0.6 : 0.3);

    // nameGuess: prima riga non vuota
    const nameGuess = rawText.split("\n").map(s => s.trim()).find(s => s.length >= 3) || "";

    return new Response(
      JSON.stringify({
        nameGuess,
        per100: found ? per100 : null,
        confidence,
        rawText: rawText.slice(0, 4000)
      }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );
  } catch (e) {
    return new Response(JSON.stringify({ error: String(e?.message || e) }), {
      status: 500,
      headers: { "Content-Type": "application/json" }
    });
  }
};
