exports.handler = async (event) => {
  try {
    if (event.httpMethod !== "POST") {
      return { statusCode: 405, body: "Method Not Allowed" };
    }

    const apiKey = process.env.GOOGLE_VISION_API_KEY;
    if (!apiKey) {
      return {
        statusCode: 500,
        body: JSON.stringify({ error: "Missing GOOGLE_VISION_API_KEY" })
      };
    }

    const { image } = JSON.parse(event.body || "{}");
    if (!image || !image.startsWith("data:image")) {
      return {
        statusCode: 400,
        body: JSON.stringify({ error: "Invalid image data" })
      };
    }

    const base64 = image.split(",")[1];

    const visionResp = await fetch(
      "https://vision.googleapis.com/v1/images:annotate?key=" + apiKey,
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

    const visionJson = await visionResp.json();
    const rawText =
      visionJson?.responses?.[0]?.fullTextAnnotation?.text || "";

    // -------- PARSER VERO (riga + riga sotto) --------

    const lines = rawText
      .split("\n")
      .map(l => l.trim().toLowerCase())
      .filter(Boolean);

    const readValueAfter = (labelRegex) => {
      for (let i = 0; i < lines.length; i++) {
        if (labelRegex.test(lines[i])) {
          // numero sulla riga stessa
          const inline = lines[i].match(/(\d+(?:[.,]\d+)?)/);
          if (inline) return parseFloat(inline[1].replace(",", "."));

          // numero sulla riga sotto
          if (lines[i + 1]) {
            const below = lines[i + 1].match(/(\d+(?:[.,]\d+)?)/);
            if (below) return parseFloat(below[1].replace(",", "."));
          }
        }
      }
      return null;
    };

    const per100 = {
      c: readValueAfter(/carboidrati|carbohydrates/),
      p: readValueAfter(/proteine|protein/),
      f: readValueAfter(/grassi|fat/),
      kcalLabel: readValueAfter(/energia.*kcal|kcal/)
    };

    const found = ["c","p","f"].filter(k => typeof per100[k] === "number").length;

    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        parserVersion: "v5-line-below-fix",
        per100: found >= 2 ? per100 : null,
        confidence: found === 3 ? 0.95 : found === 2 ? 0.7 : 0.3,
        rawText
      })
    };

  } catch (e) {
    return {
      statusCode: 500,
      body: JSON.stringify({ error: String(e.message || e) })
    };
  }
};
