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
    // PARSE
    // -----------------------------
    const raw = String(rawText || "");
    const norm = raw
      .replace(/\r/g, "")
      .replace(/\t/g, " ")
      .replace(/[ ]+/g, " ")
      .toLowerCase();

    // righe OCR (molto importanti per le tabelle)
    const linesAll = raw
      .split("\n")
      .map(s => s.trim().toLowerCase())
      .filter(Boolean);

    // prova a isolare la sezione per 100g (se c'è)
    let sectionText = norm;
    let sectionLines = linesAll;

    const idx = norm.search(/per\s*100\s*g|per\s*100\s*gr|per\s*100\s*ml|per\s*100\s*m[l1]/);
    if (idx >= 0) {
      sectionText = norm.slice(idx, idx + 1600);
      sectionLines = sectionText
        .split("\n")
        .map(s => String(s).trim().toLowerCase())
        .filter(Boolean);

      // se lo split su \n non produce quasi nulla (perché sectionText è "flat"),
      // ricadiamo su linesAll (più affidabile)
      if (sectionLines.length < 4) sectionLines = linesAll;
    }

    const flatSection = sectionText.replace(/\s+/g, " ");
    const flatNorm = norm.replace(/\s+/g, " ");

    const toNum = (s) => {
      const mm = String(s || "").match(/(\d+(?:[.,]\d+)?)/);
      if (!mm) return null;
      const v = parseFloat(mm[1].replace(",", "."));
      return Number.isFinite(v) ? v : null;
    };

    const isEnergyLine = (ln) => /\bkcal\b|\bkj\b/.test(ln);
    const isSubRow = (ln) => /\bdi\s*cui\b|\bof\s*which\b/.test(ln);

    // core finder: cerca il numero del macro vicino alla label,
    // ma se trova righe kcal/kj le SALTA (così "Grassi -> 68.0 kcal -> 0.3 g" funziona).
    const findMacro = (labelRe, opts = {}) => {
      const avoidIf = opts.avoidIf || null;

      // 1) stessa riga (flat)
      {
        const re1 = new RegExp(`${labelRe.source}\\s*[:]?\\s*(\\d+(?:[.,]\\d+)?)`, "i");
        const mm = flatSection.match(re1) || flatNorm.match(re1);
        if (mm) return toNum(mm[1]);
      }

      // 2) vicino in testo (ampio)
      {
        const re2 = new RegExp(`${labelRe.source}[\\s\\S]{0,200}?(\\d+(?:[.,]\\d+)?)`, "i");
        const mm = sectionText.match(re2) || norm.match(re2);
        if (mm) {
          // ATTENZIONE: questo può beccare numeri non desiderati, perciò lo usiamo solo come fallback.
          const v = toNum(mm[1]);
          if (v !== null) return v;
        }
      }

      // 3) riga + righe successive (robusto per tabelle)
      const lines = sectionLines && sectionLines.length ? sectionLines : linesAll;

      for (let i = 0; i < lines.length; i++) {
        const ln = lines[i];

        if (isSubRow(ln)) continue;
        if (avoidIf && avoidIf.test(ln)) continue;

        if (labelRe.test(ln)) {
          // se numero sulla stessa riga
          const v1 = toNum(ln);
          if (v1 !== null) return v1;

          // guarda le prossime 6 righe, saltando energia e fermandoti su sotto-voce
          for (let j = 1; j <= 6; j++) {
            if (i + j >= lines.length) break;
            const ln2 = lines[i + j];

            if (isSubRow(ln2)) break;
            if (avoidIf && avoidIf.test(ln2)) break;

            // SKIP energia
            if (isEnergyLine(ln2)) continue;

            const v2 = toNum(ln2);
            if (v2 !== null) return v2;
          }
        }
      }

      return null;
    };

    // Macro: evita zuccheri/saturi
    const c = findMacro(/carboidrati|carbohydrates|carbs/i, { avoidIf: /zuccheri|sugars/i });
    const p = findMacro(/proteine|protein/i);
    const f = findMacro(/grassi|fat/i, { avoidIf: /saturi|saturated/i });

    // kcal: cercala in modo dedicato (energia kcal spesso è spezzata)
    let kcal = null;

    // 1) stessa riga o vicino (flat)
    {
      const reK = /\bkcal\b/i;
      // prova su linee: prendi il primo numero di una riga che contiene kcal e (idealmente) energia
      for (let i = 0; i < linesAll.length; i++) {
        const ln = linesAll[i];
        if (reK.test(ln)) {
          // preferisci riga con "energia"
          if (ln.includes("energia")) {
            const v = toNum(ln);
            if (v !== null) { kcal = v; break; }
            // oppure numero sulla riga dopo
            if (i + 1 < linesAll.length) {
              const v2 = toNum(linesAll[i + 1]);
              if (v2 !== null) { kcal = v2; break; }
            }
          }
        }
      }
    }

    // 2) fallback: prima riga con "kcal" che abbia un numero, o numero subito dopo
    if (kcal === null) {
      for (let i = 0; i < linesAll.length; i++) {
        const ln = linesAll[i];
        if (ln.includes("kcal")) {
          const v = toNum(ln);
          if (v !== null) { kcal = v; break; }
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

    const nameGuess = raw
      .split("\n")
      .map(s => s.trim())
      .find(s => s.length >= 3 && !/^valori nutrizionali$/i.test(s)) || "";

    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        parserVersion: "v4-skip-energy-lines",
        nameGuess,
        per100: found ? per100 : null,
        confidence,
        rawText: raw.slice(0, 4000)
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
