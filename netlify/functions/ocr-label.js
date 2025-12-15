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
    // PARSE MACROS (robusto)
    // -----------------------------
    const normRaw = rawText || "";
    const norm = normRaw
      .replace(/\r/g, "")
      .replace(/\t/g, " ")
      .replace(/[ ]+/g, " ")
      .toLowerCase();

    // isolamento "per 100 g" (finestra ampia)
    let section = norm;
    const idx = norm.search(/per\s*100\s*g|per\s*100\s*gr|per\s*100\s*ml|per\s*100\s*m[l1]/);
    if (idx >= 0) section = norm.slice(idx, idx + 1400);

    // linee originali (non solo section) perché OCR a volte mette "per 100g" in mezzo
    const linesAll = normRaw
      .split("\n")
      .map(s => s.trim().toLowerCase())
      .filter(Boolean);

    // linee della section (se trovata), altrimenti tutte
    const lines = (idx >= 0 ? section.split("\n") : linesAll)
      .map(s => String(s).trim().toLowerCase())
      .filter(Boolean);

    const flatSection = section.replace(/\s+/g, " ");
    const flatNorm = norm.replace(/\s+/g, " ");

    const toNum = (s) => {
      const mm = String(s || "").match(/(\d+(?:[.,]\d+)?)/);
      if (!mm) return null;
      const v = parseFloat(mm[1].replace(",", "."));
      return Number.isFinite(v) ? v : null;
    };

    // regole anti-fregatura (sotto-voci)
    const isSubRow = (ln) => {
      // "di cui ..." / "of which ..." / simili
      return /\bdi\s*cui\b|\bof\s*which\b/.test(ln);
    };

    // Cerca valore macro con 3 strategie:
    // 1) stessa riga
    // 2) entro 160 caratteri (anche con separazioni strane)
    // 3) riga successiva (caso tabellare OCR)
    const findValue = (labelRegex, opts = {}) => {
      const avoidIf = opts.avoidIf || null; // regex che se presente nella riga, la salta (es. zuccheri, saturi)

      // 1) stesso rigo
      const re1 = new RegExp(`${labelRegex.source}\\s*[:]?\\s*(\\d+(?:[.,]\\d+)?)`, "i");
      let mm = flatSection.match(re1) || flatNorm.match(re1);
      if (mm) return toNum(mm[1]);

      // 2) vicino (più ampio)
      const re2 = new RegExp(`${labelRegex.source}[\\s\\S]{0,160}?(\\d+(?:[.,]\\d+)?)`, "i");
      mm = section.match(re2) || norm.match(re2);
      if (mm) return toNum(mm[1]);

      // 3) riga-per-riga + riga successiva
      for (let i = 0; i < lines.length; i++) {
        const ln = lines[i];

        if (isSubRow(ln)) continue; // non partire mai da una sotto-voce
        if (avoidIf && avoidIf.test(ln)) continue;

        if (labelRegex.test(ln)) {
          // se numero è già sulla riga
          const v1 = toNum(ln);
          if (v1 !== null) return v1;

          // altrimenti prova le prossime 2 righe (OCR a volte inserisce righe vuote o unità)
          for (let j = 1; j <= 2; j++) {
            if (i + j >= lines.length) break;
            const ln2 = lines[i + j];
            if (isSubRow(ln2)) break; // se finisci dentro "di cui", fermati
            if (avoidIf && avoidIf.test(ln2)) break;
            const v2 = toNum(ln2);
            if (v2 !== null) return v2;
          }
        }
      }

      return null;
    };

    // Macro (IT/EN)
    // Nota: per carbo/grassi evitiamo di prenderci "zuccheri" o "saturi"
    const c = findValue(/carboidrati|carbohydrates|carbs/, { avoidIf: /zuccheri|sugars/ });
    const p = findValue(/proteine|protein/);
    const f = findValue(/grassi|fat/, { avoidIf: /saturi|saturated/ });

    // kcal (molti OCR la spezzano in "Energia kcal" + "68.0 kcal")
    let kcal = findValue(/kcal/);
    if (kcal === null) {
      // fallback: trova "energia" vicino a "kcal"
      for (let i = 0; i < linesAll.length; i++) {
        const ln = linesAll[i];
        if (ln.includes("energia") && ln.includes("kcal")) {
          const v1 = toNum(ln);
          if (v1 !== null) { kcal = v1; break; }

          // prova riga successiva
          if (i + 1 < linesAll.length) {
            const v2 = toNum(linesAll[i + 1]);
            if (v2 !== null) { kcal = v2; break; }
          }
        }
      }
    }

    const per100 = {};
    if (c !== null) per100.c = c;
    if (p !== null) per100.p = p;
    if (f !== null) per100.f = f;
    if (kcal !== null) per100.kcalLabel = kcal;

    const found = ["c", "p", "f"].filter(k => per100[k] !== undefined).length;
    const confidence = (found === 3 ? 0.9 : (found === 2 ? 0.6 : 0.3)) + (per100.kcalLabel !== undefined ? 0.05 : 0);

    // nameGuess: prima riga utile (non "valori nutrizionali")
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
