exports.handler = async (event) => {
  try {
    if (event.httpMethod !== "POST") {
      return { statusCode: 405, body: "Method Not Allowed" };
    }

    const apiKey = process.env.GOOGLE_VISION_API_KEY;
    if (!apiKey) {
      return {
        statusCode: 500,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ error: "Missing GOOGLE_VISION_API_KEY" })
      };
    }

    const body = JSON.parse(event.body || "{}");
    const dataUrl = String(body?.image || "");
    const m = dataUrl.match(/^data:(image\/[a-zA-Z0-9.+-]+);base64,(.+)$/);
    if (!m) {
      return {
        statusCode: 400,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ error: "Invalid image data URL" })
      };
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
      const txt = await visionResp.text().catch(() => "");
      return {
        statusCode: 502,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          error: "Vision HTTP " + visionResp.status,
          detail: txt.slice(0, 500)
        })
      };
    }

    const visionJson = await visionResp.json();
    const rawText =
      visionJson?.responses?.[0]?.fullTextAnnotation?.text ||
      visionJson?.responses?.[0]?.textAnnotations?.[0]?.description ||
      "";

    // -----------------------------
    // PARSE MACROS (più robusto)
    // -----------------------------
    const normRaw = rawText || "";
    const norm = normRaw
      .replace(/\r/g, "")
      .replace(/\t/g, " ")
      .replace(/[ ]+/g, " ")
      .toLowerCase();

    // prova a isolare la sezione "per 100 g" (aumentiamo la finestra)
    let section = norm;
    const idx = norm.search(/per\s*100\s*g|per\s*100\s*gr|per\s*100\s*ml|per\s*100\s*m[l1]/);
    if (idx >= 0) section = norm.slice(idx, idx + 1200);

    const flatSection = section.replace(/\s+/g, " ");
    const flatNorm = norm.replace(/\s+/g, " ");
    const lines = normRaw
      .split("\n")
      .map(s => s.trim().toLowerCase())
      .filter(Boolean);

    const toNum = (s) => {
      const mm = String(s || "").match(/(\d+(?:[.,]\d+)?)/);
      if (!mm) return null;
      const v = parseFloat(mm[1].replace(",", "."));
      return Number.isFinite(v) ? v : null;
    };

    const findValue = (labelRegex) => {
      // 1) stesso rigo: "carboidrati 15,4" o "carboidrati: 15,4 g"
      const re1 = new RegExp(`${labelRegex.source}\\s*[:]?\\s*(\\d+(?:[.,]\\d+)?)`, "i");
      let mm = flatSection.match(re1) || flatNorm.match(re1);
      if (mm) return toNum(mm[1]);

      // 2) tabellare/colonne: label ... valore entro 120 char
      const re2 = new RegExp(`${labelRegex.source}[\\s\\S]{0,120}?(\\d+(?:[.,]\\d+)?)`, "i");
      mm = section.match(re2) || norm.match(re2);
      if (mm) return toNum(mm[1]);

      // 3) riga-per-riga: OCR che spezza colonne
      for (let i = 0; i < lines.length; i++) {
        const ln = lines[i];
        if (labelRegex.test(ln)) {
          const v1 = toNum(ln);
          if (v1 !== null) return v1;

          // a volte il numero è sulla riga dopo
          if (i + 1 < lines.length) {
            const v2 = toNum(lines[i + 1]);
            if (v2 !== null) return v2;
          }
        }
      }

      return null;
    };

    // keyword IT/EN (puoi estendere con FR/DE se vuoi)
    const c = findValue(/carboidrati|carbohydrates|carbs/);
    const p = findValue(/proteine|protein/);
    const f = findValue(/grassi|fat/);

    // kcal: spesso è "energia kcal 68" o "energia 68 kcal"
    let kcal = findValue(/kcal/);
    if (kcal === null) {
      for (const ln of lines) {
        if (ln.includes("energia") && ln.includes("kcal")) {
          const v = toNum(ln);
          if (v !== null) { kcal = v; break; }
        }
      }
    }

    const per100 = {};
    if (c !== null) per100.c = c;
    if (p !== null) per100.p = p;
    if (f !== null) per100.f = f;
    if (kcal !== null) per100.kcalLabel = kcal;

    // confidence grezza: quante metriche ho trovato
    const found = ["c", "p", "f"].filter(k => per100[k] !== undefined).length;
    const confidence = (found === 3 ? 0.9 : (found === 2 ? 0.6 : 0.3)) + (per100.kcalLabel !== undefined ? 0.05 : 0);

    // nameGuess: prima riga non vuota (ma ignora "valori nutrizionali")
    const nameGuess = rawText
      .split("\n")
      .map(s => s.trim())
      .find(s => s.length >= 3 && !/^valori nutrizionali$/i.test(s)) || "";

    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        nameGuess,
        per100: found ? per100 : null,
        confidence,
        rawText: rawText.slice(0, 4000)
      })
    };

  } catch (e) {
    return {
      statusCode: 500,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ error: String(e?.message || e) })
    };
  }
};
